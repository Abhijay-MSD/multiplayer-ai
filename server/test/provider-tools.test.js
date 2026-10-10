// Run: node --test test/   (no network, no real model)
// Each adapter's side of tool calling: the tools it sends, the calls it reads back, and how it replays a finished tool
// call to the model, in that provider's own shape. The shapes are the ones in docs/providers.md ("Tool calling"); the
// fakes here are written to those shapes, so these tests pin what the adapters do with them, not that the shapes are right.
import test from "node:test";
import { keepLoopAlive } from "./helpers/keep-alive.js";
keepLoopAlive();
import assert from "node:assert/strict";
import { callModel as groq } from "../providers/groq.js";
import { callModel as compat } from "../providers/compat.js";
import { callModel as claude } from "../providers/anthropic.js";
import { callModel as gemini } from "../providers/gemini.js";
import { TOOL_DEFINITIONS } from "../agent/tools.js";
import { parseToolArguments, normalizeToolCalls, splitAtTools, toolsRejected } from "../providers/tool-format.js";

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const chatCall = (id, name, args) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const chatReply = (message, usage = { prompt_tokens: 11, completion_tokens: 7 }) => reply(200, { choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage });

const BASE = [{ role: "system", content: "sys" }, { role: "user", content: "[Alice]: write notes" }];
const AFTER = [
  ...BASE,
  { role: "assistant", content: "I'll write it.", toolCalls: [{ id: "call_1", name: "write_file", args: { name: "notes.md", content: "hi" } }, { id: "call_2", name: "list_files", args: {} }] },
  { role: "tool", toolCallId: "call_1", name: "write_file", content: 'Created "notes.md" (2 bytes).' },
  { role: "tool", toolCallId: "call_2", name: "list_files", content: "Files in this room:\n- notes.md (2 bytes, version 1)", isError: false },
  { role: "tool", toolCallId: "call_3", name: "read_file", content: "Error: no such file", isError: true }
].filter((m) => m.toolCallId !== "call_3"); // (call_3 has no assistant call; kept out of the shared replay)

test.beforeEach(() => {
  process.env.GROQ_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.ANTHROPIC_API_KEY = "test-claude-key";
  process.env.OPENAI_COMPAT_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.OPENAI_COMPAT_MODEL = "m";
  process.env.OPENAI_COMPAT_API_KEY = "test-compat-key";
  delete process.env.GROQ_FALLBACK_MODEL;
});

// ── shared helpers ───────────────────────────────────────────────────

test("tool arguments: an object, a JSON string, an empty string, and every way a model gets them wrong", () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { args: { a: 1 } });
  assert.deepEqual(parseToolArguments({ a: 1 }), { args: { a: 1 } });
  assert.deepEqual(parseToolArguments(""), { args: {} });
  assert.deepEqual(parseToolArguments(undefined), { args: {} });
  assert.deepEqual(parseToolArguments(null), { args: {} });
  for (const bad of ['{"a":', "not json", "5", '"text"', "[1,2]", "null5", "{'a':1}"]) {
    const r = parseToolArguments(bad);
    assert.equal(r.args, null, bad);
    assert.equal(r.argsError, "malformed", bad);
  }
  const huge = parseToolArguments(`{"content":"${"x".repeat(2_000_000)}"}`);
  assert.deepEqual([huge.args, huge.argsError], [null, "too large"]);
});

test("tool calls get an id, a name that is text, and unique ids", () => {
  const out = normalizeToolCalls([
    { id: "a", name: "list_files", args: {} },
    { id: "a", name: "read_file", args: { name: "x" } },
    { name: "write_file", args: {} },
    { id: "", name: 5, args: {} },
    { id: 7, name: "list_files" }
  ]);
  assert.equal(new Set(out.map((c) => c.id)).size, 5, "every id is different");
  assert.ok(out.every((c) => typeof c.id === "string" && c.id.length > 0));
  assert.deepEqual(out.map((c) => c.name), ["list_files", "read_file", "write_file", "", "list_files"]);
  assert.deepEqual(normalizeToolCalls(undefined), []);
  assert.deepEqual(normalizeToolCalls("nope"), []);
});

test("messages are split where the first tool message begins", () => {
  const { prefix, tail } = splitAtTools(AFTER);
  assert.deepEqual(prefix.map((m) => m.role), ["system", "user"]);
  assert.deepEqual(tail.map((m) => m.role), ["assistant", "tool", "tool"]);
  assert.deepEqual(splitAtTools(BASE).tail, []);
});

