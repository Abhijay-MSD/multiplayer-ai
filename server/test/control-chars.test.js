// Run: node --test test/   (no network, made-up keys)
// Control characters in text a stranger controls: a participant's name, a room's title, and the words a provider
// answers with. Names and titles that hold them are refused when they are set. Everything untrusted that is written
// to the terminal is escaped, so an escape sequence, a carriage return or a text-direction override cannot repaint
// the host's terminal, fake a log line or hide what a name really says. Provider words never reach the room at all.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import util from "node:util";
import { makers, cleanup, tempDir } from "./helpers/stores.js";
import { createInvite } from "../invite.js";
import { createControlRequests } from "../control.js";
import { createLimits } from "../limits.js";
import { newCredential } from "../auth.js";
import { CATEGORY_MESSAGES } from "../providers/failure.js";

process.env.DIRECTIVE_LIMIT_PER_MIN ||= "10000";
const { createSession } = await import("../tools/create_session.js");
const { joinSession } = await import("../tools/join_session.js");
const { takeControl } = await import("../tools/take_control.js");
const { setStepDeps, stepAgent } = await import("../tools/step_agent.js");
const { callModel } = await import("../providers/index.js");

after(cleanup);

// Anything that is not a printable character: C0 and C1 controls, the "format" characters (which include every
// text-direction override, isolate and mark, zero-width characters and the byte-order mark), line and paragraph
// separators, and lone surrogates.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const HOSTILE = {
  "an ESC sequence that clears the screen": "Sam\x1b[2J",
  "an ESC colour sequence": "\x1b[31mSam",
  "an ESC operating-system command (sets the window title)": "Sam\x1b]0;pwned\x07",
  "a carriage return": "Sam\rAdmin",
  "a line feed": "Sam\nFAKE LOG LINE",
  "a carriage return and a line feed": "Sam\r\n[multiplayer-ai] all clear",
  "a NUL": "Sam\x00",
  "a bell and a backspace": "Sam\x07\x08",
  "a delete": "Sam\x7f",
  "a tab": "Sam\tAdmin",
  "a C1 control sequence introducer": "Sam\x9b31m",
  "a C1 next-line and OSC": "Sam\x85\x9d",
  "a right-to-left override": "Sam\u202eEvil",
  "a left-to-right override": "Sam\u202dEvil",
  "a text-direction isolate": "Sam\u2066Evil\u2069",
  "a text-direction mark": "Sam\u200fEvil",
  "an Arabic letter mark": "Sam\u061cEvil",
  "a line separator": "Sam\u2028Admin",
  "a paragraph separator": "Sam\u2029Admin",
  "a zero-width space": "Sam\u200bAdmin",
  "a byte-order mark": "\ufeffSam"
};

/** Everything written with console.* while it runs, as the terminal would get it, by stream. */
function capture() {
  const lines = [];
  const original = {};
  for (const m of ["log", "info", "debug", "warn", "error"]) {
    original[m] = console[m];
    console[m] = (...a) => lines.push({ stream: m === "log" || m === "info" || m === "debug" ? "stdout" : "stderr", text: util.format(...a) });
  }
  return {
    lines,
    stop: () => Object.assign(console, original),
    unsafe: () => lines.filter((l) => UNSAFE.test(l.text)).map((l) => `${l.stream}: ${JSON.stringify(l.text).slice(0, 200)}`)
  };
}

async function world() {
  const store = await makers.memory();
  const invite = createInvite({ dir: path.join(tempDir("multiplayer-ai-inv-"), "d") });
  const base = { db: store, invite, control: createControlRequests(), limits: createLimits({ env: {}, local: true }), trigger: () => {}, budget: { claim: () => ({}) }, keyCheck: () => true };
  const HOST = { host: true, sharing: true };
  const GUEST = { host: false, sharing: true };
  const room = await createSession({ task: "Plan a trip", creator_name: "Maya" }, { ...base, caller: HOST });
  return { store, invite, base, HOST, GUEST, room, id: room.session_id, link: () => invite.derive(room.session_id, 1) };
}

const rejects = (promise, code) => assert.rejects(promise, (e) => e.status === 400 && e.code === code && !UNSAFE.test(e.message), `expected ${code}, without echoing the text`);

// ── Names ────────────────────────────────────────────────────────────

for (const [what, name] of Object.entries(HOSTILE)) {
  test(`a name with ${what} is refused when someone creates a room`, async () => {
    const w = await world();
    const before = (await w.store.listSessions?.())?.length;
    await rejects(createSession({ task: "x", creator_name: name }, { ...w.base, caller: w.HOST }), "INVALID_NAME");
    if (before !== undefined) assert.equal((await w.store.listSessions()).length, before, "no room was made");
  });

  test(`a name with ${what} is refused when someone joins, and nothing is written`, async () => {
    const w = await world();
    const people = (await w.store.listParticipants(w.id)).length;
    const events = (await w.store.listEvents(w.id)).length;
    await rejects(joinSession({ session_id: w.id, name, invite: w.link() }, { ...w.base, caller: w.GUEST }), "INVALID_NAME");
    assert.equal((await w.store.listParticipants(w.id)).length, people);
    assert.equal((await w.store.listEvents(w.id)).length, events);
  });
}

