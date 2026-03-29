// ─────────────────────────────────────────────────────────────────────────────
// Dependency tracking for incremental evaluation
// ─────────────────────────────────────────────────────────────────────────────
//
// Wraps an EvaluationContext to intercept getState/resolveRef calls,
// recording which $variables and query/mutation results a node reads.
// The existing evaluate() function is unchanged — tracking is opt-in.

import type { EvaluationContext } from "../runtime/evaluator";

export interface DependencyTracker {
  /** Returns all dependencies accumulated since creation or last reset. */
  getDeps(): Set<string>;
  /** Clears the accumulated dependencies for reuse across nodes. */
  reset(): void;
}

/**
 * Creates a dependency tracker and a wrapped EvaluationContext that
 * records every $variable and ref access during evaluation.
 */
export function createTrackingContext(
  base: EvaluationContext,
): { context: EvaluationContext; tracker: DependencyTracker } {
  const deps = new Set<string>();

  const tracker: DependencyTracker = {
    getDeps: () => new Set(deps),
    reset: () => deps.clear(),
  };

  const context: EvaluationContext = {
    getState(name: string): unknown {
      deps.add(name);
      return base.getState(name);
    },
    resolveRef(name: string): unknown {
      deps.add(name);
      return base.resolveRef(name);
    },
    get extraScope() {
      return base.extraScope;
    },
  };

  return { context, tracker };
}
