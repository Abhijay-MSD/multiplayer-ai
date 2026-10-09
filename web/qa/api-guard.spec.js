import { test, expect } from "./test-base.js";

// The rules in test-base.js: no test reaches the real API. A request nothing mocked fails the test and is named; the few defaults answer
// as a plain visitor would; a test's own mock wins over a default.

test("an /api request nothing mocked fails the test (this test passes because it fails)", async ({ page }) => {
  test.fail();
  await page.goto("/__fixture/name");
  await page.evaluate(() => fetch("/api/nothing-mocks-this"));
});

test("a request the test mocks is answered by the test, and the defaults answer the rest as a plain visitor", async ({ page }) => {
  await page.goto("/__fixture/name");
  const ask = (path) => page.evaluate(async (p) => { const r = await fetch(p); return { status: r.status, body: await r.json() }; }, path);

  expect(await ask("/api/status")).toEqual({ status: 200, body: { configured: true, sharing: false, host: false } });
  expect(await ask("/api/config")).toEqual({ status: 200, body: { max_steps_per_session: 50 } });
  expect((await ask("/api/host/rooms")).body.code).toBe("ADMIN_LINK_NEEDED");
  expect((await ask("/api/host/sharing")).status).toBe(401);

  await page.route("**/api/status", (route) => route.fulfill({ json: { configured: false, sharing: true, host: true } }));
  expect((await ask("/api/status")).body.host).toBe(true);
});

test("a method a default does not cover is not answered by it", async ({ page }) => {
  test.fail();
  await page.goto("/__fixture/name");
  await page.evaluate(() => fetch("/api/status", { method: "POST" }));
});

test("the leaving beacon stays in the page, and goes nowhere", async ({ page }) => {
  await page.goto("/__fixture/name");
  const sent = await page.evaluate(() => navigator.sendBeacon("/api/tools/leave_session", new Blob(["{}"])));
  expect(sent).toBe(true);
  expect(await page.evaluate(() => window.__beacons.map((b) => b.url))).toEqual(["/api/tools/leave_session"]);
});