test("a provider turning tools down is recognised by what it says, not by every 400", () => {
  const f = (status, detail) => ({ status, detail });
  for (const [s, d] of [
    [400, "registry.example/library/model does not support tools"],
    [400, "Tool use is not supported for this model"],
    [400, "tools is not supported with this model"],
    [400, "Function calling is not enabled for models/example"],
    [422, "Unrecognized request argument supplied: tools"],
    [400, "this model does not support function calling"],
    [400, "'tools' : unknown field"],
    [400, "Invalid parameter: tool_choice is not allowed for this model"]
  ]) assert.equal(toolsRejected(f(s, d)), true, d);
  for (const [s, d] of [
    [400, "Invalid API key"],
    [400, "The model does not exist"],
    [400, "Parsing failed. The model generated output that could not be parsed."],
    [401, "tools are not supported"],
    [429, "tool use is not supported"],
    [500, "does not support tools"],
    [400, "max_tokens is too large"],
    [400, "messages: text content blocks must be non-empty"],
    [undefined, "does not support tools"]
  ]) assert.equal(toolsRejected(f(s, d)), false, d);
  assert.equal(toolsRejected(null), false);
  assert.equal(toolsRejected(undefined), false);
});

// ── chat completions: Groq and the OpenAI-compatible adapter ─────────

for (const [name, call] of [["groq", groq], ["compat", compat]]) {
  test(`${name}: with no tools the request has no tools field, as before`, async () => {
    let body;
    await call({ messages: BASE, fetchImpl: async (u, init) => ((body = JSON.parse(init.body)), chatReply({ content: "hi" })) });
    assert.equal("tools" in body, false);
    assert.equal("tool_choice" in body, false);
  });

  test(`${name}: tools go in as {type:"function", function:{name, description, parameters}}`, async () => {
    let body;
    await call({ messages: BASE, tools: TOOL_DEFINITIONS, fetchImpl: async (u, init) => ((body = JSON.parse(init.body)), chatReply({ content: "hi" })) });
    assert.equal(body.tools.length, 4);
    assert.deepEqual(body.tools.map((t) => [t.type, t.function.name]), [["function", "list_files"], ["function", "read_file"], ["function", "write_file"], ["function", "append_file"]]);
    assert.deepEqual(body.tools[2].function.parameters.required, ["name", "content"]);
    assert.equal(typeof body.tools[2].function.description, "string");
    assert.equal(JSON.stringify(body).includes("test-key"), false, "the key is never in the body");
  });

  test(`${name}: tool calls are read back with parsed arguments, usage, and no placeholder text`, async () => {
    const out = await call({
      messages: BASE,
      tools: TOOL_DEFINITIONS,
      fetchImpl: async () => chatReply({ content: null, tool_calls: [chatCall("call_a", "write_file", { name: "n.md", content: "x" }), chatCall("call_b", "list_files", "")] })
    });
    assert.equal(out.text, "");
    assert.deepEqual(out.toolCalls.map((c) => [c.id, c.name, c.args]), [["call_a", "write_file", { name: "n.md", content: "x" }], ["call_b", "list_files", {}]]);
    assert.deepEqual(out.usage, { inputTokens: 11, outputTokens: 7 });
  });

  test(`${name}: arguments that are not JSON are passed on as an error for the executor to refuse, with the raw text kept for replay`, async () => {
    const out = await call({ messages: BASE, tools: TOOL_DEFINITIONS, fetchImpl: async () => chatReply({ content: "", tool_calls: [chatCall("c1", "write_file", '{"name": "a.md", "content": "oops')] }) });
    assert.deepEqual([out.toolCalls[0].args, out.toolCalls[0].argsError], [null, "malformed"]);
    assert.equal(out.toolCalls[0].rawArgs, '{"name": "a.md", "content": "oops');
  });

  test(`${name}: a call with no id is given one; text beside the calls is kept`, async () => {
    const out = await call({ messages: BASE, tools: TOOL_DEFINITIONS, fetchImpl: async () => chatReply({ content: "Looking.", tool_calls: [{ type: "function", function: { name: "list_files", arguments: "{}" } }] }) });
    assert.equal(out.text, "Looking.");
    assert.ok(out.toolCalls[0].id);
  });

  test(`${name}: a plain answer comes back with no tool calls`, async () => {
    const out = await call({ messages: BASE, tools: TOOL_DEFINITIONS, fetchImpl: async () => chatReply({ content: " done " }) });
    assert.deepEqual([out.text, out.toolCalls], ["done", []]);
  });

  test(`${name}: an empty answer with no calls still says "(no response)"`, async () => {
    const out = await call({ messages: BASE, tools: TOOL_DEFINITIONS, fetchImpl: async () => chatReply({ content: "" }) });
    assert.equal(out.text, "(no response)");
  });

  test(`${name}: a finished tool call is replayed as an assistant message with tool_calls and tool messages with tool_call_id`, async () => {
    let body;
    await call({ messages: AFTER, tools: TOOL_DEFINITIONS, fetchImpl: async (u, init) => ((body = JSON.parse(init.body)), chatReply({ content: "ok" })) });
    const roles = body.messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "tool", "tool"]);
    const a = body.messages[2];
    assert.equal(a.content, "I'll write it.");
    assert.deepEqual(a.tool_calls.map((c) => [c.id, c.type, c.function.name]), [["call_1", "function", "write_file"], ["call_2", "function", "list_files"]]);
    assert.equal(typeof a.tool_calls[0].function.arguments, "string");
    assert.deepEqual(JSON.parse(a.tool_calls[0].function.arguments), { name: "notes.md", content: "hi" });
    assert.deepEqual(body.messages.slice(3).map((m) => m.tool_call_id), ["call_1", "call_2"]);
    assert.match(body.messages[3].content, /Created "notes\.md"/);
  });

  test(`${name}: an assistant turn that was only calls is sent with null content, and unreadable arguments are sent back as they came`, async () => {
    let body;
    const messages = [...BASE, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", args: null, argsError: "malformed", rawArgs: '{"bad' }] }, { role: "tool", toolCallId: "c1", name: "write_file", content: "Error: not valid JSON", isError: true }];
    await call({ messages, tools: TOOL_DEFINITIONS, fetchImpl: async (u, init) => ((body = JSON.parse(init.body)), chatReply({ content: "ok" })) });
    const a = body.messages[2];
    assert.equal(a.content, null);
    assert.equal(a.tool_calls[0].function.arguments, '{"bad');
  });

  test(`${name}: usage is null when the provider doesn't report it`, async () => {
    const out = await call({ messages: BASE, fetchImpl: async () => reply(200, { choices: [{ message: { content: "hi" } }] }) });
    assert.equal(out.usage, null);
  });
}

