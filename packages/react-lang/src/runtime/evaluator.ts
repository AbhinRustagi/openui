// ─────────────────────────────────────────────────────────────────────────────
// AST evaluator — resolves AST nodes to runtime values.
// Framework-agnostic. No React imports.
// ─────────────────────────────────────────────────────────────────────────────

import type { ASTNode } from "../parser/ast";
import { BUILTINS, toNumber } from "../parser/builtins";

export interface EvaluationContext {
  /** Read $variable from the store */
  getState(name: string): unknown;
  /** Resolve a reference to another declaration's evaluated value */
  resolveRef(name: string): unknown;
  /** Extra scope for $value injection during reactive prop evaluation */
  extraScope?: Record<string, unknown>;
}

export interface ReactiveAssign {
  __reactive: "assign";
  target: string;
  expr: ASTNode;
}

export function isReactiveAssign(value: unknown): value is ReactiveAssign {
  return typeof value === "object" && value !== null && (value as any).__reactive === "assign";
}

/**
 * Evaluate an AST node to a runtime value.
 */
export function evaluate(node: ASTNode, context: EvaluationContext): unknown {
  switch (node.k) {
    // ── Literals ──────────────────────────────────────────────────────────
    case "Str":
      return node.v;
    case "Num":
      return node.v;
    case "Bool":
      return node.v;
    case "Null":
      return null;
    case "Ph":
      return null;

    // ── State references ──────────────────────────────────────────────────
    case "StateRef":
      return context.extraScope?.[node.n] ?? context.getState(node.n);

    // ── References ────────────────────────────────────────────────────────
    case "Ref":
      return context.resolveRef(node.n);
    case "RuntimeRef":
      return context.resolveRef(node.n);

    // ── Collections ───────────────────────────────────────────────────────
    case "Arr":
      return node.els.map((el) => evaluate(el, context));
    case "Obj":
      return Object.fromEntries(node.entries.map(([k, v]) => [k, evaluate(v, context)]));

    // ── Component ─────────────────────────────────────────────────────────
    case "Comp": {
      // Check shared builtin registry first
      const builtin = BUILTINS[node.name];
      if (builtin) {
        const args = node.args.map((a) => evaluate(a, context));
        return builtin.fn(...args);
      }
      // If parser already mapped args→props (via materializeExpr), use named props
      if (node.mappedProps) {
        const props: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(node.mappedProps)) {
          props[key] = evaluate(val, context);
        }
        return { type: "element", typeName: node.name, props, partial: false };
      }
      // After materializeValue, all catalog/unknown components are lowered to
      // ElementNode at parse time. Only builtins and mappedProps Comp nodes
      // reach here. If we somehow get an unmapped Comp, warn and return null.
      console.warn(`[openui] Unexpected unmapped Comp node: ${node.name}`);
      return null;
    }

    // ── Binary operators ──────────────────────────────────────────────────
    case "BinOp": {
      // Short-circuit operators evaluate lazily
      if (node.op === "&&") {
        const left = evaluate(node.left, context);
        return left ? evaluate(node.right, context) : left;
      }
      if (node.op === "||") {
        const left = evaluate(node.left, context);
        return left ? left : evaluate(node.right, context);
      }

      const left = evaluate(node.left, context);
      const right = evaluate(node.right, context);

      switch (node.op) {
        case "+":
          if (typeof left === "string" || typeof right === "string") {
            return String(left) + String(right);
          }
          return toNumber(left) + toNumber(right);
        case "-":
          return toNumber(left) - toNumber(right);
        case "*":
          return toNumber(left) * toNumber(right);
        case "/":
          return toNumber(right) === 0 ? 0 : toNumber(left) / toNumber(right);
        case "%":
          return toNumber(right) === 0 ? 0 : toNumber(left) % toNumber(right);
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case ">":
          return toNumber(left) > toNumber(right);
        case "<":
          return toNumber(left) < toNumber(right);
        case ">=":
          return toNumber(left) >= toNumber(right);
        case "<=":
          return toNumber(left) <= toNumber(right);
        default:
          return null;
      }
    }

    // ── Unary operators ───────────────────────────────────────────────────
    case "UnaryOp":
      if (node.op === "!") {
        return !evaluate(node.operand, context);
      }
      if (node.op === "-") {
        return -toNumber(evaluate(node.operand, context));
      }
      return null;

    // ── Ternary ───────────────────────────────────────────────────────────
    case "Ternary": {
      const cond = evaluate(node.cond, context);
      return cond ? evaluate(node.then, context) : evaluate(node.else, context);
    }

    // ── Member access ─────────────────────────────────────────────────────
    case "Member": {
      const obj = evaluate(node.obj, context) as any;
      if (obj == null) return null;
      // Array pluck: if obj is an array, extract field from every element
      if (Array.isArray(obj)) {
        return obj.map((item: any) => item?.[node.field] ?? null);
      }
      return obj[node.field];
    }

    // ── Index access ──────────────────────────────────────────────────────
    case "Index": {
      const obj = evaluate(node.obj, context) as any;
      const idx = evaluate(node.index, context);
      if (obj == null || idx == null) return null;
      if (Array.isArray(obj)) {
        return obj[toNumber(idx)];
      }
      return obj[String(idx)];
    }

    // ── Assignment ────────────────────────────────────────────────────────
    case "Assign":
      return {
        __reactive: "assign" as const,
        target: node.target,
        expr: node.value,
      };
  }
}
