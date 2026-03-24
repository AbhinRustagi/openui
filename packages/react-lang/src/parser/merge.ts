// ─────────────────────────────────────────────────────────────────────────────
// Edit/Merge for openui-lang
// ─────────────────────────────────────────────────────────────────────────────

import type { ASTNode } from "./ast";
import { parseExpression } from "./expressions";
import { tokenize } from "./lexer";
import { split } from "./statements";

interface ParsedStatement {
  id: string;
  ast: ASTNode;
  raw: string;
}

/**
 * Parse an openui-lang program into individual named statements.
 */
function parseStatements(input: string): ParsedStatement[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const tokens = tokenize(trimmed);
  const rawStmts = split(tokens);
  const result: ParsedStatement[] = [];

  // Pre-build exact-match map: statement id → raw line text
  // Uses =(?!=) to avoid matching == as assignment
  const lines = trimmed.split("\n");
  const stmtLineMap = new Map<string, string>();
  for (const line of lines) {
    const match = line.trim().match(/^(\$?[a-zA-Z_]\w*)\s*=(?!=)/);
    if (match) stmtLineMap.set(match[1], line.trim());
  }

  for (const s of rawStmts) {
    const ast = parseExpression(s.tokens);
    const raw = stmtLineMap.get(s.id) ?? `${s.id} = ???`;
    result.push({ id: s.id, ast, raw });
  }

  return result;
}

/**
 * Strip lines that aren't valid openui-lang statements.
 * LLMs sometimes prepend explanatory text — remove it so the parser works.
 * A valid statement line matches: identifier = expression (or $identifier = expression)
 */
function stripNonStatements(input: string): string {
  const STMT_RE = /^\$?[a-zA-Z_][a-zA-Z0-9_]*\s*=/;
  return input
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed === "" || STMT_RE.test(trimmed);
    })
    .join("\n");
}

/**
 * Recursively collect all Ref names from an AST node.
 */
function collectRefs(node: ASTNode, out: Set<string>): void {
  switch (node.k) {
    case "Ref":
      out.add(node.n);
      break;
    case "Comp":
      for (const a of node.args) collectRefs(a, out);
      break;
    case "Arr":
      for (const e of node.els) collectRefs(e, out);
      break;
    case "Obj":
      for (const [, v] of node.entries) collectRefs(v, out);
      break;
    case "BinOp":
      collectRefs(node.left, out);
      collectRefs(node.right, out);
      break;
    case "UnaryOp":
      collectRefs(node.operand, out);
      break;
    case "Ternary":
      collectRefs(node.cond, out);
      collectRefs(node.then, out);
      collectRefs(node.else, out);
      break;
    case "Member":
      collectRefs(node.obj, out);
      break;
    case "Index":
      collectRefs(node.obj, out);
      collectRefs(node.index, out);
      break;
    case "Assign":
      collectRefs(node.value, out);
      break;
    // Str, Num, Bool, Null, Ph, StateRef — no refs
  }
}

/**
 * Remove statements unreachable from `root` (garbage collection).
 * Walks the AST graph from root, collecting all referenced statement IDs.
 * $state variables are always kept (they're referenced at runtime, not by Ref nodes).
 */
function gcUnreachable(
  order: string[],
  merged: Map<string, string>,
  asts: Map<string, ASTNode>,
): void {
  const rootAst = asts.get("root");
  if (!rootAst) return; // no root → can't GC

  // BFS from root to find all reachable statements
  const reachable = new Set<string>(["root"]);
  const queue: string[] = ["root"];

  while (queue.length > 0) {
    const id = queue.pop()!;
    const ast = asts.get(id);
    if (!ast) continue;

    const refs = new Set<string>();
    collectRefs(ast, refs);

    for (const ref of refs) {
      if (!reachable.has(ref) && asts.has(ref)) {
        reachable.add(ref);
        queue.push(ref);
      }
    }
  }

  // Keep $state variables — they're bound at runtime, not via Ref
  for (const id of order) {
    if (id.startsWith("$")) reachable.add(id);
  }

  // Remove unreachable statements
  for (let i = order.length - 1; i >= 0; i--) {
    if (!reachable.has(order[i])) {
      merged.delete(order[i]);
      order.splice(i, 1);
    }
  }
}

/**
 * Merge an existing program with a patch (partial update).
 * Patch statements override existing ones by name.
 * Unreachable statements are automatically garbage-collected.
 * Returns the merged program as a string.
 */
export function mergeStatements(existing: string, patch: string): string {
  const existingStmts = parseStatements(existing);
  const patchStmts = parseStatements(stripNonStatements(patch));

  if (!existingStmts.length) return patch;
  if (!patchStmts.length) return existing;

  // Rewrite guard: if patch re-emits >80% of existing statements, warn
  const overlapCount = patchStmts.filter((p) => existingStmts.some((e) => e.id === p.id)).length;
  const overlapRatio = existingStmts.length > 0 ? overlapCount / existingStmts.length : 0;

  if (overlapRatio > 0.8 && patchStmts.length >= existingStmts.length * 0.8) {
    console.warn(
      `[openui merge] Patch re-emits ${Math.round(overlapRatio * 100)}% of existing statements — this looks like a full rewrite, not an edit.`,
    );
  }

  // Merge: patch statements override existing by name
  const merged = new Map<string, string>();
  const asts = new Map<string, ASTNode>();
  const order: string[] = [];

  for (const stmt of existingStmts) {
    merged.set(stmt.id, stmt.raw);
    asts.set(stmt.id, stmt.ast);
    order.push(stmt.id);
  }

  for (const stmt of patchStmts) {
    if (stmt.ast.k === "Null") {
      // `name = null` in a patch means "delete this statement"
      merged.delete(stmt.id);
      asts.delete(stmt.id);
      const idx = order.indexOf(stmt.id);
      if (idx !== -1) order.splice(idx, 1);
      continue;
    }
    if (!merged.has(stmt.id)) {
      order.push(stmt.id);
    }
    merged.set(stmt.id, stmt.raw);
    asts.set(stmt.id, stmt.ast);
  }

  // GC: remove statements unreachable from root
  gcUnreachable(order, merged, asts);

  return order
    .filter((id) => merged.has(id))
    .map((id) => merged.get(id)!)
    .join("\n");
}
