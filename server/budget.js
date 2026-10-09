// The daily step budget: one count of agent replies across every room, per UTC
// day, kept in the database (usage_daily, migration 0004) so a restart can't
// refill it. claim_step() takes one step atomically; when today's budget is
// spent it takes nothing.
//
// A step is claimed when a directive is accepted (create_session with
// auto_start, send_directive), before anything is written. Counting there
// rather than inside the step queue keeps the queue untouched, and over-counts
// by at most one step if the insert that follows fails. Not counted: MCP
// step_agent (the operator's own tool) and the rolling-summary calls.
//
// If the claim itself fails (the database is unreachable, migration 0004 isn't
// applied) nothing is let through: a budget that can't be checked is a budget
// that isn't enforced.
//
// On a local store (SQLite) the budget is OFF unless DAILY_STEP_BUDGET is set:
// the model key is the person's own, on their own computer, and the per-room step
// cap (MAX_STEPS_PER_SESSION) still applies. On Supabase the default stays 200.
import { asStore, defaultStore } from "./store/index.js";
import { ApiError } from "./errors.js";
import { intSetting } from "./config.js";
import { escapeForLog } from "./safe-text.js";

export const atCapacity = () =>
  new ApiError(503, "AT_CAPACITY", "The demo is at capacity. Today's limit has been reached. Try again tomorrow, or run your own copy.");

/** The daily cap, or null when the budget is off (a local store with DAILY_STEP_BUDGET blank). */
export function dailyCap(store, env = process.env) {
  if (store.local && !String(env.DAILY_STEP_BUDGET ?? "").trim()) return null;
  return intSetting("DAILY_STEP_BUDGET", env);
}

/** Takes one step from today's budget, or throws 503 AT_CAPACITY. Resolves to { used, cap } (both null when the budget is off). */
export async function claimStep(db = defaultStore(), { env = process.env } = {}) {
  const store = asStore(db);
  const cap = dailyCap(store, env);
  if (cap === null) return { used: null, cap: null };
  let result;
  try {
    result = await store.claimStep(cap);
  } catch (e) {
    console.error(`[multiplayer-ai] could not claim from the daily step budget: ${escapeForLog(e.message)}. Is migration 0004 applied?`);
    throw new Error("The daily step budget could not be checked.");
  }
  if (!result.allowed) {
    console.error(`[multiplayer-ai] daily step budget spent (${result.used}/${cap}); refusing new steps until the next UTC day.`);
    throw atCapacity();
  }
  return { used: result.used, cap };
}

export const defaultBudget = { claim: claimStep };

/**
 * Read-only startup check that migration 0004 is applied. It selects from the
 * table and never calls claim_step, which would spend a step. Returns
 * "ok" | "missing" | "unknown" (the database couldn't be asked; not fatal).
 */
export const checkBudgetTable = (db = defaultStore()) => asStore(db).budgetStatus();
