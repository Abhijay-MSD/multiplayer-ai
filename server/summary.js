// Rolling summary of events that fell out of the context window.
//
// Runs after a reply is written, inside the session's queue (so it can't race
// another step), and never throws: a failed summary only means the next step
// tries again. Events are folded in once, tracked by summarized_through_event_id.

import { callModel, summaryModel } from "./providers/index.js";
import { asStore } from "./store/index.js";
import { escapeForLog } from "./safe-text.js";

export const SUMMARY_MIN_EVENTS = 10; // new fallen-out events needed before summarizing
const SUMMARY_CHUNK = 60; // most events folded in per pass
const SUMMARY_EVENT_CHARS = 600;
const SUMMARY_MAX_OUTPUT_TOKENS = 400;

let warnedNoColumns = false;

const INSTRUCTIONS =
  "You maintain a short running summary of a shared agent session. " +
  "Merge the new events into the existing summary. Record decisions made, constraints set, " +
  "and who requested what (use the names). Drop small talk and anything superseded. " +
  "Under 200 words. Output only the summary text.";

function line(e) {
  const text = e.content.length > SUMMARY_EVENT_CHARS ? e.content.slice(0, SUMMARY_EVENT_CHARS) + " …" : e.content;
  return e.kind === "directive" ? `[${e.author}] ${text}` : `Agent: ${text}`;
}

/** `fellOut`: events (oldest first) the step's context window no longer holds. */
export async function maybeUpdateSummary(db, session, fellOut, { call = callModel } = {}) {
  try {
    if (!("summarized_through_event_id" in session)) {
      if (!warnedNoColumns) {
        warnedNoColumns = true;
        console.error(
          "[multiplayer-ai] rolling summary is off: the sessions table has no summary / summarized_through_event_id columns " +
          "(run supabase/migrations/0001_initial_schema.sql, or recreate the table)"
        );
      }
      return;
    }
    if (fellOut.length < SUMMARY_MIN_EVENTS) return;

    const chunk = fellOut.slice(0, SUMMARY_CHUNK);
    const started = Date.now();
    const prompt =
      (session.summary ? `Existing summary:\n${session.summary}\n\n` : "Existing summary: (none)\n\n") +
      `New events:\n${chunk.map(line).join("\n")}`;

    const { text, model } = await call({
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: prompt }
      ],
      model: summaryModel(),
      thinkingLevel: "minimal",
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      label: "summary"
    });

    const through = chunk[chunk.length - 1].id;
    await asStore(db).updateSession(session.id, { summary: text, summarized_through_event_id: through });
    console.error(
      `[multiplayer-ai:timing] summary session=${session.id.slice(0, 8)} model=${model} folded=${chunk.length} ` +
      `through_event=${through} duration=${Date.now() - started}ms`
    );
  } catch (e) {
    console.error(`[multiplayer-ai] summary update skipped: ${escapeForLog(String(e?.message ?? e).split("\n")[0].slice(0, 200))}`);
  }
}
