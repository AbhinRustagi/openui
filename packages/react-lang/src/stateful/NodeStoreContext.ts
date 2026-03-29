import { createContext, useContext } from "react";
import type { NodeStore } from "./node-store";

export const NodeStoreContext = createContext<NodeStore | null>(null);

export function useNodeStore(): NodeStore {
  const store = useContext(NodeStoreContext);
  if (!store) {
    throw new Error("useNodeStore must be used within a <StatefulRenderer>");
  }
  return store;
}
