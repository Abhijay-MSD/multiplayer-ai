// Run: node --test test/   (no network, no real model)
// The provider-neutral tool loop, run against scripted models: what it does with a model that answers, one that uses
// tools, one that never stops, one that is stopped, one that fails, and one that doesn't support tools at all.
import test, { after } from "node:test";
import { keepLoopAlive } from "./helpers/keep-alive.js";
import assert from "node:assert/strict";
import { makers, cleanup } from "./helpers/stores.js";
import { runAgentLoop } from "../agent/loop.js";
import { TOOL_DEFINITIONS } from "../agent/tools.js";
import { ProviderFailure } from "../providers/failure.js";
import { ApiError } from "../errors.js";

after(cleanup);
keepLoopAlive(); // the loop waits on AbortSignal.timeout, which Node leaves unref'd; see helpers/keep-alive.js

const FILE = { maxFileBytes: 1000, maxFiles: 10, maxTotalBytes: 5000, versionsKept: 10 };
const LOOP = { toolCalls: 12, modelCalls: 8, resultBytes: 600, wallMs: 120_000, roomModelCalls: 200 };
const wf = (name, content, id) => ({ id: id ?? `c_${name}`, name: "write_file", args: { name, content } });
const usage = (i = 10, o = 5) => ({ inputTokens: i, outputTokens: o });

async function setup(over = {}) {
  const store = await makers.memory();
  const { id } = await store.createSession({ title: "T", task: "x", files_enabled: true });
  const lines = [];
  const calls = [];
  const noted = [];
  let script = over.script ?? [];
  let i = 0;
  const call = over.call ?? (async (args) => {
    calls.push(args);
    const step = script[Math.min(i++, script.length - 1)];
    return typeof step === "function" ? step(args) : step;
  });
  const run = (extra = {}) =>
    runAgentLoop({
      store, sessionId: id, author: "Alice", messages: [{ role: "system", content: "s" }, { role: "user", content: "[Alice]: go" }], call,
      tools: TOOL_DEFINITIONS, limits: { ...LOOP, ...(over.limits ?? {}) }, fileLimits: FILE, roomCalls: 0,
      claim: async () => {}, shouldStop: async () => null,
      hooks: { line: async (t) => void lines.push(t), noteCall: async (n) => void noted.push(n), toolsRejected: async () => void lines.push("NOTICE tools rejected") },
      ...extra
    });
  return { store, id, run, lines, calls, noted, setScript: (s) => ((script = s), (i = 0)) };
}

const say = (text, extra = {}) => ({ text, toolCalls: [], model: "m", usage: usage(), ...extra });
const useTools = (calls, text = "", extra = {}) => ({ text, toolCalls: calls, model: "m", usage: usage(), ...extra });

test("a model that just answers: one call, the tools offered, no tool lines", async () => {
  const { run, calls, lines } = await setup({ script: [say("hello")] });
  const out = await run();
  assert.deepEqual([out.text, out.modelCalls, out.toolCalls, out.stopped], ["hello", 1, 0, null]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tools.map((t) => t.name), ["list_files", "read_file", "write_file"]);
  assert.deepEqual(lines, []);
});

test("a model that writes a file and then answers: the file exists, a line was left, the results went back, calls are counted", async () => {
  const { run, calls, lines, store, id, noted } = await setup({ script: [useTools([wf("notes.md", "# Plan")], "Writing it."), say("Done: notes.md has the plan.")] });
  const out = await run();
  assert.equal(out.text, "Done: notes.md has the plan.");
  assert.deepEqual([out.modelCalls, out.toolCalls, out.stopped], [2, 1, null]);
  assert.deepEqual(lines, ["Created notes.md, 6 bytes"]);
  assert.deepEqual(noted, [1, 2]);
  const file = await store.getFile(id, "notes.md");
  assert.deepEqual([file.content, file.updated_by, file.on_behalf_of], ["# Plan", "agent", "Alice"]);
  const second = calls[1].messages;
  assert.deepEqual(second.slice(-2).map((m) => m.role), ["assistant", "tool"]);
  assert.equal(second.at(-2).content, "Writing it.");
  assert.equal(second.at(-2).toolCalls[0].id, "c_notes.md");
  assert.deepEqual([second.at(-1).toolCallId, second.at(-1).name, second.at(-1).isError], ["c_notes.md", "write_file", false]);
  assert.deepEqual(out.usage, { inputTokens: 20, outputTokens: 10 });
});

