import { describe, expect, it } from "vitest";
import { createStreamParser, parse } from "../parser";
import type { ParamMap } from "../parser";

// ── Test schema ──────────────────────────────────────────────────────────────

/**
 * Minimal schema used across tests.
 *
 * Stack takes one param (children), Title takes one (text),
 * Table takes two (columns, rows). These cover the common test cases.
 */
const schema: ParamMap = new Map([
  ["Stack", { params: [{ name: "children", required: true }] }],
  ["Title", { params: [{ name: "text", required: true }] }],
  [
    "Table",
    {
      params: [
        { name: "columns", required: true },
        { name: "rows", required: true },
      ],
    },
  ],
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

const errors = (input: string) => parse(input, schema).meta.validationErrors;
const rules = (input: string) => errors(input).map((e) => e.rule);

// ── unknown-component ────────────────────────────────────────────────────────

describe("unknown-component", () => {
  it("reports when component name is not in schema", () => {
    const result = parse('root = DataTable("col")', schema);
    expect(result.meta.validationErrors).toHaveLength(1);
    expect(result.meta.validationErrors[0]).toMatchObject({
      rule: "unknown-component",
      component: "DataTable",
      path: "",
    });
  });

  it("still renders the element with _args when unknown", () => {
    const result = parse('root = DataTable("col")', schema);
    expect(result.root).not.toBeNull();
    expect(result.root?.typeName).toBe("DataTable");
    expect((result.root?.props as any)._args).toEqual(["col"]);
  });

  it("reports all unknown components in a tree", () => {
    const r = rules('root = Stack([Ghost("a")])\n');
    expect(r).toContain("unknown-component");
  });

  it("does not report for known component names", () => {
    const result = parse('root = Stack(["hello"])', schema);
    expect(rules('root = Stack(["hello"])')).not.toContain("unknown-component");
    expect(result.meta.validationErrors).toHaveLength(0);
  });
});

// ── excess-args ───────────────────────────────────────────────────────────────

describe("excess-args", () => {
  it("reports when more args are passed than params", () => {
    const result = parse('root = Title("hello", "extra")', schema);
    expect(result.meta.validationErrors).toHaveLength(1);
    expect(result.meta.validationErrors[0]).toMatchObject({
      rule: "excess-args",
      component: "Title",
      path: "",
    });
    expect(result.meta.validationErrors[0].message).toMatch(/takes 1 arg/);
  });

  it("still renders the component despite excess args", () => {
    const result = parse('root = Title("hello", "extra")', schema);
    expect(result.root).not.toBeNull();
    expect(result.root?.props.text).toBe("hello");
  });

  it("does not report when arg count matches param count", () => {
    expect(rules('root = Title("hello")')).not.toContain("excess-args");
  });

  it("does not report when fewer args than params (handled by missing-required)", () => {
    expect(rules("root = Table([], [])")).not.toContain("excess-args");
  });
});

// ── unresolved-ref (one-shot) ─────────────────────────────────────────────────

describe("unresolved-ref (one-shot parse)", () => {
  it("promotes unresolved ref to validationErrors", () => {
    const result = parse("root = Stack([tbl])", schema);
    expect(result.meta.validationErrors).toHaveLength(1);
    expect(result.meta.validationErrors[0]).toMatchObject({
      rule: "unresolved-ref",
      component: "tbl",
      path: "",
    });
  });

  it("meta.unresolved is still populated", () => {
    const result = parse("root = Stack([tbl])", schema);
    expect(result.meta.unresolved).toContain("tbl");
  });

  it("does not error when ref is defined", () => {
    const result = parse('root = Stack([tbl])\ntbl = Title("hello")', schema);
    expect(rules('root = Stack([tbl])\ntbl = Title("hello")')).not.toContain(
      "unresolved-ref",
    );
    expect(result.meta.unresolved).toHaveLength(0);
  });
});

// ── unresolved-ref (streaming) ────────────────────────────────────────────────

describe("unresolved-ref (streaming)", () => {
  it("does NOT error on unresolved ref mid-stream", () => {
    const parser = createStreamParser(schema);
    const midResult = parser.push('root = Stack([tbl])\n');
    expect(midResult.meta.validationErrors.map((e) => e.rule)).not.toContain(
      "unresolved-ref",
    );
    expect(midResult.meta.unresolved).toContain("tbl");
  });

  it("resolves automatically when ref is defined in a later chunk", () => {
    const parser = createStreamParser(schema);
    parser.push('root = Stack([tbl])\n');
    const result = parser.push('tbl = Title("hello")\n');
    expect(result.meta.unresolved).toHaveLength(0);
  });

  it("finalize() promotes still-unresolved refs to validationErrors", () => {
    const parser = createStreamParser(schema);
    parser.push('root = Stack([tbl])\n');
    const final = parser.finalize();
    expect(final.meta.validationErrors).toHaveLength(1);
    expect(final.meta.validationErrors[0]).toMatchObject({
      rule: "unresolved-ref",
      component: "tbl",
    });
  });

  it("finalize() produces no unresolved-ref errors when ref was resolved", () => {
    const parser = createStreamParser(schema);
    parser.push('root = Stack([tbl])\n');
    parser.push('tbl = Title("hello")\n');
    const final = parser.finalize();
    expect(final.meta.validationErrors.map((e) => e.rule)).not.toContain(
      "unresolved-ref",
    );
  });
});

// ── existing error rules ──────────────────────────────────────────────────────

describe("existing errors carry rule tags", () => {
  it("missing-required has rule tag", () => {
    const result = parse("root = Stack()", schema);
    expect(result.meta.validationErrors).toHaveLength(1);
    expect(result.meta.validationErrors[0].rule).toBe("missing-required");
  });

  it("null-required has rule tag", () => {
    const result = parse("root = Stack(null)", schema);
    expect(result.meta.validationErrors).toHaveLength(1);
    expect(result.meta.validationErrors[0].rule).toBe("null-required");
  });
});
