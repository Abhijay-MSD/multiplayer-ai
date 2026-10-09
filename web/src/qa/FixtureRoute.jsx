import { useMemo, useState } from "react";
import { SessionRoomView } from "../components/SessionRoomView";
import { NamePrompt } from "../components/NamePrompt";
import { StatusScreen } from "../components/StatusScreen";
import { RoomsView } from "../components/RoomsPage";

// Test pages for QA and screenshots. Same components as the real room, fed
// from a JSON file instead of the server. Not part of a normal production build.
//
//   /__fixture/room?fixture=dev-room&as=Dev&state=idle|working|limit|error
//                  &readonly=1&count=2000&empty=1&upto=3&files=1&tab=files&brief=1
//   fixture=recorded-session replays the landing page's recording.
//   /__fixture/name | /__fixture/loading | /__fixture/error
const fixtures = import.meta.glob(["../../qa/fixtures/*.json", "../marketing/recorded-session.json"], {
  eager: true,
  import: "default"
});

const pickFixture = (name) => {
  const hit = Object.entries(fixtures).find(([path]) => path.endsWith(`/${name}.json`));
  return (hit ?? Object.entries(fixtures)[0])[1];
};

// Repeats the fixture's events to make a long transcript for scroll tests.
function stretch(events, count) {
  const out = [];
  let id = 1;
  while (out.length < count) {
    events.forEach((e, idx) => {
      if (out.length >= count) return;
      const replyIdx = e.reply_to ? events.findIndex((x) => x.id === e.reply_to) : -1;
      out.push({ ...e, id, reply_to: replyIdx >= 0 ? id - (idx - replyIdx) : null });
      id++;
    });
  }
  return out;
}

// A room's files for the QA pages: a few files, nothing saved anywhere.
const DEMO_FILES = [
  { name: "launch-plan.md", size: 2150, version: 3, updated_by: "agent", on_behalf_of: "Dev" },
  { name: "notes.txt", size: 312, version: 1, updated_by: "Maya", on_behalf_of: null },
  { name: "budget.csv", size: 96, version: 2, updated_by: "Dev", on_behalf_of: null }
];
const demoFilesView = (isHost) => ({
  isHost,
  canAttach: true,
  limits: { maxFileBytes: 204800, maxFiles: 50, maxTotalBytes: 2097152 },
  load: async () => ({ files: DEMO_FILES.map((f) => ({ ...f, updated_at: new Date().toISOString() })), usage: { files: 3, bytes: 2558 }, limits: { maxFileBytes: 204800, maxFiles: 50, maxTotalBytes: 2097152 } }),
  read: async (name, version) => ({ ...DEMO_FILES.find((f) => f.name === name), version: version ?? 1, content: `# ${name}\n\nThe text of ${name}.\n`, updated_at: new Date().toISOString() }),
  versions: async () => [],
  attach: async () => ({}),
  remove: async () => ({}),
  restore: async () => ({})
});

function Room({ params }) {
  const fx = useMemo(() => {
    const raw = pickFixture(params.get("fixture") || "dev-room");
    return { ...raw, session: { id: "00000000-0000-4000-8000-000000000001", ...raw.session } };
  }, [params]);
  const now = useMemo(() => Date.now(), []);
  const name = params.get("as") || "Dev";
  const state = params.get("state") || "idle";
  const count = Number(params.get("count")) || 0;
  const upto = Number(params.get("upto")) || 0; // show only the first N events

  const [participants, setParticipants] = useState(() =>
    fx.participants.map((p) => ({
      ...p,
      session_id: fx.session.id,
      last_seen: new Date(p.last_seen === "AWAY" ? now - 5 * 60_000 : now).toISOString()
    }))
  );
  const [events, setEvents] = useState(() =>
    params.get("empty") ? [] : count ? stretch(fx.events, count) : upto ? fx.events.slice(0, upto) : fx.events
  );

  const append = (kind, author, content) =>
    setEvents((prev) => [
      ...prev,
      { id: (prev.at(-1)?.id ?? 0) + 1, kind, author, content, reply_to: null, created_at: new Date().toISOString() }
    ]);

  const guard = (content) => {
    // Lets tests exercise the error path: text containing "fail" is rejected.
    if (/fail/i.test(content)) throw new Error("Control changed a moment ago. Take control to send this.");
  };

  return (
    <SessionRoomView
      sessionId={fx.session.id}
      name={name}
      session={{ ...fx.session, agent_working: state === "working", ...(params.get("files") ? { files_enabled: true } : {}), ...(params.get("brief") ? { brief: "Answer in short sentences and name every file you change.\nAsk before you delete or overwrite anything.\nThis room is for the billing team only; keep customer names out of replies." } : {}) }}
      initialView={params.get("tab") || "conversation"}
      filesView={params.get("files") ? demoFilesView(params.get("host") === "1") : null}
      events={events}
      participants={participants}
      signalState={state}
      working={state === "working"}
      readOnly={params.get("readonly") === "1"}
      onSendDirective={async (content) => {
        guard(content);
        append("directive", name, content);
      }}
      onSendComment={async (content) => {
        guard(content);
        append("comment", name, content);
      }}
      onTakeControl={async (target) => {
        setParticipants((prev) => prev.map((p) => ({ ...p, role: p.name === target ? "controller" : "watcher" })));
        append("takeover", target, `${target} took control.`);
      }}
    />
  );
}

export default function FixtureRoute() {
  const params = new URLSearchParams(window.location.search);
  const page = window.location.pathname.replace("/__fixture/", "");

  if (page === "name") return <NamePrompt onSubmit={() => {}} />;
  if (page === "rooms") {
    const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
    const room = (n, title, over) => ({ id: `0000000${n}-2222-4333-8444-555555555555`, title, created_at: at(900), last_activity: at(10 * n), people: 2, state: "open", archived_by_host: false, step_count: 4, agent_working: false, ...over });
    return (
      <RoomsView
        initial={[
          room(1, "Rollback plan for the billing migration", {}),
          room(2, "Launch checklist", { people: 3, agent_working: true }),
          room(3, "Notes from Tuesday", { state: "ended", people: 1 }),
          room(4, "Old experiment", { state: "archived", archived_by_host: true, people: 1 })
        ]}
      />
    );
  }
  if (page === "loading") return <StatusScreen>Entering the room…</StatusScreen>;
  if (page === "error") {
    return (
      <StatusScreen tone="error" title="Couldn't reach this session">
        Session not found
      </StatusScreen>
    );
  }
  return <Room params={params} />;
}