test("read, then write: reading goes through the same loop and its result is marked untrusted", async () => {
  const { run, calls, lines, store, id } = await setup({
    script: [
      useTools([wf("a.txt", "hello from a")]),
      useTools([{ id: "r1", name: "read_file", args: { name: "a.txt" } }]),
      say("a.txt says hello")
    ]
  });
  const out = await run();
  assert.equal(out.text, "a.txt says hello");
  assert.deepEqual(lines, ["Created a.txt, 12 bytes", "Read a.txt"]);
  assert.match(calls[2].messages.at(-1).content, /untrusted data[\s\S]*hello from a/);
  assert.equal((await store.getFile(id, "a.txt")).version, 1);
});

test("a model that never stops using tools is stopped by the model-call cap, and the host is told which one", async () => {
  const { run, calls, lines } = await setup({ script: [(args) => useTools([wf(`f${calls_n(args)}.txt`, "x", `c${calls_n(args)}`)], "more")] });
  function calls_n(args) { return args.messages.length; }
  const out = await run();
  assert.equal(calls.length, 8);
  assert.equal(out.stopped.reason, "model_calls");
  assert.match(out.stopped.line, /^Stopped: .*8 model calls.*MODEL_CALLS_PER_DIRECTIVE/);
  assert.equal(out.modelCalls, 8);
  assert.equal(out.toolCalls, 8);
  assert.equal(lines.filter((l) => l.startsWith("Created")).length, 8, "what it wrote stays");
  assert.equal(out.text, "more", "the last thing it said is kept");
});

test("the tool-call cap stops it too, naming itself, and only the allowed calls run", async () => {
  const { run, calls, store, id, lines } = await setup({ limits: { toolCalls: 3 }, script: [(a) => useTools([wf(`g${a.messages.length}.txt`, "x", `id${a.messages.length}`)])] });
  const out = await run();
  assert.equal(out.stopped.reason, "tool_calls");
  assert.match(out.stopped.line, /3 file tool calls.*TOOL_CALLS_PER_DIRECTIVE/);
  assert.equal(out.toolCalls, 3);
  assert.equal(calls.length, 4, "the fourth reply asked for a fourth call and was stopped");
  assert.equal((await store.listFiles(id)).length, 3);
  assert.equal(lines.length, 3);
});

test("several calls in one reply: those over the cap are not run", async () => {
  const many = Array.from({ length: 6 }, (_, i) => wf(`m${i}.txt`, "x", `m${i}`));
  const { run, store, id } = await setup({ limits: { toolCalls: 4 }, script: [useTools(many)] });
  const out = await run();
  assert.equal(out.stopped.reason, "tool_calls");
  assert.equal((await store.listFiles(id)).length, 4);
});

test("exactly the cap is fine: the model gets its results and can answer", async () => {
  const { run } = await setup({ limits: { toolCalls: 2 }, script: [useTools([wf("a.txt", "1", "a"), wf("b.txt", "2", "b")]), say("both written")] });
  const out = await run();
  assert.deepEqual([out.text, out.stopped, out.toolCalls], ["both written", null, 2]);
});

test("the room's total model calls are capped across messages", async () => {
  const { run, calls } = await setup({ limits: { roomModelCalls: 5 }, script: [(a) => useTools([wf(`h${a.messages.length}.txt`, "x", `i${a.messages.length}`)])] });
  const out = await run({ roomCalls: 3 });
  assert.equal(calls.length, 2, "5 - 3 calls were left");
  assert.equal(out.stopped.reason, "room_calls");
  assert.match(out.stopped.line, /MODEL_CALLS_PER_ROOM/);
  const none = await run({ roomCalls: 5 });
  assert.equal(none.modelCalls, 0);
  assert.equal(none.stopped.reason, "room_calls");
});

test("every model call after the first is claimed from the daily budget, and a spent budget stops the loop", async () => {
  let claims = 0;
  const { run, calls } = await setup({ script: [(a) => useTools([wf(`b${a.messages.length}.txt`, "x", `b${a.messages.length}`)])] });
  const out = await run({ claim: async () => { if (++claims > 2) throw new ApiError(503, "AT_CAPACITY", "full"); } });
  assert.equal(calls.length, 3, "the first call was claimed by the message itself; two more were claimed, the third claim was refused");
  assert.equal(claims, 3);
  assert.equal(out.stopped.reason, "budget");
  assert.match(out.stopped.line, /DAILY_STEP_BUDGET/);
});

