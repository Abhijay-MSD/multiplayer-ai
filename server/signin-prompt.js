// Getting a fresh sign-in link after the first one has been used or has expired.
//
//   * In a terminal, pressing Enter prints one (and the launcher also opens it).
//   * Anywhere, on macOS and Linux, sending the process SIGUSR2 prints one (with Docker:
//     docker kill -s USR2 <container name>).
//
// When stdin is not a terminal (a pipe, a closed stream, a detached container) the Enter
// handler is not installed at all, and a stdin that errors or ends is ignored: it can neither
// do anything nor crash Multiplayer AI.
import { escapeForLog } from "./safe-text.js";

/** Where a link should lead: Setup when no key is set up yet, otherwise the home page. */
export const signInTarget = (settings) => (settings?.configured?.() === false ? "/setup?next=%2Fnew" : "/");

/**
 * `link()` makes a fresh link; `onLink(link)` shows it. Returns a function that removes the handlers.
 */
export function attachFreshLinkHandlers({ stdin = process.stdin, link, onLink, signals = process, platform = process.platform }) {
  const removers = [];

  if (stdin?.isTTY && typeof stdin.on === "function") {
    const onData = () => {
      try {
        onLink(link());
      } catch (e) {
        console.error(`[multiplayer-ai] could not make a new sign-in link: ${escapeForLog(e.message)}`);
      }
    };
    const ignore = () => {};
    stdin.setEncoding?.("utf8");
    stdin.on("data", onData);
    stdin.on("error", ignore); // a terminal that goes away must not take Multiplayer AI with it
    stdin.on("end", ignore);
    stdin.resume?.();
    removers.push(() => {
      stdin.off?.("data", onData);
      stdin.off?.("error", ignore);
      stdin.off?.("end", ignore);
      stdin.pause?.();
    });
  }

  if (platform !== "win32" && typeof signals?.on === "function") {
    const onSignal = () => {
      try {
        onLink(link());
      } catch (e) {
        console.error(`[multiplayer-ai] could not make a new sign-in link: ${escapeForLog(e.message)}`);
      }
    };
    try {
      signals.on("SIGUSR2", onSignal);
      removers.push(() => signals.off?.("SIGUSR2", onSignal));
    } catch {
      // this platform has no such signal
    }
  }

  return () => removers.forEach((r) => r());
}
