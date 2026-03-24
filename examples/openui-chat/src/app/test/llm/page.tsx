"use client";

import "@openuidev/react-ui/components.css";
import { Renderer, mergeStatements, createMcpTransport } from "@openuidev/react-lang";
import type { Transport, McpConnection } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { useCallback, useEffect, useRef, useState } from "react";
import { ThemeProvider } from "@openuidev/react-ui";

// ── MCP Transport with tool call tracking ────────────────────────────────────

type ToolCallListener = (calls: Array<{ tool: string; status: "pending" | "done" | "error" }>) => void;

let toolCallListener: ToolCallListener | null = null;
const activeCalls: Array<{ tool: string; status: "pending" | "done" | "error" }> = [];

function notifyToolCalls() {
  toolCallListener?.([...activeCalls]);
}

function wrapTransport(inner: Transport): Transport {
  return {
    callTool: async (toolName, args) => {
      const entry: { tool: string; status: "pending" | "done" | "error" } = { tool: toolName, status: "pending" };
      activeCalls.push(entry);
      notifyToolCalls();
      try {
        const data = await inner.callTool(toolName, args);
        entry.status = "done";
        notifyToolCalls();
        return data;
      } catch {
        entry.status = "error";
        notifyToolCalls();
        return null;
      }
    },
  };
}

// ── Streaming SSE parser ────────────────────────────────────────────────────

type LLMToolCall = { id: string; name: string; status: "calling" | "done" };
type LLMToolCallListener = (calls: LLMToolCall[]) => void;
let llmToolCallListener: LLMToolCallListener | null = null;
const llmActiveCalls: LLMToolCall[] = [];

function notifyLLMToolCalls() {
  llmToolCallListener?.([...llmActiveCalls]);
}

async function streamChat(
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
  onDone: (usage?: { prompt_tokens?: number; completion_tokens?: number }) => void,
  signal?: AbortSignal,
  onFirstChunk?: () => void,
) {
  llmActiveCalls.length = 0;
  notifyLLMToolCalls();

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!res.ok) {
    const err = await res.text();
    onChunk(`Error: ${err}`);
    onDone();
    return;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  let firstChunkFired = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") {
        // Mark all remaining "calling" as "done"
        for (const tc of llmActiveCalls) {
          if (tc.status === "calling") tc.status = "done";
        }
        notifyLLMToolCalls();
        onDone(lastUsage);
        return;
      }
      try {
        const chunk = JSON.parse(data);
        // Track LLM tool calls from SSE
        const tcDeltas = chunk.choices?.[0]?.delta?.tool_calls;
        if (tcDeltas) {
          for (const tc of tcDeltas) {
            if (tc.id && tc.function?.name) {
              // New tool call start
              llmActiveCalls.push({ id: tc.id, name: tc.function.name, status: "calling" });
              notifyLLMToolCalls();
            } else if (tc.function?.arguments) {
              // Tool call result — mark the matching call as done
              const existing = llmActiveCalls[tc.index];
              if (existing) {
                existing.status = "done";
                notifyLLMToolCalls();
              }
            }
          }
        }
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
          if (!firstChunkFired) {
            firstChunkFired = true;
            onFirstChunk?.();
          }
          onChunk(content);
        }
        if (chunk.usage) lastUsage = chunk.usage;
      } catch {
        /* skip malformed chunks */
      }
    }
  }
  onDone(lastUsage);
}

// ── Starter prompts ─────────────────────────────────────────────────────────

