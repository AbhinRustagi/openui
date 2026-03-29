// ─────────────────────────────────────────────────────────────────────────────
// NodeStore — retained flat map with per-node subscriptions
// ─────────────────────────────────────────────────────────────────────────────
//
// Persists the parsed/evaluated state of each openui-lang statement across
// renders. Patches are applied incrementally, and only affected nodes are
// re-evaluated and notified.

import type { ASTNode, Statement } from "../parser/ast";
import { tokenize } from "../parser/lexer";
import {
  collectRefs,
  gcUnreachable,
  parseStatements,
  stripNonStatements,
} from "../parser/merge";
import { materializeValue, type MaterializeCtx } from "../parser/materialize";
import {
  buildSymbolTable,
  classifyStatement,
  extractStatements,
} from "../parser/parser";
import { autoClose, split } from "../parser/statements";
import { parseExpression } from "../parser/expressions";
import type { ElementNode, ParamMap, ParseResult, ValidationError } from "../parser/types";
import { isElementNode } from "../parser/types";
import { evaluateElementProps, type EvalContext } from "../runtime/evaluate-tree";
import type { EvaluationContext } from "../runtime/evaluator";
import { evaluate } from "../runtime/evaluator";
import type { Library } from "../library";
import type { Store } from "../runtime/store";
import type { QueryManager } from "../runtime/queryManager";
import { createTrackingContext } from "./dep-tracker";
import type { PatchResult, RetainedNode } from "./types";
import { createNodeRef, isNodeRef } from "./types";

// ─── NodeStore interface ────────────────────────────────────────────────────

export interface NodeStore {
  getNode(id: string): RetainedNode | null;
  getAllNodes(): Map<string, RetainedNode>;
  getRootId(): string | null;
  getOrder(): string[];

  /** Per-node subscription. Returns unsubscribe function. */
  subscribe(id: string, listener: () => void): () => void;
  /** Global subscription for structural changes (node add/remove). */
  subscribeStructure(listener: () => void): () => void;
  /** Primitive version number for useSyncExternalStore. */
  getNodeVersion(id: string): number;
  /** Global version that increments on any structural change. */
  getStructureVersion(): number;

  /** Full parse and populate from a complete source string. */
  applyFullSource(source: string): void;
  /** Incremental patch application. Returns which nodes changed. */
  applyPatch(patch: string): PatchResult;
  /**
   * Re-evaluate nodes whose deps overlap with changedKeys.
   * Returns the set of node IDs that actually changed.
   */
  applyStateDelta(changedKeys: Set<string>): Set<string>;
  /** Same as applyStateDelta but for query/mutation result changes. */
  applyQueryDelta(changedQueryIds: Set<string>): Set<string>;

  /** Serialize the flat map back to openui-lang source text. */
  getSourceText(): string;
  /** Extract ParseResult metadata (stateDeclarations, queryStatements, etc.) */
  getParseResult(): ParseResult | null;

  // ── User mutations (direct tree manipulation, no parsing) ──

  /**
   * Reorder the children of a parent node.
   * `newOrder` is the full ordered list of child IDs — must be a permutation
   * of the parent's current children.
   */
  reorderChildren(parentId: string, newOrder: string[]): void;
  /**
   * Remove a node and clean up any orphaned descendants.
   * Also removes the node from its parent's children list.
   */
  removeNode(nodeId: string): void;
  /**
   * Move a node from one parent to another at a given index.
   * Removes from the source parent's children and inserts into the target's.
   */
  moveNode(nodeId: string, toParentId: string, index: number): void;

  dispose(): void;
}

