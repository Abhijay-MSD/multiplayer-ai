// TEST ONLY. Preloaded (node --require) into the one process the agent end-to-end test starts, and nothing else: Multiplayer AI
// never loads it. The adapters send their requests to fixed addresses (that is the point of them), so this stands in for those
// services at the one place a request leaves: it answers fetches to the Groq, Claude and Gemini hosts itself, in each service's
// documented tool-calling shape, and checks the request is in that shape too. A request in the wrong shape gets a 400, so the
// agent's reply never arrives and the test fails.
//
// Each fake asks for write_file on the first call and answers in text once it has seen the result, which is what a model does.
const real = globalThis.fetch;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bad = (why) => json(400, { error: { message: `fake service: ${why}`, type: "invalid_request_error" } });
const calls = (globalThis.__fakeServiceCalls = []);
const NAME = "notes.md";
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

globalThis.fetch = async function (input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  const raw = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init.headers ?? {};
  const headers = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  const body = init.body ? JSON.parse(init.body) : {};
  if (url.hostname === "api.groq.com") return (calls.push("groq"), groq(body, headers));
  if (url.hostname === "api.anthropic.com") return (calls.push("claude"), claude(body, headers));
  if (url.hostname === "generativelanguage.googleapis.com") return (calls.push("gemini"), gemini(body, url, headers));
  return real(input, init);
};