test("groq: a malformed tool call the provider itself rejects is retried like other parse failures", async () => {
  let calls = 0;
  const out = await groq({
    messages: BASE,
    tools: TOOL_DEFINITIONS,
    parseBackoffMs: 1,
    fetchImpl: async () => (calls++ === 0 ? reply(400, { error: { message: "Failed to call a function.", type: "invalid_request_error", code: "tool_use_failed", failed_generation: "<function=x" } }) : chatReply({ content: "ok" }))
  });
  assert.equal(calls, 2);
  assert.equal(out.text, "ok");
});

// ── Claude: the Messages API ────────────────────────────────────────

const claudeReply = (content, usage = { input_tokens: 21, output_tokens: 9 }) => reply(200, { content, usage, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" });

test("claude: tools go in as {name, description, input_schema} and a plain request has none", async () => {
  let body;
  await claude({ messages: BASE, tools: TOOL_DEFINITIONS, fetchImpl: async (u, init) => ((body = JSON.parse(init.body)), claudeReply([{ type: "text", text: "hi" }])) });
  assert.deepEqual(body.tools.map((t) => Object.keys(t).sort()), Array(4).fill(["description", "input_schema", "name"]));
  assert.equal(body.tools[1].input_schema.type, "object");
  assert.deepEqual(body.tools[2].input_schema.required, ["name", "content"]);
  await claude({ messages: BASE, fetchImpl: async (u, init) => ((body = JSON.parse(init.body)), claudeReply([{ type: "text", text: "hi" }])) });
  assert.equal("tools" in body, false);
});

test("claude: tool_use blocks are read back, with the text beside them and the usage", async () => {
  const out = await claude({
    messages: BASE,
    tools: TOOL_DEFINITIONS,
    fetchImpl: async () => claudeReply([{ type: "text", text: "Writing." }, { type: "tool_use", id: "toolu_1", name: "write_file", input: { name: "a.md", content: "x" } }, { type: "tool_use", id: "toolu_2", name: "list_files", input: {} }])
  });
  assert.equal(out.text, "Writing.");
  assert.deepEqual(out.toolCalls.map((c) => [c.id, c.name, c.args]), [["toolu_1", "write_file", { name: "a.md", content: "x" }], ["toolu_2", "list_files", {}]]);
  assert.deepEqual(out.usage, { inputTokens: 21, outputTokens: 9 });
});

test("claude: only calls, no text, is not '(no response)'; nothing at all is", async () => {
  const only = await claude({ messages: BASE, tools: TOOL_DEFINITIONS, fetchImpl: async () => claudeReply([{ type: "tool_use", id: "t", name: "list_files", input: {} }]) });
  assert.deepEqual([only.text, only.toolCalls.length], ["", 1]);
  const none = await claude({ messages: BASE, tools: TOOL_DEFINITIONS, fetchImpl: async () => claudeReply([]) });
  assert.equal(none.text, "(no response)");
});

test("claude: a tool_use whose input is not an object is passed on as malformed", async () => {
  const out = await claude({ messages: BASE, tools: TOOL_DEFINITIONS, fetchImpl: async () => claudeReply([{ type: "tool_use", id: "t", name: "write_file", input: "oops" }]) });
  assert.equal(out.toolCalls[0].argsError, "malformed");
});

test("claude: a finished tool call is replayed as tool_use blocks, then one user message of tool_result blocks first", async () => {
  let body;
  const messages = [...AFTER, { role: "tool", toolCallId: "call_3", name: "x", content: "Error: failed", isError: true }];
  messages.splice(2, 1, { ...AFTER[2], toolCalls: [...AFTER[2].toolCalls, { id: "call_3", name: "read_file", args: { name: "zz" } }] });
  await claude({ messages, tools: TOOL_DEFINITIONS, fetchImpl: async (u, init) => ((body = JSON.parse(init.body)), claudeReply([{ type: "text", text: "ok" }])) });
  assert.equal(body.system, "sys");
  assert.deepEqual(body.messages.map((m) => m.role), ["user", "assistant", "user"], "the three results are one user message");
  assert.deepEqual(body.messages[1].content.map((b) => b.type), ["text", "tool_use", "tool_use", "tool_use"]);
  assert.deepEqual(body.messages[1].content[1], { type: "tool_use", id: "call_1", name: "write_file", input: { name: "notes.md", content: "hi" } });
  const results = body.messages[2].content;
  assert.deepEqual(results.map((b) => [b.type, b.tool_use_id]), [["tool_result", "call_1"], ["tool_result", "call_2"], ["tool_result", "call_3"]]);
  assert.equal(results[2].is_error, true);
  assert.equal("is_error" in results[0], false);
  assert.equal(typeof results[0].content, "string");
});

test("claude: an assistant turn with no text has no empty text block, and unreadable input goes back as an empty object", async () => {
  let body;
  const messages = [...BASE, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", args: null, argsError: "malformed", rawArgs: "{bad" }] }, { role: "tool", toolCallId: "c1", name: "write_file", content: "Error: bad", isError: true }];
  await claude({ messages, tools: TOOL_DEFINITIONS, fetchImpl: async (u, init) => ((body = JSON.parse(init.body)), claudeReply([{ type: "text", text: "ok" }])) });
  assert.deepEqual(body.messages[1].content.map((b) => b.type), ["tool_use"]);
  assert.deepEqual(body.messages[1].content[0].input, {});
});

test("claude: the key is in the header only", async () => {
  let seen;
  await claude({ messages: AFTER, tools: TOOL_DEFINITIONS, fetchImpl: async (u, init) => ((seen = { u, init }), claudeReply([{ type: "text", text: "ok" }])) });
  assert.equal(seen.init.headers["x-api-key"], "test-claude-key");
  assert.ok(!seen.u.includes("test-claude-key") && !seen.init.body.includes("test-claude-key"));
});

// ── Gemini: the library's function calling ──────────────────────────

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return handler(seen.at(-1));
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = real;
  }
}
const geminiJson = (parts, usageMetadata = { promptTokenCount: 31, candidatesTokenCount: 5 }) => new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata }), { status: 200, headers: { "content-type": "application/json" } });

