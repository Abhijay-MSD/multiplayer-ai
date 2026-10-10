// TEST ONLY. Preloaded (node --require) into the one process the agent end-to-end test starts, and nothing else: Multiplayer AI
// never loads it. The adapters send their requests to fixed addresses (that is the point of them), so this stands in for those
// services at the one place a request leaves: it answers fetches to the Groq, Claude and Gemini hosts itself, in each service's
// documented tool-calling shape, and checks the request is in that shape too. A request in the wrong shape gets a 400, so the
// agent's reply never arrives and the test fails.
//
// Each fake asks for write_file on the first call and answers in text once it has seen the result, which is what a model does.
//
// With FAKE_SERVICES_SECTIONS=1 each one instead writes a document in four sections, one tool call per model call, the way a model
// asked for something long does: write_file for the first section, append_file for the three after it, then a reply in text. It
// checks on every call that append_file is offered in that service's own format and that every earlier call and result is replayed.
const real = globalThis.fetch;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bad = (why) => json(400, { error: { message: `fake service: ${why}`, type: "invalid_request_error" } });
const calls = (globalThis.__fakeServiceCalls = []);
const NAME = "notes.md";
const SECTIONS = process.env.FAKE_SERVICES_SECTIONS === "1";
const DOC = "essay.md";
const PARTS = 4;
const section = (who, k) => `## Section ${k} (${who})\n\nText of section ${k}, written through ${who}.\n\n`;
const toolFor = (who, n) => (n === 0 ? { name: "write_file", args: { name: DOC, content: section(who, 1) } } : { name: "append_file", args: { name: DOC, content: section(who, n + 1) } });
const doneText = (who) => `Wrote ${DOC} in ${PARTS} sections through ${who}.`;
const content = (who) => `hello from ${who}`;

function groq(body, headers) {
  if (!/^Bearer \S+$/.test(headers.authorization ?? "")) return bad("no bearer key");
  const tool = body.messages?.at(-1)?.role === "tool";
  if (!tool) {
    const t = body.tools?.[0];
    if (!(t?.type === "function" && t.function?.name && t.function?.parameters?.type === "object")) return bad("tools are not in the chat-completions shape");
    return json(200, { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_g1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ name: NAME, content: content("groq") }) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 4 } });
  }
  const asked = body.messages.at(-2);
  if (!(asked?.role === "assistant" && asked.tool_calls?.[0]?.id === "call_g1" && typeof asked.tool_calls[0].function.arguments === "string")) return bad("the assistant's tool call was not replayed");
  if (body.messages.at(-1).tool_call_id !== "call_g1") return bad("the tool result does not name the call");
  return json(200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Wrote notes.md through groq." } }], usage: { prompt_tokens: 20, completion_tokens: 6 } });
}

function claude(body, headers) {
  if (!headers["x-api-key"] || headers["anthropic-version"] !== "2023-06-01") return bad("missing x-api-key or anthropic-version");
  const last = body.messages?.at(-1);
  const result = Array.isArray(last?.content) && last.content[0]?.type === "tool_result";
  if (!result) {
    const t = body.tools?.[0];
    if (!(t?.name && t.input_schema?.type === "object")) return bad("tools do not have input_schema");
    return json(200, { stop_reason: "tool_use", content: [{ type: "text", text: "Writing." }, { type: "tool_use", id: "toolu_c1", name: "write_file", input: { name: NAME, content: content("claude") } }], usage: { input_tokens: 15, output_tokens: 5 } });
  }
  const before = body.messages.at(-2);
  if (!(before?.role === "assistant" && before.content.some((b) => b.type === "tool_use" && b.id === "toolu_c1"))) return bad("the tool_use block was not replayed");
  if (last.role !== "user" || last.content[0].tool_use_id !== "toolu_c1") return bad("tool_result must be first in a user message and name the tool_use id");
  return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: "Wrote notes.md through claude." }], usage: { input_tokens: 25, output_tokens: 7 } });
}

