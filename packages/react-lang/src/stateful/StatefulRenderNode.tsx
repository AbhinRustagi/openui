// ─────────────────────────────────────────────────────────────────────────────
// StatefulRenderNode — per-node component with individual subscription
// ─────────────────────────────────────────────────────────────────────────────

import React, { Fragment, memo, useCallback, useSyncExternalStore } from "react";
import { useOpenUI, useRenderNode } from "../context";
import type { ComponentRenderer } from "../library";
import { ElementErrorBoundary } from "../shared/render-utils";
import { isNodeRef } from "./types";
import { useNodeStore } from "./NodeStoreContext";

/**
 * Renders a single retained node. Subscribes to its specific node in the
 * NodeStore via useSyncExternalStore, so it only re-renders when its own
 * node's version changes.
 */
function StatefulRenderNodeInner({ id }: { id: string }) {
  const nodeStore = useNodeStore();
  const { library } = useOpenUI();

  const subscribeToNode = useCallback(
    (onStoreChange: () => void) => nodeStore.subscribe(id, onStoreChange),
    [nodeStore, id],
  );
  const getVersion = useCallback(
    () => nodeStore.getNodeVersion(id),
    [nodeStore, id],
  );

  // Subscribe to this specific node's version
  useSyncExternalStore(subscribeToNode, getVersion, getVersion);

  const node = nodeStore.getNode(id);
  if (!node?.element || !node.evaluatedProps) return null;

  const Comp = library.components[node.element.typeName]?.component;
  if (!Comp) return null;

  return (
    <ElementErrorBoundary>
      <StatefulRenderNodeContent
        comp={Comp}
        props={node.evaluatedProps}
      />
    </ElementErrorBoundary>
  );
}

/**
 * Inner content renderer — separated so ErrorBoundary can catch errors
 * from the component without unmounting the subscription.
 */
function StatefulRenderNodeContent({
  comp: Comp,
  props,
}: {
  comp: ComponentRenderer<any>;
  props: Record<string, unknown>;
}) {
  const renderNode = useStatefulRenderNode();
  return <Comp props={props} renderNode={renderNode} />;
}

/**
 * Custom renderNode function for the stateful renderer.
 * Detects NodeRef markers and renders them as independent StatefulRenderNodes.
 * Falls back to standard rendering for primitives, arrays, and inline elements.
 */
function useStatefulRenderNode(): (value: unknown) => React.ReactNode {
  const { library } = useOpenUI();
  const renderNode = useRenderNode();

  const render = useCallback(
    (value: unknown): React.ReactNode => {
      if (value == null) return null;
      if (typeof value === "string") return value;
      if (typeof value === "number") return String(value);
      if (typeof value === "boolean") return String(value);

      // NodeRef marker — render as independent subscription point
      if (isNodeRef(value)) {
        return <StatefulRenderNode key={value.id} id={value.id} />;
      }

      if (Array.isArray(value)) {
        return value.map((v, i) => (
          <Fragment key={isNodeRef(v) ? v.id : i}>{render(v)}</Fragment>
        ));
      }

      if (typeof value === "object" && value !== null) {
        const obj = value as Record<string, unknown>;
        if (obj.type === "element") {
          // Inline anonymous element — render directly (no subscription)
          const Comp = library.components[(obj as any).typeName]?.component;
          if (!Comp) return null;
          return (
            <ElementErrorBoundary>
              <Comp props={(obj as any).props} renderNode={render} />
            </ElementErrorBoundary>
          );
        }
      }

      return null;
    },
    [library, renderNode],
  );

  return render;
}

export const StatefulRenderNode = memo(StatefulRenderNodeInner);
