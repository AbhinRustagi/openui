"use client";

import "@openuidev/react-ui/components.css";
import {
  StatefulRenderer,
  type StatefulRendererHandle,
} from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { useCallback, useRef, useState } from "react";
import { ThemeProvider } from "@openuidev/react-ui";

// ── SSE streaming parser ─────────────────────────────────────────────────────

async function streamChat(
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
  onDone: () => void,
  signal?: AbortSignal,
) {
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
        onDone();
        return;
      }
      try {
        const chunk = JSON.parse(data);
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) onChunk(content);
      } catch {
        /* skip malformed chunks */
      }
    }
  }
  onDone();
}

// ── Starter prompts ──────────────────────────────────────────────────────────

const STARTERS = [
  { label: "User Metrics", prompt: "Show me a dashboard with user metrics — total, active, and a weekly trend chart" },
  { label: "Revenue Breakdown", prompt: "Build a revenue dashboard with MRR, growth rate, and a breakdown by plan" },
  { label: "Support Overview", prompt: "Create a support ticket dashboard with open tickets, response time, and categories" },
  { label: "Full Dashboard", prompt: "Build a comprehensive dashboard with users, revenue, and support metrics" },
];

// ── Styles ───────────────────────────────────────────────────────────────────

const buttonStyle: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  border: "1px solid #d1d5db",
  background: "#fff",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
  color: "#374151",
};

const activeButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#eff6ff",
  borderColor: "#3b82f6",
  color: "#2563eb",
};

const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#fef2f2",
  borderColor: "#fca5a5",
  color: "#dc2626",
};

// ── Page component ───────────────────────────────────────────────────────────

