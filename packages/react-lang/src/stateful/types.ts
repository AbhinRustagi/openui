// ─────────────────────────────────────────────────────────────────────────────
// Types for the StatefulRenderer retained node system
// ─────────────────────────────────────────────────────────────────────────────

import type { ASTNode, Statement } from "../parser/ast";
import type { ElementNode } from "../parser/types";

/**
 * A single retained node in the NodeStore flat map.
 * Each node corresponds to one openui-lang statement and persists
 * across renders, enabling incremental updates.
 */
export interface RetainedNode {
  /** Statement ID — the stable identity key (e.g. "root", "sidebar", "$count"). */
  id: string;
  /** Statement classification, matching the parser's Statement union. */
  kind: Statement["kind"];
  /** Original source text of this statement (e.g. `root = Card([title, chart])`). */
  raw: string;
  /** Parsed AST node before materialization. */
  ast: ASTNode;
  /** Materialized element node for value statements that resolve to components. Null for state/query/mutation. */
  element: ElementNode | null;
  /**
   * Fully evaluated concrete props (after AST evaluation).
   * Null for non-element nodes or nodes not yet evaluated.
   */
  evaluatedProps: Record<string, unknown> | null;
  /**
   * Set of $variable names and query/mutation statement IDs that this node reads.
   * Computed during evaluation via DependencyTracker.
   * Used by applyStateDelta/applyQueryDelta to scope re-evaluation.
   */
  deps: Set<string>;
  /** Ordered list of child statement IDs referenced by this node's AST. */
  children: string[];
  /**
   * Monotonically increasing counter, bumped whenever evaluatedProps changes.
   * Used by useSyncExternalStore to trigger per-node re-renders.
   */
  version: number;
}

/**
 * Marker object embedded in evaluated props to indicate a child
 * that should be rendered as an independent StatefulRenderNode.
 * Replaces the inlined ElementNode in the current architecture.
 */
export interface NodeRef {
  __nodeRef: true;
  id: string;
}

export function isNodeRef(value: unknown): value is NodeRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__nodeRef === true &&
    typeof (value as Record<string, unknown>).id === "string"
  );
}

export function createNodeRef(id: string): NodeRef {
  return { __nodeRef: true, id };
}

/** Result returned from NodeStore.applyPatch(). */
export interface PatchResult {
  /** IDs of nodes that were added, modified, or removed. */
  changedIds: Set<string>;
  /** IDs of nodes that were deleted (subset of changedIds). */
  removedIds: Set<string>;
  /** IDs of newly created nodes (subset of changedIds). */
  addedIds: Set<string>;
}