test("ordinary names, including other scripts and emoji, are still accepted", async () => {
  const w = await world();
  for (const name of ["Sam", "Zoë", "李雷", "Sam O'Neil", "Ann-Marie", "Sam 🙂", "  Sam   Jr  "]) {
    const r = await joinSession({ session_id: w.id, name, invite: w.link() }, { ...w.base, caller: w.GUEST });
    assert.equal(r.you.name, name.trim().replace(/\s+/g, " "));
  }
});

test("refusing a name logs nothing and prints nothing", async () => {
  const w = await world();
  const c = capture();
  try {
    for (const name of Object.values(HOSTILE)) {
      await joinSession({ session_id: w.id, name, invite: w.link() }, { ...w.base, caller: w.GUEST }).catch(() => {});
    }
  } finally {
    c.stop();
  }
  assert.deepEqual(c.lines, []);
});

// ── Titles ───────────────────────────────────────────────────────────

for (const [what, text] of Object.entries(HOSTILE)) {
  test(`a title with ${what} is refused, and no room is made`, async () => {
    const w = await world();
    await rejects(createSession({ task: "x", title: `Weekly ${text} sync`, creator_name: "Ann" }, { ...w.base, caller: w.HOST }), "INVALID_TITLE");
  });
}

test("an ordinary title is kept as it was typed", async () => {
  const w = await world();
  const r = await createSession({ task: "x", title: "  Weekly sync: Zoë, 李雷 🙂  ", creator_name: "Ann" }, { ...w.base, caller: w.HOST });
  assert.equal(r.title, "Weekly sync: Zoë, 李雷 🙂");
});

test("with no title, the one made from the task has no control characters (the task itself may span lines)", async () => {
  const w = await world();
  const task = "Line one\r\nline two \x1b[31mred\x1b[0m \u202edone";
  const r = await createSession({ task, creator_name: "Ann" }, { ...w.base, caller: w.HOST });
  assert.ok(!UNSAFE.test(r.title), JSON.stringify(r.title));
  assert.ok(r.title.startsWith("Line one"), r.title);
  assert.equal((await w.store.getSession(r.session_id)).title, r.title);
  const first = (await w.store.listEvents(r.session_id)).find((e) => e.kind === "directive");
  assert.equal(first.content, task, "the task is saved as written");
});

// ── The terminal: names that were stored before names were checked ───

