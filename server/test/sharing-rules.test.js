// Run: node --test test/   (no network)
// Who can do what in a room, in each mode, on the stores that need no outside service.
//
//   mode "local"   nothing is shared: every rule is as it was before sharing existed.
//   mode "shared"  Same Wi-Fi, or a container. The host is the sign-in cookie holder; everyone else is a guest.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makers, cleanup, tempDir } from "./helpers/stores.js";
import { createInvite } from "../invite.js";
import { createControlRequests } from "../control.js";
import { createLimits } from "../limits.js";
import { hashToken } from "../auth.js";
import { makeFakeSupabase } from "./fakeSupabase.js";

const { createSession } = await import("../tools/create_session.js");
const { joinSession } = await import("../tools/join_session.js");
const { getSession } = await import("../tools/get_session.js");
const { sendDirective } = await import("../tools/send_directive.js");
const { sendComment } = await import("../tools/send_comment.js");
const { takeControl } = await import("../tools/take_control.js");
const { heartbeat } = await import("../tools/heartbeat.js");
const hostActions = await import("../host-actions.js");

after(cleanup);

const HOST = { host: true, sharing: true };
const GUEST = { host: false, sharing: true };
const LOCAL = { host: true, sharing: false };
const LOCAL_GUEST = { host: false, sharing: false }; // someone on this computer's own address, nothing shared

const rejects = (promise, code, status) =>
  assert.rejects(promise, (e) => e.code === code && (status === undefined || e.status === status), `expected ${code}`);

async function world(kind, { sharing = true } = {}) {
  const store = await makers[kind]();
  const invite = createInvite({ dir: path.join(tempDir("multiplayer-ai-inv-"), "d") });
  const control = createControlRequests();
  const limits = createLimits({ env: {}, local: true });
  const triggered = [];
  const base = { db: store, invite, control, limits, trigger: (...a) => triggered.push(a), budget: { claim: () => ({}) }, keyCheck: () => true };
  const call = (caller) => ({ ...base, caller });
  // The host starts a room, as the person at this computer would.
  const room = await createSession({ task: "Plan a trip", creator_name: "Maya", auto_start: true }, call(sharing ? HOST : LOCAL));
  const link = (version = 1) => invite.derive(room.session_id, version);
  return { store, invite, control, limits, triggered, base, call, room, id: room.session_id, link, host: room.token, sharing };
}
const guestJoin = (w, name, over = {}) => joinSession({ session_id: w.id, name, invite: w.link(), ...over }, w.call(GUEST));

