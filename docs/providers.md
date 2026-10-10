# Model providers

Multiplayer AI sends each agent reply to a model provider you choose. It has no model of its
own and no account system: the provider and the key are yours, and the key pays for every
reply, including replies to people you share a room with.

## The four choices

| Choice | What it is | Where a key comes from |
|---|---|---|
| Groq | The Groq chat service | Create one at console.groq.com/keys |
| Gemini | Google's Gemini models, through Google AI Studio | Create one at aistudio.google.com/app/apikey |
| Claude (experimental) | Claude models, through Anthropic's Messages API. **Experimental: not yet tested against the real service.** | Create one in Anthropic's console (console.anthropic.com). **Unconfirmed:** the console's current layout and address; it has not been checked against the provider's documentation. |
| OpenAI-compatible | Any service (or program on your computer) that answers the OpenAI chat-completions format | From that service. You also enter its address and a model name. |

The requests go to these hosts, over https on port 443: `api.groq.com` (Groq), `generativelanguage.googleapis.com` (Gemini, through Google's own library; that library's other requests, if any, have not been checked), `api.anthropic.com` (Claude), and the address you enter (OpenAI-compatible).

This page does not say what any provider charges or allows for free. Read the provider's
own pages for that, and check the limits on the key you create.

The model each choice uses until you pick another is named in `server/providers/defaults.js`
(OpenAI-compatible has none: you name the model). Those names were set when the code was written; if
a provider retires one, choose another in Settings or set the model variable below.

## Claude: what was and was not confirmed

The Claude choice is experimental: not yet tested against the real service. It is labelled that way in Setup and Settings.

The Claude adapter (`server/providers/anthropic.js`) uses plain HTTPS requests, no library, and sends the key only in a header to one fixed address. It retries busy answers (429, 503, 529 and an "overloaded" error) with backoff, never retries a key the API doesn't accept (401), and gives up on a request after a timeout when one is set (Test key sets 10 seconds). A failed reply shows people in the room only a category; what the API said goes, with keys hidden, to the terminal.

**Read from the provider's documentation on 9 October 2026** (the Tool use overview and Handle tool calls pages on platform.claude.com):

