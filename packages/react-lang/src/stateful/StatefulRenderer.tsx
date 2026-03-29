// ─────────────────────────────────────────────────────────────────────────────
// StatefulRenderer — incremental rendering with retained node map
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useImperativeHandle, forwardRef } from "react";
import { OpenUIContext } from "../context";
import type { Library } from "../library";
import type { ActionEvent, ParseResult } from "../parser/types";
import type { Transport } from "../runtime/queryManager";
import { ensureLoadingStyle, LoadingBar } from "../shared/render-utils";
import type { NodeStore } from "./node-store";
import { NodeStoreContext } from "./NodeStoreContext";
import { StatefulRenderNode } from "./StatefulRenderNode";
import { useStatefulOpenUIState } from "./useStatefulOpenUIState";

export interface StatefulRendererProps {
  /** Full source string (for initial render or full replacement). */
  response?: string | null;
  /** Incremental patch string (for edit turns — applied on top of current state). */
  patch?: string | null;
  /** Component library from createLibrary(). */
  library: Library;
  /** Whether the LLM is still streaming. */
  isStreaming?: boolean;
  /** Callback when a component triggers an action. */
  onAction?: (event: ActionEvent) => void;
  /** Called whenever a form field value changes. */
  onStateUpdate?: (state: Record<string, unknown>) => void;
  /** Initial form state to hydrate on load. */
  initialState?: Record<string, unknown>;
  /** Called whenever the parse result changes. */
  onParseResult?: (result: ParseResult | null) => void;
  /** Transport for Query() data fetching. */
  transport?: Transport | null;
}

export interface StatefulRendererHandle {
  /** Apply an incremental patch imperatively. */
  applyPatch(patch: string): void;
  /** Get the current source text (for LLM context on next edit turn). */
  getSourceText(): string;
  /** Access the underlying NodeStore for advanced use cases. */
  getNodeStore(): NodeStore;

  // ── User mutations ──

  /** Reorder children of a parent node. */
  reorderChildren(parentId: string, newOrder: string[]): void;
  /** Remove a node and clean up orphaned descendants. */
  removeNode(nodeId: string): void;
  /** Move a node from one parent to another at a given index. */
  moveNode(nodeId: string, toParentId: string, index: number): void;
}

export const StatefulRenderer = forwardRef<StatefulRendererHandle, StatefulRendererProps>(
  function StatefulRenderer(
    {
      response,
      patch,
      library,
      isStreaming = false,
      onAction,
      onStateUpdate,
      initialState,
      onParseResult,
      transport,
    },
    ref,
  ) {
    ensureLoadingStyle();

    const renderDeep = useCallback(() => null, []);

    const { nodeStore, contextValue, isQueryLoading, parseResult, rootId } =
      useStatefulOpenUIState(
        {
          response,
          patch,
          library,
          isStreaming,
          onAction,
          onStateUpdate,
          initialState,
          transport,
        },
        renderDeep,
      );

    // Expose imperative handle
    useImperativeHandle(
      ref,
      () => ({
        applyPatch: (p: string) => nodeStore.applyPatch(p),
        getSourceText: () => nodeStore.getSourceText(),
        getNodeStore: () => nodeStore,
        reorderChildren: (parentId: string, newOrder: string[]) =>
          nodeStore.reorderChildren(parentId, newOrder),
        removeNode: (nodeId: string) => nodeStore.removeNode(nodeId),
        moveNode: (nodeId: string, toParentId: string, index: number) =>
          nodeStore.moveNode(nodeId, toParentId, index),
      }),
      [nodeStore],
    );

    // Fire onParseResult callback
    useEffect(() => {
      onParseResult?.(parseResult);
    }, [parseResult, onParseResult]);

    if (!rootId) return null;

    return (
      <NodeStoreContext.Provider value={nodeStore}>
        <OpenUIContext.Provider value={contextValue}>
          <div style={{ position: "relative" }}>
            {isQueryLoading && <LoadingBar />}
            <div
              style={{
                opacity: isQueryLoading ? 0.7 : 1,
                transition: "opacity 0.2s ease",
              }}
            >
              <StatefulRenderNode id={rootId} />
            </div>
          </div>
        </OpenUIContext.Provider>
      </NodeStoreContext.Provider>
    );
  },
);
