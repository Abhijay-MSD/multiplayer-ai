// Run: node --test test/   (no network, no real model)
// Stop, and what is shown after each message: the controller or the host stops a step that is running, the request to the
// model is aborted, the room is told who stopped it, files already written stay, and each message ends with a quiet line of
// what it used (tokens only as far as the provider said, never an estimate).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { makers, cleanup } from "./helpers/stores.js";
import { createLimits } from "../limits.js";
import { TOOL_FORMAT_CONFIRMED, forgetRoom } from "../agent/support.js";
import { usageLine } from "../agent/usage.js";

const { createSession } = await import("../tools/create_session.js");
const { joinSession } = await import("../tools/join_session.js");
const { sendDirective } = await import("../tools/send_directive.js");
const { stopAgent } = await import("../tools/stop_agent.js");
const { stepAgent, setStepDeps } = await import("../tools/step_agent.js");

after(cleanup);

const wf = (name, content, id = `c_${name}`) => ({ id, name: "write_file", args: { name, content } });
const useTools = (toolCalls, text = "", usage = { inputTokens: 10, outputTokens: 5 }) => ({ text, toolCalls, model: "fake", usage });
const say = (text, usage = { inputTokens: 10, outputTokens: 5 }) => ({ text, toolCalls: [], model: "fake", usage });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hangUntilAborted = (args) => new Promise((_res, rej) => args.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));

