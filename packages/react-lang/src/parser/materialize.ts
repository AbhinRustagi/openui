// ─────────────────────────────────────────────────────────────────────────────
// Schema-aware materialization — single-pass lowering
// ─────────────────────────────────────────────────────────────────────────────

import type { ASTNode } from "./ast";
import { isASTNode, isRuntimeExpr } from "./ast";
import { isBuiltin, isReservedCall, RESERVED_CALLS } from "./builtins";
import { isElementNode, type ParamMap, type ValidationError } from "./types";

/**
 * Recursively check if a prop value contains any AST nodes that need runtime
 * evaluation. Walks into arrays, ElementNode children, and plain objects.
 */
export function containsDynamicValue(v: unknown): boolean {
  if (v == null || typeof v !== "object") return false;
  if (isASTNode(v)) return true;
  if (Array.isArray(v)) return v.some(containsDynamicValue);
  if (isElementNode(v)) {
    return Object.values(v.props).some(containsDynamicValue);
  }
  const obj = v as Record<string, unknown>;
  return Object.values(obj).some(containsDynamicValue);
}

export interface MaterializeCtx {
  syms: Map<string, ASTNode>;
  cat: ParamMap | undefined;
  errors: ValidationError[];
  unres: string[];
  visited: Set<string>;
  partial: boolean;
}

/**
 * Resolve a Ref node: inline from symbol table, detect cycles, emit RuntimeRef
 * for Query/Mutation declarations. Shared by materializeValue and materializeExpr.
 */
function resolveRef(name: string, ctx: MaterializeCtx, mode: "value" | "expr"): unknown | ASTNode {
  if (ctx.visited.has(name)) {
    ctx.unres.push(name);
    return mode === "expr" ? { k: "Ph", n: name } : null;
  }
  if (!ctx.syms.has(name)) {
    ctx.unres.push(name);
    return mode === "expr" ? { k: "Ph", n: name } : null;
  }
  const target = ctx.syms.get(name)!;
  // Query/Mutation declarations → RuntimeRef (resolved at runtime by evaluator)
  if (target.k === "Comp" && isReservedCall(target.name)) {
    const refType =
      target.name === RESERVED_CALLS.Mutation ? ("mutation" as const) : ("query" as const);
    return { k: "RuntimeRef", n: name, refType };
  }
  ctx.visited.add(name);
  const result = mode === "value" ? materializeValue(target, ctx) : materializeExpr(target, ctx);
  ctx.visited.delete(name);
  return result;
}

/**
 * Normalize an AST node for use inside runtime expressions.
 * Resolves Refs, adds mappedProps to catalog Comp nodes.
 * Returns ASTNode — structure preserved for runtime evaluation by the evaluator.
 */
export function materializeExpr(node: ASTNode, ctx: MaterializeCtx): ASTNode {
  switch (node.k) {
    case "Ref":
      return resolveRef(node.n, ctx, "expr") as ASTNode;

    case "Ph":
      return node;

    case "Comp": {
      const recursedArgs = node.args.map((a) => materializeExpr(a, ctx));
      // Builtins and reserved calls: recurse args, keep as-is
      if (isBuiltin(node.name) || isReservedCall(node.name)) {
        return { ...node, args: recursedArgs };
      }
      // Catalog component: add mappedProps for the evaluator
      const def = ctx.cat?.get(node.name);
      if (def) {
        const mappedProps: Record<string, ASTNode> = {};
        for (let i = 0; i < def.params.length && i < recursedArgs.length; i++) {
          mappedProps[def.params[i].name] = recursedArgs[i];
        }
        return { ...node, args: recursedArgs, mappedProps };
      }
      // Unknown component: recurse args
      return { ...node, args: recursedArgs };
    }

    case "Arr":
      return { ...node, els: node.els.map((e) => materializeExpr(e, ctx)) };
    case "Obj":
      return {
        ...node,
        entries: node.entries.map(([k, v]) => [k, materializeExpr(v, ctx)] as [string, ASTNode]),
      };
    case "BinOp":
      return {
        ...node,
        left: materializeExpr(node.left, ctx),
        right: materializeExpr(node.right, ctx),
      };
    case "UnaryOp":
      return { ...node, operand: materializeExpr(node.operand, ctx) };
    case "Ternary":
      return {
        ...node,
        cond: materializeExpr(node.cond, ctx),
        then: materializeExpr(node.then, ctx),
        else: materializeExpr(node.else, ctx),
      };
    case "Member":
      return { ...node, obj: materializeExpr(node.obj, ctx) };
    case "Index":
      return {
        ...node,
        obj: materializeExpr(node.obj, ctx),
        index: materializeExpr(node.index, ctx),
      };
    case "Assign":
      return { ...node, value: materializeExpr(node.value, ctx) };

    // Literals, StateRef, RuntimeRef — pass through unchanged
    default:
      return node;
  }
}

