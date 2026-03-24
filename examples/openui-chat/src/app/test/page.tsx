"use client";

import "@openuidev/react-ui/components.css";
import { Renderer } from "@openuidev/react-lang";
import type { Transport } from "@openuidev/react-lang";
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib";
import { useState } from "react";

// ── In-memory mock data for Jira/Linear tools ──────────────────────────────
const mockIssues = [
  { key: "PROJ-1", summary: "Fix login redirect loop", status: "in_progress", priority: "high", assignee: "Alice" },
  { key: "PROJ-2", summary: "Add dark mode support", status: "open", priority: "medium", assignee: "Bob" },
  { key: "PROJ-3", summary: "Update API documentation", status: "done", priority: "low", assignee: "Charlie" },
  { key: "PROJ-4", summary: "Optimize database queries", status: "open", priority: "high", assignee: "Alice" },
  { key: "PROJ-5", summary: "Fix mobile responsive layout", status: "in_progress", priority: "medium", assignee: "Bob" },
];
let nextIssueId = 6;

// ── Mock transport for testing Query() and Mutation() ───────────────────────
// For MCP servers, use: createMcpTransport({ url: "/mcp" })

const mockTransport: Transport = {
  callTool: async (toolName, args) => {
    // Simulate network delay
    await new Promise((r) => setTimeout(r, 800));

    if (toolName === "get_usage_metrics") {
      const days = Number(args.dateRange ?? 14);
      // resource arg accepted but does not change output (mock)
      const _resource = args.resource ?? "all";
      const scale = days / 14; // scale data relative to 14-day baseline
      return {
        totalEvents: days * 890,
        totalUsers: days * 42,
        data: [
          { day: "Mon", events: Math.round(420 * scale), users: Math.round(180 * scale) },
          { day: "Tue", events: Math.round(380 * scale), users: Math.round(165 * scale) },
          { day: "Wed", events: Math.round(510 * scale), users: Math.round(220 * scale) },
          { day: "Thu", events: Math.round(470 * scale), users: Math.round(195 * scale) },
          { day: "Fri", events: Math.round(630 * scale), users: Math.round(280 * scale) },
        ],
      };
    }

    if (toolName === "get_top_endpoints") {
      return {
        endpoints: [
          { path: "/api/chat", requests: 4820, avgLatency: 120 },
          { path: "/api/auth", requests: 3210, avgLatency: 85 },
          { path: "/api/users", requests: 2180, avgLatency: 95 },
          { path: "/api/files", requests: 1540, avgLatency: 200 },
        ],
      };
    }

    // ── Jira/Linear mock tools ──────────────────────────────────────────
    if (toolName === "jira_create_issue") {
      const summary = String(args.summary ?? "").trim();
      if (!summary) throw new Error("Summary is required");
      const issue = {
        key: `PROJ-${nextIssueId++}`,
        summary,
        status: "open",
        priority: String(args.priority ?? "medium"),
        assignee: String(args.assignee ?? "Unassigned"),
      };
      mockIssues.unshift(issue);
      return issue;
    }

    if (toolName === "jira_list_issues") {
      const status = String(args.status ?? "all");
      const filtered = status === "all"
        ? [...mockIssues]
        : mockIssues.filter((i) => i.status === status);
      return { columns: ["key", "summary", "status", "priority", "assignee"], rows: filtered };
    }

    if (toolName === "jira_update_status") {
      const key = String(args.key ?? "");
      const newStatus = String(args.status ?? "");
      const issue = mockIssues.find((i) => i.key === key);
      if (!issue) throw new Error(`Issue ${key} not found`);
      issue.status = newStatus;
      return issue;
    }

    return null;
  },
};

// ── Test programs ───────────────────────────────────────────────────────────

