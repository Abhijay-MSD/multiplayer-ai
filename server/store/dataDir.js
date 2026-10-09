// Where Multiplayer AI keeps its data on this computer, and who can read it.
//
//   MULTIPLAYER_AI_DATA_DIR, or a folder named .multiplayer-ai in the user's home folder.
//
// On macOS and Linux the folder is created owner-only (0700) and the data file
// is owner-only (0600), so other accounts on the same computer cannot read it.
// That is all it does: it does not protect against anyone who can use this
// account, or against a backup that copies the file elsewhere. Windows does not
// use these permission bits, so there they do nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_FILE_NAME = "multiplayer-ai.db";
const isWindows = process.platform === "win32";

export function dataDir(env = process.env) {
  const raw = (env.MULTIPLAYER_AI_DATA_DIR ?? "").trim();
  if (!raw) return path.join(os.homedir(), ".multiplayer-ai");
  if (raw === "~" || raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(1));
  return path.resolve(raw);
}

const WHY = {
  EACCES: "Multiplayer AI isn't allowed to create or write there",
  EPERM: "Multiplayer AI isn't allowed to create or write there",
  EROFS: "that location is read-only",
  ENOSPC: "the disk is full",
  ENOTDIR: "part of that path is a file, not a folder",
  EEXIST: "something that is not a folder is already there",
  ENAMETOOLONG: "the path is too long"
};

/** Turns a file system error about the data folder into a message that says what to do. Other errors pass through. */
export function explainDataFolder(error, dir) {
  const why = WHY[error?.code];
  if (!why) return error;
  const out = new Error(
    `Multiplayer AI can't use its data folder, ${dir}: ${why}. Choose a different folder by setting MULTIPLAYER_AI_DATA_DIR, or fix that folder's permissions.`
  );
  out.code = "DATA_FOLDER";
  out.cause = error;
  return out;
}

/**
 * Creates the folder if it is missing (owner-only). Returns { dir, created, warnings }.
 * A folder that already exists keeps its permissions; if others can open it, that
 * is reported, and the files inside are still owner-only.
 */
export function prepareDataDir(dir) {
  const warnings = [];
  try {
    const existed = fs.existsSync(dir);
    if (!existed) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!isWindows) {
      if (!existed) fs.chmodSync(dir, 0o700);
      else if (fs.statSync(dir).mode & 0o077) {
        warnings.push(`The data folder ${dir} can be opened by other accounts on this computer. The files inside are owner-only.`);
      }
    }
    return { dir, created: !existed, warnings };
  } catch (e) {
    throw explainDataFolder(e, dir);
  }
}

/** Makes sure `file` exists and only its owner can read or write it. */
export function secureFile(file) {
  try {
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "a", 0o600));
    if (!isWindows) fs.chmodSync(file, 0o600);
  } catch (e) {
    throw explainDataFolder(e, path.dirname(file));
  }
}