export interface NodeStoreOptions {
  library: Library;
  store: Store;
  queryManager: QueryManager;
  catalog: ParamMap | undefined;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createNodeStore(options: NodeStoreOptions): NodeStore {
  const { library, store, queryManager, catalog } = options;

  // Internal state
  const nodes = new Map<string, RetainedNode>();
  const order: string[] = [];
  let rootId: string | null = null;

  // Subscriptions
  const nodeListeners = new Map<string, Set<() => void>>();
  const structureListeners = new Set<() => void>();
  let structureVersion = 0;

  // Parsed metadata cache
  let cachedStatements: Statement[] = [];
  let cachedStmtMap = new Map<string, Statement>();

  // ── Notification helpers ──

  function notifyNode(id: string) {
    const listeners = nodeListeners.get(id);
    if (listeners) {
      for (const fn of [...listeners]) fn();
    }
  }

  function notifyStructure() {
    structureVersion++;
    for (const fn of [...structureListeners]) fn();
  }

  // ── Evaluation helpers ──

  function buildEvaluationContext(): EvaluationContext {
    return {
      getState: (name: string) => store.get(name),
      resolveRef: (name: string) => {
        const mutResult = queryManager.getMutationResult(name);
        if (mutResult) return mutResult;
        return queryManager.getResult(name);
      },
    };
  }

  function buildEvalContext(evalCtx: EvaluationContext): EvalContext {
    return { ctx: evalCtx, library, store };
  }

  /**
   * Evaluate a single node's element props and track deps.
   * Returns the new evaluatedProps and deps, or null if unchanged.
   */
  function evaluateNode(
    node: RetainedNode,
    evalCtx: EvaluationContext,
  ): { evaluatedProps: Record<string, unknown> | null; deps: Set<string> } {
    if (!node.element) {
      return { evaluatedProps: null, deps: new Set() };
    }

    const { context: trackingCtx, tracker } = createTrackingContext(evalCtx);
    const evalContext = buildEvalContext(trackingCtx);

    const evaluated = evaluateElementProps(node.element, evalContext);
    const deps = tracker.getDeps();

    // Build a lookup of child typeName → nodeId for this parent's children.
    // Used by injectNodeRefs to replace inlined ElementNodes with NodeRef markers
    // so children render as independent StatefulRenderNodes.
    const childTypeToId = buildChildLookup(node.children);
    const propsWithRefs = injectNodeRefs(evaluated.props, childTypeToId);

    return { evaluatedProps: propsWithRefs, deps };
  }

  /**
   * Build a map from (typeName, occurrence) to node ID for a set of child IDs.
   * Handles duplicate typeNames by tracking consumption order — children are
   * consumed in the same order they appear in the `children` array.
   */
  function buildChildLookup(childIds: string[]): Map<string, string[]> {
    const typeToIds = new Map<string, string[]>();
    for (const childId of childIds) {
      const child = nodes.get(childId);
      if (!child?.element) continue;
      const typeName = child.element.typeName;
      if (!typeToIds.has(typeName)) typeToIds.set(typeName, []);
      typeToIds.get(typeName)!.push(childId);
    }
    return typeToIds;
  }

  /**
   * Walk evaluated props and replace ElementNode values that correspond to
   * retained child nodes with NodeRef markers. Matches by typeName from the
   * parent's children, consuming in order to handle duplicate typeNames.
   */
  function injectNodeRefs(
    props: Record<string, unknown>,
    childTypeToId: Map<string, string[]>,
  ): Record<string, unknown> {
    // Track consumption indices per typeName for positional matching
    const consumed = new Map<string, number>();
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      result[key] = injectNodeRefsInValue(value, childTypeToId, consumed);
    }
    return result;
  }

  function injectNodeRefsInValue(
    value: unknown,
    childTypeToId: Map<string, string[]>,
    consumed: Map<string, number>,
  ): unknown {
    if (value == null || typeof value !== "object") return value;

    if (Array.isArray(value)) {
      return value.map((v) => injectNodeRefsInValue(v, childTypeToId, consumed));
    }

    // Check if this is an ElementNode that matches a retained child node
    if (isElementNode(value)) {
      const typeName = value.typeName;
      const candidates = childTypeToId.get(typeName);
      if (candidates && candidates.length > 0) {
        const idx = consumed.get(typeName) ?? 0;
        if (idx < candidates.length) {
          consumed.set(typeName, idx + 1);
          return createNodeRef(candidates[idx]);
        }
      }
      // Not a retained child — leave as inline element
      return value;
    }

    // NodeRef passthrough
    if (isNodeRef(value)) return value;

    // Recurse into plain objects
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    let changed = false;
    for (const [k, v] of Object.entries(obj)) {
      const newV = injectNodeRefsInValue(v, childTypeToId, consumed);
      result[k] = newV;
      if (newV !== v) changed = true;
    }
    return changed ? result : value;
  }