const PROGRAMS = {
  // Test 1: Static v1 program (backward compat)
  static: `root = Card([header, stats])
header = CardHeader("Hello World", "A simple v1 test")
stats = TextContent("This is a static v1 program — no bindings, no queries.", "default")`,

  // Test 2: Bindings + string concat
  bindings: `root = Card([header, info])
header = CardHeader("Bindings Test", "Testing $variable declarations and string concatenation")
$name = "World"
info = TextContent("Hello, " + $name + "! This text uses string concatenation with a $binding.", "default")`,

  // Test 3: Query with defaults
  query: `root = Card([header, stats, info])
header = CardHeader("Query Test", "Live data from mock MCP transport")
metrics = Query("get_usage_metrics", {dateRange: "14"}, {totalEvents: 0, totalUsers: 0, data: []})
stats = TextContent("Events: " + metrics.totalEvents + " | Users: " + metrics.totalUsers, "large-heavy")
info = TextContent("Data points: " + Count(metrics.data) + " | Max events: " + Max(metrics.data.events) + " | Min events: " + Min(metrics.data.events), "default")`,

  // Test 4: Builtins + Table with object data
  builtins: `root = Card([header, countText, sumText, tbl])
header = CardHeader("Builtins + Table Test", "Count, Sum, Avg + Table with object data from Query")
endpoints = Query("get_top_endpoints", {}, {endpoints: []})
countText = TextContent("Endpoint count: " + Count(endpoints.endpoints) + " | Total requests: " + Sum(endpoints.endpoints.requests), "default")
sumText = TextContent("Avg latency: " + Avg(endpoints.endpoints.avgLatency) + "ms | Min: " + Min(endpoints.endpoints.avgLatency) + "ms | Max: " + Max(endpoints.endpoints.avgLatency) + "ms", "default")
tbl = Table(cols, endpoints.endpoints)
cols = [Col("Path", "path"), Col("Requests", "requests", "number"), Col("Latency", "avgLatency", "number")]`,

  // Test 5: Full dashboard (bindings + query + builtins + concat + chart)
  dashboard: `root = Card([header, stats, chart, details])
header = CardHeader("Usage Dashboard", "Live metrics from mock data")
$dateRange = "14"
metrics = Query("get_usage_metrics", {dateRange: $dateRange}, {totalEvents: 0, totalUsers: 0, data: []})
endpoints = Query("get_top_endpoints", {}, {endpoints: []})
stats = TextContent("Events: " + metrics.totalEvents + " | Users: " + metrics.totalUsers + " | Endpoints: " + Count(endpoints.endpoints), "large-heavy")
chart = LineChart(metrics.data.day, [Series("Events", metrics.data.events), Series("Users", metrics.data.users)])
details = TextContent("Top endpoint requests: " + Sum(endpoints.endpoints.requests) + " | Avg latency: " + Avg(endpoints.endpoints.avgLatency) + "ms", "default")`,

  // Test 6: Complex — exercises ALL features together
  complex: `root = Card([header, bindingInfo, statRow1, statRow2, chart, tbl])
header = CardHeader("Complex Dashboard", "All features: bindings, queries, concat, builtins, pluck, chart, table")
$dateRange = "14"
$resource = "all"
metrics = Query("get_usage_metrics", {dateRange: $dateRange, resource: $resource}, {totalEvents: 0, totalUsers: 0, data: []})
endpoints = Query("get_top_endpoints", {dateRange: $dateRange}, {endpoints: []})
bindingInfo = TextContent("Date range: " + $dateRange + " days | Resource filter: " + $resource, "default")
statRow1 = TextContent("Total events: " + metrics.totalEvents + " | Total users: " + metrics.totalUsers + " | Data points: " + Count(metrics.data), "large-heavy")
statRow2 = TextContent("Sum events: " + Sum(metrics.data.events) + " | Avg events: " + Avg(metrics.data.events) + " | Min users: " + Min(metrics.data.users) + " | Max users: " + Max(metrics.data.users) + " | Endpoints: " + Count(endpoints.endpoints), "default")
chart = LineChart(metrics.data.day, [Series("Events", metrics.data.events), Series("Users", metrics.data.users)])
tbl = Table(cols, endpoints.endpoints)
cols = [Col("Path", "path"), Col("Requests", "requests", "number"), Col("Avg Latency (ms)", "avgLatency", "number")]`,

  // Test 7: Interactive filters — Select binds to $dateRange, Query re-fetches on change
  filters: `root = Card([header, rangeField, stats, chart, tbl])
header = CardHeader("Interactive Filters", "Change the date range to re-fetch data")
$dateRange = "14"
rangeField = FormControl("Date Range", Select("dateRange", $dateRange, [range7, range14, range30]))
range7 = SelectItem("7", "Last 7 days")
range14 = SelectItem("14", "Last 14 days")
range30 = SelectItem("30", "Last 30 days")
metrics = Query("get_usage_metrics", {dateRange: $dateRange}, {totalEvents: 0, totalUsers: 0, data: []})
endpoints = Query("get_top_endpoints", {dateRange: $dateRange}, {endpoints: []})
stats = TextContent("Date range: " + $dateRange + " days | Events: " + metrics.totalEvents + " | Users: " + metrics.totalUsers, "large-heavy")
chart = LineChart(metrics.data.day, [Series("Events", metrics.data.events), Series("Users", metrics.data.users)])
tbl = Table(cols, endpoints.endpoints)
cols = [Col("Path", "path"), Col("Requests", "requests", "number"), Col("Latency", "avgLatency", "number")]`,

  // Test 8: Mutation — Jira/Linear project board with create + list + filter
  jira: `root = Card([header, createForm, feedback, statusFilter, refreshBtn, ticketTable])
header = CardHeader("Project Board", "Create and manage issues with Mutation()")
$title = ""
$priority = "medium"
$status = "all"
createForm = Form("create-issue", createBtn, [titleField, prioField])
titleField = FormControl("Issue Summary", Input("title", $title, "What needs to be done?", "text", {required: true, minLength: 3}))
prioField = FormControl("Priority", Select("priority", $priority, [pHigh, pMed, pLow]))
pHigh = SelectItem("high", "High")
pMed = SelectItem("medium", "Medium")
pLow = SelectItem("low", "Low")
createResult = Mutation("jira_create_issue", {summary: $title, priority: $priority})
createBtn = Button("Create Issue", {type: "mutation", target: "createResult", refresh: ["tickets"]}, "primary")
feedback = createResult.status == "success" ? Callout("success", "Issue Created", "Created " + createResult.data.key + ": " + createResult.data.summary) : createResult.status == "error" ? Callout("error", "Creation Failed", "Error: " + createResult.error) : createResult.status == "loading" ? TextContent("Creating...", "small") : null
statusFilter = FormControl("Filter by Status", Select("status", $status, [sAll, sOpen, sInProgress, sDone]))
sAll = SelectItem("all", "All")
sOpen = SelectItem("open", "Open")
sInProgress = SelectItem("in_progress", "In Progress")
sDone = SelectItem("done", "Done")
refreshBtn = Button("Refresh", {type: "refresh"}, "secondary")
tickets = Query("jira_list_issues", {status: $status}, {columns: ["key", "summary", "status", "priority", "assignee"], rows: []})
ticketTable = Table(ticketCols, tickets.rows)
ticketCols = [Col("Key", "key"), Col("Summary", "summary"), Col("Status", "status"), Col("Priority", "priority"), Col("Assignee", "assignee")]`,

  // Test 9: Local form fields — NO $bindings, pure form submission
  form: `root = Card([header, contactForm])
header = CardHeader("Contact Form", "Local fields only — no $bindings")
contactForm = Form("contact", submitBtn, [nameField, emailField, msgField, prioField])
nameField = FormControl("Name", Input("name", null, "Your name", "text", {required: true, minLength: 2}))
emailField = FormControl("Email", Input("email", null, "you@example.com", "email", {required: true}))
msgField = FormControl("Message", TextArea("message", null, "Your message", 4))
prioField = FormControl("Priority", Select("priority", null, [pHigh, pMed, pLow]))
pHigh = SelectItem("high", "High")
pMed = SelectItem("medium", "Medium")
pLow = SelectItem("low", "Low")
submitBtn = Button("Submit", "continue_conversation", "primary")`,
};

