// A write the caller doesn't wait on to succeed: the person's action has
// already happened, and this only adds a line to the transcript. If it fails the
// failure is logged and the action still stands, as it did before the storage layer.
import { escapeForLog } from "../safe-text.js";
export async function bestEffort(promise, what) {
  try {
    return await promise;
  } catch (e) {
    console.error(`[multiplayer-ai] could not write the ${what} event: ${escapeForLog(e?.message ?? e)}`);
    return null;
  }
}