export default function GeminiChatPage() {
  const rendererRef = useRef<StatefulRendererHandle>(null);
  const [input, setInput] = useState("");
  const [initialSource, setInitialSource] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [editHistory, setEditHistory] = useState<string[]>([]);
  const [currentSource, setCurrentSource] = useState<string>("");
  const [showSource, setShowSource] = useState(false);
  const [showMutations, setShowMutations] = useState(false);
  const responseRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);

  // Refresh the source display from the NodeStore
  const refreshSource = useCallback(() => {
    const source = rendererRef.current?.getSourceText() ?? "";
    setCurrentSource(source);
  }, []);

  const send = useCallback(
    (text: string) => {
      if (!text.trim() || isStreaming) return;
      const trimmed = text.trim();
      const isEdit = initialSource !== null;

      setInput("");
      setIsStreaming(true);
      responseRef.current = "";

      const controller = new AbortController();
      abortRef.current = controller;

      // For edits, send the current source (which may include user mutations)
      // as the assistant context — the LLM sees the user's rearranged layout.
      const currentText = isEdit
        ? rendererRef.current?.getSourceText() ?? initialSource!
        : null;

      const apiMessages = isEdit
        ? [
            { role: "assistant", content: currentText! },
            { role: "user", content: trimmed },
          ]
        : [{ role: "user", content: trimmed }];

      setEditHistory((prev) => [...prev, trimmed]);

      streamChat(
        apiMessages,
        (chunk) => {
          responseRef.current += chunk;
          if (isEdit) {
            // Apply as incremental patch
            rendererRef.current?.applyPatch(responseRef.current);
          } else {
            // First turn — set full source (StatefulRenderer handles it)
            setInitialSource(responseRef.current);
          }
        },
        () => {
          setIsStreaming(false);
          if (responseRef.current) {
            if (!isEdit) {
              setInitialSource(responseRef.current);
            }
            refreshSource();
          }
        },
        controller.signal,
      );
    },
    [isStreaming, initialSource, refreshSource],
  );

  const clear = () => {
    abortRef.current?.abort();
    setInitialSource(null);
    setEditHistory([]);
    setIsStreaming(false);
    setCurrentSource("");
    setShowMutations(false);
  };

  // ── User mutation actions ──

  const getChildrenOfRoot = useCallback((): string[] => {
    const store = rendererRef.current?.getNodeStore();
    if (!store) return [];
    const rootId = store.getRootId();
    if (!rootId) return [];
    const root = store.getNode(rootId);
    return root?.children ?? [];
  }, []);

  const handleMoveUp = useCallback(
    (childId: string) => {
      const store = rendererRef.current?.getNodeStore();
      if (!store) return;
      const rootId = store.getRootId();
      if (!rootId) return;
      const children = getChildrenOfRoot();
      const idx = children.indexOf(childId);
      if (idx <= 0) return;
      const newOrder = [...children];
      [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];
      rendererRef.current?.reorderChildren(rootId, newOrder);
      refreshSource();
    },
    [getChildrenOfRoot, refreshSource],
  );

  const handleMoveDown = useCallback(
    (childId: string) => {
      const store = rendererRef.current?.getNodeStore();
      if (!store) return;
      const rootId = store.getRootId();
      if (!rootId) return;
      const children = getChildrenOfRoot();
      const idx = children.indexOf(childId);
      if (idx < 0 || idx >= children.length - 1) return;
      const newOrder = [...children];
      [newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]];
      rendererRef.current?.reorderChildren(rootId, newOrder);
      refreshSource();
    },
    [getChildrenOfRoot, refreshSource],
  );

  const handleRemove = useCallback(
    (childId: string) => {
      rendererRef.current?.removeNode(childId);
      refreshSource();
    },
    [refreshSource],
  );

  const rootChildren = initialSource ? getChildrenOfRoot() : [];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#fafbfc",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px" }}>
        {/* Header */}
        <div style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>
              OpenUI + Gemini
            </h1>
            <p style={{ fontSize: 14, color: "#666", marginTop: 4 }}>
              Generative UI with user mutations — reorder and remove components
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {initialSource && (
              <>
                <button
                  onClick={() => setShowMutations((v) => !v)}
                  style={showMutations ? activeButtonStyle : buttonStyle}
                >
                  {showMutations ? "Hide Controls" : "Edit Layout"}
                </button>
                <button
                  onClick={() => { setShowSource((v) => !v); refreshSource(); }}
                  style={showSource ? activeButtonStyle : buttonStyle}
                >
                  {showSource ? "Hide Source" : "View Source"}
                </button>
                <button onClick={clear} style={buttonStyle}>
                  Clear
                </button>
              </>
            )}
          </div>
        </div>

        {/* Starter prompts */}
        {!initialSource && editHistory.length === 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
            {STARTERS.map((s, i) => (
              <button
                key={i}
                onClick={() => send(s.prompt)}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  border: "1px solid #e5e7eb",
                  background: "#fff",
                  cursor: "pointer",
                  fontSize: 13,
                  textAlign: "left",
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

        {/* Input */}
        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send(input)}
            placeholder={
              initialSource
                ? "Describe changes to the UI..."
                : "Describe the UI you want..."
            }
            disabled={isStreaming}
            style={{
              flex: 1,
              padding: "10px 14px",
              borderRadius: 8,
              border: "1px solid #d1d5db",
              fontSize: 14,
              outline: "none",
            }}
          />
          <button
            onClick={() => send(input)}
            disabled={isStreaming || !input.trim()}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              background: isStreaming ? "#9ca3af" : "#2563eb",
              color: "#fff",
              cursor: isStreaming ? "not-allowed" : "pointer",
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            {isStreaming ? "Generating..." : initialSource ? "Edit" : "Generate"}
          </button>
        </div>

        {/* User mutation controls */}
        {showMutations && rootChildren.length > 0 && (
          <div
            style={{
              marginBottom: 16,
              padding: 16,
              background: "#f8fafc",
              borderRadius: 8,
              border: "1px solid #e2e8f0",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: "#475569" }}>
              Layout Controls — root children
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {rootChildren.map((childId, i) => (
                <div
                  key={childId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 10px",
                    background: "#fff",
                    borderRadius: 6,
                    border: "1px solid #e5e7eb",
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 500, flex: 1, fontFamily: "monospace" }}>
                    {childId}
                  </span>
                  <button
                    onClick={() => handleMoveUp(childId)}
                    disabled={i === 0}
                    style={{
                      ...buttonStyle,
                      padding: "2px 8px",
                      opacity: i === 0 ? 0.3 : 1,
                      cursor: i === 0 ? "default" : "pointer",
                    }}
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => handleMoveDown(childId)}
                    disabled={i === rootChildren.length - 1}
                    style={{
                      ...buttonStyle,
                      padding: "2px 8px",
                      opacity: i === rootChildren.length - 1 ? 0.3 : 1,
                      cursor: i === rootChildren.length - 1 ? "default" : "pointer",
                    }}
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => handleRemove(childId)}
                    style={{ ...dangerButtonStyle, padding: "2px 8px" }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: "#94a3b8" }}>
              Changes are reflected in the source text. The LLM will see your layout changes on the next edit.
            </div>
          </div>
        )}

        {/* Rendered output */}
        {initialSource && (
          <div
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: 20,
              background: "#fff",
              marginBottom: 16,
            }}
          >
            <ThemeProvider>
              <StatefulRenderer
                ref={rendererRef}
                response={initialSource}
                library={openuiLibrary}
                isStreaming={isStreaming}
                onAction={(event) => {
                  console.log("[action]", event);
                  if (event.type === "continue_conversation") {
                    const text =
                      event.params?.context || event.humanFriendlyMessage || "";
                    if (text) send(text);
                  }
                }}
              />
            </ThemeProvider>
          </div>
        )}

        {/* Source view */}
        {showSource && currentSource && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "#475569" }}>
              Current Source (sent to LLM on next edit)
            </div>
            <pre
              style={{
                background: "#1e293b",
                color: "#e2e8f0",
                padding: 16,
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.6,
                overflow: "auto",
                maxHeight: 300,
              }}
            >
              {currentSource}
            </pre>
          </div>
        )}

        {/* Edit history */}
        {editHistory.length > 1 && (
          <div style={{ marginTop: 8, fontSize: 12, color: "#999" }}>
            Edits: {editHistory.map((h, i) => (
              <span key={i}>
                {i > 0 && " → "}
                {h.length > 40 ? h.slice(0, 40) + "..." : h}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
