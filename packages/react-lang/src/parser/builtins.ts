/**
 * Shared builtin registry — single source of truth for:
 *   - Runtime evaluation (evaluator.ts imports .fn)
 *   - Prompt generation (prompt.ts imports .signature + .description)
 *   - Parser identification (`isBuiltin`, `isReservedCall`, `RESERVED_CALLS`)
 */

export interface BuiltinDef {
  /** PascalCase name matching the openui-lang syntax: Count, Sum, etc. */
  name: string;
  /** Signature for prompt docs: "Count(array) → number" */
  signature: string;
  /** One-line description for prompt docs */
  description: string;
  /** Runtime implementation */
  fn: (...args: unknown[]) => unknown;
}

function toNumber(val: unknown): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = Number(val);
    return isNaN(n) ? 0 : n;
  }
  if (typeof val === "boolean") return val ? 1 : 0;
  return 0;
}

export const BUILTINS: Record<string, BuiltinDef> = {
  Count: {
    name: "Count",
    signature: "Count(array) → number",
    description: "Returns array length",
    fn: (arr) => (Array.isArray(arr) ? arr.length : 0),
  },
  First: {
    name: "First",
    signature: "First(array) → element",
    description: "Returns first element of array",
    fn: (arr) => (Array.isArray(arr) ? (arr[0] ?? null) : null),
  },
  Last: {
    name: "Last",
    signature: "Last(array) → element",
    description: "Returns last element of array",
    fn: (arr) => (Array.isArray(arr) ? (arr[arr.length - 1] ?? null) : null),
  },
  Sum: {
    name: "Sum",
    signature: "Sum(numbers[]) → number",
    description: "Sum of numeric array",
    fn: (arr) =>
      Array.isArray(arr) ? arr.reduce((a: number, b: unknown) => a + (Number(b) || 0), 0) : 0,
  },
  Avg: {
    name: "Avg",
    signature: "Avg(numbers[]) → number",
    description: "Average of numeric array",
    fn: (arr) =>
      Array.isArray(arr) && arr.length
        ? (arr.reduce((a: number, b: unknown) => a + (Number(b) || 0), 0) as number) / arr.length
        : 0,
  },
  Min: {
    name: "Min",
    signature: "Min(numbers[]) → number",
    description: "Minimum value in array",
    fn: (arr) => (Array.isArray(arr) && arr.length ? Math.min(...arr.map(Number)) : 0),
  },
  Max: {
    name: "Max",
    signature: "Max(numbers[]) → number",
    description: "Maximum value in array",
    fn: (arr) => (Array.isArray(arr) && arr.length ? Math.max(...arr.map(Number)) : 0),
  },
  Sort: {
    name: "Sort",
    signature: "Sort(array, field, direction?) → sorted array",
    description: 'Sort array by field. Direction: "asc" (default) or "desc"',
    fn: (arr, field, dir) => {
      if (!Array.isArray(arr)) return arr;
      const f = String(field ?? "");
      const desc = String(dir ?? "asc") === "desc";
      return [...arr].sort((a: any, b: any) => {
        const av = f ? a?.[f] : a;
        const bv = f ? b?.[f] : b;
        if (av > bv) return desc ? -1 : 1;
        if (av < bv) return desc ? 1 : -1;
        return 0;
      });
    },
  },
  Filter: {
    name: "Filter",
    signature:
      'Filter(array, field, operator: "==" | "!=" | ">" | "<" | ">=" | "<=" | "contains", value) → filtered array',
    description: "Filter array by field value",
    fn: (arr, field, op, value) => {
      if (!Array.isArray(arr)) return [];
      const f = String(field ?? "");
      const o = String(op ?? "==");
      return arr.filter((item: any) => {
        const v = f ? item?.[f] : item;
        switch (o) {
          case "==":
            return v === value;
          case "!=":
            return v !== value;
          case ">":
            return toNumber(v) > toNumber(value);
          case "<":
            return toNumber(v) < toNumber(value);
          case ">=":
            return toNumber(v) >= toNumber(value);
          case "<=":
            return toNumber(v) <= toNumber(value);
          case "in":
          case "contains":
            return String(v ?? "").includes(String(value ?? ""));
          default:
            return false;
        }
      });
    },
  },
  Round: {
    name: "Round",
    signature: "Round(number, decimals?) → number",
    description: "Round to N decimal places (default 0)",
    fn: (n, decimals) => {
      const num = toNumber(n);
      const d = decimals != null ? toNumber(decimals) : 0;
      const factor = Math.pow(10, d);
      return Math.round(num * factor) / factor;
    },
  },
  Abs: {
    name: "Abs",
    signature: "Abs(number) → number",
    description: "Absolute value",
    fn: (n) => Math.abs(toNumber(n)),
  },
  Floor: {
    name: "Floor",
    signature: "Floor(number) → number",
    description: "Round down to nearest integer",
    fn: (n) => Math.floor(toNumber(n)),
  },
  Ceil: {
    name: "Ceil",
    signature: "Ceil(number) → number",
    description: "Round up to nearest integer",
    fn: (n) => Math.ceil(toNumber(n)),
  },
};

/** Set of builtin names for fast lookup */
export const BUILTIN_NAMES: Set<string> = new Set(Object.keys(BUILTINS));

/** Check if a name is a builtin function (not a component) */
export function isBuiltin(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

/** Reserved statement-level call names — not builtins, not components */
export const RESERVED_CALLS = { Query: "Query", Mutation: "Mutation" } as const;

/** Check if a name is a reserved statement call (Query, Mutation) */
export function isReservedCall(name: string): boolean {
  return name in RESERVED_CALLS;
}

/** Re-export toNumber for evaluator compatibility */
export { toNumber };