const STARTERS = [
  {
    label: "Web Analytics",
    prompt: "Show me pageviews and unique users over the last 14 days with a date range filter",
    icon: "📊",
  },
  {
    label: "Top Events",
    prompt: "What are the top 10 events by volume this week?",
    icon: "🔥",
  },
  {
    label: "Full Dashboard",
    prompt: "Build a web analytics dashboard like PostHog with KPIs, trend chart, top pages table, and traffic sources",
    icon: "📈",
  },
  {
    label: "Marketing & SEO",
    prompt: "Give me an analysis dashboard for marketing and SEO with traffic sources, top pages, and conversion funnel",
    icon: "🎯",
  },
  {
    label: "Weekly Comparison",
    prompt: "Share me the views difference between last and current week with a refresh button",
    icon: "📅",
  },
  {
    label: "Server Health",
    prompt: "Create a server monitoring dashboard that auto-refreshes every 30 seconds showing CPU, memory, and latency",
    icon: "🖥️",
  },
];

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = {
  page: {
    minHeight: "100vh",
    background: "#fafbfc",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  } as React.CSSProperties,
  container: {
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "32px 24px",
  } as React.CSSProperties,
  header: {
    marginBottom: "24px",
  } as React.CSSProperties,
  title: {
    fontSize: "24px",
    fontWeight: 700,
    margin: 0,
    color: "#111",
  } as React.CSSProperties,
  subtitle: {
    fontSize: "14px",
    color: "#666",
    marginTop: "4px",
    display: "flex",
    alignItems: "center",
    gap: "12px",
  } as React.CSSProperties,
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 8px",
    borderRadius: "12px",
    fontSize: "12px",
    fontWeight: 500,
  } as React.CSSProperties,
  starterGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: "10px",
    marginBottom: "20px",
  } as React.CSSProperties,
  starterBtn: {
    padding: "12px 14px",
    border: "1px solid #e2e5e9",
    borderRadius: "10px",
    background: "white",
    cursor: "pointer",
    fontSize: "13px",
    textAlign: "left" as const,
    transition: "all 0.15s",
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
    lineHeight: "1.4",
  } as React.CSSProperties,
  inputRow: {
    display: "flex",
    gap: "8px",
    marginBottom: "20px",
  } as React.CSSProperties,
  input: {
    flex: 1,
    padding: "12px 16px",
    border: "1px solid #d1d5db",
    borderRadius: "10px",
    fontSize: "14px",
    outline: "none",
    transition: "border-color 0.15s",
  } as React.CSSProperties,
  sendBtn: (active: boolean) =>
    ({
      padding: "12px 24px",
      border: "none",
      borderRadius: "10px",
      background: active ? "#111" : "#d1d5db",
      color: "white",
      cursor: active ? "pointer" : "not-allowed",
      fontSize: "14px",
      fontWeight: 600,
      transition: "all 0.15s",
      whiteSpace: "nowrap",
    }) as React.CSSProperties,
  clearBtn: {
    padding: "12px 16px",
    border: "1px solid #d1d5db",
    borderRadius: "10px",
    background: "white",
    cursor: "pointer",
    fontSize: "14px",
    color: "#666",
    transition: "all 0.15s",
  } as React.CSSProperties,
  meta: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    marginBottom: "12px",
    fontSize: "13px",
    color: "#888",
  } as React.CSSProperties,
  sourceToggle: {
    marginBottom: "12px",
  } as React.CSSProperties,
  sourcePre: {
    background: "#1e1e2e",
    color: "#cdd6f4",
    padding: "16px",
    borderRadius: "8px",
    fontSize: "12px",
    overflow: "auto",
    whiteSpace: "pre-wrap" as const,
    maxHeight: "300px",
    lineHeight: "1.5",
  } as React.CSSProperties,
  rendererWrap: {
    border: "1px solid #e2e5e9",
    borderRadius: "12px",
    padding: "20px",
    background: "white",
    minHeight: "120px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
  } as React.CSSProperties,
  conversationItem: {
    padding: "8px 12px",
    borderRadius: "8px",
    marginBottom: "4px",
    fontSize: "13px",
    lineHeight: "1.4",
  } as React.CSSProperties,
};

// ── Component ───────────────────────────────────────────────────────────────

