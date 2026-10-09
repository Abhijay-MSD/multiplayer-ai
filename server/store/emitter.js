// A store tells in-process listeners which room it just wrote to, so the hub
// can push the change at once instead of waiting for its timer.
// sessionId is null when the store cannot say which room (another process wrote).
import { escapeForLog } from "../safe-text.js";
export function createEmitter() {
  const listeners = new Set();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(sessionId) {
      for (const fn of [...listeners]) {
        try {
          fn({ sessionId });
        } catch (e) {
          console.error(`[multiplayer-ai] a change listener failed: ${escapeForLog(e?.message ?? e)}`);
        }
      }
    },
    get size() {
      return listeners.size;
    }
  };
}