for (const kind of ["memory", "sqlite"]) {
  async function world({ filesEnabled = true } = {}) {
    const store = await makers[kind]();
    const d = { db: store, trigger: () => {}, limits: createLimits({ env: {}, local: true }), budget: { claim: () => ({}) } };
    const room = await createSession({ task: "Plan a trip", creator_name: "Maya" }, { ...d, caller: { host: true, sharing: false } });
    const guest = await joinSession({ session_id: room.session_id, name: "Guest" }, d);
    const id = room.session_id;
    forgetRoom(id);
    if (!filesEnabled) await store.updateSession(id, { files_enabled: false });
    const lines = async () => (await store.listEvents(id)).filter((e) => e.kind === "status").map((e) => e.content);
    const replies = async () => (await store.listEvents(id)).filter((e) => e.kind === "agent_message");
    const run = (script) => {
      const calls = [];
      let i = 0;
      setStepDeps({
        db: store, summarize: async () => {}, provider: () => "groq", toolFormats: TOOL_FORMAT_CONFIRMED,
        call: async (args) => {
          calls.push(args);
          const step = script[Math.min(i++, script.length - 1)];
          return typeof step === "function" ? step(args, calls.length) : step;
        }
      });
      return { calls, step: () => stepAgent({ session_id: id, token: room.token }) };
    };
    const stop = (token) => stopAgent({ session_id: id, token }, d);
    return { store, d, id, host: room.token, guest: guest.token, lines, replies, run, stop };
  }
  const t = (title, fn) => test(`[${kind}] ${title}`, async () => fn(await world()));

  t("Stop during a tool loop aborts the model request at once, says who stopped it, keeps what was written, and writes no reply", async (w) => {
    const r = w.run([useTools([wf("a.txt", "kept")]), hangUntilAborted]);
    const pending = r.step().catch((e) => e);
    while (r.calls.length < 2) await sleep(5);
    const out = await w.stop(w.host);
    assert.deepEqual([out.stopped, out.dropped], [true, 0]);
    await pending;
    const lines = await w.lines();
    assert.ok(lines.includes("Stopped by Maya"), lines.join(" | "));
    assert.ok(lines.includes("Created a.txt, 4 bytes"));
    assert.equal((await w.replies()).length, 0);
    assert.equal((await w.store.getFile(w.id, "a.txt")).content, "kept");
    const room = await w.store.getSession(w.id);
    assert.deepEqual([room.agent_working, room.step_count], [false, 1]);
  });

  t("Stop during a plain answer (files off) aborts that request too", async (w) => {
    const w2 = await world({ filesEnabled: false });
    const r = w2.run([hangUntilAborted]);
    const pending = r.step().catch((e) => e);
    while (r.calls.length < 1) await sleep(5);
    assert.ok(r.calls[0].signal instanceof AbortSignal);
    assert.equal((await w2.stop(w2.host)).stopped, true);
    await pending;
    assert.ok((await w2.lines()).includes("Stopped by Maya"));
    assert.equal((await w2.replies()).length, 0);
    assert.equal((await w2.store.getSession(w2.id)).agent_working, false);
  });

  t("Stop with nothing running says so and writes nothing", async (w) => {
    const out = await w.stop(w.host);
    assert.deepEqual([out.stopped, out.dropped], [false, 0]);
    assert.deepEqual(await w.lines(), []);
    const r = w.run([say("done")]);
    await r.step();
    assert.equal((await w.stop(w.host)).stopped, false, "and after it finished");
  });

  t("the controller and the host can stop it; a guest and a stranger cannot", async (w) => {
    await assert.rejects(w.stop(w.guest), (e) => e.status === 403 && e.code === "NOT_ALLOWED");
    for (const token of [undefined, "", "nope", "mpai_" + "a".repeat(43)]) await assert.rejects(w.stop(token), (e) => e.status === 401);
    const other = await createSession({ task: "Other", creator_name: "Zed" }, { ...w.d, caller: { host: true, sharing: false } });
    await assert.rejects(w.stop(other.token), (e) => e.status === 403 && e.code === "FORBIDDEN");
    // The guest holds control: now they may.
    await w.store.setController(w.id, "Guest");
    assert.equal((await w.stop(w.guest)).stopped, false);
    // And the host may even when someone else steers.
    assert.equal((await w.stop(w.host)).stopped, false);
    // A guest who is no longer steering is a guest again.
    await w.store.setController(w.id, "Maya");
    await assert.rejects(w.stop(w.guest), (e) => e.code === "NOT_ALLOWED");
  });

  t("a guest's attempt to stop does not stop a running step", async (w) => {
    const r = w.run([hangUntilAborted]);
    const pending = r.step().catch((e) => e);
    while (r.calls.length < 1) await sleep(5);
    await assert.rejects(w.stop(w.guest), (e) => e.code === "NOT_ALLOWED");
    assert.equal(r.calls[0].signal.aborted, false);
    await w.stop(w.host);
    await pending;
  });

  t("messages waiting behind the running one are dropped, and the room is told", async (w) => {
    const r = w.run([hangUntilAborted, say("never")]);
    const first = r.step().catch((e) => e);
    while (r.calls.length < 1) await sleep(5);
    const second = r.step().catch((e) => e);
    await sleep(20);
    const out = await w.stop(w.host);
    assert.deepEqual([out.stopped, out.dropped], [true, 1]);
    await Promise.all([first, second]);
    assert.equal(r.calls.length, 1, "the waiting one never reached the model");
    const lines = await w.lines();
    assert.ok(lines.includes("Stopped by Maya"));
    assert.ok(lines.includes("1 message that was waiting for the agent was not answered."));
  });

  t("after a stop the room works as before: the next message is answered", async (w) => {
    const r = w.run([hangUntilAborted, say("fine now")]);
    const pending = r.step().catch((e) => e);
    while (r.calls.length < 1) await sleep(5);
    await w.stop(w.host);
    await pending;
    const out = await r.step();
    assert.equal(out.event.content, "fine now");
    assert.equal((await w.store.getSession(w.id)).agent_working, false);
  });

  t("a stop that arrives just as the model answers leaves one consistent outcome: a stop line and no reply, never both", async (w) => {
    const r = w.run([async () => { await w.stop(w.host); return say("a reply that arrived too late"); }]);
    await r.step().catch(() => {});
    const lines = await w.lines();
    assert.ok(lines.includes("Stopped by Maya"));
    assert.equal((await w.replies()).length, 0);
    assert.equal((await w.store.getSession(w.id)).agent_working, false);
    const again = await w.stop(w.host);
    assert.equal(again.stopped, false);
  });

  t("a stop after the reply was written changes nothing", async (w) => {
    const r = w.run([say("done")]);
    await r.step();
    assert.equal((await w.stop(w.host)).stopped, false);
    assert.equal((await w.replies()).length, 1);
    assert.ok(!(await w.lines()).some((l) => l.startsWith("Stopped")));
  });

  t("each answered message ends with a quiet line of what it used", async (w) => {
    const r = w.run([useTools([wf("a.txt", "1")], "", { inputTokens: 10, outputTokens: 5 }), say("done", { inputTokens: 20, outputTokens: 6 })]);
    await r.step();
    const lines = await w.lines();
    assert.equal(lines.at(-1), "Used 2 model calls and 1 file tool call. Tokens: 30 in, 11 out.");
    const events = await w.store.listEvents(w.id);
    const used = events.findIndex((e) => e.content?.startsWith("Used "));
    const reply = events.findIndex((e) => e.kind === "agent_message");
    assert.ok(used > reply, "the line comes after the reply");
  });

  t("a plain answer says one model call, and tokens as reported", async (w) => {
    const w2 = await world({ filesEnabled: false });
    await w2.run([say("hi", { inputTokens: 1234, outputTokens: 56 })]).step();
    assert.equal((await w2.lines()).at(-1), "Used 1 model call. Tokens: 1,234 in, 56 out.");
  });

  t("when the provider reports no tokens the line says not reported, and never an estimate", async (w) => {
    await w.run([say("hi", null)]).step();
    assert.equal((await w.lines()).at(-1), "Used 1 model call. Tokens: not reported.");
  });

  t("when only some calls reported, the line says so", async (w) => {
    await w.run([useTools([wf("a.txt", "1")], "", null), say("ok", { inputTokens: 7, outputTokens: 3 })]).step();
    assert.equal((await w.lines()).at(-1), "Used 2 model calls and 1 file tool call. Tokens: 7 in, 3 out (the provider didn't report every call).");
  });

  t("a stopped or capped message still says what it used", async (w) => {
    process.env.MODEL_CALLS_PER_DIRECTIVE = "2";
    await w.run([(a) => useTools([wf(`f${a.messages.length}.txt`, "x", `i${a.messages.length}`)])]).step();
    delete process.env.MODEL_CALLS_PER_DIRECTIVE;
    const lines = await w.lines();
    assert.ok(lines.some((l) => /^Stopped: .*MODEL_CALLS_PER_DIRECTIVE/.test(l)));
    assert.equal(lines.at(-1), "Used 2 model calls and 2 file tool calls. Tokens: 20 in, 10 out.");
  });

  t("a failed message has no usage line, only the failure", async (w) => {
    const r = w.run([() => { throw Object.assign(new Error("boom"), { status: 500 }); }]);
    await r.step().catch(() => {});
    assert.ok(!(await w.lines()).some((l) => l.startsWith("Used ")));
  });
}

test("the usage line, case by case", () => {
  const line = (o) => usageLine({ modelCalls: 1, toolCalls: 0, usage: null, usageComplete: false, ...o });
  assert.equal(line({}), "Used 1 model call. Tokens: not reported.");
  assert.equal(line({ modelCalls: 3, toolCalls: 1, usage: { inputTokens: 1000000, outputTokens: 2 }, usageComplete: true }), "Used 3 model calls and 1 file tool call. Tokens: 1,000,000 in, 2 out.");
  assert.equal(line({ toolCalls: 12, usage: { inputTokens: 5, outputTokens: null }, usageComplete: true }), "Used 1 model call and 12 file tool calls. Tokens: 5 in, not reported out.");
});
