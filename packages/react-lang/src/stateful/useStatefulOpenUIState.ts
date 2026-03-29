// ─────────────────────────────────────────────────────────────────────────────
// Orchestration hook for StatefulRenderer
// ─────────────────────────────────────────────────────────────────────────────
//
// Adapted from useOpenUIState. Instead of re-parsing and re-evaluating the
// full tree on every change, this hook manages a NodeStore (retained flat map)
// and routes state/query changes to incremental node-level updates.

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { OpenUIContextValue } from "../context";
import type { Library } from "../library";
import { BuiltinActionType } from "../parser/types";
import type { ActionEvent, ParseResult } from "../parser/types";
import type { EvaluationContext } from "../runtime/evaluator";
import { evaluate } from "../runtime/evaluator";
import type { QueryManager, QuerySnapshot, Transport } from "../runtime/queryManager";
import { createQueryManager } from "../runtime/queryManager";
import type { Store } from "../runtime/store";
import { createStore } from "../runtime/store";
import { compileSchema } from "../parser/parser";
import type { ParamMap } from "../parser/types";
import type { NodeStore } from "./node-store";
import { createNodeStore } from "./node-store";

export interface UseStatefulOpenUIStateOptions {
  response?: string | null;
  patch?: string | null;
  library: Library;
  isStreaming: boolean;
  onAction?: (event: ActionEvent) => void;
  onStateUpdate?: (state: Record<string, unknown>) => void;
  initialState?: Record<string, unknown>;
  transport?: Transport | null;
}

export interface StatefulOpenUIState {
  nodeStore: NodeStore;
  contextValue: OpenUIContextValue;
  isQueryLoading: boolean;
  parseResult: ParseResult | null;
  rootId: string | null;
}