/**
 * Schema-aware materialization: resolves refs, normalizes catalog component args
 * to named props, validates required props, applies defaults, converts literals
 * to plain values, and preserves runtime expressions as AST nodes — all in a
 * single recursive traversal.
 *
 * Returns:
 *   - ElementNode for catalog/unknown components
 *   - ASTNode for builtins and runtime expression nodes
 *   - Plain values for literals, arrays, objects
 *   - null for placeholders
 */
export function materializeValue(node: ASTNode, ctx: MaterializeCtx): unknown {
  switch (node.k) {
    // ── Ref resolution ───────────────────────────────────────────────────
    case "Ref":
      return resolveRef(node.n, ctx, "value");

    // ── Literals → plain values ──────────────────────────────────────────
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

    // ── Collections ──────────────────────────────────────────────────────
    case "Arr": {
      const items: unknown[] = [];
      for (const e of node.els) {
        if (e.k === "Ph") continue;
        items.push(materializeValue(e, ctx));
      }
      return items;
    }
    case "Obj": {
      const o: Record<string, unknown> = {};
      for (const [k, v] of node.entries) o[k] = materializeValue(v, ctx);
      return o;
    }

    // ── Component nodes ──────────────────────────────────────────────────
    case "Comp": {
      const { name, args } = node;

      // Builtins (Sum, Count, Filter, etc.) → preserve as ASTNode for runtime
      if (isBuiltin(name) || isReservedCall(name)) {
        return { ...node, args: args.map((a) => materializeExpr(a, ctx)) };
      }

      const def = ctx.cat?.get(name);
      const props: Record<string, unknown> = {};

      if (def) {
        // Catalog component: map positional args → named props
        for (let i = 0; i < def.params.length && i < args.length; i++) {
          props[def.params[i].name] = materializeValue(args[i], ctx);
        }

        // Validate required props — try defaultValue first before dropping
        const missingRequired = def.params.filter(
          (p) => p.required && (!(p.name in props) || props[p.name] === null),
        );
        if (missingRequired.length) {
          const stillInvalid = missingRequired.filter((p) => {
            if (p.defaultValue !== undefined) {
              props[p.name] = p.defaultValue;
              return false;
            }
            return true;
          });
          if (stillInvalid.length) {
            for (const p of stillInvalid) {
              ctx.errors.push({
                component: name,
                path: `/${p.name}`,
                message:
                  p.name in props
                    ? `required field "${p.name}" cannot be null`
                    : `missing required field "${p.name}"`,
              });
            }
            return null;
          }
        }
      } else {
        // Unknown component: preserve all args under _args
        props._args = args.map((a) => materializeValue(a, ctx));
      }

      const hasDynamicProps = Object.values(props).some((v) => containsDynamicValue(v));
      return { type: "element", typeName: name, props, partial: ctx.partial, hasDynamicProps };
    }

    // ── Runtime expression nodes → preserve as ASTNode, normalize children ─
    default: {
      if (isRuntimeExpr(node)) {
        return materializeExpr(node, ctx);
      }
      // Unreachable for well-formed AST, but preserve the value defensively.
      return node;
    }
  }
}
