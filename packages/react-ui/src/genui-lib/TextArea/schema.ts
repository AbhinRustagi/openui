import { reactive } from "@openuidev/react-lang";
import { z } from "zod";
import { rulesSchema } from "../rules";

export const TextAreaSchema = z.object({
  name: z.string(),
  value: reactive(z.string().optional()),
  placeholder: z.string().optional(),
  rows: z.number().optional(),
  rules: rulesSchema,
});
