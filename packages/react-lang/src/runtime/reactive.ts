// ─────────────────────────────────────────────────────────────────────────────
// Reactive schema marker for openui-lang
// ─────────────────────────────────────────────────────────────────────────────

import type { z } from "zod";
import type { BoundField } from "./field-binding";

// ── reactive() schema marker ────────────────────────────────────────────────

const REACTIVE_SYMBOL = Symbol.for("openui:reactive");

/**
 * Mark a schema prop as reactive so runtime evaluation can preserve $bindings.
 *
 * This mutates the Zod schema instance by attaching a hidden Symbol flag that
 * `isReactiveSchema()` checks later in `evaluate-tree.ts`.
 *
 * The widened return type carries the eventual value shape into helpers like
 * `useBoundField()`. The actual bound value is still resolved at render time.
 */
export function reactive<T extends z.ZodType>(schema: T): z.ZodType<BoundField<z.infer<T>>> {
  (schema as z.ZodType & Record<symbol, unknown>)[REACTIVE_SYMBOL] = true;
  return schema as unknown as z.ZodType<BoundField<z.infer<T>>>;
}

export function isReactiveSchema(schema: unknown): boolean {
  return typeof schema === "object" && schema !== null && (schema as any)[REACTIVE_SYMBOL] === true;
}
