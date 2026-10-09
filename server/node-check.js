// Imported first by every entry point. Written in plain syntax with no imports so
// an old Node reaches this message instead of a SyntaxError or a missing module.
//
// The floor is the first release of each line where the built-in node:sqlite module needs no flag:
// 22.13.0 and 23.4.0 (checked by running containers of 22.12.0, 22.13.0, 23.3.0 and 23.4.0). Node 24 and
// newer have it. scripts/start.mjs has the same rule; a test keeps the two equal.
export const MIN_NODE_LABEL = "22.13";

/** True when this version of Node has no unflagged node:sqlite, or when it cannot be read. */
export function nodeTooOld(version) {
  const [major, minor] = String(version).split(".").map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return true;
  if (major >= 24) return false;
  if (major === 23) return minor < 4;
  if (major === 22) return minor < 13;
  return true;
}

if (nodeTooOld(process.versions.node)) {
  console.error(
    `Multiplayer AI needs Node ${MIN_NODE_LABEL} or newer, and this is Node ${process.versions.node}.\n` +
      "Older versions are untested. Install a current Node from https://nodejs.org and run this again."
  );
  process.exit(1);
}
