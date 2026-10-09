// The host's sharing controls: switch Same Wi-Fi on and off, and for each room the link, the QR code, who is
// waiting for control, the control policy, the guest cap, making a new link and removing a person.
//
// Mounted behind the host gate (admin.js) and answered only on this computer's own listener (local-guard.js).
// The share link and the QR code are in these responses and nowhere else; nothing here prints or logs them.
import { ApiError } from "./errors.js";
import { PLAIN_HTTP_WARNING } from "./sharing.js";
import { qrSvg } from "./qr.js";
import { intSetting } from "./config.js";
import * as actions from "./host-actions.js";

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const UNAVAILABLE_MESSAGE = "Sharing needs the local data file. It isn't available with Supabase storage.";

export function mountHostRoutes(app, { store, sharing, control, invite, localUrl, wrap, env }) {
  const needLocal = () => {
    if (!store.local || !invite) throw new ApiError(409, "SHARING_UNAVAILABLE", UNAVAILABLE_MESSAGE);
  };
  const roomId = (req) => {
    if (!ROOM_ID.test(req.params.id)) throw new ApiError(404, "ROOM_NOT_FOUND", "This room doesn't exist.");
    return req.params.id;
  };

  function sharingView() {
    const status = sharing.status();
    return {
      ...status,
      available: Boolean(store.local && invite) && status.available,
      unavailable_reason: store.local && invite ? null : UNAVAILABLE_MESSAGE,
      warning: PLAIN_HTTP_WARNING,
      guest_cap_default: intSetting("GUEST_STEP_CAP_PER_ROOM", env),
      control_default: "ask"
    };
  }

  /** Everything the panel shows for one room: the link and QR code, the counters, the waiting requests, the policy, the people. */
  async function panel(sessionId) {
    needLocal();
    const state = await actions.roomState({ store, control, sessionId, env });
    const room = await store.getSession(sessionId);
    const status = sharing.status();
    const base = status.url ?? localUrl();
    const link = `${base}/s/${sessionId}/join#k=${invite.derive(sessionId, room.invite_version)}`;
    const shareable = status.active && Boolean(status.url);
    return {
      room: { id: sessionId, title: room.title },
      ...state,
      share: {
        link,
        qr_svg: shareable ? qrSvg(link, { label: "QR code for the link to join this room" }) : null,
        sharing: status.active,
        needs_address: status.active && !status.url,
        note: shareable
          ? "Stay on this computer's own address (127.0.0.1 or localhost) to use these controls. Copy link copies the link for your guests on the network."
          : status.active
            ? "Enter the address people will use to reach this computer in Settings to get a link for them."
            : "This link only works on this computer. Turn on Same Wi-Fi in Settings to share it.",
        warning: status.active ? PLAIN_HTTP_WARNING : null
      }
    };
  }

  app.get("/api/host/sharing", wrap((req, res) => res.json(sharingView())));

  app.put("/api/host/sharing", wrap(async (req, res) => {
    needLocal();
    const { mode, address, acknowledge, share_address: shareAddress } = req.body ?? {};
    if (sharing.status().container) {
      if (shareAddress === undefined) throw new ApiError(400, "BAD_REQUEST", "Enter the address people will use to reach this computer.");
      sharing.setShareName(shareAddress);
    } else if (mode === "wifi") {
      if (typeof address !== "string" || !address) throw new ApiError(400, "BAD_REQUEST", "Choose which network address to share on.");
      await sharing.enable(address, { acknowledgeUnusual: acknowledge === true });
    } else if (mode === "local") {
      await sharing.disable();
    } else {
      throw new ApiError(400, "BAD_REQUEST", "Choose This computer only or Same Wi-Fi.");
    }
    res.json(sharingView());
  }));

  // "Your rooms": the list, and rename, archive or unarchive, and delete one. Local storage only.
  const roomsView = async () => ({ rooms: await actions.listRooms({ store }) });
  app.get("/api/host/rooms", wrap(async (req, res) => res.json(await roomsView())));
  app.put("/api/host/rooms/:id/title", wrap(async (req, res) => {
    await actions.renameRoom({ store, sessionId: roomId(req), title: req.body?.title });
    res.json(await roomsView());
  }));
  app.post("/api/host/rooms/:id/archive", wrap(async (req, res) => {
    await actions.setArchived({ store, sessionId: roomId(req), archived: req.body?.archived });
    res.json(await roomsView());
  }));
  app.post("/api/host/rooms/:id/delete", wrap(async (req, res) => {
    await actions.deleteRoom({ store, sessionId: roomId(req), confirm: req.body?.confirm });
    res.json(await roomsView());
  }));

  app.get("/api/host/rooms/:id", wrap(async (req, res) => res.json(await panel(roomId(req)))));

  app.put("/api/host/rooms/:id/policy", wrap(async (req, res) => {
    needLocal();
    await actions.setPolicy({ store, sessionId: roomId(req), policy: req.body?.policy });
    res.json(await panel(req.params.id));
  }));

  // The agent's use of the room's files: on or off, for this room. Deleting or restoring a file is the host's too.
  app.put("/api/host/rooms/:id/files", wrap(async (req, res) => {
    needLocal();
    await actions.setFilesEnabled({ store, sessionId: roomId(req), enabled: req.body?.enabled });
    res.json(await panel(req.params.id));
  }));

  app.post("/api/host/rooms/:id/files/delete", wrap(async (req, res) => {
    needLocal();
    await actions.deleteFile({ store, sessionId: roomId(req), name: req.body?.name });
    res.json(await panel(req.params.id));
  }));

  app.post("/api/host/rooms/:id/files/restore", wrap(async (req, res) => {
    needLocal();
    await actions.restoreFile({ store, sessionId: roomId(req), name: req.body?.name, version: req.body?.version });
    res.json(await panel(req.params.id));
  }));

  app.put("/api/host/rooms/:id/brief", wrap(async (req, res) => {
    needLocal();
    await actions.setBrief({ store, sessionId: roomId(req), brief: req.body?.brief });
    res.json(await panel(req.params.id));
  }));

  app.put("/api/host/rooms/:id/guest-cap", wrap(async (req, res) => {
    needLocal();
    await actions.setGuestCap({ store, sessionId: roomId(req), cap: req.body?.cap === undefined ? undefined : req.body.cap });
    res.json(await panel(req.params.id));
  }));

  app.post("/api/host/rooms/:id/rotate-link", wrap(async (req, res) => {
    needLocal();
    await actions.rotateInvite({ store, sessionId: roomId(req) });
    res.json(await panel(req.params.id));
  }));

  app.post("/api/host/rooms/:id/control/:requestId", wrap(async (req, res) => {
    needLocal();
    await actions.decideControl({ store, control, sessionId: roomId(req), requestId: req.params.requestId, decision: req.body?.decision });
    res.json(await panel(req.params.id));
  }));

  app.post("/api/host/rooms/:id/remove", wrap(async (req, res) => {
    needLocal();
    const name = req.body?.name;
    if (typeof name !== "string" || !name) throw new ApiError(400, "BAD_REQUEST", "Say who to remove.");
    await actions.removePerson({ store, control, sessionId: roomId(req), name });
    res.json(await panel(req.params.id));
  }));
}