  // ── Structural equality for evaluated props ──

  function propsEqual(
    a: Record<string, unknown> | null,
    b: Record<string, unknown> | null,
  ): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    // JSON comparison handles nested arrays, objects, and NodeRef markers.
    // Same approach used by QueryManager for snapshot identity stability.
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // ── Core: populate from statements ──

  function populateFromStatements(
    stmts: Statement[],
    stmtMap: Map<string, Statement>,
    syms: Map<string, ASTNode>,
    wasIncomplete: boolean,
  ) {
    const evalCtx = buildEvaluationContext();
    const errors: ValidationError[] = [];
    const unresolved: string[] = [];

    // Materialize the root statement's element
    const firstId = stmts[0]?.id;
    if (!firstId) return;

    const matCtx: MaterializeCtx = {
      syms,
      cat: catalog,
      errors,
      unres: unresolved,
      visited: new Set(),
      partial: wasIncomplete,
    };

    // Materialize root to get the element tree
    const rootValue = materializeValue(syms.get(firstId)!, matCtx);
    const rootElement = isElementNode(rootValue) ? (rootValue as ElementNode) : null;

    // Build retained nodes from all statements
    for (const stmt of stmts) {
      const id = stmt.id;
      const raw = getRawForStatement(stmt);
      const ast = getAstForStatement(stmt);

      let element: ElementNode | null = null;
      if (id === firstId && rootElement) {
        element = rootElement;
      } else if (stmt.kind === "value") {
        // Materialize non-root value statements
        const val = materializeValue(ast, {
          ...matCtx,
          visited: new Set(),
        });
        element = isElementNode(val) ? (val as ElementNode) : null;
      }

      // Collect children via ref traversal
      const childRefs = new Set<string>();
      collectRefs(ast, childRefs);
      const children = [...childRefs].filter((ref) => stmtMap.has(ref));

      const existing = nodes.get(id);
      const node: RetainedNode = {
        id,
        kind: stmt.kind,
        raw,
        ast,
        element,
        evaluatedProps: null,
        deps: existing?.deps ?? new Set(),
        children,
        version: existing ? existing.version : 0,
      };

      // Evaluate props with dependency tracking
      if (element) {
        const { evaluatedProps, deps } = evaluateNode(node, evalCtx);
        node.evaluatedProps = evaluatedProps;
        node.deps = deps;
      }

      // Check if version should bump
      if (existing && propsEqual(existing.evaluatedProps, node.evaluatedProps)) {
        node.version = existing.version;
      } else {
        node.version = (existing?.version ?? 0) + 1;
      }

      nodes.set(id, node);
    }

    // Update order and root
    order.length = 0;
    for (const stmt of stmts) order.push(stmt.id);
    rootId = firstId;

    // Remove nodes no longer in the statement list
    const activeIds = new Set(order);
    for (const id of [...nodes.keys()]) {
      if (!activeIds.has(id)) nodes.delete(id);
    }

    cachedStatements = stmts;
    cachedStmtMap = stmtMap;
  }

  function getRawForStatement(stmt: Statement): string {
    switch (stmt.kind) {
      case "value":
        return `${stmt.id} = ???`;
      case "state":
        return `${stmt.id} = ???`;
      case "query":
        return `${stmt.id} = Query(...)`;
      case "mutation":
        return `${stmt.id} = Mutation(...)`;
    }
  }

