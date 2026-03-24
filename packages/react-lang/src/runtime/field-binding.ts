/**
 * Unified field binding — framework-agnostic core.
 *
 * Pure function: resolves a field's identity and binding to a
 * BoundField with value + setter. No side effects, no registration.
 *
 * Two paths:
 *   - `value` is ReactiveAssign → reads/writes via Store (global binding)
 *   - No binding → reads/writes via fieldGetter/fieldSetter (local or global)
 */

import type { EvaluationContext } from "./evaluator";
import { evaluate, isReactiveAssign } from "./evaluator";
import type { Store } from "./store";

/** A resolved field with value + setter. Framework-agnostic. */
export interface BoundField<T = unknown> {
  /** Field identity (always a plain string) */
  name: string;
  /** Current field value */
  value: T;
  /** Update the field value (writes to Store or field state) */
  setValue: (newValue: T) => void;
  /** Whether this field is backed by a $binding (reactive) */
  isReactive: boolean;
}

/** Extract the inner value type from a BoundField-shaped prop. */
export type InferBoundValue<T> = T extends BoundField<infer U> ? U : T;

/**
 * Resolve a field to a BoundField with value + setter.
 * Pure function — no React hooks, no registration side effects.
 *
 * @param name - Field identity (always string, used for validation/submission)
 * @param bindingValue - The `value` prop: ReactiveAssign if bound to $var, undefined if local
 * @param store - Reactive Store for global bindings
 * @param evaluationContext - For evaluating binding expressions
 * @param fieldGetter - Read current value by field name (delegates to FieldStateEngine)
 * @param fieldSetter - Write value by field name (delegates to FieldStateEngine)
 */
export function resolveBoundField<T = unknown>(
  name: string,
  bindingValue: unknown,
  store: Store | null,
  evaluationContext: EvaluationContext | null,
  fieldGetter: (fieldName: string) => unknown,
  fieldSetter: (fieldName: string, value: unknown) => void,
): BoundField<T> {
  if (isReactiveAssign(bindingValue) && store && evaluationContext) {
    const { target, expr } = bindingValue;
    return {
      name,
      value: store.get(target) as T,
      setValue: (v: T) => {
        const extraScope: Record<string, unknown> = { $value: v };
        const newValue = evaluate(expr, { ...evaluationContext, extraScope });
        store.set(target, newValue);
      },
      isReactive: true,
    };
  }

  return {
    name,
    value: fieldGetter(name) as T,
    setValue: (v: T) => fieldSetter(name, v),
    isReactive: false,
  };
}
