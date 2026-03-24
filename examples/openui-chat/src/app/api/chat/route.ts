import { NextRequest } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

// ── System prompt (generated from dashboard-library.ts) ──
const systemPrompt = readFileSync(
  join(process.cwd(), "src/generated/dashboard-prompt.txt"),
  "utf-8",
);

// ── PostHog query execution (server-side for tool calls) ──

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY ?? "";
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID ?? "";
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://us.posthog.com";

async function executePostHogQuery(sql: string): Promise<string> {
  if (!POSTHOG_API_KEY || !POSTHOG_PROJECT_ID) {
    return JSON.stringify({ error: "POSTHOG_API_KEY and POSTHOG_PROJECT_ID env vars required" });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(
      `${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${POSTHOG_API_KEY}`,
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql } }),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const err = await res.text();
      return JSON.stringify({ error: `PostHog API error ${res.status}: ${err.substring(0, 200)}` });
    }
    const data = await res.json();
    const columns: string[] = data.columns ?? [];
    const rawResults: unknown[][] = data.results ?? [];
    const preview = rawResults.slice(0, 20).map((row: unknown[]) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
      return obj;
    });
    return JSON.stringify({ columns, rows: preview, total_rows: rawResults.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "PostHog query failed";
    if (msg.includes("aborted")) {
      return JSON.stringify({ error: "PostHog query timed out after 45s. Try a simpler query or shorter time range." });
    }
    return JSON.stringify({ error: msg });
  } finally {
    clearTimeout(timeout);
  }
}

// ── Tool definitions (with function implementations for runTools) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tools: any[] = [
  {
    type: "function",
    function: {
      name: "posthog_query",
      description: "Run a HogQL SQL query against PostHog analytics to explore data before generating the UI. Use this to test queries and see the actual data shape/values.",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "HogQL SQL query to execute" },
        },
        required: ["sql"],
      },
      function: ({ sql }: { sql: string }) => executePostHogQuery(sql),
      parse: JSON.parse,
    },
  },
];

// ── SSE helpers ──

function sseToolCallStart(
  encoder: TextEncoder,
  tc: { id: string; function: { name: string } },
  index: number,
) {
  return encoder.encode(
    `data: ${JSON.stringify({
      id: `chatcmpl-tc-${tc.id}`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: tc.id,
                type: "function",
                function: { name: tc.function.name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
}

function sseToolCallArgs(
  encoder: TextEncoder,
  tc: { id: string; function: { arguments: string } },
  result: string,
  index: number,
) {
  let enrichedArgs: string;
  try {
    enrichedArgs = JSON.stringify({
      _request: JSON.parse(tc.function.arguments),
      _response: JSON.parse(result),
    });
  } catch {
    enrichedArgs = tc.function.arguments;
  }
  return encoder.encode(
    `data: ${JSON.stringify({
      id: `chatcmpl-tc-${tc.id}-args`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index, function: { arguments: enrichedArgs } }] },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
}

// ── Route handler using runTools ──

export async function POST(req: NextRequest) {
  const { messages } = await req.json();

  // LLM config from env — supports OpenAI-compatible providers (OpenAI, OpenRouter, etc.)
  const apiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const baseURL = process.env.LLM_BASE_URL; // e.g. "https://openrouter.ai/api/v1"
  const model = process.env.LLM_MODEL ?? "gpt-5.4";

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Set LLM_API_KEY or OPENAI_API_KEY env var" }),
      { status: 500 },
    );
  }

  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  const cleanMessages = (messages as any[])
    .filter((m: any) => m.role !== "tool")
    .map((m: any) => {
      if (m.role === "assistant" && m.tool_calls?.length) {
        const { tool_calls: _tc, ...rest } = m;
        return rest;
      }
      return m;
    });

  const chatMessages: ChatCompletionMessageParam[] = [
    { role: "system" as const, content: systemPrompt },
    ...cleanMessages,
  ];

  const encoder = new TextEncoder();
  let controllerClosed = false;

  const readable = new ReadableStream({
    start(controller) {
      const enqueue = (data: Uint8Array) => {
        if (controllerClosed) return;
        try { controller.enqueue(data); } catch { /* closed */ }
      };
      const close = () => {
        if (controllerClosed) return;
        controllerClosed = true;
        try { controller.close(); } catch { /* closed */ }
      };

      const pendingCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let callIdx = 0;
      let resultIdx = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const runOpts: any = {
        model,
        messages: chatMessages,
        tools,
        stream: true,
      };
      const runner = (client.chat.completions as any).runTools(runOpts);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runner.on("functionToolCall", (fc: any) => {
        const id = `tc-${callIdx}`;
        pendingCalls.push({ id, name: fc.name, arguments: fc.arguments });
        enqueue(sseToolCallStart(encoder, { id, function: { name: fc.name } }, callIdx));
        callIdx++;
      });

      runner.on("functionToolCallResult", (result: string) => {
        const tc = pendingCalls[resultIdx];
        if (tc) {
          enqueue(
            sseToolCallArgs(
              encoder,
              { id: tc.id, function: { arguments: tc.arguments } },
              result,
              resultIdx,
            ),
          );
        }
        resultIdx++;
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let accumulator = "";
      runner.on("chunk", (chunk: any) => {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (!delta) return;
        if (delta.content) {
          accumulator += delta.content;
          enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        if (choice?.finish_reason === "stop") {
          enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
      });

      runner.on("end", () => {
        enqueue(encoder.encode("data: [DONE]\n\n"));
        close();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runner.on("error", (err: any) => {
        const msg = err instanceof Error ? err.message : "Stream error";
        console.error("[chat] Error:", msg);
        enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
        close();
      });
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
