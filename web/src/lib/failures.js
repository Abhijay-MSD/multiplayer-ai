// What to tell someone when a call fails: a title, what happened, and what to
// do next. Written by hand for each case the server can report (its `code`);
// anything else falls back to the server's own message. `action` is "retry"
// (try the same thing again) or "start" (go start a room of your own).

const minutes = (seconds) => Math.max(1, Math.ceil(seconds / 60));

export function describeFailure(err) {
  switch (err?.code) {
    case "NETWORK":
    case "SERVER_DOWN":
      return {
        title: "Can't reach the server",
        body: "Your connection or the server is down. Nothing you wrote is lost. Check your connection, then try again.",
        action: "retry"
      };
    case "ROOM_NOT_FOUND":
      return {
        title: "This room doesn't exist",
        body: "The link may be mistyped, or the room was never created. Ask whoever sent it for the link again, or start a room of your own.",
        action: "start"
      };
    case "ROOM_ARCHIVED":
      if (/host archived/i.test(err.message ?? "")) {
        return {
          title: "The host archived this room",
          body: "It is read-only now: people who were in it can still read it, and nobody new can join. Ask the host to unarchive it, or start a new room to keep going.",
          action: "start"
        };
      }
      return {
        title: "This room was archived",
        body: "It went quiet for too long and is now read-only. Only people who were already in it can still read it, and nobody new can join. Start a new room to keep going.",
        action: "start"
      };
    case "ROOM_ENDED":
      return {
        title: "This room has ended",
        body: "Its controller ended it, so new people can't join. Start a new room to keep going.",
        action: "start"
      };
    case "RATE_LIMITED":
      return {
        title: "Too many attempts",
        body: err.retryAfter
          ? `Too many rooms were started or joined from this connection in a short time. Wait about ${minutes(err.retryAfter)} ${minutes(err.retryAfter) === 1 ? "minute" : "minutes"}, then try again.`
          : "Too many rooms were started or joined from this connection in a short time. Wait a few minutes, then try again.",
        action: "retry"
      };
    case "AT_CAPACITY":
      return {
        title: "The demo is at capacity",
        body: "Today's limit has been reached. Try again tomorrow, or run your own copy.",
        action: "retry"
      };
    case "NO_KEY":
      return {
        title: "No model key yet",
        body: "This copy of Multiplayer AI has no model key, so an agent can't reply yet. If this is your computer, set one up; it takes about a minute. If it isn't, ask whoever runs Multiplayer AI.",
        action: "setup"
      };
    case "ADMIN_LINK_NEEDED":
      return {
        title: "Open Multiplayer AI from the terminal's link",
        body: "Setup, Settings and Your rooms open only from the link Multiplayer AI printed in the terminal where you started it. That link signs this browser in, and it also opens by itself when Multiplayer AI starts. If it has expired, press Enter in the terminal for a new one.",
        action: "none"
      };
    case "ADMIN_LOCAL_ONLY":
    case "BAD_ORIGIN":
      return {
        title: "Only on the computer running Multiplayer AI",
        body: "Setup, Settings and Your rooms can be used only on the computer where Multiplayer AI is running, in the browser it opened.",
        action: "none"
      };
    case "INVITE_REQUIRED":
      return {
        title: "This room needs its link",
        body: "To get in, open the link the host shared with you, the whole link, including the long code after the # sign. If it doesn't work any more, ask the host to send it again or to make a new one.",
        action: "none"
      };
    case "HOST_ONLY":
      return {
        title: "Ask the host to start a room",
        body: "Only the person running Multiplayer AI can start a room, because the host's key pays for every reply. Ask them to start one and send you its link.",
        action: "none"
      };
    case "SIGNIN_EXPIRED":
      return {
        title: "That sign-in link has expired",
        body: "A sign-in link works once and lasts 5 minutes. In the terminal where Multiplayer AI is running, press Enter for a new one. If Multiplayer AI runs in a container with no keyboard, send it the SIGUSR2 signal, or restart it. Rooms don't need signing in; only Setup and Settings do.",
        action: "none"
      };
    case "ROOMS_UNAVAILABLE":
      return {
        title: "Your rooms need the local data file",
        body: "This page works with the data file on this computer. It isn't available with Supabase storage.",
        action: "none"
      };
    case "ROOM_DELETED":
      return {
        title: "The rooms were deleted",
        body: "Whoever runs Multiplayer AI deleted all rooms from their computer, so this room is gone and can't be recovered. Start a new room to keep going.",
        action: "start"
      };
    default:
      return {
        title: "Something went wrong",
        body: err?.message || "An unexpected error happened. Try again in a moment.",
        action: "retry"
      };
  }
}

// Messages about the form itself, shown next to the field rather than as a
// full failure screen.
export const isFormProblem = (err) => ["BAD_REQUEST", "INVALID_NAME", "NAME_TAKEN"].includes(err?.code);
