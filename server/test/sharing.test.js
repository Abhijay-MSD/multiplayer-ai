// Run: node --test test/   (no network)
// Which addresses can be shared on, and what a person may type for the address to share from a container.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyAddress, lanCandidates, parseShareName, PLAIN_HTTP_WARNING } from "../sharing.js";

test("an address is private, link-local, carrier-grade shared, public, loopback or invalid", () => {
  const cases = {
    "10.0.0.1": "private", "10.255.255.254": "private", "172.16.0.1": "private", "172.31.255.254": "private", "192.168.0.1": "private", "192.168.1.50": "private",
    "172.15.255.255": "public", "172.32.0.1": "public", "192.167.1.1": "public", "11.0.0.1": "public", "8.8.8.8": "public", "203.0.113.5": "public",
    "169.254.10.20": "link-local", "100.64.0.1": "cgnat", "100.127.255.254": "cgnat", "100.63.0.1": "public", "100.128.0.1": "public",
    "127.0.0.1": "loopback", "127.9.9.9": "loopback",
    "0.0.0.0": "invalid", "255.255.255.255": "invalid", "224.0.0.1": "invalid", "192.168.1": "invalid", "192.168.1.256": "invalid", "192.168.1.1.1": "invalid",
    "010.0.0.1": "invalid", "::1": "invalid", "fe80::1": "invalid", "": "invalid", "localhost": "invalid", "192.168.1.1 ": "invalid", "1e2.0.0.1": "invalid"
  };
  for (const [ip, kind] of Object.entries(cases)) assert.equal(classifyAddress(ip), kind, ip);
  for (const bad of [undefined, null, 42, {}, []]) assert.equal(classifyAddress(bad), "invalid");
});

const nic = (address, extra = {}) => ({ address, family: "IPv4", internal: false, ...extra });

test("only IPv4 addresses of real, non-loopback interfaces on a private-ish range are offered, with the interface name", () => {
  const interfaces = {
    lo0: [nic("127.0.0.1", { internal: true })],
    en0: [nic("192.168.1.50"), { address: "fe80::1", family: "IPv6", internal: false }],
    en5: [nic("203.0.113.5")], // a public address: never offered
    awdl0: [{ address: "fe80::2", family: "IPv6", internal: false }],
    empty: undefined
  };
  const found = lanCandidates(interfaces);
  assert.deepEqual(found.map((c) => [c.interface, c.address, c.kind]), [["en0", "192.168.1.50", "private"]]);
});

test("candidates are ordered: real private interfaces first, then virtual ones, then unusual ranges, and the unusual ones carry a warning", () => {
  const interfaces = {
    docker0: [nic("172.17.0.1")],
    utun3: [nic("100.100.1.2")],
    en0: [nic("192.168.1.50")],
    eth1: [nic("169.254.5.5")],
    vboxnet0: [nic("192.168.56.1")],
    wlan0: [nic("10.0.0.7")]
  };
  const found = lanCandidates(interfaces);
  assert.deepEqual(found.map((c) => c.interface), ["en0", "wlan0", "docker0", "vboxnet0", "eth1", "utun3"].sort((a, b) => {
    const order = ["en0", "wlan0", "docker0", "vboxnet0", "eth1", "utun3"];
    return order.indexOf(a) - order.indexOf(b);
  }));
  const by = Object.fromEntries(found.map((c) => [c.interface, c]));
  assert.equal(by.en0.virtual, false);
  assert.equal(by.docker0.virtual, true);
  assert.equal(by.vboxnet0.virtual, true);
  assert.equal(by.en0.warning, undefined);
  assert.match(by.eth1.warning, /link-local/i);
  assert.match(by.utun3.warning, /carrier|shared address|not a home/i);
});

test("a whole host machine with no usable network offers nothing", () => {
  assert.deepEqual(lanCandidates({ lo0: [nic("127.0.0.1", { internal: true })] }), []);
  assert.deepEqual(lanCandidates({}), []);
  assert.deepEqual(lanCandidates(undefined), []);
});

test("the plain-http warning says what is exposed and where not to use it", () => {
  assert.match(PLAIN_HTTP_WARNING, /plain http/i);
  assert.match(PLAIN_HTTP_WARNING, /read what's sent/i);
  assert.match(PLAIN_HTTP_WARNING, /secret/i);
  assert.match(PLAIN_HTTP_WARNING, /café, hotel, school or office/i);
});

test("an address to share from a container is a private IPv4 address or a .local name, and nothing else", () => {
  for (const ok of ["192.168.1.20", "10.0.0.5", "172.20.1.1", "macbook.local", "My-Mac.local", "  192.168.1.20  "]) {
    const r = parseShareName(ok);
    assert.equal(r.ok, true, ok);
    assert.equal(r.host, ok.trim().toLowerCase());
  }
  for (const bad of [
    "", "   ", "8.8.8.8", "203.0.113.5", "127.0.0.1", "localhost", "0.0.0.0", "example.com", "evil.example", "macbook.local.evil.example",
    "macbook.local:3737", "192.168.1.20:3737", "http://192.168.1.20", "192.168.1.20/", "a b.local", "-x.local", "x..local", ".local", "192.168.1.256", "*.local", "192.168.1.20,10.0.0.1"
  ]) {
    const r = parseShareName(bad);
    assert.equal(r.ok, false, `"${bad}" should be refused`);
    assert.ok(r.message.length > 10);
  }
  assert.equal(parseShareName("a".repeat(70) + ".local").ok, false, "too long");
});
