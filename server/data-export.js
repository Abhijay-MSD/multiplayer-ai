// Everything a person put into Multiplayer AI, as one JSON file they can keep: rooms, their
// events, their files (with every kept version), and who was in them (name and role). Not included: token hashes or expiry
// dates, when people were last seen, the saved key, or any setting.
//
// Written room by room so a large export does not have to fit in memory.
import { PARTICIPANT_PUBLIC } from "./store/columns.js";

const PAGE = 100;
const write = (res, text) => new Promise((resolve) => (res.write(text) ? resolve() : res.once("drain", resolve)));

export const exportFileName = (when = new Date()) => `multiplayer-ai-export-${when.toISOString().slice(0, 10)}.json`;

export async function streamExport(store, res, { now = () => new Date() } = {}) {
  await write(res, `{"format":"multiplayer-ai-export","version":1,"exported_at":${JSON.stringify(now().toISOString())},"rooms":[`);
  let first = true;
  for (let offset = 0; ; offset += PAGE) {
    const rooms = await store.listSessions({ limit: PAGE, offset });
    if (!rooms.length) break;
    for (const room of rooms) {
      const [participants, events] = await Promise.all([
        store.listParticipants(room.id, { columns: PARTICIPANT_PUBLIC }),
        store.listEvents(room.id)
      ]);
      // Files, with every kept version, so what the agent and the people made is in the export too (local storage only).
      const files = [];
      if (store.supportsFiles) {
        for (const f of await store.listFiles(room.id)) {
          const versions = await store.listFileVersions(room.id, f.name);
          const history = [];
          for (const v of versions) {
            const full = await store.getFileVersion(room.id, f.name, v.version);
            history.push({ version: v.version, size: v.size, author: v.author, on_behalf_of: v.on_behalf_of ?? null, created_at: v.created_at, content: full?.content ?? "" });
          }
          files.push({ name: f.name, version: f.version, size: f.size, updated_by: f.updated_by, on_behalf_of: f.on_behalf_of, updated_at: f.updated_at, content: history[0]?.content ?? "", versions: history });
        }
      }
      const out = {
        id: room.id,
        title: room.title,
        task: room.task,
        status: room.status,
        step_count: room.step_count,
        summary: room.summary ?? null,
        ...(store.local ? { brief: room.brief ?? "" } : {}),
        created_at: room.created_at,
        updated_at: room.updated_at,
        participants: participants.map((p) => ({ name: p.name, role: p.role })),
        ...(store.supportsFiles ? { files } : {}),
        events: events.map((e) => ({ id: e.id, kind: e.kind, author: e.author, content: e.content, reply_to: e.reply_to, created_at: e.created_at }))
      };
      await write(res, (first ? "" : ",") + JSON.stringify(out));
      first = false;
    }
    if (rooms.length < PAGE) break;
  }
  res.end("]}\n");
}
