// The texts that go with a reply the agent could not finish, and the Continue button on them. The server has the same words
// (server/agent/length.js, and rateLimitLine in server/providers/failure.js) and a test checks that they match: the line is how this
// app finds where to put the button, and the message is what the button sends.
export const LENGTH_LIMIT_LINE = "The reply reached its length limit";
export const CONTINUE_TEXT = "Continue from where you stopped";

// The line for a provider that is limiting the key. With a short wait the server says how many seconds; with a long or no wait it
// says the second sentence. Nothing else the provider said is in either.
const LEAD = "Agent could not reply: ";
const FAST = /^Agent could not reply: The model provider is limiting how fast this key can be used\. Try again in about ([1-9]\d{0,2}) (second|seconds)\.$/;
const SLOW = `${LEAD}The model provider is limiting this key. Check the provider's console for the limit, then try again.`;
const SHORT_WAIT_SECONDS = 120; // the longest wait the server says in seconds

/** For a rate-limit line: { seconds } (a number, or null when no wait was given). For any other text: null. */
export function limitWait(content) {
  if (typeof content !== "string") return null;
  if (content === SLOW) return { seconds: null };
  const m = FAST.exec(content);
  if (!m) return null;
  const seconds = Number(m[1]);
  return seconds <= SHORT_WAIT_SECONDS && (seconds === 1) === (m[2] === "second") ? { seconds } : null;
}

/**
 * The id of the status line that should offer Continue: the latest line that says a reply was cut at its length limit or that the
 * provider is limiting the key, as long as nothing has been said to the agent since (a message after it, Continue included,
 * means it was dealt with). Only a status line counts: a person's comment or message with the same words does not. null when none.
 */
export function continuableLine(events) {
  let line = null;
  for (const e of events) {
    if (e.kind === "status" && (e.content === LENGTH_LIMIT_LINE || limitWait(e.content) !== null)) line = e.id;
    else if (e.kind === "directive" && line !== null && e.id > line) line = null;
  }
  return line;
}

/**
 * Whole seconds still to wait: `seconds` counted from when the line was written (`writtenAt`, an ISO time), rounded up, never above
 * `seconds` (a clock that is behind the server's does not lengthen the wait) and never below nothing.
 */
export function secondsLeft(seconds, writtenAt, nowMs) {
  if (typeof seconds !== "number" || !(seconds > 0)) return 0;
  const at = Date.parse(writtenAt);
  const elapsedMs = Number.isFinite(at) ? Math.max(0, nowMs - at) : 0;
  return Math.max(0, Math.ceil(seconds - elapsedMs / 1000));
}
