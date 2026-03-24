import { z } from "zod";

export const ColSchema = z.object({
  label: z.string(),
  /** Object key to extract from row data. Required when rows are objects. */
  key: z.string().optional(),
  type: z.enum(["string", "number", "action"]).optional(),
});