type ProgramKey = keyof typeof PROGRAMS;

// ── Test page component ─────────────────────────────────────────────────────

export default function TestPage() {
  const [active, setActive] = useState<ProgramKey>("static");
  const [parseInfo, setParseInfo] = useState<string>("");

  const needsTransport = active === "query" || active === "builtins" || active === "dashboard" || active === "complex" || active === "filters" || active === "jira";

  return (
    <div style={{ padding: "24px", maxWidth: "900px", margin: "0 auto", fontFamily: "system-ui" }}>
      <h1 style={{ marginBottom: "8px" }}>openui-lang Test Page</h1>
      <p style={{ color: "#666", marginBottom: "24px" }}>
        Select a test program to verify features: bindings, Query, builtins, string concat.
      </p>

      {/* Program selector */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
        {(Object.keys(PROGRAMS) as ProgramKey[]).map((key) => (
          <button
            key={key}
            onClick={() => setActive(key)}
            style={{
              padding: "8px 16px",
              border: active === key ? "2px solid #0066ff" : "1px solid #ccc",
              borderRadius: "6px",
              background: active === key ? "#e6f0ff" : "white",
              cursor: "pointer",
              fontWeight: active === key ? 600 : 400,
            }}
          >
            {key}
          </button>
        ))}
      </div>

      {/* Source code display */}
      <details style={{ marginBottom: "16px" }}>
        <summary style={{ cursor: "pointer", fontWeight: 500 }}>Source code</summary>
        <pre
          style={{
            background: "#f5f5f5",
            padding: "12px",
            borderRadius: "6px",
            fontSize: "13px",
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {PROGRAMS[active]}
        </pre>
      </details>

      {/* Parse info */}
      {parseInfo && (
        <div style={{ marginBottom: "16px", fontSize: "12px", color: "#888" }}>{parseInfo}</div>
      )}

      {/* Rendered output */}
      <div
        style={{
          border: "1px solid #e0e0e0",
          borderRadius: "8px",
          padding: "16px",
          minHeight: "100px",
        }}
      >
        <Renderer
          key={active}
          response={PROGRAMS[active]}
          library={openuiChatLibrary}
          isStreaming={false}
          transport={needsTransport ? mockTransport : undefined}
          onAction={(event) => console.log("[action]", event)}
          onStateUpdate={(state) => console.log("[state]", state)}
          onParseResult={(result) => {
            if (result) {
              setParseInfo(
                `Statements: ${result.meta.statementCount} | ` +
                  `State declarations: ${Object.keys(result.stateDeclarations ?? {}).length} | ` +
                  `Queries: ${result.queryStatements?.length ?? 0} | ` +
                  `Unresolved: ${result.meta.unresolved.length}`,
              );
            }
          }}
        />
      </div>
    </div>
  );
}
