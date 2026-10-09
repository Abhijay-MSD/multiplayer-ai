// Shared by the specs that load the real room route against a mocked API.
export const ROOM = "11111111-2222-4333-8444-555555555555";
export const ROOM_B = "99999999-2222-4333-8444-555555555555";
export const NOW = () => new Date().toISOString();

export const roomState = (me = { name: "Dana", role: "watcher" }) => ({
  session: { id: ROOM, title: "Plan the launch", task: "Plan the launch", status: "active", step_count: 1, agent_working: false },
  participants: [
    { session_id: ROOM, name: "Maya", role: "controller", last_seen: NOW() },
    { session_id: ROOM, name: me.name, role: me.role, last_seen: NOW() }
  ],
  events: [
    { id: 1, session_id: ROOM, kind: "join", author: "Maya", content: "Maya created the session.", created_at: NOW() },
    { id: 2, session_id: ROOM, kind: "directive", author: "Maya", content: "Plan the launch", created_at: NOW() },
    { id: 3, session_id: ROOM, kind: "agent_message", author: "agent", content: "Start with the checklist.", reply_to: 2, created_at: NOW() }
  ],
  you: me
});

export const sse = (...messages) =>
  "retry: 3000\n\n" +
  messages.map(({ type, data, id }) => `${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join("");

export const streamOf = (state) => () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: state }) });

// Wires up the API. `onJoin` can answer join_session differently per call.
export async function mockApi(page, { onJoin, stream, onTool } = {}) {
  const calls = { tools: [], streams: [] };
  await page.route("**/api/tools/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    const body = route.request().postDataJSON();
    calls.tools.push({ name, body });
    if (name === "join_session") return route.fulfill(await onJoin(body, calls.tools.filter((c) => c.name === "join_session").length));
    if (onTool?.[name]) return route.fulfill(onTool[name](body));
    return route.fulfill({ json: { ok: true, event: { id: 99 } } });
  });
  await page.route("**/api/stream/*", async (route) => {
    const req = route.request();
    calls.streams.push({ url: req.url(), auth: req.headers().authorization });
    return route.fulfill(stream ? stream(calls.streams.length) : { status: 200, headers: { "content-type": "text/event-stream" }, body: sse({ type: "state", data: roomState() }) });
  });
  return calls;
}

export const asReturning = (page, { name = "Dana", token } = {}) =>
  page.addInitScript(
    ([n, t, room]) => {
      if (n) localStorage.setItem("multiplayer-ai:name", n);
      if (t) localStorage.setItem(`multiplayer-ai:token:${room}`, t);
    },
    [name, token, ROOM]
  );

