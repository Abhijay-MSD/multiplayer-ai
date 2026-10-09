// Is this process really running inside a container?
//
// MULTIPLAYER_AI_CONTAINER=1 changes how Multiplayer AI listens and how it checks who is asking (see
// admin.js), because a container can't bind the host's loopback address: a browser on the
// host reaches it through Docker's network. That change must not be possible to switch on by
// accident on an ordinary computer, so the variable does nothing unless the process is
// actually in a container.
import fs from "node:fs";

/** True when the markers a Linux container leaves are present. Only Linux containers are supported. */
export function detectContainer({
  platform = process.platform,
  exists = fs.existsSync,
  read = (p) => fs.readFileSync(p, "utf8"),
  env = process.env
} = {}) {
  if (platform !== "linux") return false;
  if (exists("/.dockerenv") || exists("/run/.containerenv")) return true;
  try {
    if (/docker|kubepods|containerd|libpod/.test(read("/proc/1/cgroup"))) return true;
  } catch {
    // no /proc/1/cgroup: not conclusive
  }
  return Boolean(env.container); // set by Podman and systemd-nspawn
}

/** { on, ignored }: `on` when MULTIPLAYER_AI_CONTAINER=1 and this really is a container; `ignored` when it was set but this is not one. */
export function containerMode(env = process.env, detect = detectContainer) {
  const requested = String(env.MULTIPLAYER_AI_CONTAINER ?? "").trim() === "1";
  if (!requested) return { on: false, ignored: false };
  return detect({ env }) ? { on: true, ignored: false } : { on: false, ignored: true };
}
