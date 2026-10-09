// Whether the file tools may be used for a room right now, and what the room is told when they can't.
//
//   * A provider's tool format is used only once it was read from that provider's documentation or library (docs/providers.md
//     lists which). Until then, for that provider the agent answers in text and the room is told so.
//   * A model that turns tools down is remembered per room, for as long as the server runs, and the room is told once.
// Both notices are one line in the transcript, written once per room per run of the server.

/** Providers whose tool-calling format has been confirmed (see docs/providers.md, "Tool calling"). */
export const TOOL_FORMAT_CONFIRMED = { groq: true, gemini: true, claude: true, compat: true };

export const NOTICE_NO_FORMAT = "File tools aren't available with this model provider yet, so the agent will answer in text only in this room.";
export const NOTICE_REJECTED = "This model doesn't accept tools, so the agent will answer in text only in this room.";

const off = new Set(); // rooms whose model turned tools down
const told = new Set(); // rooms already told the provider has no confirmed format

export const toolsTurnedOff = (sessionId) => off.has(sessionId);
export const turnToolsOff = (sessionId) => void off.add(sessionId);

/** True the first time it is asked for a room: the caller then writes the notice. */
export function firstNoticeFor(sessionId) {
  if (told.has(sessionId)) return false;
  told.add(sessionId);
  return true;
}

/** Forgets what was learned about a room (a deleted room, a test). */
export function forgetRoom(sessionId) {
  off.delete(sessionId);
  told.delete(sessionId);
}
