// The two texts that go with a reply that stopped at the provider's length limit. The server has the same two
// (server/agent/length.js) and a test checks that they match: the line is how this app finds where to put the Continue button,
// and the message is what the button sends.
export const LENGTH_LIMIT_LINE = "The reply reached its length limit";
export const CONTINUE_TEXT = "Continue from where you stopped";

/**
 * The id of the status line that should offer Continue: the latest length-limit line, as long as nothing has been said to the
 * agent since (a message after it, Continue included, means it was dealt with). null when there is none.
 */
export function continuableLine(events) {
  let line = null;
  for (const e of events) {
    if (e.kind === "status" && e.content === LENGTH_LIMIT_LINE) line = e.id;
    else if (e.kind === "directive" && line !== null && e.id > line) line = null;
  }
  return line;
}
