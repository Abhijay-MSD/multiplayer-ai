// Checks the environment once at startup and reports every problem at once.
//
// A blank value always means "use the default". A value that is set but wrong
// (MAX_STEPS_PER_SESSION=abc) used to fall back to the default without a word;
// here it stops the server with a message that names the variable.
//
// validateEnv() is pure, so the tests can feed it any environment. boot.js is
// what runs it for real.
import { DEFAULTS, CEILINGS } from "./config.js";
import { FILE_CEILINGS } from "./files/limits.js";

const PROVIDERS = {
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  compat: "OPENAI_COMPAT_API_KEY"
};

// Settings that must be positive whole numbers when set.
const POSITIVE_INTS = [
  "MAX_STEPS_PER_SESSION",
  "MAX_CONTEXT_TOKENS",
  "MAX_OUTPUT_TOKENS",
  "TOKEN_TTL_DAYS",
  "ARCHIVE_AFTER_DAYS",
  "STREAM_PING_MS",
  ...Object.keys(DEFAULTS)
];

const ENUMS = {
  GEMINI_THINKING_LEVEL: ["minimal", "low", "medium", "high", "none"],
  GROQ_REASONING_EFFORT: ["low", "medium", "high", "none"],
  MULTIPLAYER_AI_SHARE: ["wifi", "local"]
};

const set = (env, name) => typeof env[name] === "string" && env[name].trim() !== "";

/**
 * Returns { errors, warnings }, lists of sentences about named variables.
 * `store` is the storage in use. "supabase" (the default here, as before the
 * storage layer) needs the database settings and a model key; a local store
 * needs neither, because the model key is a setting stored on this computer.
 */
export function validateEnv(env = process.env, { store = "supabase" } = {}) {
  const errors = [];
  const warnings = [];
  const hosted = store === "supabase";
  const bad = (name, why) => errors.push(`${name}: ${why} (it is "${env[name]}").`);

  if (hosted) {
    for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"]) {
      if (!set(env, name)) errors.push(`${name} is required. Copy .env.example to .env and fill it in.`);
    }
    if (set(env, "SUPABASE_URL") && !isHttpUrl(env.SUPABASE_URL)) bad("SUPABASE_URL", "must be an http(s) URL");
  }

  const provider = (env.PROVIDER || "gemini").trim().toLowerCase();
  if (!PROVIDERS[provider]) {
    bad("PROVIDER", `must be one of ${Object.keys(PROVIDERS).join(", ")}`);
  } else if (hosted && !set(env, PROVIDERS[provider])) {
    errors.push(`${PROVIDERS[provider]} is required while PROVIDER is ${provider}.`);
  }

  for (const name of POSITIVE_INTS) {
    if (!set(env, name)) continue;
    const n = Number(env[name]);
    if (!Number.isInteger(n) || n <= 0) bad(name, "must be a whole number above 0, or blank for the default");
  }
  for (const [name, ceiling] of Object.entries(CEILINGS)) {
    if (set(env, name) && Number(env[name]) > ceiling) {
      bad(name, `can be lowered but not raised above ${ceiling}, because the database and the web inputs are fixed at that size`);
    }
  }
  if (set(env, "MAX_BODY_KB") && Number(env.MAX_BODY_KB) > 1024) bad("MAX_BODY_KB", "must be 1024 or less");
  for (const [name, ceiling] of Object.entries(FILE_CEILINGS)) {
    if (set(env, name) && Number(env[name]) > ceiling) bad(name, `must be ${ceiling} or less`);
  }
  // One file can't be allowed to be bigger than everything a room may hold.
  const fileKb = Number(env.MAX_FILE_KB || DEFAULTS.MAX_FILE_KB);
  const roomKb = Number(env.MAX_ROOM_FILES_KB || DEFAULTS.MAX_ROOM_FILES_KB);
  if ((set(env, "MAX_FILE_KB") || set(env, "MAX_ROOM_FILES_KB")) && Number.isInteger(fileKb) && Number.isInteger(roomKb) && fileKb > roomKb) {
    bad("MAX_FILE_KB", `can't be more than MAX_ROOM_FILES_KB (${roomKb}), the most one room may hold`);
  }

  if (set(env, "TRUST_PROXY_HOPS")) {
    const n = Number(env.TRUST_PROXY_HOPS);
    if (!Number.isInteger(n) || n < 0 || n > 10) bad("TRUST_PROXY_HOPS", "must be a whole number from 0 to 10; see docs/limits.md");
  }
  for (const name of ["PORT", "MULTIPLAYER_AI_PORT", "MULTIPLAYER_AI_PUBLIC_PORT"]) {
    if (!set(env, name)) continue;
    const n = Number(env[name]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) bad(name, "must be a port number from 1 to 65535");
  }
  for (const [name, allowed] of Object.entries(ENUMS)) {
    if (set(env, name) && !allowed.includes(env[name].trim().toLowerCase())) bad(name, `must be one of ${allowed.join(", ")}`);
  }

  // PUBLIC_URL is sent as the CORS origin, so a path or a trailing slash makes
  // the browser refuse every call.
  if (set(env, "PUBLIC_URL")) {
    if (!isHttpUrl(env.PUBLIC_URL)) {
      bad("PUBLIC_URL", "must be an http(s) URL such as https://multiplayer-ai.example");
    } else if (new URL(env.PUBLIC_URL).origin !== env.PUBLIC_URL.trim()) {
      bad("PUBLIC_URL", "must be the origin only, with no path and no trailing slash, because browsers compare it exactly");
    }
  } else if (hosted && env.NODE_ENV === "production") {
    errors.push("PUBLIC_URL is required when NODE_ENV is production; without it any website could call the API.");
  }

  if (hosted && !set(env, "MAX_OUTPUT_TOKENS")) {
    warnings.push("MAX_OUTPUT_TOKENS is blank, so a reply has no length cap. Set one to limit what each step can cost.");
  }
  return { errors, warnings };
}

const isHttpUrl = (value) => {
  try {
    return ["http:", "https:"].includes(new URL(String(value).trim()).protocol);
  } catch {
    return false;
  }
};