function gemini(body, url, headers) {
  if (!/:generateContent$/.test(url.pathname) || !(headers["x-goog-api-key"] || url.searchParams.get("key"))) return bad("not generateContent with a key");
  const last = body.contents?.at(-1);
  if (last?.role !== "function") {
    const d = body.tools?.[0]?.functionDeclarations;
    if (!(Array.isArray(d) && d.some((f) => f.name === "write_file" && f.parameters?.type === "object"))) return bad("no functionDeclarations");
    return json(200, { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { name: "write_file", args: { name: NAME, content: content("gemini") } }, thoughtSignature: "SIGNATURE-KEPT" }] } }], usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 3 } });
  }
  const before = body.contents.at(-2);
  if (!(before?.role === "model" && before.parts[0]?.thoughtSignature === "SIGNATURE-KEPT" && before.parts[0].functionCall?.name === "write_file")) return bad("the model's own parts were not replayed");
  if (last.parts[0]?.functionResponse?.name !== "write_file") return bad("no functionResponse for write_file");
  return json(200, { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Wrote notes.md through gemini." }] } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 6 } });
}


function groqSections(body, headers) {
  if (!/^Bearer \S+$/.test(headers.authorization ?? "")) return bad("no bearer key");
  const decl = body.tools?.find((t) => t.function?.name === "append_file");
  if (!(decl?.type === "function" && decl.function.parameters?.type === "object" && decl.function.parameters.required?.includes("content"))) return bad("append_file is not offered in the chat-completions shape");
  const results = body.messages.filter((m) => m.role === "tool");
  const n = results.length;
  const asked = body.messages.filter((m) => m.role === "assistant" && m.tool_calls);
  if (asked.length !== n) return bad(`${n} results but ${asked.length} assistant tool calls were replayed`);
  for (let i = 0; i < n; i++) {
    const c = asked[i].tool_calls[0];
    if (c.id !== `call_g${i + 1}` || c.function.name !== toolFor("groq", i).name || typeof c.function.arguments !== "string") return bad(`call ${i + 1} was not replayed as it was made`);
    if (results[i].tool_call_id !== c.id) return bad(`result ${i + 1} does not name its call`);
  }
  if (n >= PARTS) return json(200, { choices: [{ finish_reason: "stop", message: { role: "assistant", content: doneText("groq") } }], usage: { prompt_tokens: 40, completion_tokens: 8 } });
  const t = toolFor("groq", n);
  return json(200, { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `call_g${n + 1}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }] } }], usage: { prompt_tokens: 12, completion_tokens: 4 } });
}

function claudeSections(body, headers) {
  if (!headers["x-api-key"] || headers["anthropic-version"] !== "2023-06-01") return bad("missing x-api-key or anthropic-version");
  const decl = body.tools?.find((t) => t.name === "append_file");
  if (!(decl?.input_schema?.type === "object" && decl.input_schema.required?.includes("content"))) return bad("append_file is not offered with an input_schema");
  const turns = body.messages;
  const results = turns.filter((m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result");
  const uses = turns.filter((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"));
  const n = results.length;
  if (uses.length !== n) return bad(`${n} results but ${uses.length} tool_use turns were replayed`);
  for (let i = 0; i < n; i++) {
    const u = uses[i].content.find((b) => b.type === "tool_use");
    if (u.id !== `toolu_c${i + 1}` || u.name !== toolFor("claude", i).name) return bad(`tool_use ${i + 1} was not replayed as it was made`);
    if (results[i].content[0].tool_use_id !== u.id) return bad(`tool_result ${i + 1} does not name its tool_use`);
  }
  if (n && turns.at(-1) !== results[n - 1]) return bad("the last turn must be the newest tool_result");
  if (n >= PARTS) return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: doneText("claude") }], usage: { input_tokens: 40, output_tokens: 8 } });
  const t = toolFor("claude", n);
  return json(200, { stop_reason: "tool_use", content: [{ type: "text", text: `Section ${n + 1}.` }, { type: "tool_use", id: `toolu_c${n + 1}`, name: t.name, input: t.args }], usage: { input_tokens: 15, output_tokens: 5 } });
}

function geminiSections(body, url, headers) {
  if (!/:generateContent$/.test(url.pathname) || !(headers["x-goog-api-key"] || url.searchParams.get("key"))) return bad("not generateContent with a key");
  const decl = body.tools?.[0]?.functionDeclarations?.find((f) => f.name === "append_file");
  if (!(decl?.parameters?.type === "object" && decl.parameters.required?.includes("content"))) return bad("append_file is not declared with parameters");
  const results = body.contents.filter((c) => c.role === "function");
  const calls = body.contents.filter((c) => c.role === "model" && c.parts?.some((p) => p.functionCall));
  const n = results.length;
  if (calls.length !== n) return bad(`${n} results but ${calls.length} model turns with a call were replayed`);
  for (let i = 0; i < n; i++) {
    const part = calls[i].parts.find((p) => p.functionCall);
    if (part.functionCall.name !== toolFor("gemini", i).name || part.thoughtSignature !== `SIG-${i + 1}`) return bad(`the model's own parts for call ${i + 1} were not replayed`);
    if (results[i].parts[0]?.functionResponse?.name !== part.functionCall.name) return bad(`functionResponse ${i + 1} does not name its call`);
  }
  if (n >= PARTS) return json(200, { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: doneText("gemini") }] } }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 8 } });
  const t = toolFor("gemini", n);
  return json(200, { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { name: t.name, args: t.args }, thoughtSignature: `SIG-${n + 1}` }] } }], usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 3 } });
}

globalThis.fetch = async function (input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  const raw = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init.headers ?? {};
  const headers = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  const body = init.body ? JSON.parse(init.body) : {};
  if (url.hostname === "api.groq.com") return (calls.push("groq"), SECTIONS ? groqSections(body, headers) : groq(body, headers));
  if (url.hostname === "api.anthropic.com") return (calls.push("claude"), SECTIONS ? claudeSections(body, headers) : claude(body, headers));
  if (url.hostname === "generativelanguage.googleapis.com") return (calls.push("gemini"), SECTIONS ? geminiSections(body, url, headers) : gemini(body, url, headers));
  return real(input, init);
};
