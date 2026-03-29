import type { ASTNode, Statement } from "./ast";
import { isASTNode } from "./ast";
import { RESERVED_CALLS } from "./builtins";
import { parseExpression } from "./expressions";
import { tokenize } from "./lexer";
import { materializeValue, type MaterializeCtx } from "./materialize";
import { autoClose, split, type RawStmt } from "./statements";
import { T } from "./tokens";
import {
  isElementNode,
  type LibraryJSONSchema,
  type MutationStatementInfo,
  type ParamMap,
  type ParseResult,
  type QueryStatementInfo,
  type ValidationError,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Result building
// ─────────────────────────────────────────────────────────────────────────────

function emptyResult(incomplete = true): ParseResult {
  return {
    root: null,
    meta: {
      incomplete,
      unresolved: [],
      statementCount: 0,
      validationErrors: [],
    },
  };
}

/**
 * Walk an AST node to collect all StateRef ($variable) names referenced
 * within. Used at parse time to pre-compute per-query state dependencies.
 */
export function collectQueryDeps(node: unknown): string[] {
  if (!isASTNode(node)) return [];
  const refs: string[] = [];
  const walk = (n: unknown) => {
    if (!isASTNode(n)) return;
    if (n.k === "StateRef") {
      refs.push(n.n);
      return;
    }
    if (n.k === "BinOp") {
      walk(n.left);
      walk(n.right);
    }
    if (n.k === "UnaryOp") {
      walk(n.operand);
    }
    if (n.k === "Ternary") {
      walk(n.cond);
      walk(n.then);
      walk(n.else);
    }
    if (n.k === "Member") {
      walk(n.obj);
    }
    if (n.k === "Index") {
      walk(n.obj);
      walk(n.index);
    }
    if (n.k === "Comp") {
      n.args.forEach(walk);
    }
    if (n.k === "Arr") {
      n.els.forEach(walk);
    }
    if (n.k === "Obj") {
      n.entries.forEach(([_, v]: [string, unknown]) => walk(v));
    }
    if (n.k === "Assign") {
      walk(n.value);
    }
  };
  walk(node);
  return [...new Set(refs)];
}

/**
 * Classify a raw statement + parsed expression into a typed Statement.
 * Determined at parse time from token type + expression shape.
 */
export function classifyStatement(raw: RawStmt, expr: ASTNode): Statement {
  // Query(...) → query declaration — check BEFORE $var to handle `$foo = Query(...)` correctly
  if (expr.k === "Comp" && expr.name === RESERVED_CALLS.Query) {
    const deps = collectQueryDeps(expr.args[1]);
    return {
      kind: "query",
      id: raw.id,
      call: { callee: RESERVED_CALLS.Query, args: expr.args },
      deps: deps.length > 0 ? deps : undefined,
    };
  }
  // Mutation(...) → mutation declaration
  if (expr.k === "Comp" && expr.name === RESERVED_CALLS.Mutation) {
    return {
      kind: "mutation",
      id: raw.id,
      call: { callee: RESERVED_CALLS.Mutation, args: expr.args },
    };
  }
  // $variables → state declaration
  if (raw.idTokenType === T.StateVar) {
    return { kind: "state", id: raw.id, init: expr };
  }
  // Everything else → value declaration
  return { kind: "value", id: raw.id, expr };
}

/** Build a symbol table (Map<id, ASTNode>) from typed statements for materializeValue. */
export function buildSymbolTable(stmtMap: Map<string, Statement>): Map<string, ASTNode> {
  const m = new Map<string, ASTNode>();
  for (const [id, stmt] of stmtMap) {
    switch (stmt.kind) {
      case "value":
        m.set(id, stmt.expr);
        break;
      case "state":
        m.set(id, stmt.init);
        break;
      case "query":
        m.set(id, { k: "Comp", name: stmt.call.callee, args: stmt.call.args });
        break;
      case "mutation":
        m.set(id, { k: "Comp", name: stmt.call.callee, args: stmt.call.args });
        break;
    }
  }
  return m;
}

/**
 * Extract typed statements from the symbol table.
 * State defaults are materialized to plain values (no raw AST in output).
 */
export function extractStatements(
  stmts: Statement[],
  ctx: MaterializeCtx,
): {
  stateDeclarations: Record<string, unknown>;
  queryStatements: QueryStatementInfo[];
  mutationStatements: MutationStatementInfo[];
} {
  const stateDeclarations: Record<string, unknown> = {};
  const queryStatements: QueryStatementInfo[] = [];
  const mutationStatements: MutationStatementInfo[] = [];

  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "state":
        // Materialize state init to plain value (scalar defaults only in practice)
        stateDeclarations[stmt.id] = materializeValue(stmt.init, ctx);
        break;
      case "query":
        queryStatements.push({
          statementId: stmt.id,
          toolAST: stmt.call.args[0] ?? null,
          argsAST: stmt.call.args[1] ?? null,
          defaultsAST: stmt.call.args[2] ?? null,
          refreshAST: stmt.call.args[3] ?? null,
          deps: stmt.deps,
          complete: true,
        });
        break;
      case "mutation":
        mutationStatements.push({
          statementId: stmt.id,
          toolAST: stmt.call.args[0] ?? null,
          argsAST: stmt.call.args[1] ?? null,
        });
        break;
    }
  }

  return { stateDeclarations, queryStatements, mutationStatements };
}

