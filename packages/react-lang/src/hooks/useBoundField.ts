/**
 * React hook for unified field binding.
 *
 * Component authors use this to get a BoundField with value + setter.
 * Delegates to getFieldValue/setFieldValue from context, which route
 * to Store (the single source of truth for all state).
 *
 * @param name - Field identity (always string)
 * @param value - Optional binding source (ReactiveAssign from $var, or undefined for local)
 *
 * @example
 * ```tsx
 * const field = useBoundField("dateRange", props.value);
 * <select value={field.value} onChange={e => field.setValue(e.target.value)} />
 * ```
 */

import { useFormName, useOpenUI } from "../context";
import { resolveBoundField, type BoundField, type InferBoundValue } from "../runtime/field-binding";

export function useBoundField<T = unknown>(
  name: string,
  value?: T,
): BoundField<InferBoundValue<T>> {
  const ctx = useOpenUI();
  const formName = useFormName();

  return resolveBoundField<InferBoundValue<T>>(
    name,
    value,
    ctx.store ?? null,
    ctx.evaluationContext ?? null,
    (n) => ctx.getFieldValue(formName, n),
    (n, v) => ctx.setFieldValue(formName, n, v),
  );
}
