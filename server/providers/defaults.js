// The model each built-in provider uses when none is chosen. Kept apart from the
// adapters so the settings code can read it without importing them.
export const DEFAULT_MODELS = {
  groq: "openai/gpt-oss-120b",
  gemini: "gemini-3.5-flash",
  claude: "claude-haiku-4-5-20251001", // NOT CONFIRMED against the API's model list; change it in Settings or with ANTHROPIC_MODEL
  compat: null // an OpenAI-compatible provider has no default: the person says which model
};
export const PROVIDER_IDS = ["groq", "gemini", "claude", "compat"];
