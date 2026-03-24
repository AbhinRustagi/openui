import { reactive } from "@openuidev/react-lang";
import { z } from "zod";

type RefComponent = { ref: z.ZodTypeAny };

export const SwitchItemSchema = z.object({
  label: z.string().optional(),
  description: z.string().optional(),
  name: z.string(),
  defaultChecked: z.boolean().optional(),
});

export function createSwitchGroupSchema(SwitchItem: RefComponent) {
  return z.object({
    name: z.string(),
    value: reactive(z.record(z.string(), z.boolean()).optional()),
    items: z.array(SwitchItem.ref),
    variant: z.enum(["clear", "card", "sunk"]).optional(),
  });
}
