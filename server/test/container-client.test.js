// Run: MULTIPLAYER_AI_TEST_CLIENT_IMAGE=<an image with sh and curl> node --test test/container-client.test.js
// (skipped unless that variable names a local image; nothing is pulled)
//
// A guest that is really somewhere else: a throwaway container makes the requests a phone would, to this
// computer's network address, and the server records the source address each connection came from. This
// is what proves the loopback checks are not what the tests were passing on: every connection here is
// from a non-loopback source. The container is labelled multiplayer-ai-test and removed when the test ends.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { boot, lanAddress, resetSettings } from "./helpers/http.js";
import { startFakeProvider, ok } from "./helpers/fakeProvider.js";
import { cleanup } from "./helpers/stores.js";

const image = process.env.MULTIPLAYER_AI_TEST_CLIENT_IMAGE;
const lan = lanAddress();
const docker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20000 }).status === 0;
const skip = !image ? "set MULTIPLAYER_AI_TEST_CLIENT_IMAGE to a local image that has sh and curl" : !docker ? "docker is not running" : !lan ? "this computer has no non-loopback IPv4 address" : false;
const name = `multiplayer-ai-test-client-${process.pid}`;

const closers = [];
after(async () => {
  if (!skip) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30000 }); // only the one this test named
  for (const c of closers.splice(0)) await c();
  resetSettings();
  await cleanup();
});

test("a guest in a container, on a real non-loopback source, gets exactly what a guest should", { skip, timeout: 120_000 }, async (t) => {
  const provider = await startFakeProvider(ok("A reply."));
  closers.push(() => provider.close());
  const b = await boot();
  closers.push(() => b.app.close());
  b.settings.save({ provider: "compat", baseUrl: provider.base, model: "m1" });
  b.settings.saveKey("compat", "sk_container_client_made_up_key_00112233");
  const cookie = await b.cookie();
  await b.app.sharing.enable(lan);

  const sources = [];
  b.app.sharing.listener.on("connection", (s) => sources.push(s.remoteAddress));

  const host = (method, path, body) =>
    fetch(`${b.app.url}${path}`, { method, headers: { Cookie: cookie, Origin: b.app.url, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const room = await (await host("POST", "/api/tools/create_session", { task: "Plan a trip", creator_name: "Maya" })).json();
  const panel = await (await host("GET", `/api/host/rooms/${room.session_id}`)).json();
  const secret = new URL(panel.share.link).hash.replace(/^#k=/, "");
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);

  const base = `http://${lan}:${b.app.port}`;
  const script = `
b=${base}
json='Content-Type: application/json'
r() { l=$1; shift; c=$(curl -sS -o /tmp/o -w '%{http_code}' --max-time 10 "$@" 2>/tmp/e); [ -f /tmp/o ] || : >/tmp/o; printf 'R %s %s %s %s\n' "$l" "$c" "$(tr -d '\n' </tmp/o | cut -c1-8000)" "$(tr -d '\n' </tmp/e | cut -c1-120)"; rm -f /tmp/o /tmp/e; }
r status        $b/api/status
r settings      $b/api/settings -H "Cookie: ${cookie}"
r export        $b/api/data/export -H "Cookie: ${cookie}"
r host-sharing  $b/api/host/sharing -H "Cookie: ${cookie}"
r create        -X POST $b/api/tools/create_session -H "$json" -H "Origin: $b" -H "Cookie: ${cookie}" -d '{"task":"x","creator_name":"Mallory"}'
r join-no-link  -X POST $b/api/tools/join_session -H "$json" -H "Origin: $b" -d '{"session_id":"${room.session_id}","name":"Dana"}'
r join-wrong    -X POST $b/api/tools/join_session -H "$json" -H "Origin: $b" -d '{"session_id":"${room.session_id}","name":"Dana","invite":"${"A".repeat(43)}"}'
r join          -X POST $b/api/tools/join_session -H "$json" -H "Origin: $b" -d '{"session_id":"${room.session_id}","name":"Dana","invite":"${secret}"}'
r proxied       $b/api/status -H "X-Forwarded-For: 10.0.0.9"
r wrong-host    $b/api/status -H "Host: evil.example"
r wrong-origin  -X POST $b/api/tools/join_session -H "$json" -H "Origin: http://evil.example" -d '{"session_id":"${room.session_id}","name":"Eve","invite":"${secret}"}'
`;
  // Asynchronous on purpose: the server being tested runs in this process, so waiting for the container must not block it.
  const run = await new Promise((resolve) => {
    const child = spawn("docker", ["run", "--rm", "-i", "--label", "multiplayer-ai-test", "--name", name, "--entrypoint", "sh", image, "-s"], { stdio: ["pipe", "pipe", "pipe"] });
    const out = { stdout: "", stderr: "", status: null };
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stdout.on("data", (d) => (out.stdout += d));
    child.stderr.on("data", (d) => (out.stderr += d));
    child.on("close", (code) => (clearTimeout(timer), resolve({ ...out, status: code })));
    child.stdin.end(script);
  });
  assert.equal(run.status, 0, `the container did not run: ${run.stderr.slice(0, 300)}`);
  const got = Object.fromEntries(
    run.stdout.split("\n").filter((l) => l.startsWith("R ")).map((l) => {
      const [, label, status, ...rest] = l.split(" ");
      return [label, { status: Number(status), body: rest.join(" ") }];
    })
  );

  assert.equal(got.status.status, 200, run.stdout.slice(0, 700));
  assert.deepEqual(JSON.parse(got.status.body), { configured: true, sharing: true, host: false });
  for (const l of ["settings", "export", "host-sharing"]) assert.equal(got[l].status, 404, `${l} is not there for a guest, even with the host's cookie`);
  assert.equal(got.create.status, 403);
  assert.match(got.create.body, /HOST_ONLY/);
  assert.equal(got["join-no-link"].status, 403);
  assert.match(got["join-no-link"].body, /INVITE_REQUIRED/);
  assert.equal(got["join-wrong"].status, 403);
  assert.equal(got.join.status, 200, `joining with the link: ${got.join.body.replace(/mpai_[A-Za-z0-9_-]+/g, "mpai_…")}`);
  assert.match(got.join.body, /"token":"mpai_/, run.stdout.split("\n").find((l) => l.startsWith("R join ")).replace(/mpai_[A-Za-z0-9_-]+/g, "mpai_…").slice(0, 400));
  assert.ok(!got.join.body.includes(secret), "the secret is not echoed to the guest");
  assert.equal(got.proxied.status, 403);
  assert.match(got.proxied.body, /PROXY_NOT_SUPPORTED/);
  assert.equal(got["wrong-host"].status, 403);
  assert.match(got["wrong-host"].body, /BAD_HOST/);
  assert.equal(got["wrong-origin"].status, 403);

  // And the point of this test: where the server saw these requests come from.
  assert.ok(sources.length >= 11, `the server saw ${sources.length} connections from the container`);
  const seen = [...new Set(sources)];
  assert.ok(seen.every((a) => !/^(127\.|::1$|::ffff:127\.)/.test(a)), `no connection came from loopback (saw ${seen.join(", ")})`);
  t.diagnostic(`source addresses the server saw from the container: ${seen.join(", ")}; this computer's address: ${lan}`);
  const jar = JSON.stringify([...(await b.store.listParticipants(room.session_id))]);
  assert.ok(!jar.includes(secret));
});
