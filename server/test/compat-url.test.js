// Run: node --test test/   (no network)
// Which addresses a key may be sent to.
import test from "node:test";
import assert from "node:assert/strict";
import { parseCompatBaseUrl } from "../providers/compat-url.js";

const ok = (raw) => {
  const r = parseCompatBaseUrl(raw);
  assert.equal(r.ok, true, `${raw} should be accepted: ${r.message}`);
  return r;
};
const refused = (raw, re) => {
  const r = parseCompatBaseUrl(raw);
  assert.equal(r.ok, false, `${raw} should be refused`);
  assert.match(r.message, re);
};

test("an https address is accepted, with the exact host and port the key will go to", () => {
  const r = ok("https://api.example.com/v1");
  assert.deepEqual([r.base, r.host, r.port, r.scheme, r.local], ["https://api.example.com/v1", "api.example.com", "443", "https", false]);
  assert.equal(r.display, "api.example.com (https, port 443)");
  assert.equal(ok("https://api.example.com:8443/openai/v1/").display, "api.example.com (https, port 8443)");
  assert.equal(ok("https://api.example.com:8443/openai/v1/").base, "https://api.example.com:8443/openai/v1", "no trailing slash");
});

test("plain http is accepted only for this computer", () => {
  for (const raw of ["http://localhost:11434/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080/v1", "http://LOCALHOST/v1"]) {
    const r = ok(raw);
    assert.equal(r.local, true, raw);
    assert.equal(r.scheme, "http");
  }
  assert.equal(ok("http://localhost/v1").display, "localhost (http, port 80)");
});

test("plain http to anywhere else is refused, including names that only look local", () => {
  for (const raw of [
    "http://api.example.com/v1",
    "http://192.168.1.20:8080/v1",
    "http://localhost.evil.example/v1",
    "http://127.0.0.1.evil.example/v1",
    "http://0.0.0.0:8080/v1",
    "http://[::ffff:127.0.0.1]:8080/v1",
    "http://localhost" + "@" + "evil.example/v1"
  ]) {
    refused(raw, /http would send your key unprotected|user name/);
  }
});

test("other schemes, empty or malformed addresses are refused", () => {
  refused("", /Enter the address/);
  refused("   ", /Enter the address/);
  refused(undefined, /Enter the address/);
  refused("api.example.com/v1", /isn't a web address/);
  refused("ftp://api.example.com", /must start with https/);
  refused("file:///etc/passwd", /must start with https/);
  refused("javascript:alert(1)", /must start with https/);
  refused("https://" + "a".repeat(400), /too long/);
});

test("an address with a user name, a password, a query or a fragment is refused", () => {
  refused("https://user:pass" + "@" + "api.example.com/v1", /user name and password/);
  refused("https://user" + "@" + "api.example.com/v1", /user name and password/);
  refused("https://api.example.com/v1?key=abc", /\? and # parts/);
  refused("https://api.example.com/v1#frag", /\? and # parts/);
});

test("a look-alike host is shown in the form the network sees, so the difference is visible", () => {
  const r = ok("https://аpi.example.com/v1"); // the first letter is Cyrillic
  assert.match(r.host, /^xn--/);
  assert.ok(r.display.startsWith("xn--"));
});