  function getAstForStatement(stmt: Statement): ASTNode {
    switch (stmt.kind) {
      case "value":
        return stmt.expr;
      case "state":
        return stmt.init;
      case "query":
        return { k: "Comp", name: stmt.call.callee, args: stmt.call.args };
      case "mutation":
        return { k: "Comp", name: stmt.call.callee, args: stmt.call.args };
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function applyFullSource(source: string): void {
    if (!source?.trim()) {
      nodes.clear();
      order.length = 0;
      rootId = null;
      notifyStructure();
      return;
    }

    const { text, wasIncomplete } = autoClose(source);
    const tokens = tokenize(text);
    const rawStmts = split(tokens);

    if (!rawStmts.length) return;

    // Parse and classify
    const stmtMap = new Map<string, Statement>();
    const stmts: Statement[] = [];
    for (const raw of rawStmts) {
      const expr = parseExpression(raw.tokens);
      const stmt = classifyStatement(raw, expr);
      stmtMap.set(stmt.id, stmt);
      stmts.push(stmt);
    }

    const syms = buildSymbolTable(stmtMap);

    // Store raw text for each statement
    const lines = text.split("\n");
    const rawMap = new Map<string, string>();
    for (const line of lines) {
      const match = line.trim().match(/^(\$?[a-zA-Z_]\w*)\s*=(?!=)/);
      if (match) rawMap.set(match[1], line.trim());
    }

    // Snapshot old versions before repopulating
    const prevVersions = new Map<string, number>();
    for (const [id, node] of nodes) {
      prevVersions.set(id, node.version);
    }
    const prevNodeCount = nodes.size;

    populateFromStatements(stmts, stmtMap, syms, wasIncomplete);

    // Update raw text from source
    for (const [id, raw] of rawMap) {
      const node = nodes.get(id);
      if (node) node.raw = raw;
    }

    // Only notify nodes whose version actually changed
    for (const [id, node] of nodes) {
      const prevVersion = prevVersions.get(id);
      if (prevVersion === undefined || node.version !== prevVersion) {
        notifyNode(id);
      }
    }
    if (nodes.size !== prevNodeCount || order.length !== prevNodeCount) {
      notifyStructure();
    }
  }

  function applyPatch(patch: string): PatchResult {
    const changedIds = new Set<string>();
    const removedIds = new Set<string>();
    const addedIds = new Set<string>();

    const cleaned = stripNonStatements(patch);
    const patchStmts = parseStatements(cleaned);

    if (!patchStmts.length) return { changedIds, removedIds, addedIds };

    // Apply patch statements
    for (const patchStmt of patchStmts) {
      const { id, ast, raw } = patchStmt;

      if (ast.k === "Null") {
        // Deletion
        if (nodes.has(id)) {
          nodes.delete(id);
          const idx = order.indexOf(id);
          if (idx !== -1) order.splice(idx, 1);
          removedIds.add(id);
          changedIds.add(id);
        }
        continue;
      }

      const existing = nodes.get(id);
      if (existing && existing.raw === raw) {
        // Unchanged — skip
        continue;
      }

      if (!existing) {
        addedIds.add(id);
        order.push(id);
      }
      changedIds.add(id);

      // Parse and classify the patched statement
      const tokens = tokenize(raw);
      const rawStmts = split(tokens);
      if (!rawStmts.length) continue;

      const expr = parseExpression(rawStmts[0].tokens);
      const stmt = classifyStatement(rawStmts[0], expr);

      cachedStmtMap.set(id, stmt);

      // Rebuild symbol table for materialization
      const syms = buildSymbolTable(cachedStmtMap);
      const stmtAst = getAstForStatement(stmt);

      // Collect children
      const childRefs = new Set<string>();
      collectRefs(stmtAst, childRefs);
      const children = [...childRefs].filter((ref) => nodes.has(ref) || cachedStmtMap.has(ref));

      // Materialize if value statement
      let element: ElementNode | null = null;
      if (stmt.kind === "value") {
        const matCtx: MaterializeCtx = {
          syms,
          cat: catalog,
          errors: [],
          unres: [],
          visited: new Set(),
          partial: false,
        };
        const val = materializeValue(stmtAst, matCtx);
        element = isElementNode(val) ? (val as ElementNode) : null;
      }

      // Evaluate with dependency tracking
      const evalCtx = buildEvaluationContext();
      const node: RetainedNode = {
        id,
        kind: stmt.kind,
        raw,
        ast: stmtAst,
        element,
        evaluatedProps: null,
        deps: existing?.deps ?? new Set(),
        children,
        version: (existing?.version ?? 0) + 1,
      };

      if (element) {
        const { evaluatedProps, deps } = evaluateNode(node, evalCtx);
        node.evaluatedProps = evaluatedProps;
        node.deps = deps;
      }

      nodes.set(id, node);
    }

    // GC unreachable nodes
    if (nodes.has("root")) {
      const gcOrder = [...order];
      const gcMerged = new Map<string, string>();
      const gcAsts = new Map<string, ASTNode>();
      for (const id of gcOrder) {
        const node = nodes.get(id);
        if (node) {
          gcMerged.set(id, node.raw);
          gcAsts.set(id, node.ast);
        }
      }
      gcUnreachable(gcOrder, gcMerged, gcAsts);

      // Remove GC'd nodes
      const reachable = new Set(gcOrder);
      for (const id of [...nodes.keys()]) {
        if (!reachable.has(id)) {
          nodes.delete(id);
          removedIds.add(id);
          changedIds.add(id);
        }
      }
      order.length = 0;
      order.push(...gcOrder);
    }

    // Refresh children lists for all nodes — references to newly added nodes
    // may have been filtered out during earlier calls when those nodes didn't exist.
    for (const [id, node] of nodes) {
      const freshRefs = new Set<string>();
      collectRefs(node.ast, freshRefs);
      node.children = [...freshRefs].filter((ref) => nodes.has(ref));
    }

    // Re-evaluate parent nodes whose children changed.
    // Iterate until stable — a re-evaluated parent may itself be a child of another node.
    const evalCtx = buildEvaluationContext();
    const syms = buildSymbolTable(cachedStmtMap);
    let moreWork = true;
    while (moreWork) {
      moreWork = false;
      for (const [id, node] of nodes) {
        if (changedIds.has(id)) continue;
        const childChanged = node.children.some((childId) => changedIds.has(childId));
        if (childChanged && node.element) {
          const matCtx: MaterializeCtx = {
            syms,
            cat: catalog,
            errors: [],
            unres: [],
            visited: new Set(),
            partial: false,
          };
          const val = materializeValue(node.ast, matCtx);
          if (isElementNode(val)) {
            node.element = val as ElementNode;
            const { evaluatedProps, deps } = evaluateNode(node, evalCtx);
            if (!propsEqual(node.evaluatedProps, evaluatedProps)) {
              node.evaluatedProps = evaluatedProps;
              node.deps = deps;
              node.version++;
              changedIds.add(id);
              moreWork = true;
            }
          }
        }
      }
    }

    // Notify
    for (const id of changedIds) notifyNode(id);
    if (removedIds.size > 0 || addedIds.size > 0) notifyStructure();

    return { changedIds, removedIds, addedIds };
  }

  function applyStateDelta(changedKeys: Set<string>): Set<string> {
    return reEvaluateByDeps(changedKeys);
  }

  function applyQueryDelta(changedQueryIds: Set<string>): Set<string> {
    return reEvaluateByDeps(changedQueryIds);
  }

  function reEvaluateByDeps(changedKeys: Set<string>): Set<string> {
    const affected = new Set<string>();
    const evalCtx = buildEvaluationContext();

    for (const [id, node] of nodes) {
      if (!node.element || !node.evaluatedProps) continue;

      // Check dep overlap
      let hasOverlap = false;
      for (const dep of node.deps) {
        if (changedKeys.has(dep)) {
          hasOverlap = true;
          break;
        }
      }
      if (!hasOverlap) continue;

      const { evaluatedProps, deps } = evaluateNode(node, evalCtx);
      if (!propsEqual(node.evaluatedProps, evaluatedProps)) {
        node.evaluatedProps = evaluatedProps;
        node.deps = deps;
        node.version++;
        affected.add(id);
        notifyNode(id);
      }
    }

    return affected;
  }

  function getSourceText(): string {
    return order
      .filter((id) => nodes.has(id))
      .map((id) => nodes.get(id)!.raw)
      .join("\n");
  }

  function getParseResult(): ParseResult | null {
    if (!rootId || !nodes.has(rootId)) return null;

    const rootNode = nodes.get(rootId)!;
    const rootElement = rootNode.element;
    if (!rootElement) return null;

    // Extract state/query/mutation declarations from cached statements
    const matCtx: MaterializeCtx = {
      syms: buildSymbolTable(cachedStmtMap),
      cat: catalog,
      errors: [],
      unres: [],
      visited: new Set(),
      partial: false,
    };
    const { stateDeclarations, queryStatements, mutationStatements } = extractStatements(
      cachedStatements,
      matCtx,
    );

    return {
      root: rootElement,
      meta: {
        incomplete: false,
        unresolved: [],
        statementCount: order.length,
        validationErrors: [],
      },
      stateDeclarations,
      queryStatements,
      mutationStatements,
    };
  }

  // ── Subscription API ──

  function subscribe(id: string, listener: () => void): () => void {
    if (!nodeListeners.has(id)) nodeListeners.set(id, new Set());
    nodeListeners.get(id)!.add(listener);
    return () => {
      const set = nodeListeners.get(id);
      if (set) {
        set.delete(listener);
        if (set.size === 0) nodeListeners.delete(id);
      }
    };
  }

  function subscribeStructure(listener: () => void): () => void {
    structureListeners.add(listener);
    return () => structureListeners.delete(listener);
  }

  function getNodeVersion(id: string): number {
    return nodes.get(id)?.version ?? 0;
  }

  function getStructureVersion(): number {
    return structureVersion;
  }

  // ── User mutation helpers ──

  /**
   * Regenerate the `raw` source text for a node whose children changed.
   * Reconstructs the component call with the new child order.
   *
   * For a node like `root = Card([title, metrics, chart])`, reordering
   * to `[chart, title, metrics]` produces `root = Card([chart, title, metrics])`.
   */
  function regenerateRaw(node: RetainedNode): void {
    if (!node.element) return;

    // Reconstruct: `id = TypeName([child1, child2, ...])`
    // We look at the existing raw to preserve non-children args if possible.
    const childList = node.children.join(", ");
    // Simple reconstruction — assumes the first arg is the children array.
    // This works for Card, Stack, and similar container components.
    node.raw = `${node.id} = ${node.element.typeName}([${childList}])`;
  }

  /**
   * Re-evaluate a single node's props after a mutation and notify if changed.
   */
  function reEvaluateAndNotify(node: RetainedNode): void {
    if (!node.element) return;
    const evalCtx = buildEvaluationContext();
    const { evaluatedProps, deps } = evaluateNode(node, evalCtx);
    if (!propsEqual(node.evaluatedProps, evaluatedProps)) {
      node.evaluatedProps = evaluatedProps;
      node.deps = deps;
      node.version++;
      notifyNode(node.id);
    }
  }

  /**
   * Find which parent node(s) reference a given child ID.
   */
  function findParents(childId: string): RetainedNode[] {
    const parents: RetainedNode[] = [];
    for (const [, node] of nodes) {
      if (node.children.includes(childId)) parents.push(node);
    }
    return parents;
  }

  // ── User mutations ──

  function reorderChildren(parentId: string, newOrder: string[]): void {
    const parent = nodes.get(parentId);
    if (!parent) return;

    // Validate: newOrder must be a permutation of existing children
    const currentSet = new Set(parent.children);
    const newSet = new Set(newOrder);
    if (currentSet.size !== newSet.size) return;
    for (const id of newOrder) {
      if (!currentSet.has(id)) return;
    }

    parent.children = [...newOrder];
    regenerateRaw(parent);

    // Re-materialize and re-evaluate the parent with new child order
    const syms = buildSymbolTable(cachedStmtMap);
    // Rebuild AST to reflect new child order
    parent.ast = {
      k: "Comp",
      name: parent.element?.typeName ?? "Card",
      args: [{ k: "Arr", els: newOrder.map((id) => ({ k: "Ref" as const, n: id })) }],
    };

    const matCtx: MaterializeCtx = {
      syms: new Map([...syms, [parent.id, parent.ast]]),
      cat: catalog,
      errors: [],
      unres: [],
      visited: new Set(),
      partial: false,
    };
    const val = materializeValue(parent.ast, matCtx);
    if (isElementNode(val)) {
      parent.element = val as ElementNode;
    }

    reEvaluateAndNotify(parent);
  }

  function removeNode(nodeId: string): void {
    if (!nodes.has(nodeId)) return;

    // Remove from all parents' children lists
    const parents = findParents(nodeId);
    for (const parent of parents) {
      parent.children = parent.children.filter((id) => id !== nodeId);
      regenerateRaw(parent);
    }

    // Delete the node itself
    nodes.delete(nodeId);
    const idx = order.indexOf(nodeId);
    if (idx !== -1) order.splice(idx, 1);

    // GC orphaned descendants
    if (nodes.has("root")) {
      const gcOrder = [...order];
      const gcMerged = new Map<string, string>();
      const gcAsts = new Map<string, ASTNode>();
      for (const id of gcOrder) {
        const node = nodes.get(id);
        if (node) {
          gcMerged.set(id, node.raw);
          gcAsts.set(id, node.ast);
        }
      }
      gcUnreachable(gcOrder, gcMerged, gcAsts);

      const reachable = new Set(gcOrder);
      for (const id of [...nodes.keys()]) {
        if (!reachable.has(id)) nodes.delete(id);
      }
      order.length = 0;
      order.push(...gcOrder);
    }

    // Re-evaluate affected parents
    for (const parent of parents) {
      if (nodes.has(parent.id)) {
        const syms = buildSymbolTable(cachedStmtMap);
        parent.ast = {
          k: "Comp",
          name: parent.element?.typeName ?? "Card",
          args: [{ k: "Arr", els: parent.children.map((id) => ({ k: "Ref" as const, n: id })) }],
        };
        const matCtx: MaterializeCtx = {
          syms: new Map([...syms, [parent.id, parent.ast]]),
          cat: catalog,
          errors: [],
          unres: [],
          visited: new Set(),
          partial: false,
        };
        const val = materializeValue(parent.ast, matCtx);
        if (isElementNode(val)) parent.element = val as ElementNode;
        reEvaluateAndNotify(parent);
      }
    }

    notifyNode(nodeId);
    notifyStructure();
  }

  function moveNode(nodeId: string, toParentId: string, index: number): void {
    const node = nodes.get(nodeId);
    const toParent = nodes.get(toParentId);
    if (!node || !toParent) return;

    // Remove from all current parents
    const fromParents = findParents(nodeId);
    for (const parent of fromParents) {
      parent.children = parent.children.filter((id) => id !== nodeId);
      regenerateRaw(parent);
    }

    // Insert into target parent at the specified index
    const clampedIndex = Math.min(index, toParent.children.length);
    toParent.children.splice(clampedIndex, 0, nodeId);
    regenerateRaw(toParent);

    // Re-evaluate all affected parents
    const allAffected = new Set([...fromParents.map((p) => p.id), toParentId]);
    const syms = buildSymbolTable(cachedStmtMap);

    for (const parentId of allAffected) {
      const parent = nodes.get(parentId);
      if (!parent) continue;

      parent.ast = {
        k: "Comp",
        name: parent.element?.typeName ?? "Card",
        args: [{ k: "Arr", els: parent.children.map((id) => ({ k: "Ref" as const, n: id })) }],
      };
      const matCtx: MaterializeCtx = {
        syms: new Map([...syms, [parent.id, parent.ast]]),
        cat: catalog,
        errors: [],
        unres: [],
        visited: new Set(),
        partial: false,
      };
      const val = materializeValue(parent.ast, matCtx);
      if (isElementNode(val)) parent.element = val as ElementNode;
      reEvaluateAndNotify(parent);
    }

    notifyStructure();
  }

  function dispose() {
    nodes.clear();
    order.length = 0;
    rootId = null;
    nodeListeners.clear();
    structureListeners.clear();
    cachedStatements = [];
    cachedStmtMap = new Map();
  }

  return {
    getNode: (id) => nodes.get(id) ?? null,
    getAllNodes: () => new Map(nodes),
    getRootId: () => rootId,
    getOrder: () => [...order],
    subscribe,
    subscribeStructure,
    getNodeVersion,
    getStructureVersion,
    applyFullSource,
    applyPatch,
    applyStateDelta,
    applyQueryDelta,
    getSourceText,
    getParseResult,
    reorderChildren,
    removeNode,
    moveNode,
    dispose,
  };
}
