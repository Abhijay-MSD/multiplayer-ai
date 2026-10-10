// The model each built-in provider uses when none is chosen. Kept apart from the
// adapters so the settings code can read it without importing them.
export const DEFAULT_MODELS = {
  groq: "openai/gpt-oss-120b",
  gemini: "gemini-3.5-flash",
  claude: "claude-haiku-4-5-20251001", // NOT CONFIRMED against the API's model list; change it in Settings or with ANTHROPIC_MODEL
  compat: null // an OpenAI-compatible provider has no default: the person says which model
};
export const PROVIDER_IDS = ["groq", "gemini", "claude", "compat"];

// The cap on the answer when MAX_OUTPUT_TOKENS is blank, for a provider whose API makes the caller send one (Claude). 16000 tokens is
// roughly 12000 words, room for a long essay, and under the size at which providers ask for streaming. Groq, Gemini and an
// OpenAI-compatible service are sent no cap of ours when it is blank: their own default applies, and it depends on the provider,
// the model and the account (see docs/providers.md). When MAX_OUTPUT_TOKENS is set it applies to all four, and Groq and Gemini
// add room for the model's thinking on top of it, because their limit counts thinking tokens too.
export const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
