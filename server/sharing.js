// Sharing a room with people on the same network: which address to listen on, and what to say about it.
//
// Multiplayer AI only ever listens on this computer (127.0.0.1) and, when the host turns sharing on, on ONE
// chosen address of this computer's own network. It never listens on every interface. This file
// decides which addresses may be chosen; http.js opens and closes the listener.

export const PLAIN_HTTP_WARNING =
  "This link uses plain http on your local network. Anyone on the same network who can capture traffic can read what's sent, " +
  "including the room secret and people's access tokens. Use it only on a network you trust, like your home or your own hotspot. " +
  "Don't use it on café, hotel, school or office Wi-Fi.";

const OCTET = /^(0|[1-9]\d{0,2})$/;

function parse(ip) {
  if (typeof ip !== "string") return null;
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => OCTET.test(p))) return null;
  const n = parts.map(Number);
  return n.every((x) => x <= 255) ? n : null;
}

/** "private" | "link-local" | "cgnat" | "public" | "loopback" | "invalid" for a dotted IPv4 address. */
export function classifyAddress(ip) {
  const o = parse(ip);
  if (!o) return "invalid";
  const [a, b] = o;
  if (a === 0 || a >= 224) return "invalid"; // "this network", multicast, reserved, broadcast
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  return "public";
}

const VIRTUAL = /^(docker|br-|veth|vmnet|vboxnet|virbr|bridge|vnic|vethernet|utun|tun|tap|wg|ppp|ham|zt|tailscale)/i;
const WARNINGS = {
  "link-local":
    "This is a link-local address (169.254.x.x). Your computer probably did not get a normal address from the network, so other devices usually can't reach it.",
  cgnat:
    "This address is in the range used for shared carrier networks and some VPNs (100.64.x.x), not a home network. Other devices on a network like that are not necessarily ones you know."
};
const RANK = { private: 0, "link-local": 2, cgnat: 3 };

/**
 * The addresses the host may choose from, out of `os.networkInterfaces()`: IPv4, not loopback, and in a
 * private, link-local or shared-carrier range. A public address is never offered. Ordered: real private
 * interfaces first, then virtual ones (Docker, VPN, virtual machines), then the unusual ranges.
 */
export function lanCandidates(interfaces) {
  const out = [];
  let index = 0;
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    for (const i of list ?? []) {
      if (!i || i.internal || (i.family !== "IPv4" && i.family !== 4)) continue;
      const kind = classifyAddress(i.address);
      if (!(kind in RANK)) continue;
      const virtual = VIRTUAL.test(name);
      out.push({
        interface: name,
        address: i.address,
        kind,
        virtual,
        ...(WARNINGS[kind] ? { warning: WARNINGS[kind] } : {}),
        _rank: kind === "private" && virtual ? 1 : RANK[kind],
        _index: index++
      });
    }
  }
  return out
    .sort((a, b) => a._rank - b._rank || a._index - b._index)
    .map(({ _rank, _index, ...c }) => c);
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * What a person may type as "the address to share" when Multiplayer AI runs in a container, where it can't see the
 * host's network: a private IPv4 address, or a name ending in .local. Returns { ok, host } or { ok: false, message }.
 */
export function parseShareName(text) {
  const raw = typeof text === "string" ? text.trim().toLowerCase() : "";
  if (!raw) return { ok: false, message: "Enter the address other people will use to reach this computer, such as 192.168.1.20." };
  if (classifyAddress(raw) === "private") return { ok: true, host: raw };
  const labels = raw.split(".");
  if (raw.length <= 253 && labels.length >= 2 && labels.at(-1) === "local" && labels.every((l) => LABEL.test(l))) return { ok: true, host: raw };
  return {
    ok: false,
    message: "Use a private network address such as 192.168.1.20 (or 10.x.x.x, 172.16 to 31.x.x), or a name ending in .local. Leave out http://, a port and anything after the address."
  };
}
