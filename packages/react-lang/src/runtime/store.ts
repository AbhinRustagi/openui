// ─────────────────────────────────────────────────────────────────────────────
// Reactive state store for openui-lang
// ─────────────────────────────────────────────────────────────────────────────

export interface Store {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): Record<string, unknown>;
  initialize(defaults: Record<string, unknown>, persisted: Record<string, unknown>): void;
}

export function createStore(): Store {
  const state = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  let snapshot: Record<string, unknown> = {};

  function notify() {
    const currentListeners = [...listeners];
    for (const listener of currentListeners) {
      listener();
    }
  }

  function rebuildSnapshot() {
    snapshot = Object.fromEntries(state);
  }

  function get(name: string): unknown {
    return state.get(name);
  }

  function set(name: string, value: unknown): void {
    state.set(name, value);
    rebuildSnapshot();
    notify();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): Record<string, unknown> {
    return snapshot;
  }

  function initialize(defaults: Record<string, unknown>, persisted: Record<string, unknown>): void {
    // Clear stale keys so removed bindings don't linger
    state.clear();
    const allKeys = new Set([...Object.keys(defaults), ...Object.keys(persisted)]);
    for (const key of allKeys) {
      state.set(key, key in persisted ? persisted[key] : defaults[key]);
    }
    rebuildSnapshot();
    notify();
  }

  return { get, set, subscribe, getSnapshot, initialize };
}