test('the "asked for control" line is escaped in the terminal and in the room, whatever the stored name is', async () => {
  const w = await world();
  // A name from before names were checked: the store accepts it, as an older data file may hold it.
  const old = newCredential();
  const name = "Sam\x1b[2J\r\nFAKE\x9b\u202e";
  await w.store.insertParticipant({ session_id: w.id, name, role: "watcher", last_seen: new Date().toISOString(), ...old.columns });
  const c = capture();
  try {
    const r = await takeControl({ session_id: w.id, token: old.token }, { ...w.base, caller: w.GUEST });
    assert.equal(r.pending, true);
  } finally {
    c.stop();
  }
  assert.deepEqual(c.unsafe(), []);
  const asked = c.lines.find((l) => /asked for control/.test(l.text));
  assert.ok(asked, "the line is still printed");
  assert.match(asked.text, /Sam\\x1b\[2J\\x0d\\x0aFAKE\\x9b\\u\{202e\} asked for control/, "and it shows what the name really holds");
  const status = (await w.store.listEvents(w.id)).find((e) => e.kind === "status" && /asked for control/.test(e.content));
  assert.ok(status && !UNSAFE.test(status.content), JSON.stringify(status?.content));
});

// ── Provider error text ──────────────────────────────────────────────

const HOSTILE_TEXT = "Bad request \x1b[2J\x1b[31mRED\x1b]0;pwned\x07\r\n[multiplayer-ai] step ok\x9b31m\x85 \u202eexe.txt\u2066 \u2028end";
const KEY = "ctrlchars_made_up_key_9f8e7d6c5b4a";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
// How each provider words an error, with the hostile text in every field it may carry.
const ERRORS = {
  groq: { env: "GROQ_API_KEY", body: { error: { message: HOSTILE_TEXT, type: `t${HOSTILE_TEXT}`, code: `c${HOSTILE_TEXT}`, failed_generation: HOSTILE_TEXT } } },
  compat: { env: "OPENAI_COMPAT_API_KEY", body: { error: { message: HOSTILE_TEXT, type: HOSTILE_TEXT } } },
  claude: { env: "ANTHROPIC_API_KEY", body: { type: "error", error: { type: HOSTILE_TEXT, message: HOSTILE_TEXT } } },
  gemini: { env: "GEMINI_API_KEY", body: { error: { message: HOSTILE_TEXT, status: HOSTILE_TEXT } } }
};

function useProvider(provider) {
  for (const v of ["GROQ_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_COMPAT_API_KEY", "GROQ_FALLBACK_MODEL", "GEMINI_FALLBACK_MODEL"]) delete process.env[v];
  process.env[ERRORS[provider].env] = KEY;
  if (provider === "compat") Object.assign(process.env, { OPENAI_COMPAT_BASE_URL: "https://api.example.test/v1", OPENAI_COMPAT_MODEL: "m1" });
}

for (const provider of Object.keys(ERRORS)) {
  for (const status of [400, 401, 500]) {
    test(`${provider}: a ${status} whose text is full of control characters reaches the room as a category only, and the terminal gets it escaped`, async () => {
      useProvider(provider);
      const w = await world();
      const fetchImpl = async () => json(status, ERRORS[provider].body);
      const saved = globalThis.fetch;
      if (provider === "gemini") globalThis.fetch = fetchImpl;
      setStepDeps({ db: w.store, summarize: async () => {}, call: ({ messages }) => callModel({ provider, messages, fetchImpl, maxRetries: 0, maxParseRetries: 0 }) });
      const c = capture();
      try {
        await stepAgent({ session_id: w.id, token: w.room.token }).catch(() => {});
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        c.stop();
        globalThis.fetch = saved;
      }
      assert.deepEqual(c.unsafe(), [], "nothing raw reached stdout or stderr");
      assert.ok(c.lines.some((l) => /step failed/.test(l.text)), "the failure is still reported to the terminal");
      const statuses = (await w.store.listEvents(w.id)).filter((e) => e.kind === "status");
      assert.equal(statuses.length, 1);
      assert.match(statuses[0].content, /^Agent could not reply: /);
      assert.ok(Object.values(CATEGORY_MESSAGES).some((m) => statuses[0].content === `Agent could not reply: ${m}`), statuses[0].content);
      assert.ok(!UNSAFE.test(statuses[0].content) && !/pwned|RED|exe\.txt/.test(statuses[0].content), "none of the provider's words are in the room");
    });
  }
}

test("the escaped terminal line still says what the provider said", async () => {
  useProvider("groq");
  const w = await world();
  const fetchImpl = async () => json(400, ERRORS.groq.body);
  setStepDeps({ db: w.store, summarize: async () => {}, call: ({ messages }) => callModel({ provider: "groq", messages, fetchImpl, maxRetries: 0, maxParseRetries: 0 }) });
  const c = capture();
  try {
    await stepAgent({ session_id: w.id, token: w.room.token }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    c.stop();
  }
  const failed = c.lines.find((l) => /step failed/.test(l.text));
  assert.match(failed.text, /Bad request \\x1b\[2J\\x1b\[31mRED/);
  assert.ok(!failed.text.includes("\n"), "a provider cannot add a line to the log");
});

test("Test key: the terminal gets the provider's words escaped, and the page gets none of them", async () => {
  const { testKey } = await import("../key-test.js");
  const call = async () => { throw Object.assign(new Error(`Groq 400: ${HOSTILE_TEXT}`), { status: 400 }); };
  const c = capture();
  let result;
  try {
    result = await testKey({ provider: "groq", key: KEY }, { call });
  } finally {
    c.stop();
  }
  assert.deepEqual(c.unsafe(), []);
  assert.ok(c.lines.some((l) => /key test failed/.test(l.text) && /Bad request \\x1b\[2J/.test(l.text)), "the terminal line shows the escaped words");
  assert.equal(result.ok, false);
  assert.ok(!UNSAFE.test(result.message) && !/pwned|RED/.test(result.message), JSON.stringify(result.message));
});

// A provider that answers fine but fills the fields the terminal line prints with control characters
// (a service running on this computer is as much a stranger as any other).
const SNEAKY = "9\x1b[2J\r\n[multiplayer-ai] all clear\x9b‮";
const SNEAKY_OK = {
  groq: { choices: [{ message: { content: "fine" }, finish_reason: SNEAKY }], usage: { prompt_tokens: SNEAKY, completion_tokens: SNEAKY, completion_tokens_details: { reasoning_tokens: SNEAKY } } },
  compat: { choices: [{ message: { content: "fine" } }], usage: { prompt_tokens: SNEAKY, completion_tokens: SNEAKY } },
  claude: { content: [{ type: "text", text: "fine" }], usage: { input_tokens: SNEAKY, output_tokens: SNEAKY } },
  gemini: { candidates: [{ content: { parts: [{ text: "fine" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: SNEAKY, candidatesTokenCount: SNEAKY, thoughtsTokenCount: SNEAKY } }
};
for (const provider of Object.keys(SNEAKY_OK)) {
  test(`${provider}: control characters in a good answer's usage fields do not reach the terminal raw`, async () => {
    useProvider(provider);
    const fetchImpl = async () => json(200, SNEAKY_OK[provider]);
    const saved = globalThis.fetch;
    if (provider === "gemini") globalThis.fetch = fetchImpl;
    const c = capture();
    let out;
    try {
      out = await callModel({ provider, messages: [{ role: "user", content: "hi" }], fetchImpl, maxRetries: 0, maxParseRetries: 0 });
    } finally {
      c.stop();
      globalThis.fetch = saved;
    }
    assert.equal(out.text, "fine");
    assert.deepEqual(c.unsafe(), []);
    assert.ok(c.lines.some((l) => /timing/.test(l.text)), "the timing line is still printed");
  });
}
