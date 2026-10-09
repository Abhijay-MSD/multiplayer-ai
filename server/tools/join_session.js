import { asStore, defaultStore } from "../store/index.js";
import { bestEffort } from "../store/best-effort.js";
import { ApiError } from "../errors.js";
import {
  hashToken,
  isAway,
  nameKey,
  newCredential,
  normalizeName,
  suggestName,
  tokenIsLive,
  tokenTtlMs
} from "../auth.js";
import { nudge } from "../hub.js";
import { StoreError } from "../store/errors.js";
import { assertWritable, roomInfo } from "../rooms.js";
import { defaultLimits, maxParticipants } from "../limits.js";
import { participantPublicFor } from "../store/index.js";
import { hasInvite, getInvite } from "../invite.js";
import { DEFAULT_CALLER } from "../host-actions.js";

const ROW_COLUMNS = "session_id, name, role, last_seen, token_hash, token_expires_at, token_revoked_at";

/**
 * Join a room, or come back to it.
 *
 * - With a `token` that is still good for this room, you are that participant
 *   again (the name argument is ignored) and your access is renewed.
 * - Otherwise you join as a new watcher under `name`, and get a new token. A
 *   name someone in the room already holds is refused, with a suggestion. The
 *   exception is a name whose holder is away and has no working token (it
 *   expired, was revoked, or predates tokens): that name can be claimed, and
 *   the claimant starts as a watcher.
 *
 * When the app is shared (Same Wi-Fi, or in a container) a guest, meaning anyone without the
 * host's sign-in cookie, can join a new place in a room only with the room's invite secret (the part
 * after "#k=" in the share link) or a token already issued for it. A room that does not exist
 * answers exactly as a room that needs an invite, so ids cannot be probed. Only wrong invites are counted.
 */
export async function joinSession(
  { session_id, name, token, invite: givenInvite },
  { db = defaultStore(), ip, limits = defaultLimits, caller = DEFAULT_CALLER, invite: inviteService = hasInvite() ? getInvite() : null } = {}
) {
  const store = asStore(db);
  const guest = Boolean(caller.sharing && store.local && !caller.host);
  const session = await store.getSession(session_id);
  if (!session && !guest) throw new ApiError(404, "ROOM_NOT_FOUND", "This room doesn't exist.");

  const rows = session ? await store.listParticipants(session_id, { columns: store.local ? `${ROW_COLUMNS}, is_host` : ROW_COLUMNS }) : [];

  let issued = null; // the new plaintext token, when this call creates one
  let wrote = false;
  let youName; // who this call ended up being

  const tokenHash = typeof token === "string" ? hashToken(token) : null;
  const mine = tokenHash ? rows.find((r) => r.token_hash === tokenHash) : null;

  if (guest && !(mine && tokenIsLive(mine))) {
    limits.checkInvite?.(ip);
    const valid = Boolean(session && inviteService && inviteService.verify(session_id, session.invite_version, givenInvite));
    if (!valid) {
      limits.failInvite?.(ip);
      throw new ApiError(
        403,
        "INVITE_REQUIRED",
        givenInvite
          ? "That link isn't valid any more. Ask the host for a new one."
          : "This room needs the link the host shared. Ask the host for it."
      );
    }
  }

  if (mine && tokenIsLive(mine)) {
    // Coming back: renew access and refresh last_seen. (The host's own cookie marks their seat as the host's.)
    youName = mine.name;
    await store.updateParticipant(session_id, mine.name, {
      last_seen: new Date().toISOString(),
      token_expires_at: new Date(Date.now() + tokenTtlMs()).toISOString(),
      ...(store.local && caller.host && !caller.direct && !mine.is_host ? { is_host: true } : {})
    });
  } else {
    // Nobody new joins a room that is read-only; people already in it can still open it.
    assertWritable(session);
    const wanted = normalizeName(name);
    const key = nameKey(wanted);
    const holder = rows.find((r) => nameKey(r.name) === key);
    const claimable = holder && isAway(holder) && !tokenIsLive(holder);

    if (holder && !claimable) {
      const suggestion = suggestName(wanted, new Set(rows.map((r) => nameKey(r.name))));
      throw new ApiError(409, "NAME_TAKEN", `Someone in this room is already using the name "${holder.name}". Pick another, for example "${suggestion}".`, { suggestion });
    }

    if (!claimable && rows.length >= maxParticipants()) {
      throw new ApiError(400, "BAD_REQUEST", `This room is full: it holds up to ${maxParticipants()} people.`);
    }
    // Only a new person counts against the IP's joins; coming back with a token (above) is free.
    limits.checkJoin(ip);

    youName = wanted;
    const credential = newCredential();
    issued = credential.token;
    const fresh = {
      name: wanted,
      role: "watcher",
      last_seen: new Date().toISOString(),
      ...credential.columns,
      ...(store.local ? { is_host: Boolean(caller.host && !caller.direct) } : {})
    };
    try {
      if (claimable) await store.updateParticipant(session_id, holder.name, fresh);
      else await store.insertParticipant({ session_id, ...fresh });
    } catch (error) {
      // Two people picked the same name at once; the unique index let one in.
      if (error instanceof StoreError && error.code === "CONFLICT") {
        throw new ApiError(409, "NAME_TAKEN", `Someone in this room is already using the name "${wanted}".`, {
          suggestion: suggestName(wanted, new Set(rows.map((r) => nameKey(r.name))))
        });
      }
      throw error;
    }

    await bestEffort(
      store.insertEvent({ session_id, kind: "join", author: wanted, content: `${wanted} joined the session.` }),
      "join"
    );
    wrote = true;
  }

  const [events, participants] = await Promise.all([
    store.listEvents(session_id),
    store.listParticipants(session_id, { columns: participantPublicFor(store) })
  ]);
  const me = participants.find((p) => p.name === youName);

  if (wrote) nudge(session_id);
  return {
    session,
    room: { ...roomInfo(session), sharing: Boolean(caller.sharing && store.local) },
    participants,
    events,
    you: me ? { name: me.name, role: me.role } : null,
    ...(issued ? { token: issued } : {})
  };
}