test("gemini: functions go in as one functionDeclarations tool, and a no-argument function has no parameters", async () => {
  await withFetch(() => geminiJson([{ text: "hi" }]), async (seen) => {
    await gemini({ messages: BASE, tools: TOOL_DEFINITIONS, thinkingLevel: "none" });
    const tools = seen[0].body.tools;
    assert.equal(tools.length, 1);
    const decls = tools[0].functionDeclarations;
    assert.deepEqual(decls.map((d) => d.name), ["list_files", "read_file", "write_file", "append_file"]);
    assert.equal("parameters" in decls[0], false);
    assert.equal(decls[2].parameters.type, "object");
    assert.deepEqual(decls[2].parameters.required, ["name", "content"]);
    assert.equal(decls[2].parameters.properties.content.type, "string");
  });
  await withFetch(() => geminiJson([{ text: "hi" }]), async (seen) => {
    await gemini({ messages: BASE, thinkingLevel: "none" });
    assert.equal("tools" in seen[0].body, false, "a plain request has none");
  });
});

test("gemini: functionCall parts are read back with usage, and the raw parts are kept for replay", async () => {
  const parts = [{ text: "Writing." }, { functionCall: { name: "write_file", args: { name: "a.md", content: "x" } }, thoughtSignature: "SIG-123" }, { functionCall: { name: "list_files", args: {} } }];
  await withFetch(() => geminiJson(parts), async () => {
    const out = await gemini({ messages: BASE, tools: TOOL_DEFINITIONS, thinkingLevel: "none" });
    assert.equal(out.text, "Writing.");
    assert.deepEqual(out.toolCalls.map((c) => [c.name, c.args]), [["write_file", { name: "a.md", content: "x" }], ["list_files", {}]]);
    assert.equal(new Set(out.toolCalls.map((c) => c.id)).size, 2);
    assert.deepEqual(out.usage, { inputTokens: 31, outputTokens: 5 });
    assert.deepEqual(out.raw, { provider: "gemini", parts });
  });
});