function buildResult(
  stmtMap: Map<string, Statement>,
  typedStmts: Statement[],
  firstId: string,
  wasIncomplete: boolean,
  stmtCount: number,
  cat: ParamMap | undefined,
): ParseResult {
  if (!stmtMap.has(firstId)) return emptyResult(wasIncomplete);

  const syms = buildSymbolTable(stmtMap);
  const unres: string[] = [];
  const errors: ValidationError[] = [];
  const ctx: MaterializeCtx = {
    syms,
    cat,
    errors,
    unres,
    visited: new Set(),
    partial: wasIncomplete,
  };
  const materialized = materializeValue(syms.get(firstId)!, ctx);

  const root = isElementNode(materialized) ? materialized : null;

  const { stateDeclarations, queryStatements, mutationStatements } = extractStatements(
    typedStmts,
    ctx,
  );

  const qs = queryStatements.length > 0 ? queryStatements : undefined;
  const ms = mutationStatements.length > 0 ? mutationStatements : undefined;

  return {
    root,
    meta: {
      incomplete: wasIncomplete,
      unresolved: unres,
      statementCount: stmtCount,
      validationErrors: errors,
    },
    stateDeclarations: Object.keys(stateDeclarations).length > 0 ? stateDeclarations : undefined,
    queryStatements: qs,
    mutationStatements: ms,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a complete openui-lang string in one pass.
 *
 * @param input  - Full openui-lang source text (may be partial/streaming)
 * @param cat    - Optional param map for positional-arg → named-prop mapping
 * @returns      ParseResult with root ElementNode (or null) and metadata
 */
export function parse(input: string, cat?: ParamMap): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return emptyResult();

  const { text, wasIncomplete } = autoClose(trimmed);
  const stmts = split(tokenize(text));
  if (!stmts.length) return emptyResult(wasIncomplete);

  const stmtMap = new Map<string, Statement>();
  let firstId = "";
  for (const s of stmts) {
    const expr = parseExpression(s.tokens);
    const stmt = classifyStatement(s, expr);
    stmtMap.set(s.id, stmt);
    if (!firstId) firstId = s.id;
  }
  // Derive from map to deduplicate — Map.set overwrites duplicates
  const typedStmts = [...stmtMap.values()];

  return buildResult(stmtMap, typedStmts, firstId, wasIncomplete, stmts.length, cat);
}

export interface StreamParser {
  /** Feed the next SSE/stream chunk and get the latest ParseResult. */
  push(chunk: string): ParseResult;
  /** Get the latest ParseResult without consuming new data. */
  getResult(): ParseResult;
}

export function createStreamParser(cat?: ParamMap): StreamParser {
  let buf = "";
  let completedEnd = 0;
  const completedStmtMap = new Map<string, Statement>();

  let completedCount = 0;
  let firstId = "";

  function addStmt(text: string) {
    for (const s of split(tokenize(text))) {
      const expr = parseExpression(s.tokens);
      const stmt = classifyStatement(s, expr);
      completedStmtMap.set(s.id, stmt);
      completedCount++;
      if (!firstId) firstId = s.id;
    }
  }

  function scanNewCompleted(): number {
    let depth = 0,
      inStr = false,
      esc = false;
    let stmtStart = completedEnd;

    for (let i = completedEnd; i < buf.length; i++) {
      const c = buf[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\" && inStr) {
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;

      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "\n" && depth <= 0) {
        // Depth-0 newline = end of a statement
        const t = buf.slice(stmtStart, i).trim();
        if (t) addStmt(t);
        stmtStart = i + 1; // next statement begins after this newline
        completedEnd = i + 1; // advance the "already processed" watermark
      }
    }

    return stmtStart; // start of the current pending (incomplete) statement
  }

  function currentResult(): ParseResult {
    const pendingStart = scanNewCompleted();
    const pendingText = buf.slice(pendingStart).trim();

    // No pending text — all statements are complete
    if (!pendingText) {
      if (completedCount === 0) return emptyResult();
      return buildResult(
        completedStmtMap,
        [...completedStmtMap.values()],
        firstId,
        false,
        completedCount,
        cat,
      );
    }

    // Autoclose the incomplete last statement so it's syntactically valid
    const { text: closed, wasIncomplete } = autoClose(pendingText);
    const stmts = split(tokenize(closed));

    if (!stmts.length) {
      if (completedCount === 0) return emptyResult(wasIncomplete);
      return buildResult(
        completedStmtMap,
        [...completedStmtMap.values()],
        firstId,
        wasIncomplete,
        completedCount,
        cat,
      );
    }

    // Merge: completed cache + re-parsed pending statement
    const allStmtMap = new Map(completedStmtMap);
    for (const s of stmts) {
      const expr = parseExpression(s.tokens);
      const stmt = classifyStatement(s, expr);
      allStmtMap.set(s.id, stmt);
    }
    // Derive from map to deduplicate
    const allTypedStmts = [...allStmtMap.values()];

    const fid = firstId || stmts[0].id;
    return buildResult(
      allStmtMap,
      allTypedStmts,
      fid,
      wasIncomplete,
      completedCount + stmts.length,
      cat,
    );
  }

  return {
    push(chunk) {
      buf += chunk;
      return currentResult();
    },
    getResult: currentResult,
  };
}

export interface Parser {
  parse(input: string): ParseResult;
}

function getSchemaDefaultValue(property: unknown): unknown {
  if (!property || typeof property !== "object" || Array.isArray(property)) {
    return undefined;
  }
  return (property as { default?: unknown }).default;
}

export function compileSchema(schema: LibraryJSONSchema): ParamMap {
  const map: ParamMap = new Map();
  const defs = schema.$defs ?? {};

  for (const [name, def] of Object.entries(defs)) {
    const properties = def.properties ?? {};
    const required = def.required ?? [];
    const params = Object.keys(properties).map((key) => ({
      name: key,
      required: required.includes(key),
      defaultValue: getSchemaDefaultValue(properties[key]),
    }));
    map.set(name, { params });
  }

  return map;
}

/**
 * Create a parser from a library JSON Schema document.
 * Pass `library.toJSONSchema()` to get the schema.
 *
 * @example
 * ```ts
 * const parser = createParser(library.toJSONSchema());
 * const result = parser.parse(openuiLangString);
 * ```
 */
export function createParser(schema: LibraryJSONSchema): Parser {
  const paramMap = compileSchema(schema);
  return {
    parse(input: string): ParseResult {
      return parse(input, paramMap);
    },
  };
}

/**
 * Create a streaming parser from a library JSON Schema document.
 * Pass `library.toJSONSchema()` to get the schema.
 */
export function createStreamingParser(schema: LibraryJSONSchema): StreamParser {
  return createStreamParser(compileSchema(schema));
}
