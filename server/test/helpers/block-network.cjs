// TEST ONLY. Preloaded (node --require) into the one process the smoke test starts, and
// nothing else: it is never loaded by Multiplayer AI itself. It makes any connection to anything
// but this computer fail, so a test that passes with it shows that what it exercised needed
// no network, and will pass the same on a machine with none.
//
// It stops TCP/TLS connections (which fetch, http and https all use) and name lookups for
// names other than this computer's own. It does not stop UDP or a program started from the
// process that makes its own connections (npm is started with this same preload, because it
// inherits NODE_OPTIONS).
const net = require("node:net");
const dns = require("node:dns");
const os = require("node:os");

// This computer's own addresses count as this computer: listening on one (sharing on the local network) and
// connecting to it never leave the machine. Read each time, because an address can come and go.
const ownAddress = (h) =>
  Object.values(os.networkInterfaces()).some((list) => (list ?? []).some((a) => a.address.toLowerCase() === h));

const isLocal = (host) => {
  const h = String(host ?? "localhost").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "::" || /^127\./.test(h) || h.endsWith(".localhost") || ownAddress(h);
};
const blocked = (host) => Object.assign(new Error(`network blocked by the test: a connection to ${host} was attempted`), { code: "ENETBLOCKED" });

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let host = "localhost";
  const first = args[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    if (first.path) return connect.apply(this, args); // a local socket file
    host = first.host ?? "localhost";
  } else if (Array.isArray(first)) {
    const opts = first[0];
    if (opts?.path) return connect.apply(this, args);
    host = opts?.host ?? "localhost";
  } else if (typeof first === "string" && Number.isNaN(Number(first))) {
    return connect.apply(this, args); // a path
  } else if (typeof args[1] === "string") {
    host = args[1];
  }
  if (!isLocal(host)) {
    process.nextTick(() => this.destroy(blocked(host)));
    return this;
  }
  return connect.apply(this, args);
};

const lookup = dns.lookup;
dns.lookup = function (hostname, ...rest) {
  if (!isLocal(hostname)) {
    const cb = rest.find((a) => typeof a === "function");
    return process.nextTick(() => cb(blocked(hostname)));
  }
  return lookup.call(this, hostname, ...rest);
};
const plookup = dns.promises.lookup;
dns.promises.lookup = async function (hostname, ...rest) {
  if (!isLocal(hostname)) throw blocked(hostname);
  return plookup.call(this, hostname, ...rest);
};
