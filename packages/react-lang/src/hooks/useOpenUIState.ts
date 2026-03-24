import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { OpenUIContextValue } from "../context";
import type { Library } from "../library";
import { createParser } from "../parser/parser";
import type { ActionEvent, ParseResult } from "../parser/types";
import { BuiltinActionType } from "../parser/types";
import { evaluateElementProps, type EvalContext } from "../runtime/evaluate-tree";
import type { EvaluationContext } from "../runtime/evaluator";
import { evaluate } from "../runtime/evaluator";
import type { QueryManager, QuerySnapshot, Transport } from "../runtime/queryManager";
import { createQueryManager } from "../runtime/queryManager";
import type { Store } from "../runtime/store";
import { createStore } from "../runtime/store";

export interface UseOpenUIStateOptions {
  response: string | null;
  library: Library;
  isStreaming: boolean;
  onAction?: (event: ActionEvent) => void;
  onStateUpdate?: (state: Record<string, unknown>) => void;
  initialState?: Record<string, unknown>;
  /** Transport for Query data fetching — MCP, REST, GraphQL, or any backend. */
  transport?: Transport | null;
}

export interface OpenUIState {
  /** Evaluated result (props resolved to concrete values). Used by Renderer. */
  result: ParseResult | null;
  /** Raw parse result (AST nodes in props). Used by onParseResult callback. */
  parseResult: ParseResult | null;
  contextValue: OpenUIContextValue;
  /** Whether any Query is currently fetching data. */
  isQueryLoading: boolean;
}

/**
 * Core state hook — extracts all form state, action handling, parser
 * management, and context assembly out of the Renderer component.
 *
 * Store holds everything: $bindings as top-level keys, form fields nested
 * under formName as FieldSlot objects ({ source: "local"|"global", ... }).
 */
