// Picks the model provider (Settings, or PROVIDER in the environment) and turns any
// failure into a ProviderFailure: a category for the room, and the redacted detail for
// the host's terminal. Read at call time, so a change in Settings applies to the next call.
import * as gemini from "./gemini.js";
import * as groq from "./groq.js";
import * as compat from "./compat.js";
import * as anthropic from "./anthropic.js";
import { getSettings } from "../settings.js";
import { toProviderFailure } from "./failure.js";

const providers = {
  gemini: {
    callModel: gemini.callModel,
    summaryModel: () => process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite"
  },
  groq: {
    callModel: groq.callModel,
    summaryModel: () => process.env.GROQ_SUMMARY_MODEL || groq.DEFAULT_SUMMARY_MODEL
  },
  claude: {
    callModel: anthropic.callModel,
    summaryModel: () => getSettings().model("claude")
  },
  compat: {
    callModel: compat.callModel,
    summaryModel: () => getSettings().model("compat")
  }
};

function active(name = getSettings().provider()) {
  const p = providers[name];
  if (!p) throw new Error(`Unknown PROVIDER "${name}". Use one of: ${Object.keys(providers).join(", ")}.`);
  return { name, ...p };
}

// MAX_OUTPUT_TOKENS: cap on the reply a step asks the model for. Blank (or
// anything that isn't a positive whole number) means no cap. Each adapter adds
// room for the model's thinking on top, so the cap limits the answer, not the
// reasoning; a call that passes its own maxOutputTokens (the summary) keeps it.
export function maxOutputTokensFromEnv(value = process.env.MAX_OUTPUT_TOKENS) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** `provider` picks one for this call only (testing a key); otherwise the one in force. */
export async function callModel({ provider, ...args }) {
  const p = active(provider);
  try {
    return await p.callModel({ ...args, maxOutputTokens: args.maxOutputTokens ?? maxOutputTokensFromEnv() });
  } catch (e) {
    throw toProviderFailure(e, p.name);
  }
}
export const summaryModel = () => active().summaryModel();
