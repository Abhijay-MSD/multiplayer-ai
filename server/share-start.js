// What to do about sharing when Multiplayer AI starts. Sharing is never remembered: every start is "This computer only"
// unless MULTIPLAYER_AI_SHARE=wifi is set (npm start -- --share=wifi sets it) or, in a container, an address is given.
// Nothing here prints a room link or a secret; it names the network address, which is not one.
import { lanCandidates, PLAIN_HTTP_WARNING } from "./sharing.js";

/** Applies MULTIPLAYER_AI_SHARE / MULTIPLAYER_AI_SHARE_ADDRESS to a running server. Never throws. */
export async function applyShareSettings({ env, running, interfaces, log }) {
  const status = running.sharing.status();
  const wantsWifi = String(env.MULTIPLAYER_AI_SHARE ?? "").trim().toLowerCase() === "wifi";
  const address = String(env.MULTIPLAYER_AI_SHARE_ADDRESS ?? "").trim();

  if (status.container) {
    if (address) {
      try {
        const name = running.sharing.setShareName(address);
        log(`[multiplayer-ai] Sharing is on for ${name} (port ${status.port}). ${PLAIN_HTTP_WARNING}`);
      } catch (e) {
        log(`[multiplayer-ai] warning: MULTIPLAYER_AI_SHARE_ADDRESS was not used: ${e.message}`);
      }
    }
    if (!running.sharing.status().shareName) {
      log(
        "[multiplayer-ai] This is a container, so Multiplayer AI counts as shared: guests need the host's link, and only the host can start rooms. " +
        "Enter the address people will use to reach this computer (in Settings, or MULTIPLAYER_AI_SHARE_ADDRESS) to get a link to give them."
      );
    }
    return;
  }

  if (address) log("[multiplayer-ai] note: MULTIPLAYER_AI_SHARE_ADDRESS is only used inside a container, so it was ignored.");
  if (!wantsWifi) return;
  if (!status.available) {
    log("[multiplayer-ai] note: MULTIPLAYER_AI_SHARE was ignored. Sharing needs the local data file; it isn't available with Supabase storage.");
    return;
  }

  const candidates = lanCandidates(interfaces());
  if (!candidates.length) {
    log("[multiplayer-ai] Sharing was not turned on: this computer has no network address it could share on. Connect to your Wi-Fi, then turn sharing on in Settings.");
    return;
  }
  const usual = candidates.filter((c) => c.kind === "private");
  if (candidates.length > 1 || usual.length !== 1) {
    const list = candidates.map((c) => `${c.address} (${c.interface})`).join(", ");
    log(
      `[multiplayer-ai] Sharing was not turned on: ${candidates.length > 1 ? "this computer has more than one network address" : "the only address is an unusual one"}: ${list}. ` +
      "Choose which one to share on in Settings."
    );
    return;
  }
  try {
    await running.sharing.enable(usual[0].address);
    log(`[multiplayer-ai] Sharing is on for ${usual[0].address} (port ${status.port}). ${PLAIN_HTTP_WARNING}`);
  } catch (e) {
    log(`[multiplayer-ai] Sharing was not turned on: ${e.message}`);
  }
}
