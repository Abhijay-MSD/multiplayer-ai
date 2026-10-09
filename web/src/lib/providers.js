// The model providers a person can choose, as the screens name them. This file and
// docs/providers.md are the only places allowed to use provider names: the copy check
// excuses exactly these two (scripts/copy-exemptions.json). Screens take the names from
// here, so they never spell one themselves.
//
// Nothing here says what a provider costs or gives away. Where a key comes from is a link
// the person follows themselves; nothing is requested from these addresses when a page loads.
// Said wherever the Claude choice is offered or in use. It is true until a real key has been tried.
export const EXPERIMENTAL_NOTE = "Experimental: not yet tested against the real service.";

export const PROVIDERS = [
  {
    id: "groq",
    label: "Groq",
    sendsTo: "api.groq.com (https, port 443)",
    keyLink: { href: "https://console.groq.com/keys", text: "console.groq.com/keys" },
    keyHint: "Create a key in the Groq console, then paste it here."
  },
  {
    id: "gemini",
    label: "Gemini",
    sendsTo: "generativelanguage.googleapis.com (https, port 443)",
    keyLink: { href: "https://aistudio.google.com/app/apikey", text: "aistudio.google.com/app/apikey" },
    keyHint: "Create a key in Google AI Studio, then paste it here."
  },
  {
    id: "claude",
    label: "Claude",
    experimental: true,
    sendsTo: "api.anthropic.com (https, port 443)",
    // Address and wording not confirmed against the provider's current site: the front page only, no deep link.
    keyLink: { href: "https://console.anthropic.com/", text: "console.anthropic.com" },
    keyHint: "Sign in to the provider's console, create an API key there, then paste it here."
  },
  {
    id: "compat",
    label: "OpenAI-compatible",
    keyLink: null,
    keyHint:
      "Use the address, the model name and the key your provider gives you. For a model running on this computer, use the address that program shows; it may not need a key."
  }
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