test("some other failure while claiming is not hidden", async () => {
  const { run } = await setup({ script: [useTools([wf("a.txt", "1")]), say("x")] });
  await assert.rejects(run({ claim: async () => { throw new Error("database is down"); } }), /database is down/);
});

test("the wall clock: a model call that hangs is cut off at the deadline", async () => {
  const hang = (args) => new Promise((_res, rej) => args.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const { run, lines } = await setup({ limits: { wallMs: 60 }, script: [useTools([wf("a.txt", "1")]), hang] });
  const t0 = Date.now();
  const out = await run();
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(out.stopped.reason, "time");
  assert.match(out.stopped.line, /DIRECTIVE_SECONDS/);
  assert.deepEqual(lines, ["Created a.txt, 1 byte"], "what was written stays");
});

test("the wall clock is also checked between steps, with a stand-in clock", async () => {
  let t = 1000;
  const { run } = await setup({ limits: { wallMs: 5000 }, script: [(a) => ((t += 3000), useTools([wf(`w${a.messages.length}.txt`, "x", `w${a.messages.length}`)]))] });
  const out = await run({ now: () => t });
  assert.equal(out.stopped.reason, "time");
  assert.equal(out.modelCalls, 2);
});

test("Stop: a model call in flight is aborted at once, with the reason from the signal, and files already written stay", async () => {
  const controller = new AbortController();
  const slow = (args) => new Promise((_res, rej) => args.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const { run, store, id } = await setup({ script: [useTools([wf("a.txt", "kept")]), slow] });
  const pending = run({ signal: controller.signal });
  await new Promise((r) => setTimeout(r, 30));
  controller.abort({ stoppedBy: "Alice" });
  const out = await pending;
  assert.equal(out.stopped.reason, "stopped");
  assert.equal(out.stopped.by, "Alice");
  assert.equal((await store.getFile(id, "a.txt")).content, "kept");
});

test("Stop between tool calls: the next call does not run", async () => {
  const controller = new AbortController();
  const many = [wf("a.txt", "1", "a"), wf("b.txt", "2", "b"), wf("c.txt", "3", "c")];
  const { run, store, id } = await setup({ script: [useTools(many)] });
  const out = await run({
    signal: controller.signal,
    hooks: { line: async (t) => { if (t.startsWith("Created a.txt")) controller.abort({ stoppedBy: "Bob" }); }, noteCall: async () => {}, toolsRejected: async () => {} }
  });
  assert.equal(out.stopped.reason, "stopped");
  assert.deepEqual((await store.listFiles(id)).map((f) => f.name), ["a.txt"]);
});

test("Stop before it starts: nothing is called", async () => {
  const controller = new AbortController();
  controller.abort({ stoppedBy: "Alice" });
  const { run, calls } = await setup({ script: [say("x")] });
  const out = await run({ signal: controller.signal });
  assert.equal(calls.length, 0);
  assert.equal(out.stopped.reason, "stopped");
});

test("when the room stops allowing it (archived, ended, turned off, deleted) the loop stops at the next step", async () => {
  for (const reason of ["room_closed", "files_off", "deleted"]) {
    let allowed = true;
    const { run, calls } = await setup({ script: [(a) => ((allowed = false), useTools([wf(`s${a.messages.length}.txt`, "x", `s${a.messages.length}`)])), say("never")] });
    const out = await run({ shouldStop: async () => (allowed ? null : { reason, line: `Stopped: ${reason}` }) });
    assert.equal(calls.length, 1, reason);
    assert.equal(out.stopped.reason, reason);
  }
});

test("a failure from the provider mid-loop surfaces as it is, and what was written stays", async () => {
  const boom = () => { throw new ProviderFailure("BUSY", { status: 503, detail: "overloaded" }); };
  const { run, store, id } = await setup({ script: [useTools([wf("a.txt", "kept")]), boom] });
  await assert.rejects(run(), (e) => e instanceof ProviderFailure && e.category === "BUSY");
  assert.equal((await store.getFile(id, "a.txt")).content, "kept");
});

test("a provider that turns tools down: the room is told once, the call is made again without tools, and the answer is text", async () => {
  const rejected = new ProviderFailure("UNKNOWN", { status: 400, detail: "registry.example/model does not support tools" });
  const { run, calls, lines, noted } = await setup({ script: [() => { throw rejected; }, say("plain text answer")] });
  const out = await run();
  assert.equal(out.text, "plain text answer");
  assert.equal(out.noTools, true);
  assert.deepEqual(lines, ["NOTICE tools rejected"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].tools?.length ?? 0, 0, "the second call has no tools");
  assert.equal(out.modelCalls, 2, "the rejected call counts");
  assert.deepEqual(noted, [1, 2]);
});

test("a 400 that is not about tools is not mistaken for that", async () => {
  const bad = new ProviderFailure("BAD_KEY", { status: 400, detail: "Invalid API key" });
  const { run, lines } = await setup({ script: [() => { throw bad; }] });
  await assert.rejects(run(), (e) => e === bad);
  assert.deepEqual(lines, []);
});

test("a model that asks for tools it was not offered is ignored: its text is the answer", async () => {
  const { run, store, id } = await setup({ script: [useTools([wf("a.txt", "1")], "I'll just say it.")] });
  const out = await run({ tools: [] });
  assert.deepEqual([out.text, out.toolCalls], ["I'll just say it.", 0]);
  assert.deepEqual(await store.listFiles(id), []);
});

test("malformed and unknown calls are answered with an error the model can read, and count against the cap", async () => {
  const { run, calls, lines } = await setup({
    limits: { toolCalls: 12 },
    script: [
      useTools([{ id: "x1", name: "write_file", args: null, argsError: "malformed" }, { id: "x2", name: "bash", args: { cmd: "rm -rf /" } }, { id: "x3", name: "read_file", args: { name: "../../etc/passwd" } }]),
      say("I could not do that.")
    ]
  });
  const out = await run();
  assert.equal(out.toolCalls, 3);
  const results = calls[1].messages.slice(-3);
  assert.ok(results.every((m) => m.role === "tool" && m.isError && m.content.startsWith("Error: ")));
  assert.deepEqual(lines, ["Couldn't write a file: the request was malformed.", "Tried a tool that doesn't exist, so nothing was done.", "Couldn't read a file: the name isn't allowed."]);
});

test("huge arguments are refused by the size rules, and what goes back to the model stays small", async () => {
  const { run, calls, store, id } = await setup({ script: [useTools([wf("big.txt", "x".repeat(5_000_000))]), say("ok")] });
  await run();
  assert.deepEqual(await store.listFiles(id), []);
  const back = calls[1].messages.at(-1);
  assert.ok(back.content.length < 400, `${back.content.length} chars`);
  assert.match(back.content, /too large/);
});

test("a long file read back is cut to the result limit", async () => {
  const { run, calls } = await setup({ script: [useTools([wf("l.txt", "y".repeat(900))]), useTools([{ id: "r", name: "read_file", args: { name: "l.txt" } }]), say("ok")] });
  await run();
  assert.ok(Buffer.byteLength(calls[2].messages.at(-1).content) <= LOOP.resultBytes);
});

test("usage is null when no call reported any, and partial reports are summed without guessing", async () => {
  const none = await setup({ script: [useTools([wf("a.txt", "1")], "", { usage: null }), say("ok", { usage: null })] });
  const a = await none.run();
  assert.equal(a.usage, null);
  const some = await setup({ script: [useTools([wf("a.txt", "1")], "", { usage: null }), say("ok", { usage: usage(7, 3) })] });
  const b = await some.run();
  assert.deepEqual(b.usage, { inputTokens: 7, outputTokens: 3 });
  assert.equal(b.usageComplete, false);
  assert.equal(a.usageComplete, false);
});

test("the fallback model's name and flag are passed up", async () => {
  const { run } = await setup({ script: [say("x", { model: "fallback-model", usedFallback: true })] });
  const out = await run();
  assert.deepEqual([out.model, out.usedFallback], ["fallback-model", true]);
});

test("a store without files can't run the loop's tools: they answer with an error, not a crash", async () => {
  const { run } = await setup({ script: [useTools([wf("a.txt", "1")]), say("fine")] });
  const out = await run({ store: { supportsFiles: false } });
  assert.equal(out.text, "fine");
});
