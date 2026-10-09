// Every cost and abuse limit, in one place. Each can be set in .env; blank uses
// the default below. The defaults are placeholders: tune them to your own
// provider quota and traffic. A value that is set but not a whole number is
// refused at startup by env-check.js, so a typo can't silently turn into the
// default.

export const DEFAULTS = {
  CREATE_LIMIT_PER_HOUR: 5, // rooms one IP may start per hour
  JOIN_LIMIT_PER_HOUR: 30, // new people one IP may add per hour (returning with a valid token is free)
  DIRECTIVE_LIMIT_PER_MIN: 6, // messages to the agent per person per room
  COMMENT_LIMIT_PER_MIN: 20, // room comments per person per room
  MAX_PARTICIPANTS_PER_ROOM: 25,
  DAILY_STEP_BUDGET: 200, // agent replies across all rooms per UTC day
  GUEST_STEP_CAP_PER_ROOM: 20, // messages to the agent from people other than the host, per shared room
  INVITE_FAILURES_PER_10_MIN: 50, // wrong invite secrets one address may try in 10 minutes before it is held up
  MAX_MESSAGE_CHARS: 4000, // task, directive and comment length
  MAX_TITLE_CHARS: 120,
  MAX_BODY_KB: 32, // JSON request body
  // Room files and the agent's tool loop (see docs/limits.md and docs/agent-tools.md)
  MAX_FILE_KB: 200, // one file, in KB (1 KB = 1024 bytes)
  MAX_FILES_PER_ROOM: 50,
  MAX_ROOM_FILES_KB: 2048, // every kept version of every file in one room
  TOOL_CALLS_PER_DIRECTIVE: 12, // file tool calls the agent may make to answer one message
  MODEL_CALLS_PER_DIRECTIVE: 8, // model calls to answer one message
  TOOL_RESULT_KB: 20, // the most a tool result fed back to the model may hold
  DIRECTIVE_SECONDS: 120, // wall-clock time for answering one message when tools are in use
  MODEL_CALLS_PER_ROOM: 200 // model calls one room may make in all
};

// The database CHECK constraints (migration 0004) and the web inputs are fixed
// at these sizes, so a setting may lower them but not raise them.
export const CEILINGS = { MAX_MESSAGE_CHARS: 4000, MAX_TITLE_CHARS: 120 };

/** The setting as a positive whole number, or its default when blank or invalid. */
export function intSetting(name, env = process.env) {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 ? n : DEFAULTS[name];
}

// The address people use to reach this copy, for the links the MCP tools hand back.
// PUBLIC_URL wins; otherwise the address the running HTTP server printed; otherwise
// the default for this kind of copy (a local one is at 127.0.0.1:3737; a hosted one,
// as before, is the web app's dev server).
let runtimeUrl = null;
export const setRuntimeUrl = (url) => {
  runtimeUrl = url;
};
export function publicBaseUrl(env = process.env, { local = false } = {}) {
  return env.PUBLIC_URL || runtimeUrl || (local ? "http://127.0.0.1:3737" : "http://localhost:5173");
}

/** Agent steps one room may use before it stops. Blank or invalid means 50. */
export function maxStepsPerSession(env = process.env) {
  return Number(env.MAX_STEPS_PER_SESSION) || 50;
}

/** Hops of proxy to trust when working out a caller's IP. 0 trusts none. */
export function trustProxyHops(env = process.env) {
  const n = Number(env.TRUST_PROXY_HOPS);
  return env.TRUST_PROXY_HOPS && Number.isInteger(n) && n >= 0 ? n : 0;
}