export function useStatefulOpenUIState(
  {
    response,
    patch,
    library,
    isStreaming,
    onAction,
    onStateUpdate,
    initialState,
    transport,
  }: UseStatefulOpenUIStateOptions,
  renderDeep: (value: unknown) => React.ReactNode,
): StatefulOpenUIState {
  // ─── Store ───
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

  // ─── NodeStore ───
  const catalog = useMemo<ParamMap>(
    () => compileSchema(library.toJSONSchema()),
    [library],
  );

  const nodeStore = useMemo<NodeStore>(
    () => createNodeStore({ library, store, queryManager, catalog }),
    [library, store, queryManager, catalog],
  );

  useEffect(() => {
    return () => nodeStore.dispose();
  }, [nodeStore]);

  // ─── Apply full source or patch ───
  const lastResponseRef = useRef<string | null>(null);
  const lastPatchRef = useRef<string | null>(null);

  useEffect(() => {
    if (response !== undefined && response !== lastResponseRef.current) {
      lastResponseRef.current = response;
      if (response) {
        nodeStore.applyFullSource(response);
      }
    }
  }, [response, nodeStore]);

  useEffect(() => {
    if (patch !== undefined && patch !== null && patch !== lastPatchRef.current) {
      lastPatchRef.current = patch;
      nodeStore.applyPatch(patch);
    }
  }, [patch, nodeStore]);

  // ─── Parse result (stabilized — only changes on source/patch, not state updates) ───
  const parseResultRef = useRef<ParseResult | null>(null);
  const currentPR = nodeStore.getParseResult();
  // Only update ref when statement count changes (structural change)
  if (
    currentPR?.meta.statementCount !== parseResultRef.current?.meta.statementCount ||
    (!parseResultRef.current && currentPR)
  ) {
    parseResultRef.current = currentPR;
  }
  const parseResult = parseResultRef.current;
  const storeInitKeyRef = useRef<unknown>(Symbol());

  useEffect(() => {
    if (!parseResult?.stateDeclarations) return;
    const key = `${JSON.stringify(parseResult.stateDeclarations)}::${JSON.stringify(initialState?.bindings)}`;
    if (storeInitKeyRef.current === key) return;
    storeInitKeyRef.current = key;

    const persisted = (initialState?.bindings as Record<string, unknown> | undefined) ?? {};
    store.initialize(parseResult.stateDeclarations, persisted);

    if (initialState?.forms) {
      for (const [formName, fields] of Object.entries(
        initialState.forms as Record<string, unknown>,
      )) {
        store.set(formName, fields);
      }
    }
  }, [parseResult?.stateDeclarations, store, initialState]);

  // ─── Subscribe to Store/QueryManager changes → NodeStore delta ───
  // Use direct subscriptions instead of useSyncExternalStore to avoid
  // re-rendering the StatefulRenderer component on every state/query change.
  // The NodeStore handles per-node re-evaluation and notification internally.
  const prevStoreSnapshotRef = useRef<Record<string, unknown>>(store.getSnapshot());
  const prevQuerySnapshotRef = useRef<QuerySnapshot>(queryManager.getSnapshot() as QuerySnapshot);

  useEffect(() => {
    const unsubStore = store.subscribe(() => {
      const prev = prevStoreSnapshotRef.current;
      const current = store.getSnapshot();
      prevStoreSnapshotRef.current = current;

      if (prev === current) return;

      const changedKeys = new Set<string>();
      const allKeys = new Set([...Object.keys(prev), ...Object.keys(current)]);
      for (const key of allKeys) {
        if (prev[key] !== current[key]) changedKeys.add(key);
      }

      if (changedKeys.size > 0) {
        nodeStore.applyStateDelta(changedKeys);
      }
    });

    const unsubQuery = queryManager.subscribe(() => {
      const prev = prevQuerySnapshotRef.current;
      const current = queryManager.getSnapshot() as QuerySnapshot;
      prevQuerySnapshotRef.current = current;

      if (prev === current) return;

      const changedIds = new Set<string>();
      const allKeys = new Set([...Object.keys(prev), ...Object.keys(current)]);
      for (const key of allKeys) {
        if (key.startsWith("__")) continue;
        if (prev[key] !== current[key]) changedIds.add(key);
      }

      if (changedIds.size > 0) {
        nodeStore.applyQueryDelta(changedIds);
      }
    });

    return () => {
      unsubStore();
      unsubQuery();
    };
  }, [store, queryManager, nodeStore]);

  // ─── Evaluation context ───
  // STABLE reference — store.get() and queryManager.getResult() always return
  // current values, so this doesn't need to recreate on snapshot changes.
  // The NodeStore handles re-evaluation internally via applyStateDelta/applyQueryDelta.
  // Recreating this on every snapshot would cascade through triggerAction → contextValue
  // → OpenUIContext.Provider → re-render every component consuming the context.
  const evaluationContext = useMemo<EvaluationContext>(
    () => ({
      getState: (name: string) => store.get(name),
      resolveRef: (name: string) => {
        const mutResult = queryManager.getMutationResult(name);
        if (mutResult) return mutResult;
        return queryManager.getResult(name);
      },
    }),
    [store, queryManager],
  );

  // Submit queries when parseResult changes (new source/patch) or streaming stops.
  // State-driven re-submission (when $variables change) is handled by the store
  // subscription above — it calls applyStateDelta which re-evaluates affected nodes,
  // and the queryManager's cache handles deduplication.
  const submitQueries = useCallback(() => {
    const pr = nodeStore.getParseResult();
    if (isStreaming) return;
    if (!pr?.queryStatements?.length) return;

    const snapshot = store.getSnapshot();
    const evaluatedNodes = pr.queryStatements.map((qn) => {
      const relevantDeps: Record<string, unknown> = {};
      if (qn.deps) {
        for (const ref of qn.deps) {
          relevantDeps[ref] = snapshot[ref];
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
  }, [isStreaming, nodeStore, store, evaluationContext, queryManager]);

  // Submit on initial load and when streaming stops
  useEffect(() => {
    submitQueries();
  }, [submitQueries]);

  // Re-submit queries when store state changes (e.g. $variable bound to a filter)
  useEffect(() => {
    return store.subscribe(() => submitQueries());
  }, [store, submitQueries]);

  // ─── Register mutations ───
  useEffect(() => {
    if (isStreaming) return;
    if (!parseResult?.mutationStatements?.length) {
      queryManager.registerMutations([]);
      return;
    }
    const nodes = parseResult.mutationStatements.map((mn) => ({
      statementId: mn.statementId,
      toolName: mn.toolAST ? (evaluate(mn.toolAST, evaluationContext) as string) : "",
    }));
    queryManager.registerMutations(nodes);
  }, [isStreaming, parseResult?.mutationStatements, evaluationContext, queryManager]);

  // ─── Stable callback refs ───
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

  // ─── getFieldValue / setFieldValue ───
  const getFieldValue = useCallback(
    (formName: string | undefined, name: string) => {
      if (!formName) return store.get(name);
      const formData = store.get(formName);
      if (!formData || typeof formData !== "object" || Array.isArray(formData)) return undefined;
      const slot = (formData as Record<string, unknown>)[name];
      if (slot && typeof slot === "object" && !Array.isArray(slot)) {
        const record = slot as Record<string, unknown>;
        if (record.source === "global" && typeof record.key === "string") return store.get(record.key);
        if (record.source === "local") return record.value;
      }
      return slot;
    },
    [store],
  );

  const setFieldValue = useCallback(
    (formName: string | undefined, name: string, value: unknown) => {
      if (!formName) {
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
      store.set(formName, { ...formData, [name]: { source: "local", value } });
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
        const mn = parseResult?.mutationStatements?.find((m) => m.statementId === target);
        const evaluatedArgs = mn?.argsAST
          ? (evaluate(mn.argsAST, evaluationContext) as Record<string, unknown>)
          : {};
        const refreshDeps = action?.params?.refresh as string[] | undefined;
        queryManager.fireMutation(target, evaluatedArgs, refreshDeps);
        return;
      }

      const { onAction: handler } = propsRef.current;
      if (!handler) return;

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
    [queryManager, parseResult?.mutationStatements, evaluationContext, store],
  );

  // ─── Context value ───
  // All values here must be STABLE references. If contextValue changes,
  // every component consuming OpenUIContext re-renders — defeating per-node subscriptions.
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
      store,
      evaluationContext,
    ],
  );

  // Subscribe to structural changes (node add/remove) to trigger root re-render.
  // The value itself isn't read — the subscription is the side effect.
  useSyncExternalStore(
    nodeStore.subscribeStructure,
    nodeStore.getStructureVersion,
    nodeStore.getStructureVersion,
  );

  // Query loading state — uses useSyncExternalStore since it drives the loading bar UI.
  const isQueryLoading = useSyncExternalStore(
    queryManager.subscribe,
    () => queryManager.isAnyLoading(),
    () => false,
  );

  const rootId = nodeStore.getRootId();

  return {
    nodeStore,
    contextValue,
    isQueryLoading,
    parseResult,
    rootId,
  };
}