export default function LLMTestPage() {
  const [input, setInput] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [showPatch, setShowPatch] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [toolCalls, setToolCalls] = useState<Array<{ tool: string; status: string }>>([]);
  const [usage, setUsage] = useState<{ prompt_tokens?: number; completion_tokens?: number } | null>(null);
  const [llmTools, setLlmTools] = useState<LLMToolCall[]>([]);
  // Edit history — user prompts only (for display), not sent to API
  const [editHistory, setEditHistory] = useState<string[]>([]);
  // The current merged dashboard source (single source of truth)
  const mergedRef = useRef<string | null>(null);
  const [currentPatch, setCurrentPatch] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const responseRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);

  // MCP transport — connects to /api/mcp
  const [transport, setTransport] = useState<Transport | null>(null);
  const mcpRef = useRef<McpConnection | null>(null);

  useEffect(() => {
    let cancelled = false;
    createMcpTransport({ url: "/api/mcp" }).then((mcp) => {
      if (cancelled) { mcp.disconnect(); return; }
      mcpRef.current = mcp;
      setTransport(wrapTransport(mcp.transport));
    }).catch((err) => {
      console.error("[mcp] Failed to connect:", err);
    });
    return () => {
      cancelled = true;
      mcpRef.current?.disconnect();
    };
  }, []);

  // Listen for tool calls (runtime transport + LLM tool calls)
  useEffect(() => {
    toolCallListener = (calls) => setToolCalls([...calls]);
    llmToolCallListener = (calls) => setLlmTools([...calls]);
    return () => { toolCallListener = null; llmToolCallListener = null; };
  }, []);

  // Debug: ?code=<base64 openui-lang> renders directly
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("code");
    if (p) {
      try {
        const code = atob(p);
        setResponse(code);
        mergedRef.current = code;
      } catch {
        /* ignore */
      }
    }
  }, []);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, [isStreaming]);

  // Timer
  useEffect(() => {
    if (!isStreaming || !startTime) return;
    const iv = setInterval(() => setElapsed(Date.now() - startTime), 100);
    return () => clearInterval(iv);
  }, [isStreaming, startTime]);

  // Core: send messages to API and stream response
  const doStream = useCallback(
    async (apiMessages: Array<{ role: string; content: string }>, isEdit: boolean) => {
      if (isStreaming) return;
      setInput("");
      setIsStreaming(true);
      setStartTime(null);
      setElapsed(null);
      setUsage(null);
      activeCalls.length = 0;
      setToolCalls([]);
      responseRef.current = "";
      setCurrentPatch(null);
      let streamStartTime: number | null = null;

      const base = isEdit ? mergedRef.current : null;
      // During streaming of an edit, show the existing dashboard immediately
      if (!isEdit) setResponse("");

      const controller = new AbortController();
      abortRef.current = controller;

      await streamChat(
        apiMessages,
        (chunk) => {
          responseRef.current += chunk;
          if (isEdit && base) {
            // Live merge: patch streamed so far + base
            try {
              const merged = mergeStatements(base, responseRef.current);
              setResponse(merged);
            } catch {
              // If merge fails mid-stream (incomplete statement), show base
              setResponse(base);
            }
          } else {
            setResponse(responseRef.current);
          }
          setCurrentPatch(responseRef.current);
        },
        (streamUsage) => {
          setIsStreaming(false);
          if (streamStartTime) setElapsed(Date.now() - streamStartTime);
          if (streamUsage) setUsage(streamUsage);
          // Finalize: merge one last time and store as new mergedDashboard
          if (responseRef.current) {
            let finalMerged: string;
            if (isEdit && base) {
              try {
                finalMerged = mergeStatements(base, responseRef.current);
              } catch {
                finalMerged = base;
              }
            } else {
              finalMerged = responseRef.current;
            }
            mergedRef.current = finalMerged;
            setResponse(finalMerged);
            setCurrentPatch(responseRef.current);
          }
        },
        controller.signal,
        () => {
          // Timer starts when first content chunk arrives (after tool calls)
          streamStartTime = Date.now();
          setStartTime(streamStartTime);
        },
      );
    },
    [isStreaming],
  );

  // Send new user message (turn 1 or edit)
  const send = useCallback(
    (text: string) => {
      if (!text.trim() || isStreaming) return;
      const trimmed = text.trim();
      const isEdit = mergedRef.current !== null;

      // Build API messages
      let apiMessages: Array<{ role: string; content: string }>;
      if (isEdit) {
        // Edit: only send current dashboard + new prompt (2 messages)
        apiMessages = [
          { role: "assistant", content: mergedRef.current! },
          { role: "user", content: trimmed },
        ];
      } else {
        // First turn: just the user prompt
        apiMessages = [{ role: "user", content: trimmed }];
      }

      // Track in edit history for display
      setEditHistory((prev) => [...prev, trimmed]);
      doStream(apiMessages, isEdit);
    },
    [isStreaming, doStream],
  );

  // Regenerate last response
  const regenerate = useCallback(() => {
    if (isStreaming || editHistory.length === 0) return;
    const lastPrompt = editHistory[editHistory.length - 1];

    if (editHistory.length === 1) {
      // Regenerate first turn — no base
      mergedRef.current = null;
      doStream([{ role: "user", content: lastPrompt }], false);
    } else {
      // Regenerate edit — revert merged to before this edit
      // We don't have the previous merged state, so re-send as edit
      // The LLM will re-generate the patch
      const apiMessages = [
        { role: "assistant", content: mergedRef.current! },
        { role: "user", content: lastPrompt },
      ];
      doStream(apiMessages, true);
    }
  }, [isStreaming, editHistory, doStream]);

  const clear = () => {
    abortRef.current?.abort();
    setResponse(null);
    mergedRef.current = null;
    setCurrentPatch(null);
    setEditHistory([]);
    setIsStreaming(false);
    setStartTime(null);
    setElapsed(null);
    responseRef.current = "";
  };

  const completionTokens = usage?.completion_tokens ?? null;
  const lineCount = response ? response.split("\n").filter((l) => l.trim()).length : 0;
  const patchLineCount = currentPatch ? currentPatch.split("\n").filter((l) => l.trim()).length : 0;
  const pendingTools = toolCalls.filter((t) => t.status === "pending");
  const canSend = input.trim().length > 0 && !isStreaming;
  const hasDashboard = mergedRef.current !== null && !isStreaming;

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        {/* Header */}
        <div style={styles.header}>
          <h1 style={styles.title}>openui-lang Live Demo</h1>
          <div style={styles.subtitle}>
            <span>LLM generates reactive dashboards with live PostHog data</span>
            <span
              style={{
                ...styles.badge,
                background: "#ecfdf5",
                color: "#059669",
              }}
            >
              Live Data
            </span>
            <span
              style={{
                ...styles.badge,
                background: "#eff6ff",
                color: "#2563eb",
              }}
            >
              Streaming
            </span>
            <span
              style={{
                ...styles.badge,
                background: "#fef3c7",
                color: "#d97706",
              }}
            >
              Editable
            </span>
          </div>
        </div>

        {/* Starters — show when no conversation */}
        {editHistory.length === 0 && !response && (
          <div style={styles.starterGrid}>
            {STARTERS.map((s) => (
              <button
                key={s.prompt}
                onClick={() => send(s.prompt)}
                style={styles.starterBtn}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "#111";
                  e.currentTarget.style.background = "#f9fafb";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "#e2e5e9";
                  e.currentTarget.style.background = "white";
                }}
              >
                <span style={{ fontSize: "18px", flexShrink: 0 }}>
                  {s.icon}
                </span>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: "2px" }}>
                    {s.label}
                  </div>
                  <div style={{ color: "#888", fontSize: "12px" }}>
                    {s.prompt.length > 60
                      ? s.prompt.slice(0, 60) + "..."
                      : s.prompt}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Edit history */}
        {editHistory.length > 0 && (
          <div style={{ marginBottom: "12px" }}>
            <div
              style={{
                fontSize: "13px",
                color: "#888",
                marginBottom: "6px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span>{editHistory.length} turn{editHistory.length !== 1 ? "s" : ""}</span>
              {editHistory.length > 1 && (
                <span style={{
                  ...styles.badge,
                  background: "#f0f4ff",
                  color: "#2563eb",
                  fontSize: "11px",
                }}>
                  merge-by-name
                </span>
              )}
            </div>
            {editHistory.map((prompt, i) => (
              <div
                key={i}
                style={{
                  ...styles.conversationItem,
                  background: "#f0f4ff",
                  color: "#1e40af",
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: "8px",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong style={{ color: "#6b7280", fontSize: "11px", marginRight: "6px" }}>
                    {i === 0 ? "Create" : `Edit ${i}`}
                  </strong>
                  {prompt.length > 120 ? prompt.slice(0, 120) + "..." : prompt}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Input */}
        <div style={styles.inputRow}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSend) send(input);
            }}
            placeholder={
              mergedRef.current
                ? "Edit the dashboard... (e.g. 'add a date filter', 'remove the chart')"
                : "Ask for a dashboard..."
            }
            disabled={isStreaming}
            style={{
              ...styles.input,
              borderColor: isStreaming ? "#d1d5db" : "#9ca3af",
            }}
          />
          <button
            onClick={() => canSend && send(input)}
            disabled={!canSend}
            style={styles.sendBtn(canSend)}
          >
            {isStreaming ? "Streaming..." : mergedRef.current ? "Edit" : "Send"}
          </button>
          {hasDashboard && (
            <button
              onClick={regenerate}
              style={styles.clearBtn}
              title="Regenerate last response"
            >
              Regen
            </button>
          )}
          {(response || editHistory.length > 0) && (
            <button onClick={clear} style={styles.clearBtn}>
              Clear
            </button>
          )}
        </div>

        {/* Meta info + tool calls */}
        {response && (
          <div style={styles.meta}>
            {isStreaming && (
              <span style={{ color: "#059669", fontWeight: 500 }}>
                {editHistory.length > 1 ? "Patching" : "Generating"}... {elapsed ? `${(elapsed / 1000).toFixed(1)}s` : ""}
              </span>
            )}
            {!isStreaming && elapsed && (
              <span>{editHistory.length > 1 ? "Patched" : "Generated"} in {(elapsed / 1000).toFixed(1)}s</span>
            )}
            <span>{lineCount} statements{currentPatch && editHistory.length > 1 ? ` (patch: ${patchLineCount})` : ""}</span>
            {completionTokens && <span>{completionTokens} tokens</span>}
            {!completionTokens && response && <span>{response.length} chars</span>}
            <button
              onClick={() => setShowSource(!showSource)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#2563eb",
                fontSize: "13px",
                padding: 0,
              }}
            >
              {showSource ? "Hide merged" : "View merged"}
            </button>
            {currentPatch && editHistory.length > 1 && (
              <button
                onClick={() => setShowPatch(!showPatch)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#d97706",
                  fontSize: "13px",
                  padding: 0,
                }}
              >
                {showPatch ? "Hide patch" : "View patch"}
              </button>
            )}
          </div>
        )}

        {/* Tool call activity — LLM tool calls (pre-generation data fetching) */}
        {(llmTools.length > 0 || toolCalls.length > 0) && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              marginBottom: "12px",
              fontSize: "12px",
            }}
          >
            {llmTools.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
                <span style={{ color: "#6b7280", fontWeight: 500 }}>LLM queries:</span>
                {llmTools.map((tc, i) => (
                  <span
                    key={`llm-${i}`}
                    style={{
                      padding: "3px 8px",
                      borderRadius: "6px",
                      background: tc.status === "calling" ? "#eff6ff" : "#ecfdf5",
                      color: tc.status === "calling" ? "#1d4ed8" : "#065f46",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    {tc.status === "calling" ? "⏳" : "✓"}
                    {tc.name}
                  </span>
                ))}
                {llmTools.some(t => t.status === "calling") && (
                  <span style={{ color: "#1d4ed8" }}>Querying data...</span>
                )}
              </div>
            )}
            {toolCalls.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
                <span style={{ color: "#6b7280", fontWeight: 500 }}>Runtime:</span>
                {toolCalls.map((tc, i) => (
                  <span
                    key={`rt-${i}`}
                    style={{
                      padding: "3px 8px",
                      borderRadius: "6px",
                      background:
                        tc.status === "pending"
                          ? "#fef3c7"
                          : tc.status === "done"
                            ? "#ecfdf5"
                            : "#fef2f2",
                      color:
                        tc.status === "pending"
                          ? "#92400e"
                          : tc.status === "done"
                            ? "#065f46"
                            : "#991b1b",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    {tc.status === "pending" ? "⏳" : tc.status === "done" ? "✓" : "✗"}
                    {tc.tool}
                  </span>
                ))}
                {pendingTools.length > 0 && (
                  <span style={{ color: "#92400e" }}>Fetching data...</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Merged source */}
        {response && showSource && (
          <div style={styles.sourceToggle}>
            <pre style={styles.sourcePre}>{response}</pre>
          </div>
        )}

        {/* Patch source (edit only) */}
        {currentPatch && showPatch && editHistory.length > 1 && (
          <div style={styles.sourceToggle}>
            <pre style={{ ...styles.sourcePre, borderLeft: "3px solid #d97706" }}>{currentPatch}</pre>
          </div>
        )}

        {/* Rendered output */}
        {response && (
          <div style={styles.rendererWrap}>
            <ThemeProvider>
            <Renderer
              response={response}
              library={openuiLibrary}
              isStreaming={isStreaming}
              transport={transport}
              onAction={(event) => {
                console.log("[action]", event);
                if (event.type === "continue_conversation") {
                  const text =
                    event.params?.context ||
                    event.humanFriendlyMessage ||
                    "";
                  if (text) send(text);
                }
                }}
              />
            </ThemeProvider>
          </div>
        )}

        {/* Empty state */}
        {!response && editHistory.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "60px 20px",
              color: "#999",
              fontSize: "14px",
            }}
          >
            <div style={{ fontSize: "40px", marginBottom: "12px" }}>
              ⚡
            </div>
            <div>Pick a starter or type your own prompt</div>
            <div style={{ fontSize: "12px", marginTop: "4px", color: "#bbb" }}>
              Dashboards render with live PostHog data
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
