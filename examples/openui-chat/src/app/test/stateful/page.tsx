"use client";

import "@openuidev/react-ui/components.css";
import {
  StatefulRenderer,
  type StatefulRendererHandle,
  type Transport,
} from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { useCallback, useRef, useState } from "react";
import { ThemeProvider } from "@openuidev/react-ui";

// ── Mock transport ───────────────────────────────────────────────────────────

const mockTransport: Transport = {
  callTool: async (name, args) => {
    await new Promise((r) => setTimeout(r, 500));
    if (name === "get_sales") {
      return {
        total: 128500,
        items: [
          { region: "US", revenue: 45000 },
          { region: "EU", revenue: 38000 },
          { region: "APAC", revenue: 25500 },
          { region: "LATAM", revenue: 20000 },
        ],
      };
    }
    return { result: "ok" };
  },
};

// ── Initial source ───────────────────────────────────────────────────────────

const INITIAL_SOURCE = `root = Card([title, metrics, chart])
title = Text("Sales Dashboard")
$region = "all"
sales = Query("get_sales", {region: $region}, {total: 0, items: []})
metrics = Text("Total Revenue: $" + sales.total)
chart = PieChart(["US", "EU", "APAC", "LATAM"], [45000, 38000, 25500, 20000])`;

// ── Patches to apply ─────────────────────────────────────────────────────────

const PATCHES = [
  {
    label: "Add a filter",
    patch: `root = Card([filter, title, metrics, chart])
filter = Select("Region", $region, ["all", "US", "EU", "APAC"])`,
  },
  {
    label: "Add a subtitle",
    patch: `root = Card([filter, title, subtitle, metrics, chart])
subtitle = Text("Q1 2026 Performance")`,
  },
  {
    label: "Remove the chart",
    patch: `root = Card([filter, title, subtitle, metrics])
chart = null`,
  },
  {
    label: "Update the title",
    patch: `title = Text("Revenue Overview")`,
  },
];

// ── Page component ───────────────────────────────────────────────────────────

export default function StatefulRendererTestPage() {
  const rendererRef = useRef<StatefulRendererHandle>(null);
  const [patchHistory, setPatchHistory] = useState<string[]>([]);
  const [currentSource, setCurrentSource] = useState<string>("");

  const applyPatch = useCallback((patchStr: string, label: string) => {
    rendererRef.current?.applyPatch(patchStr);
    setPatchHistory((prev) => [...prev, label]);
    // Read back the current source text after applying the patch
    const source = rendererRef.current?.getSourceText() ?? "";
    setCurrentSource(source);
  }, []);

  const showSource = useCallback(() => {
    const source = rendererRef.current?.getSourceText() ?? "(no source)";
    setCurrentSource(source);
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "32px", maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
        StatefulRenderer Test
      </h1>
      <p style={{ color: "#666", marginBottom: 24, fontSize: 14 }}>
        Demonstrates incremental patch application. Each button applies a patch
        to the retained node map — only affected components re-render.
      </p>

      {/* Controls */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
        {PATCHES.map((p, i) => (
          <button
            key={i}
            onClick={() => applyPatch(p.patch, p.label)}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "1px solid #ddd",
              background: "#f5f5f5",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={showSource}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "1px solid #3b82f6",
            background: "#eff6ff",
            color: "#3b82f6",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Show Source
        </button>
      </div>

      {/* Rendered output */}
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 16, marginBottom: 24 }}>
        <ThemeProvider>
          <StatefulRenderer
            ref={rendererRef}
            response={INITIAL_SOURCE}
            library={openuiLibrary}
            transport={mockTransport}
            onAction={(event) => console.log("[action]", event)}
          />
        </ThemeProvider>
      </div>

      {/* Patch history */}
      {patchHistory.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Patch History</h3>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#555" }}>
            {patchHistory.map((label, i) => (
              <li key={i}>{label}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Current source */}
      {currentSource && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Current Source (from getSourceText)</h3>
          <pre
            style={{
              background: "#f8f9fa",
              padding: 16,
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.5,
              overflow: "auto",
              border: "1px solid #e5e7eb",
            }}
          >
            {currentSource}
          </pre>
        </div>
      )}
    </div>
  );
}
