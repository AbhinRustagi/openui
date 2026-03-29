import {
  GoogleGenerativeAI,
  SchemaType,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/generative-ai";
import { readFileSync } from "fs";
import { NextRequest } from "next/server";
import { join } from "path";

// ── System prompt (generated from library.ts) ──

const systemPrompt = readFileSync(join(process.cwd(), "src/generated/system-prompt.txt"), "utf-8");

// ── Mock data tool (replace with your own backend) ──

async function getMockData(query: string): Promise<string> {
  const data: Record<string, unknown> = {
    users: {
      total: 12450,
      active: 8920,
      new_this_week: 340,
      trend: [
        { date: "2026-03-22", count: 1240 },
        { date: "2026-03-23", count: 1180 },
        { date: "2026-03-24", count: 1350 },
        { date: "2026-03-25", count: 1420 },
        { date: "2026-03-26", count: 1290 },
        { date: "2026-03-27", count: 1380 },
        { date: "2026-03-28", count: 1060 },
      ],
    },
    revenue: {
      total: 284500,
      mrr: 23700,
      growth_percent: 12.4,
      by_plan: [
        { plan: "Free", users: 5200, revenue: 0 },
        { plan: "Starter", users: 4100, revenue: 82000 },
        { plan: "Pro", users: 2800, revenue: 140000 },
        { plan: "Enterprise", users: 350, revenue: 62500 },
      ],
    },
    support: {
      open_tickets: 47,
      resolved_today: 23,
      avg_response_minutes: 14,
      by_category: [
        { category: "Billing", count: 12 },
        { category: "Technical", count: 18 },
        { category: "Feature Request", count: 9 },
        { category: "Account", count: 8 },
      ],
    },
  };

  const key = query.toLowerCase().trim();
  if (key in data) return JSON.stringify(data[key]);
  return JSON.stringify(data);
}

// ── Gemini tool declarations ──

const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "get_dashboard_data",
    description:
      "Fetch dashboard data. Pass a topic like 'users', 'revenue', or 'support' to get relevant metrics, or pass 'all' for everything.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: "The data topic to fetch: 'users', 'revenue', 'support', or 'all'",
        },
      },
      required: ["query"],
    },
  },
];

// ── SSE helpers (emit OpenAI-compatible format for frontend reuse) ──

function sseChunk(encoder: TextEncoder, content: string): Uint8Array {
  return encoder.encode(
    `data: ${JSON.stringify({
      id: "chatcmpl-gemini",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`,
  );
}

function sseToolCallStart(encoder: TextEncoder, name: string, index: number): Uint8Array {
  return encoder.encode(
    `data: ${JSON.stringify({
      id: `chatcmpl-tc-${index}`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: `tc-${index}`,
                type: "function",
                function: { name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
}

function sseToolCallResult(
  encoder: TextEncoder,
  args: Record<string, unknown>,
  result: string,
  index: number,
): Uint8Array {
  let enriched: string;
  try {
    enriched = JSON.stringify({ _request: args, _response: JSON.parse(result) });
  } catch {
    enriched = JSON.stringify({ _request: args, _response: result });
  }
  return encoder.encode(
    `data: ${JSON.stringify({
      id: `chatcmpl-tc-${index}-args`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index, function: { arguments: enriched } }] },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
}

// ── Convert messages from frontend format to Gemini Content[] ──

function toGeminiContents(messages: Array<{ role: string; content: string }>): Content[] {
  const contents: Content[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue; // handled via systemInstruction
    if (msg.role === "tool") continue;

    const role = msg.role === "assistant" ? "model" : "user";
    contents.push({
      role,
      parts: [{ text: msg.content }],
    });
  }
  return contents;
}

// ── Route handler ──

export async function POST(req: NextRequest) {
  const { messages } = await req.json();

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
  const model = "gemini-2.5-flash";

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Set GEMINI_API_KEY or GOOGLE_API_KEY env var" }), {
      status: 500,
    });
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const gemini = genAI.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
    tools: [{ functionDeclarations: toolDeclarations }],
  });

  const contents = toGeminiContents(messages);
  const encoder = new TextEncoder();
  let controllerClosed = false;

  const readable = new ReadableStream({
    async start(controller) {
      const enqueue = (data: Uint8Array) => {
        if (controllerClosed) return;
        try {
          controller.enqueue(data);
        } catch {
          /* closed */
        }
      };
      const close = () => {
        if (controllerClosed) return;
        controllerClosed = true;
        try {
          controller.close();
        } catch {
          /* closed */
        }
      };

      try {
        let currentContents = [...contents];
        let toolCallIndex = 0;

        // Tool call loop: Gemini may request function calls across multiple turns
        while (true) {
          const stream = await gemini.generateContentStream({ contents: currentContents });
          let functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
          let hasText = false;

          for await (const chunk of stream.stream) {
            const candidate = chunk.candidates?.[0];
            if (!candidate?.content?.parts) continue;

            for (const part of candidate.content.parts) {
              if (part.text) {
                hasText = true;
                enqueue(sseChunk(encoder, part.text));
              }
              if (part.functionCall) {
                const fc = part.functionCall;
                enqueue(sseToolCallStart(encoder, fc.name, toolCallIndex));
                functionCalls.push({
                  name: fc.name,
                  args: (fc.args as Record<string, unknown>) ?? {},
                });
              }
            }
          }

          // If no function calls, we're done
          if (functionCalls.length === 0) break;

          // Execute function calls and build response parts
          const functionResponseParts: Part[] = [];

          for (const fc of functionCalls) {
            let result: string;
            if (fc.name === "get_dashboard_data") {
              result = await getMockData((fc.args.query as string) ?? "all");
            } else {
              result = JSON.stringify({ error: `Unknown function: ${fc.name}` });
            }

            enqueue(sseToolCallResult(encoder, fc.args, result, toolCallIndex));
            toolCallIndex++;

            functionResponseParts.push({
              functionResponse: {
                name: fc.name,
                response: { result: JSON.parse(result) },
              },
            });
          }

          // Append the model's function call turn and our response
          currentContents.push({
            role: "model",
            parts: functionCalls.map((fc) => ({
              functionCall: { name: fc.name, args: fc.args },
            })),
          });
          currentContents.push({
            role: "user",
            parts: functionResponseParts,
          });

          functionCalls = [];
        }

        enqueue(encoder.encode("data: [DONE]\n\n"));
        close();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Gemini stream error";
        console.error("[gemini-chat] Error:", msg);
        enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
        close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