export function useOpenUIState(
  {
    response,
    library,
    isStreaming,
    onAction,
    onStateUpdate,
    initialState,
    transport,
  }: UseOpenUIStateOptions,
  renderDeep: (value: unknown) => React.ReactNode,
): OpenUIState {
  // ─── Parser ───
  const parser = useMemo(() => createParser(library.toJSONSchema()), [library]);

  // ─── Parse result ───
  const result = useMemo<ParseResult | null>(() => {
    if (!response) return null;
    try {
      return parser.parse(response);
    } catch (e) {
      console.error("[openui] Parse error:", e);
      return null;
    }
  }, [parser, response]);

  // ─── Store (holds everything: $bindings + form fields) ───
  const store = useMemo<Store>(() => createStore(), []);

  // ─── QueryManager ───
  const queryManager = useMemo<QueryManager>(
    () => createQueryManager(transport ?? null),
    [transport],
  );

  useEffect(() => {
    queryManager.activate();
    return () => queryManager.dispose();
  }, [queryManager]);

  // ─── Initialize Store ───
  const storeInitKeyRef = useRef<unknown>(Symbol());
  useEffect(() => {
    if (!result?.stateDeclarations) return;
    const key = `${JSON.stringify(result.stateDeclarations)}::${JSON.stringify(initialState?.bindings)}`;
    if (storeInitKeyRef.current === key) return;
    storeInitKeyRef.current = key;

    const persisted = (initialState?.bindings as Record<string, unknown> | undefined) ?? {};
    store.initialize(result.stateDeclarations, persisted);

    // Also restore persisted form field state
    if (initialState?.forms) {
      for (const [formName, fields] of Object.entries(
        initialState.forms as Record<string, unknown>,
      )) {
        store.set(formName, fields);
      }
    }
  }, [result?.stateDeclarations, store, initialState]);

  // ─── Subscribe to Store and QueryManager for re-renders ───
  const storeSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const querySnapshot = useSyncExternalStore(
    queryManager.subscribe,
    queryManager.getSnapshot,
    queryManager.getSnapshot,
  ) as QuerySnapshot;

  // ─── Build EvaluationContext ───
  const evaluationContext = useMemo<EvaluationContext>(
    () => ({
      getState: (name: string) => store.get(name),
      resolveRef: (name: string) => {
        const mutResult = queryManager.getMutationResult(name);
        if (mutResult) return mutResult;
        return queryManager.getResult(name);
      },
    }),
    [store, queryManager, storeSnapshot, querySnapshot],
  );

  // ─── Evaluate and submit queries ───
  useEffect(() => {
    if (isStreaming) return;
    if (!result?.queryStatements?.length) return;

    const evaluatedNodes = result.queryStatements.map((qn) => {
      const relevantDeps: Record<string, unknown> = {};
      if (qn.deps) {
        for (const ref of qn.deps) {
          relevantDeps[ref] = storeSnapshot[ref];
        }
      }
      return {
        statementId: qn.statementId,
        toolName: qn.toolAST ? (evaluate(qn.toolAST, evaluationContext) as string) : "",
        args: qn.argsAST ? evaluate(qn.argsAST, evaluationContext) : null,
        defaults: qn.defaultsAST ? evaluate(qn.defaultsAST, evaluationContext) : null,
        refreshInterval: qn.refreshAST
          ? (evaluate(qn.refreshAST, evaluationContext) as number)
          : undefined,
        deps: Object.keys(relevantDeps).length > 0 ? relevantDeps : undefined,
        complete: qn.complete,
      };
    });

    queryManager.evaluateQueries(evaluatedNodes);
  }, [isStreaming, result?.queryStatements, evaluationContext, queryManager, storeSnapshot]);

  // ─── Register mutations ───
  useEffect(() => {
    if (isStreaming) return;
    if (!result?.mutationStatements?.length) {
      queryManager.registerMutations([]);
      return;
    }
    const nodes = result.mutationStatements.map((mn) => ({
      statementId: mn.statementId,
      toolName: mn.toolAST ? (evaluate(mn.toolAST, evaluationContext) as string) : "",
    }));
    queryManager.registerMutations(nodes);
  }, [isStreaming, result?.mutationStatements, evaluationContext, queryManager]);

  // ─── Ref for stable callbacks ───
  const propsRef = useRef({ onAction, onStateUpdate });
  propsRef.current = { onAction, onStateUpdate };

  // ─── Fire onStateUpdate when Store changes ───
  const lastInitSnapshotRef = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    lastInitSnapshotRef.current = store.getSnapshot();
    const unsub = store.subscribe(() => {
      const currentSnapshot = store.getSnapshot();
      if (currentSnapshot === lastInitSnapshotRef.current) return;
      lastInitSnapshotRef.current = null;
      propsRef.current.onStateUpdate?.(currentSnapshot);
    });
    return unsub;
  }, [store]);

  // ─── getFieldValue ───
  // Reads from Store: global ($binding) → top-level key, form field → nested under formName
  const getFieldValue = useCallback(
    (formName: string | undefined, name: string) => {
      if (!formName) {
        // Outside form → read from Store top-level
        return store.get(name);
      }
      const formData = store.get(formName);
      if (!formData || typeof formData !== "object" || Array.isArray(formData)) {
        return undefined;
      }
      const slot = (formData as Record<string, unknown>)[name];
      if (slot && typeof slot === "object" && !Array.isArray(slot)) {
        const record = slot as Record<string, unknown>;
        if (record.source === "global" && typeof record.key === "string") {
          return store.get(record.key);
        }
        if (record.source === "local") {
          return record.value;
        }
      }
      return slot;
    },
    [store],
  );

  // ─── setFieldValue ───
  // Writes to Store: global → Store top-level, local → nested form object
  const setFieldValue = useCallback(
    (formName: string | undefined, name: string, value: unknown) => {
      if (!formName) {
        // Outside form → write to Store top-level
        store.set(name, value);
        return;
      }
      const rawFormData = store.get(formName);
      const formData =
        rawFormData && typeof rawFormData === "object" && !Array.isArray(rawFormData)
          ? (rawFormData as Record<string, unknown>)
          : {};
      const slot = formData[name];
      if (slot && typeof slot === "object" && !Array.isArray(slot)) {
        const record = slot as Record<string, unknown>;
        if (record.source === "global" && typeof record.key === "string") {
          store.set(record.key, value);
          return;
        }
      }
      store.set(formName, {
        ...formData,
        [name]: { source: "local", value },
      });
    },
    [store],
  );

  // ─── triggerAction ───
  const triggerAction = useCallback(
    (
      userMessage: string,
      formName?: string,
      action?: { type?: string; params?: Record<string, unknown> },
    ) => {
      const actionType = action?.type || BuiltinActionType.ContinueConversation;

      if (actionType === BuiltinActionType.Refresh || userMessage === BuiltinActionType.Refresh) {
        const targets = action?.params?.targets ?? action?.params?.deps;
        queryManager.invalidate(Array.isArray(targets) ? targets : undefined);
        return;
      }

      if (actionType === BuiltinActionType.Mutation) {
        const target = action?.params?.target as string | undefined;
        if (!target) return;
        const mn = result?.mutationStatements?.find((m) => m.statementId === target);
        const evaluatedArgs = mn?.argsAST
          ? (evaluate(mn.argsAST, evaluationContext) as Record<string, unknown>)
          : {};
        const refreshDeps = action?.params?.refresh as string[] | undefined;
        queryManager.fireMutation(target, evaluatedArgs, refreshDeps);
        return;
      }

      const { onAction: handler } = propsRef.current;
      if (!handler) return;

      // Materialize form payload at submit time — resolve slots to plain values
      let formPayload: Record<string, unknown> | undefined;
      if (formName) {
        const rawFormData = store.get(formName);
        if (rawFormData && typeof rawFormData === "object" && !Array.isArray(rawFormData)) {
          const resolved: Record<string, unknown> = {};
          for (const [fieldName, slot] of Object.entries(rawFormData as Record<string, unknown>)) {
            if (slot && typeof slot === "object" && !Array.isArray(slot)) {
              const record = slot as Record<string, unknown>;
              if (record.source === "global" && typeof record.key === "string") {
                resolved[fieldName] = store.get(record.key);
                continue;
              }
              if (record.source === "local") {
                resolved[fieldName] = record.value;
                continue;
              }
            }
            resolved[fieldName] = slot;
          }
          formPayload = { [formName]: resolved };
        }
      } else {
        // No form → send full store snapshot
        formPayload = store.getSnapshot();
      }

      handler({
        type: actionType,
        params: action?.params || {},
        humanFriendlyMessage: userMessage,
        formState: formPayload,
        formName,
      });
    },
    [queryManager, result?.mutationStatements, evaluationContext, store],
  );

  // ─── Context value ───
  const contextValue = useMemo<OpenUIContextValue>(
    () => ({
      library,
      renderNode: renderDeep,
      triggerAction,
      isStreaming,
      getFieldValue,
      setFieldValue,
      store,
      evaluationContext,
    }),
    [
      library,
      renderDeep,
      isStreaming,
      triggerAction,
      getFieldValue,
      setFieldValue,
      storeSnapshot,
      store,
      evaluationContext,
    ],
  );

  // ─── Evaluate props ───
  const evalContext = useMemo<EvalContext>(
    () => ({
      ctx: evaluationContext,
      library,
      store,
    }),
    [evaluationContext, library, store],
  );

  const evaluatedResult = useMemo<ParseResult | null>(() => {
    if (!result?.root) return result;
    try {
      const evaluatedRoot = evaluateElementProps(result.root, evalContext);
      return { ...result, root: evaluatedRoot };
    } catch (e) {
      console.error("[openui] Prop evaluation error:", e);
      return result;
    }
  }, [result, evalContext]);

  const isQueryLoading = querySnapshot.__loading.length > 0;

  return { result: evaluatedResult, parseResult: result, contextValue, isQueryLoading };
}