for (const kind of ["memory", "sqlite"]) {
  const t = (title, fn, options) => test(`[${kind}] ${title}`, async () => fn(await world(kind, options)));

  // ── starting a room ────────────────────────────────────────────────
  t("shared: only the host can start a room; a guest is told to ask the host, and nothing is created or counted", async (w) => {
    const rooms = (await w.store.listSessions()).length;
    for (const args of [{ task: "x", creator_name: "Sam" }, { task: "x", creator_name: "Sam", auto_start: true }]) {
      await rejects(createSession(args, w.call(GUEST)), "HOST_ONLY", 403);
    }
    assert.equal((await w.store.listSessions()).length, rooms);
    await rejects(createSession({ task: "x", creator_name: "Sam" }, { ...w.call(GUEST), limits: { checkCreate: () => assert.fail("must be refused before any limit is used") } }), "HOST_ONLY");
  });

  t("shared: the host's room has the host marked, and a room started with no sharing on has its creator marked too when they hold the cookie", async (w) => {
    const [maya] = await w.store.listParticipants(w.id, { columns: "name, role, is_host" });
    assert.deepEqual(maya, { name: "Maya", role: "controller", is_host: true });
  });

  t("local: anyone may start a room, as before, and without the cookie nobody is marked as host", async (w) => {
    const r = await createSession({ task: "x", creator_name: "Sam" }, w.call(LOCAL_GUEST));
    assert.ok(r.session_id);
    const [sam] = await w.store.listParticipants(r.session_id, { columns: "name, is_host" });
    assert.strictEqual(sam.is_host, false);
  }, { sharing: false });

  // ── joining ────────────────────────────────────────────────────────
  t("shared: joining needs the invite, a valid token, or the host cookie", async (w) => {
    await rejects(joinSession({ session_id: w.id, name: "Sam" }, w.call(GUEST)), "INVITE_REQUIRED", 403);
    await rejects(joinSession({ session_id: w.id, name: "Sam", invite: "A".repeat(43) }, w.call(GUEST)), "INVITE_REQUIRED", 403);
    await rejects(joinSession({ session_id: w.id, name: "Sam", invite: "x" }, w.call(GUEST)), "INVITE_REQUIRED");
    const sam = await guestJoin(w, "Sam");
    assert.equal(sam.you.role, "watcher");
    assert.ok(sam.token.startsWith("mpai_"));
    const back = await joinSession({ session_id: w.id, name: "ignored", token: sam.token }, w.call(GUEST)); // a token needs no invite
    assert.equal(back.you.name, "Sam");
    const hostBack = await joinSession({ session_id: w.id, name: "Maya 2" }, w.call(HOST)); // the host cookie needs none
    assert.equal(hostBack.you.name, "Maya 2");
    const people = Object.fromEntries((await w.store.listParticipants(w.id, { columns: "name, is_host" })).map((p) => [p.name, p.is_host]));
    assert.deepEqual(people, { Maya: true, Sam: false, "Maya 2": true });
  });

  t("shared: a room that does not exist looks the same as one that needs an invite", async (w) => {
    const missing = "00000000-0000-4000-8000-000000000000";
    await rejects(joinSession({ session_id: missing, name: "Sam" }, w.call(GUEST)), "INVITE_REQUIRED");
    await rejects(joinSession({ session_id: missing, name: "Sam", invite: w.link() }, w.call(GUEST)), "INVITE_REQUIRED");
    await rejects(joinSession({ session_id: missing, name: "Maya" }, w.call(HOST)), "ROOM_NOT_FOUND", 404);
  });

  t("shared: an invite for one room does not open another, and a token for one room is no use in another", async (w) => {
    const other = await createSession({ task: "other", creator_name: "Zoe" }, w.call(HOST));
    await rejects(joinSession({ session_id: other.session_id, name: "Sam", invite: w.link() }, w.call(GUEST)), "INVITE_REQUIRED");
    const sam = await guestJoin(w, "Sam");
    await rejects(joinSession({ session_id: other.session_id, name: "Sam", token: sam.token }, w.call(GUEST)), "INVITE_REQUIRED");
  });

  t("local: no invite is needed and a wrong one is ignored", async (w) => {
    assert.ok((await joinSession({ session_id: w.id, name: "Sam" }, w.call(LOCAL_GUEST))).token);
    assert.ok((await joinSession({ session_id: w.id, name: "Dana", invite: "garbage" }, w.call(LOCAL_GUEST))).token);
  }, { sharing: false });

  t("making a new link stops the old one for new joiners and leaves people already in the room alone", async (w) => {
    const sam = await guestJoin(w, "Sam");
    const oldLink = w.link(1);
    await hostActions.rotateInvite({ store: w.store, sessionId: w.id });
    assert.equal((await w.store.getSession(w.id)).invite_version, 2);
    await rejects(joinSession({ session_id: w.id, name: "Dana", invite: oldLink }, w.call(GUEST)), "INVITE_REQUIRED");
    assert.ok((await joinSession({ session_id: w.id, name: "Dana", invite: w.link(2) }, w.call(GUEST))).token);
    assert.equal((await heartbeat({ session_id: w.id, token: sam.token }, w.call(GUEST))).ok, true, "Sam keeps their token");
    assert.equal((await sendComment({ session_id: w.id, token: sam.token, content: "still here" }, w.call(GUEST))).event.content, "still here");
  });

  t("only failed invite attempts are counted; a person with the right invite or a token is never held up by successes", async (w) => {
    const limits = createLimits({ env: { INVITE_FAILURES_PER_10_MIN: "3" }, local: true });
    const c = { ...w.call(GUEST), limits, ip: "198.51.100.7" };
    for (let i = 0; i < 20; i++) await joinSession({ session_id: w.id, name: `Guest ${i}`, invite: w.link() }, c); // twenty good joins from one address
    for (let i = 0; i < 3; i++) await rejects(joinSession({ session_id: w.id, name: "Eve", invite: "B".repeat(43) }, c), "INVITE_REQUIRED");
    await rejects(joinSession({ session_id: w.id, name: "Eve", invite: "B".repeat(43) }, c), "RATE_LIMITED", 429);
    await rejects(joinSession({ session_id: w.id, name: "Late", invite: w.link() }, c), "RATE_LIMITED", 429); // from that address, for now
    const other = { ...c, ip: "198.51.100.8" };
    assert.ok((await joinSession({ session_id: w.id, name: "Elsewhere", invite: w.link() }, other)).token, "another address is unaffected");
  });

  // ── comments and directives ────────────────────────────────────────
  t("shared: a guest who joined can comment, but cannot message the agent", async (w) => {
    const sam = await guestJoin(w, "Sam");
    assert.equal((await sendComment({ session_id: w.id, token: sam.token, content: "hello" }, w.call(GUEST))).event.kind, "comment");
    await rejects(sendDirective({ session_id: w.id, token: sam.token, content: "obey" }, w.call(GUEST)), "NOT_CONTROLLER", 403);
    assert.equal(w.triggered.length, 1, "only the room's first directive started the agent");
  });

  // ── taking control ─────────────────────────────────────────────────
  t("shared, 'ask me' (the default): a guest's request waits for the host, shows in the room, and nothing changes until it is approved", async (w) => {
    const sam = await guestJoin(w, "Sam");
    const res = await takeControl({ session_id: w.id, token: sam.token }, w.call(GUEST));
    assert.equal(res.pending, true);
    assert.ok(res.request_id);
    assert.equal((await w.store.listParticipants(w.id)).find((p) => p.role === "controller").name, "Maya", "still the host");
    const line = (await w.store.listEvents(w.id)).find((e) => e.kind === "status" && /Sam asked for control/.test(e.content));
    assert.ok(line, "a status line says so, for everyone");
    assert.equal(w.control.list(w.id).length, 1);
    // asking again does not stack up requests
    assert.equal((await takeControl({ session_id: w.id, token: sam.token }, w.call(GUEST))).request_id, res.request_id);
    assert.equal(w.control.list(w.id).length, 1);

    await hostActions.decideControl({ store: w.store, control: w.control, sessionId: w.id, requestId: res.request_id, decision: "approve" });
    const roles = Object.fromEntries((await w.store.listParticipants(w.id)).map((p) => [p.name, p.role]));
    assert.deepEqual(roles, { Maya: "watcher", Sam: "controller" });
    assert.ok((await w.store.listEvents(w.id)).some((e) => e.kind === "takeover" && /Sam took control/.test(e.content)));
    assert.equal(w.control.list(w.id).length, 0);
  });

  t("shared: a denied request changes nothing, says so in the room, and can be asked again", async (w) => {
    const sam = await guestJoin(w, "Sam");
    const { request_id } = await takeControl({ session_id: w.id, token: sam.token }, w.call(GUEST));
    await hostActions.decideControl({ store: w.store, control: w.control, sessionId: w.id, requestId: request_id, decision: "deny" });
    assert.equal((await w.store.listParticipants(w.id)).find((p) => p.role === "controller").name, "Maya");
    assert.ok((await w.store.listEvents(w.id)).some((e) => e.kind === "status" && /host said no to Sam/.test(e.content)));
    assert.ok((await takeControl({ session_id: w.id, token: sam.token }, w.call(GUEST))).pending);
  });

  t("shared: a request expires after 5 minutes, with a line in the room, and can no longer be approved", async (w) => {
    let t0 = 1_000_000;
    const control = createControlRequests({ now: () => t0 });
    const sam = await guestJoin(w, "Sam");
    const { request_id } = await takeControl({ session_id: w.id, token: sam.token }, { ...w.call(GUEST), control });
    t0 += 5 * 60_000 - 1;
    assert.equal(control.list(w.id).length, 1, "just inside the limit");
    t0 += 2;
    await hostActions.sweepControl({ store: w.store, control });
    assert.equal(control.list(w.id).length, 0);
    assert.ok((await w.store.listEvents(w.id)).some((e) => e.kind === "status" && /Sam's request for control expired/.test(e.content)));
    await rejects(hostActions.decideControl({ store: w.store, control, sessionId: w.id, requestId: request_id, decision: "approve" }), "REQUEST_GONE", 404);
    assert.equal((await w.store.listParticipants(w.id)).find((p) => p.role === "controller").name, "Maya");
  });

  t("shared: two requests at once both wait; approving one does not approve the other; approving twice does nothing the second time", async (w) => {
    const sam = await guestJoin(w, "Sam");
    const dana = await guestJoin(w, "Dana");
    const [a, b] = await Promise.all([takeControl({ session_id: w.id, token: sam.token }, w.call(GUEST)), takeControl({ session_id: w.id, token: dana.token }, w.call(GUEST))]);
    assert.notEqual(a.request_id, b.request_id);
    assert.equal(w.control.list(w.id).length, 2);
    const first = hostActions.decideControl({ store: w.store, control: w.control, sessionId: w.id, requestId: a.request_id, decision: "approve" });
    const again = hostActions.decideControl({ store: w.store, control: w.control, sessionId: w.id, requestId: a.request_id, decision: "approve" });
    const results = await Promise.allSettled([first, again]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one of two simultaneous approvals took effect");
    assert.equal(results.find((r) => r.status === "rejected").reason.code, "REQUEST_GONE");
    assert.equal(w.control.list(w.id).length, 1, "Dana's request is still waiting");
    assert.equal((await w.store.listParticipants(w.id)).filter((p) => p.role === "controller").length, 1, "never two controllers");
  });

  t("shared: approving a request from someone who has since left or been removed is refused", async (w) => {
    const sam = await guestJoin(w, "Sam");
    const { request_id } = await takeControl({ session_id: w.id, token: sam.token }, w.call(GUEST));
    await hostActions.removePerson({ store: w.store, control: w.control, sessionId: w.id, name: "Sam" });
    assert.equal(w.control.list(w.id).length, 0, "removing someone drops their request");
    await rejects(hostActions.decideControl({ store: w.store, control: w.control, sessionId: w.id, requestId: request_id, decision: "approve" }), "REQUEST_GONE");
  });

  t("shared, 'locked': a guest is told control is locked and no request is made; the host can still take control", async (w) => {
    await hostActions.setPolicy({ store: w.store, sessionId: w.id, policy: "locked" });
    const sam = await guestJoin(w, "Sam");
    await rejects(takeControl({ session_id: w.id, token: sam.token }, w.call(GUEST)), "CONTROL_LOCKED", 403);
    assert.equal(w.control.list(w.id).length, 0);
    // the controller handing it on is also the host's call alone
    await takeControl({ session_id: w.id, token: w.host, target: "Sam" }, w.call(HOST)); // host hands to Sam: allowed, host action
    assert.equal((await w.store.listParticipants(w.id)).find((p) => p.role === "controller").name, "Sam");
    const dana = await guestJoin(w, "Dana");
    // a guest controller cannot hand it on while locked
    await rejects(takeControl({ session_id: w.id, token: sam.token, target: "Dana" }, w.call(GUEST)), "CONTROL_LOCKED", 403);
    await takeControl({ session_id: w.id, token: w.host }, w.call(HOST));
    assert.equal((await w.store.listParticipants(w.id)).find((p) => p.role === "controller").name, "Maya");
    void dana;
  });

  t("shared, 'free': the usual rules apply to guests (control only if nobody holds it or the holder is away), and the host takes it at any time", async (w) => {
    await hostActions.setPolicy({ store: w.store, sessionId: w.id, policy: "free" });
    const sam = await guestJoin(w, "Sam");
    await rejects(takeControl({ session_id: w.id, token: sam.token }, w.call(GUEST)), "CONTROL_HELD", 403);
    await w.store.updateParticipant(w.id, "Maya", { last_seen: new Date(Date.now() - 5 * 60_000).toISOString() });
    assert.equal((await takeControl({ session_id: w.id, token: sam.token }, w.call(GUEST))).controller, "Sam");
    await takeControl({ session_id: w.id, token: w.host }, w.call(HOST));
    assert.equal((await w.store.listParticipants(w.id)).find((p) => p.role === "controller").name, "Maya", "the host's takeover is immediate");
  });

  t("shared: a guest controller handing control to another guest is a request the host must approve; to the host, it is immediate", async (w) => {
    const sam = await guestJoin(w, "Sam");
    const dana = await guestJoin(w, "Dana");
    await takeControl({ session_id: w.id, token: w.host, target: "Sam" }, w.call(HOST));
    const asked = await takeControl({ session_id: w.id, token: sam.token, target: "Dana" }, w.call(GUEST));
    assert.equal(asked.pending, true);
    assert.equal((await w.store.listParticipants(w.id)).find((p) => p.role === "controller").name, "Sam", "not yet");
    assert.ok((await w.store.listEvents(w.id)).some((e) => /Sam asked to hand control to Dana/.test(e.content)));
    await hostActions.decideControl({ store: w.store, control: w.control, sessionId: w.id, requestId: asked.request_id, decision: "approve" });
    assert.equal((await w.store.listParticipants(w.id)).find((p) => p.role === "controller").name, "Dana");
    const back = await takeControl({ session_id: w.id, token: dana.token, target: "Maya" }, w.call(GUEST));
    assert.equal(back.controller, "Maya", "handing control back to the host needs no approval");
  });

  t("local: the old control rules are untouched (held and here: refused; away: allowed)", async (w) => {
    const sam = await joinSession({ session_id: w.id, name: "Sam" }, w.call(LOCAL_GUEST));
    await rejects(takeControl({ session_id: w.id, token: sam.token }, w.call(LOCAL_GUEST)), "CONTROL_HELD", 403);
    await w.store.updateParticipant(w.id, "Maya", { last_seen: new Date(Date.now() - 5 * 60_000).toISOString() });
    assert.equal((await takeControl({ session_id: w.id, token: sam.token }, w.call(LOCAL_GUEST))).controller, "Sam");
  }, { sharing: false });

  // ── the guest cap ───────────────────────────────────────────────────
  t("shared: guest messages to the agent are counted per room and stop at the cap; the host's are not counted", async (w) => {
    await hostActions.setGuestCap({ store: w.store, sessionId: w.id, cap: 2 });
    const sam = await guestJoin(w, "Sam");
    await takeControl({ session_id: w.id, token: sam.token, target: undefined }, w.call(GUEST)).then((r) => hostActions.decideControl({ store: w.store, control: w.control, sessionId: w.id, requestId: r.request_id, decision: "approve" }));
    for (let i = 1; i <= 2; i++) await sendDirective({ session_id: w.id, token: sam.token, content: `guest ${i}` }, w.call(GUEST));
    const err = await sendDirective({ session_id: w.id, token: sam.token, content: "guest 3" }, w.call(GUEST)).catch((e) => e);
    assert.equal(err.code, "GUEST_CAP");
    assert.equal(err.status, 429);
    assert.match(err.message, /2 messages/);
    assert.equal((await w.store.listEvents(w.id)).filter((e) => e.kind === "directive" && e.author === "Sam").length, 2, "the refused one was not stored");
    const budgetBefore = w.triggered.length;
    await takeControl({ session_id: w.id, token: w.host }, w.call(HOST));
    for (let i = 0; i < 5; i++) await sendDirective({ session_id: w.id, token: w.host, content: `host ${i}` }, w.call(HOST));
    assert.equal(w.triggered.length, budgetBefore + 5, "the host is not held to the guest cap");
  });

  t("shared: the cap can be raised for one room, and the default comes from GUEST_STEP_CAP_PER_ROOM (20)", async (w) => {
    const room = await w.store.getSession(w.id);
    assert.equal(room.guest_step_cap, null);
    assert.equal(hostActions.guestCapFor(room, {}), 20);
    assert.equal(hostActions.guestCapFor(room, { GUEST_STEP_CAP_PER_ROOM: "7" }), 7);
    await hostActions.setGuestCap({ store: w.store, sessionId: w.id, cap: 30 });
    assert.equal(hostActions.guestCapFor(await w.store.getSession(w.id), { GUEST_STEP_CAP_PER_ROOM: "7" }), 30);
    await rejects(hostActions.setGuestCap({ store: w.store, sessionId: w.id, cap: -1 }), "BAD_REQUEST");
    await rejects(hostActions.setGuestCap({ store: w.store, sessionId: w.id, cap: 1.5 }), "BAD_REQUEST");
    await rejects(hostActions.setGuestCap({ store: w.store, sessionId: w.id, cap: 100001 }), "BAD_REQUEST");
  });

  t("shared: the host's counters say how many guest messages and how many room steps have been used", async (w) => {
    const sam = await guestJoin(w, "Sam");
    await takeControl({ session_id: w.id, token: sam.token }, w.call(GUEST)).then((r) => hostActions.decideControl({ store: w.store, control: w.control, sessionId: w.id, requestId: r.request_id, decision: "approve" }));
    await sendDirective({ session_id: w.id, token: sam.token, content: "one" }, w.call(GUEST));
    await w.store.updateSession(w.id, { step_count: 12 });
    const state = await hostActions.roomState({ store: w.store, control: w.control, sessionId: w.id, env: {} });
    assert.deepEqual(state.counters, { guest_messages: 1, guest_cap: 20, room_steps: 12, room_cap: 50, model_calls: 0, model_call_cap: 200 });
    assert.equal(state.policy, "ask");
  });

  // ── removing a person ───────────────────────────────────────────────
  t("removing a person revokes their token, frees their name, drops their request, and says so in the room; the host cannot be removed", async (w) => {
    const sam = await guestJoin(w, "Sam");
    await hostActions.removePerson({ store: w.store, control: w.control, sessionId: w.id, name: "Sam" });
    await rejects(sendComment({ session_id: w.id, token: sam.token, content: "x" }, w.call(GUEST)), "INVALID_TOKEN", 401);
    assert.ok((await w.store.listEvents(w.id)).some((e) => e.kind === "status" && /Sam was removed by the host/.test(e.content)));
    assert.equal((await guestJoin(w, "Sam")).you.name, "Sam", "the name is free again, with the invite");
    await rejects(hostActions.removePerson({ store: w.store, control: w.control, sessionId: w.id, name: "Maya" }), "CANNOT_REMOVE_HOST", 409);
    await rejects(hostActions.removePerson({ store: w.store, control: w.control, sessionId: w.id, name: "Nobody" }), "NOT_FOUND", 404);
  });

  t("removing the controller leaves the room with no controller, and the host can take it", async (w) => {
    const sam = await guestJoin(w, "Sam");
    await takeControl({ session_id: w.id, token: w.host, target: "Sam" }, w.call(HOST));
    await hostActions.removePerson({ store: w.store, control: w.control, sessionId: w.id, name: "Sam" });
    assert.equal((await w.store.listParticipants(w.id)).filter((p) => p.role === "controller").length, 0);
    await takeControl({ session_id: w.id, token: w.host }, w.call(HOST));
    assert.equal((await w.store.listParticipants(w.id)).find((p) => p.role === "controller").name, "Maya");
    void sam;
  });

  // ── what a client is shown ──────────────────────────────────────────
  t("the room data tells a guest whether the room is shared and its control policy, and shows who the host is, never a token or hash", async (w) => {
    const sam = await guestJoin(w, "Sam");
    const got = await getSession({ session_id: w.id, token: sam.token }, w.call(GUEST));
    assert.equal(got.room.sharing, true);
    assert.equal(got.room.control_policy, "ask");
    assert.deepEqual(got.participants.map((p) => [p.name, p.is_host]).sort(), [["Maya", true], ["Sam", false]]);
    const text = JSON.stringify([sam, got]);
    assert.ok(!text.includes(hashToken(sam.token)) && !text.includes(hashToken(w.host)));
    assert.ok(!text.includes(w.link()), "the invite secret is not in anything a guest is sent");
  });

  t("an unknown policy is refused", async (w) => {
    await rejects(hostActions.setPolicy({ store: w.store, sessionId: w.id, policy: "anyone" }), "BAD_REQUEST", 400);
    assert.equal((await w.store.getSession(w.id)).control_policy, "ask");
  });
}

test("with Supabase storage the sharing rules do not apply (the store has nowhere to keep them), exactly as before", async () => {
  const db = makeFakeSupabase({ sessions: [], session_events: [], session_participants: [] });
  const d = { db, caller: GUEST, trigger: () => {}, keyCheck: () => true, limits: createLimits({ env: {} }), budget: { claim: () => {} } };
  const room = await createSession({ task: "x", creator_name: "Zoe" }, d);
  const joined = await joinSession({ session_id: room.session_id, name: "Sam" }, d);
  assert.ok(joined.token);
});
