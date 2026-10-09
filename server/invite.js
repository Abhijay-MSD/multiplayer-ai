// The invite secret of a room, and the instance key it is made from.
//
// Sharing Multiplayer AI on a network means the room's id alone must not be enough to get in. Each room has
// an invite secret that goes in the share link after a "#", so it is never sent in a request line, a
// server log or a Referer. The page sends it once, in the body of the join request.
//
// The secret is derived, not stored: HMAC-SHA256 of the room id and the room's invite_version, keyed by
// the instance key (a random 32-byte value in instance.key in the data folder, owner-only). So the host
// can be shown the link again at any time; raising invite_version stops the old link working for new
// joiners; and deleting every room replaces the instance key, which retires every old link at once.
//
// The instance key, and every secret made from it, is registered with the redactor so it is hidden
// from logs and error text, and it never leaves this module except as the secret in a share link.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prepareDataDir, secureFile } from "./store/dataDir.js";
import { registerSecret } from "./secrets.js";

export const INSTANCE_KEY_FILE = "instance.key";
const FORMAT = /^[A-Za-z0-9_-]{43}$/;
const toSecret = (key, sessionId, version) =>
  crypto.createHmac("sha256", key).update(`multiplayer-ai-invite-v1\n${sessionId}\n${version}`).digest("base64url");

export function createInvite({ dir }) {
  const file = path.join(dir, INSTANCE_KEY_FILE);
  let key = null;
  const seen = new Set();

  function write(value) {
    prepareDataDir(dir);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeSync(fd, value.toString("base64") + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    secureFile(file);
  }

  function adopt(value) {
    key = value;
    registerSecret(value.toString("base64"));
    return key;
  }

  function load() {
    if (key) return key;
    if (fs.existsSync(file)) {
      const stored = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
      if (stored.length === 32) {
        secureFile(file);
        return adopt(stored);
      }
      // Not a key we wrote: don't trust it. Replacing it retires any secret made from it.
    }
    const fresh = crypto.randomBytes(32);
    write(fresh);
    return adopt(fresh);
  }

  return {
    file,

    /** The secret for a room at an invite version. Registered for redaction the first time it is made. */
    derive(sessionId, version) {
      const secret = toSecret(load(), sessionId, version);
      if (!seen.has(secret)) {
        seen.add(secret);
        registerSecret(secret);
      }
      return secret;
    },

    /** Does `given` match, in constant time? Anything that is not shaped like a secret is false. */
    verify(sessionId, version, given) {
      if (typeof given !== "string" || !FORMAT.test(given)) return false;
      const expected = Buffer.from(toSecret(load(), sessionId, version));
      const actual = Buffer.from(given);
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    },

    /** A new instance key. Every secret made before stops working. */
    rotate() {
      load();
      const fresh = crypto.randomBytes(32);
      write(fresh);
      adopt(fresh);
    }
  };
}

// The invite in force for this process: set at startup by the entry points.
let current = null;
export const setInvite = (invite) => {
  current = invite;
};
export const getInvite = () => {
  if (!current) throw new Error("Sharing has not been set up yet.");
  return current;
};
export const hasInvite = () => current !== null;