test("gemini: a finished tool call is replayed as the model's own parts, then one function turn of functionResponse parts", async () => {
  const rawParts = [{ text: "I'll write it." }, { functionCall: { name: "write_file", args: { name: "notes.md", content: "hi" } }, thoughtSignature: "SIG-123" }, { functionCall: { name: "list_files", args: {} } }];
  const messages = [...AFTER];
  messages[2] = { ...AFTER[2], raw: { provider: "gemini", parts: rawParts } };
  await withFetch(() => geminiJson([{ text: "ok" }]), async (seen) => {
    await gemini({ messages, tools: TOOL_DEFINITIONS, thinkingLevel: "none" });
    const { contents } = seen[0].body;
    assert.deepEqual(contents.map((c) => c.role), ["user", "model", "function"]);
    assert.match(contents[0].parts[0].text, /sys[\s\S]*write notes/);
    assert.deepEqual(contents[1].parts, rawParts, "replayed exactly as received, signature and all");
    assert.deepEqual(contents[2].parts.map((p) => p.functionResponse.name), ["write_file", "list_files"]);
    assert.equal(typeof contents[2].parts[0].functionResponse.response, "object");
    assert.match(JSON.stringify(contents[2].parts[0].functionResponse.response), /Created/);
  });
});

test("gemini: without raw parts the calls are rebuilt from the internal ones", async () => {
  await withFetch(() => geminiJson([{ text: "ok" }]), async (seen) => {
    await gemini({ messages: AFTER, tools: TOOL_DEFINITIONS, thinkingLevel: "none" });
    const model = seen[0].body.contents[1];
    assert.deepEqual(model.parts, [{ text: "I'll write it." }, { functionCall: { name: "write_file", args: { name: "notes.md", content: "hi" } } }, { functionCall: { name: "list_files", args: {} } }]);
  });
});

test("gemini: the key is in a header, never in the address or the body", async () => {
  await withFetch(() => geminiJson([{ text: "ok" }]), async (seen) => {
    await gemini({ messages: AFTER, tools: TOOL_DEFINITIONS, thinkingLevel: "none" });
    assert.ok(!seen[0].url.includes("test-gemini-key"));
    assert.ok(!JSON.stringify(seen[0].body).includes("test-gemini-key"));
  });
});
