import React, { Fragment, useEffect } from "react";
import { OpenUIContext, useOpenUI, useRenderNode } from "./context";
import { useOpenUIState } from "./hooks/useOpenUIState";
import type { ComponentRenderer, Library } from "./library";
import type { ActionEvent, ElementNode, ParseResult } from "./parser/types";
import type { Transport } from "./runtime/queryManager";
import { ElementErrorBoundary, LoadingBar, ensureLoadingStyle } from "./shared/render-utils";

export interface RendererProps {
  /** Raw response text (openui-lang code). */
  response: string | null;
  /** Component library from createLibrary(). */
  library: Library;
  /** Whether the LLM is still streaming (form interactions disabled during streaming). */
  isStreaming?: boolean;
  /** Callback when a component triggers an action. */
  onAction?: (event: ActionEvent) => void;
  /**
   * Called whenever a form field value changes. Receives the raw form state map.
   * The consumer decides how to persist this (e.g. embed in message, store separately).
   */
  onStateUpdate?: (state: Record<string, unknown>) => void;
  /**
   * Initial form state to hydrate on load (e.g. from a previously persisted message).
   * Shape: { bindings?: {...}, forms?: { formName: { fieldName: { source, ... } } } }
   */
  initialState?: Record<string, unknown>;
  /** Called whenever the parse result changes. */
  onParseResult?: (result: ParseResult | null) => void;
  /** Transport for Query() data fetching — MCP, REST, GraphQL, or any backend. */
  transport?: Transport | null;
}

// ─── Internal rendering ───

/**
 * Recursively renders a parsed value (element, array, primitive)
 * into React nodes.
 */
function renderDeep(value: unknown): React.ReactNode {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    return value.map((v, i) => <Fragment key={i}>{renderDeep(v)}</Fragment>);
  }

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (obj.type === "element") {
      return <RenderNode node={obj as unknown as ElementNode} />;
    }
  }

  return null;
}

/**
 * Renders a single ElementNode.
 */
function RenderNode({ node }: { node: ElementNode }) {
  const { library } = useOpenUI();
  const Comp = library.components[node.typeName]?.component;

  if (!Comp) return null;

  return (
    <ElementErrorBoundary>
      <RenderNodeInner el={node} Comp={Comp} />
    </ElementErrorBoundary>
  );
}

/**
 * Renders a resolved element using its renderer.
 * Props are already evaluated by evaluate-tree — no AST awareness needed.
 */
function RenderNodeInner({ el, Comp }: { el: ElementNode; Comp: ComponentRenderer<any> }) {
  const renderNode = useRenderNode();
  return <Comp props={el.props} renderNode={renderNode} />;
}

// ─── Public component ───

export function Renderer({
  response,
  library,
  isStreaming = false,
  onAction,
  onStateUpdate,
  initialState,
  onParseResult,
  transport,
}: RendererProps) {
  ensureLoadingStyle();

  const { result, parseResult, contextValue, isQueryLoading } = useOpenUIState(
    {
      response,
      library,
      isStreaming,
      onAction,
      onStateUpdate,
      initialState,
      transport,
    },
    renderDeep,
  );

  // Fire onParseResult with the RAW parse result (not evaluated),
  // so hosts only see changes when the parser output actually changes.
  useEffect(() => {
    onParseResult?.(parseResult);
  }, [parseResult, onParseResult]);

  if (!result?.root) {
    return null;
  }

  return (
    <OpenUIContext.Provider value={contextValue}>
      <div style={{ position: "relative" }}>
        {isQueryLoading && <LoadingBar />}
        <div style={{ opacity: isQueryLoading ? 0.7 : 1, transition: "opacity 0.2s ease" }}>
          <RenderNode node={result.root} />
        </div>
      </div>
    </OpenUIContext.Provider>
  );
}