- the address, `https://api.anthropic.com/v1/messages` (POST), and the headers `x-api-key`, `anthropic-version: 2023-06-01` and `content-type: application/json`
- the request's `model`, `max_tokens` (required, so 16000 is sent when nothing sets a cap) and `messages`
- tool calling, in the shape described under [Tool calling](#tool-calling)

**Not confirmed against the documentation** (what the adapter was written to, pinned by tests that don't prove it right):

- the `system` field (all system text, joined), and `messages` alternating user and assistant starting with the user
- the answer's `usage.input_tokens` and `usage.output_tokens`
- the error statuses and types: 401 and 403 mean the key was not accepted, 404 an unknown model, 429 rate limited, 529 or an `overloaded_error` busy, other 5xx a provider problem
- the default model, `claude-haiku-4-5-20251001`. It is only a default: change it in Settings or with `ANTHROPIC_MODEL`. It was chosen as the least expensive of the current names, not checked against the provider's model list. If it has been retired, Test key says the provider doesn't know the model.

**Press Test key with a real key before relying on it.** Nothing here has been run against the real service.

## Tool calling

The agent's file tools ([agent-tools.md](agent-tools.md)) are described to each provider in that provider's own format, and a tool call's result is sent back in the same format. The agent loop itself is provider-neutral; each adapter converts. A provider whose format is **UNCONFIRMED** here would get text only (the agent answers without tools and the room is told so). Today every provider below is confirmed to the extent stated, so none is switched off. None has been run against its real service.

| Provider | Tools are sent as | A call comes back as | A result goes back as | Confirmed from |
|---|---|---|---|---|
| Groq | `tools: [{type: "function", function: {name, description, parameters}}]` (JSON Schema) | `message.tool_calls[]`: `id`, `type`, `function.name`, `function.arguments` (a JSON string) | `{role: "tool", tool_call_id, content}`; the assistant turn is replayed with its `tool_calls` | Groq's documentation, console.groq.com/docs/tool-use, read 9 October 2026. That page does not document `tool_choice` or `finish_reason`; neither is sent or relied on. |
| OpenAI-compatible | The same as Groq | The same | The same | The same format as Groq's, which is the OpenAI chat-completions format. OpenAI's own page (platform.openai.com) now redirects to a host outside the list this project reads from, so it was **not read**. Services that only partly follow the format may reject it; see below. |
| Gemini | One tool: `tools: [{functionDeclarations: [{name, description, parameters: {type, properties, required}}]}]`; a function with no parameters has none | `response.functionCalls()`: `{name, args}` (the library gives no call id, so the adapter numbers them) | A `function` turn of `{functionResponse: {name, response}}` parts, after the model's own turn (its parts replayed exactly as received) | The installed library's type definitions and code (`@google/generative-ai` 0.21.0: `FunctionDeclaration`, `FunctionCall`, `FunctionResponsePart`, the roles `user`, `model` and `function`). The Google page that was read documents a newer interface instead of this library, so the library's behaviour was **not** confirmed against Google's documentation. **UNCONFIRMED:** whether the current Gemini models want anything more on replay than the model's own parts, which is what is sent back. |
| Claude | `tools: [{name, description, input_schema}]` | `content` blocks of type `tool_use`: `id`, `name`, `input` (an object); `stop_reason: "tool_use"` | One user message whose first blocks are `{type: "tool_result", tool_use_id, content, is_error?}`, after the assistant turn replayed with its `tool_use` blocks | The Messages API documentation (platform.claude.com, Tool use overview and Handle tool calls), read 9 October 2026 |

**A provider or model that doesn't take tools.** If a request that carries tools is answered with a 400 or 422 that says tools or function calling aren't supported, the room is told once ("This model doesn't accept tools, so the agent will answer in text only in this room."), that message is answered again in text, and later messages in that room are sent without tools until the server restarts. A 400 about anything else (a bad key, an unknown model) is not mistaken for this.

**Arguments a model gets wrong.** Arguments that aren't valid JSON, aren't an object, or are over a million characters are not run: the tool answers with an error the model can read, and it counts against the tool-call cap.

## Setting it up

Open Multiplayer AI from the link in the terminal, then use Setup (the first time) or Settings. Choose
the provider, paste the key, press **Test key** (one small request, and it tells you what went wrong
if it fails), then save.

## Environment variables

Environment variables override what is saved, one field at a time, and Settings says when one is
doing so (naming the variable, never its value).

| Variable | Overrides |
|---|---|
| `PROVIDER` | the provider: `groq`, `gemini` or `compat` |
| `GROQ_API_KEY`, `GROQ_MODEL` | the Groq key and model |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | the Gemini key and model |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | the Claude key and model |
| `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_MODEL` | the address, key and model of an OpenAI-compatible provider |

## Where the key is kept, and what that protects

A saved key is stored in `settings.json` in the data folder (`MULTIPLAYER_AI_DATA_DIR`, or `.multiplayer-ai` in
your home folder), as plain text, in a file only your account can read (mode 600 on macOS and Linux;
Windows ignores that setting).

That keeps other accounts on the same computer out. It does not protect against anyone who can use your
account, against malware running as you, or against a backup or sync tool that copies the folder. Keep
the folder out of git: Multiplayer AI warns at startup if it sits inside a repository.

The key is never shown again after you save it (only its last four characters), never put in an address,
never passed to another program, and hidden from the terminal output and from error messages.

## An OpenAI-compatible address

The address must be `https://`, or `http://` for this computer only (`localhost`, `127.0.0.1`, `::1`).
It cannot contain a user name, a password, a `?` or a `#`. Before you save, Settings shows the exact host the
key will be sent to. A redirect is refused, so a key cannot be sent on to a different host.

## What people in a room see when a reply fails

A category, such as "The model provider didn't accept the API key" or "The model provider is busy right now".
What the provider actually said goes to the terminal Multiplayer AI runs in, with keys hidden, and nowhere else.

## How long a reply may be

`MAX_OUTPUT_TOKENS` (see [limits.md](limits.md)) is the most one reply is asked for.

**Token limits depend on the provider, the model and your account, and they change. Look them up in the provider's own documentation and in your account's settings; do not rely on a number in this file.** That covers the longest reply a model can write, the room it needs for its own thinking, how many tokens an account may use per minute or per day, and what the provider does when a request asks for more than its model allows (some refuse the request). **None of this has been tested against real providers.** The requests below were written from each provider's documentation (Gemini's from the library's type definitions) and run against stand-ins that answer in the same shape, so what a real provider does with them is not known.

What each provider is sent when `MAX_OUTPUT_TOKENS` is blank, and what it does with a number:

| Provider | `MAX_OUTPUT_TOKENS` blank | `MAX_OUTPUT_TOKENS` set to N |
|---|---|---|
| Groq | no cap sent: Groq's own default for the model | `max_completion_tokens` of N plus room for reasoning (512, 1024 or 2048 by `GROQ_REASONING_EFFORT`), because Groq's limit counts reasoning tokens |
| Gemini | no cap sent: Gemini's own default for the model | `maxOutputTokens` of N plus room for thinking (128 to 2048 by `GEMINI_THINKING_LEVEL`), because Gemini's limit counts thinking tokens |
| Claude | `max_tokens` of 16000, because the API needs a number | `max_tokens` of N |
| OpenAI-compatible | no cap sent: the service's own default | `max_tokens` of N |

When a provider says it stopped a reply at its length limit (Groq and compatible services: `finish_reason` "length"; Claude: `stop_reason` "max_tokens"; Gemini: `finishReason` "MAX_TOKENS"), the part that was written is saved and the room shows "The reply reached its length limit" with a Continue button for the controller.
