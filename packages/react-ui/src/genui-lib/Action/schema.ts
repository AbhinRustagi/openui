import { BuiltinActionType } from "@openuidev/react-lang";
import { z } from "zod";

const continueConversationAction = z.object({
  type: z.literal(BuiltinActionType.ContinueConversation),
  /** Extra context string passed to the LLM — useful for carousel/list item data. */
  context: z.string().optional(),
});

const openUrlAction = z.object({
  type: z.literal(BuiltinActionType.OpenUrl),
  url: z.string(),
});

const refreshAction = z.object({
  type: z.literal(BuiltinActionType.Refresh),
  /** Optional list of query statement IDs to refresh. Omit to refresh all. */
  deps: z.array(z.string()).optional(),
});

const mutationAction = z.object({
  type: z.literal(BuiltinActionType.Mutation),
  /** Statement ID of the Mutation to fire. */
  target: z.string(),
  /** Optional query statement IDs to refresh after the mutation completes. */
  refresh: z.array(z.string()).optional(),
});

const customAction = z.object({
  type: z.string(),
  params: z.record(z.string(), z.any()).optional(),
});

export const actionSchema = z
  .union([openUrlAction, continueConversationAction, refreshAction, mutationAction, customAction])
  .optional();

export type ActionSchema = z.infer<typeof actionSchema>;
