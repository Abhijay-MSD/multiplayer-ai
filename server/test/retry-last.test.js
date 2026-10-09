// Run: node --test test/   (no network, no real model)
// Retry: the controller sends their last message to the agent again. It is a new message in the room (so every rule for a
// message applies to it: who may send, the guest cap, the pace, the daily budget, the step cap), and it is refused while the
// agent is working.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { makers, cleanup, ageRoom } from "./helpers/stores.js";
import { createLimits } from "../limits.js";
import { claimStep } from "../budget.js";

const { createSession } = await import("../tools/create_session.js");
const { joinSession } = await import("../tools/join_session.js");
const { sendDirective } = await import("../tools/send_directive.js");
const { retryLast } = await import("../tools/retry_last.js");

after(cleanup);
const rejects = (promise, status, code) => assert.rejects(promise, (e) => e.status === status && e.code === code, `expected ${status} ${code}`);

for (const kind of ["memory", "sqlite"]) {
  async function world({ sharing = false } = {}) {
    const store = await makers[kind]();
    const triggered = [];
    const claims = [];
    const d = { db: store, trigger: (...a) => triggered.push(a), limits: createLimits({ env: {}, local: true }), budget: { claim: async () => (claims.push(1), {}) } };
    const room = await createSession({ task: "Plan a trip", creator_name: "Maya" }, { ...d, caller: { host: true, sharing } });
    const guest = await joinSession({ session_id: room.session_id, name: "Guest" }, d);
    return { store, d, id: room.session_id, host: room.token, guest: guest.token, triggered, claims };
  }
  const t = (title, fn) => test(`[${kind}] ${title}`, async () => fn(await world()));
  const retry = (w, token, opts = {}) => retryLast({ session_id: w.id, token }, { ...w.d, ...opts });

  t("it sends the controller's last message again as a new message, and the agent is asked to answer it", async (w) => {
    await sendDirective({ session_id: w.id, token: w.host, content: "second question" }, w.d);
    w.triggered.length = 0;
    const out = await retry(w, w.host);
    assert.equal(out.event.kind, "directive");
    assert.deepEqual([out.event.author, out.event.content], ["Maya", "second question"]);
    const directives = (await w.store.listEvents(w.id)).filter((e) => e.kind === "directive").map((e) => e.content);
    assert.deepEqual(directives, ["Plan a trip", "second question", "second question"]);
    assert.deepEqual(w.triggered, [[w.id, out.event.id]]);
  });

  t("with only the task sent so far, it sends the task again", async (w) => {
    const out = await retry(w, w.host);
    assert.equal(out.event.content, "Plan a trip");
  });

  t("it takes a step from the daily budget, like any message", async (w) => {
    await retry(w, w.host);
    assert.equal(w.claims.length, 1);
    const spent = await world();
    const env = { DAILY_STEP_BUDGET: "1" };
    await claimStep(spent.store, { env });
    await rejects(retry(spent, spent.host, { budget: { claim: (db) => claimStep(db, { env }) } }), 503, "AT_CAPACITY");
    assert.equal((await spent.store.listEvents(spent.id)).filter((e) => e.kind === "directive").length, 1, "nothing was written");
  });

  t("someone who is not the controller can't retry", async (w) => {
    await rejects(retry(w, w.guest), 403, "NOT_CONTROLLER");
    for (const token of [undefined, "", "nope", "mpai_" + "a".repeat(43)]) await rejects(retry(w, token), 401, "INVALID_TOKEN");
    assert.equal((await w.store.listEvents(w.id)).filter((e) => e.kind === "directive").length, 1);
  });

  t("it retries the controller's own message, not someone else's", async (w) => {
    await w.store.setController(w.id, "Guest");
    await rejects(retry(w, w.guest), 404, "NOTHING_TO_RETRY");
    await sendDirective({ session_id: w.id, token: w.guest, content: "guest question" }, w.d);
    const out = await retry(w, w.guest);
    assert.deepEqual([out.event.author, out.event.content], ["Guest", "guest question"]);
    await w.store.setController(w.id, "Maya");
    assert.equal((await retry(w, w.host)).event.content, "Plan a trip", "Maya's last message is still hers");
  });

  t("it is refused while the agent is working, and nothing is written", async (w) => {
    await w.store.updateSession(w.id, { agent_working: true });
    await rejects(retry(w, w.host), 409, "AGENT_WORKING");
    assert.equal((await w.store.listEvents(w.id)).filter((e) => e.kind === "directive").length, 1);
    await w.store.updateSession(w.id, { agent_working: false });
    assert.ok((await retry(w, w.host)).event);
  });

  t("it is a message like any other: paced, so too many in a minute are refused", async (w) => {
    for (let i = 0; i < 6; i++) await retry(w, w.host);
    await rejects(retry(w, w.host), 429, "RATE_LIMITED");
  });

  t("in a shared room a guest who holds control can't use retry to get past the host's limit on guest messages", async () => {
    const w = await world({ sharing: true });
    await w.store.updateSession(w.id, { guest_step_cap: 2 });
    await w.store.setController(w.id, "Guest");
    const d = { ...w.d, caller: { host: false, sharing: true } };
    await sendDirective({ session_id: w.id, token: w.guest, content: "one" }, d);
    await retryLast({ session_id: w.id, token: w.guest }, d);
    await rejects(retryLast({ session_id: w.id, token: w.guest }, d), 429, "GUEST_CAP");
  });

  t("an archived or ended room can't be retried in", async (w) => {
    await w.store.updateSession(w.id, { status: "done" });
    await rejects(retry(w, w.host), 410, "ROOM_ENDED");
    const w2 = await world();
    ageRoom(w2.store, w2.id, 30 * 86_400_000);
    await rejects(retry(w2, w2.host), 410, "ROOM_ARCHIVED");
  });
}
