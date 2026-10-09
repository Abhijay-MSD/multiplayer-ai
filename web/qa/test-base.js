// The `test` every spec imports instead of the one from @playwright/test. It adds what every browser test needs and none should repeat.
//
//   PW_CPU_THROTTLE=4  slows the page's CPU 4x through the DevTools protocol, to see how a test behaves on a slow runner.
//                      Unset (or 1) is full speed.
//
// No browser test reaches the real API. The preview server proxies /api to a server that is not running, so a request that nothing
// answered used to be a connection error in the log (and a page quietly behaving as if the server were down). Now:
//   - the few calls a page makes on its own (status, config, the host's room list and sharing) have a default answer below;
//   - a test's own page.route (mockApi, or its own) is looked at first and wins over the defaults;
//   - any other /api request is answered 501 and fails the test, naming the request. Mock it in the test, or add a default here.
import { test as base, expect } from "@playwright/test";

export { expect };

export const CPU_THROTTLE = Math.max(1, Number(process.env.PW_CPU_THROTTLE) || 1);

const isApi = (url) => new URL(url).pathname.startsWith("/api/");

// Answers for the requests a page makes whether or not the test is about them. They are what a plain visitor gets from a server with a
// key set: not the host (so the host-only routes say the host's link is needed), nothing shared. Only the routes the suite was found
// to leave unmocked are here; a room's own routes (/api/host/rooms/<id>, the stream, the tools) are the test's to mock.
const LINK_NEEDED = { status: 401, json: { error: "Open Multiplayer AI from the link in the terminal.", code: "ADMIN_LINK_NEEDED" } };
const DEFAULTS = [
  { method: "GET", path: "/api/status", json: { configured: true, sharing: false, host: false } },
  { method: "GET", path: "/api/config", json: { max_steps_per_session: 50 } },
  { method: "GET", path: "/api/host/rooms", ...LINK_NEEDED },
  { method: "GET", path: "/api/host/sharing", ...LINK_NEEDED }
];

// Context routes run after the page's own, and among themselves the one added last runs first: so the catch-all goes in first.
async function guardApi(context, unmocked) {
  await context.addInitScript(KEEP_BEACONS);
  await context.route(isApi, async (route) => {
    const req = route.request();
    unmocked.push(`${req.method()} ${new URL(req.url()).pathname}`);
    await route.fulfill({ status: 501, json: { error: "No mock for this request in the browser tests.", code: "UNMOCKED_API" } });
  });
  for (const d of DEFAULTS) {
    await context.route(
      (url) => new URL(url).pathname === d.path,
      (route) => (route.request().method() === d.method ? route.fulfill({ status: d.status ?? 200, json: d.json }) : route.fallback())
    );
  }
}

// The room tells the server it is leaving with navigator.sendBeacon as its page goes away. Playwright cannot route a request sent while a
// page unloads (not a beacon, and not a fetch with keepalive), so it would go to the proxy whatever the test mocked. Here the beacon is
// kept in the page, in window.__beacons, and goes nowhere.
const KEEP_BEACONS = () => {
  window.__beacons = [];
  navigator.sendBeacon = (url, data) => {
    window.__beacons.push({ url: String(url), data });
    return true;
  };
};

// What a test left unmocked, as one failure message.
function assertNoneUnmocked(unmocked) {
  if (unmocked.length) {
    const once = [...new Set(unmocked)];
    throw new Error(`The page made ${unmocked.length} /api request(s) the test did not mock:\n  ${once.join("\n  ")}\nMock them in the test (mockApi, or page.route), or add a default in test-base.js.`);
  }
}

// Applies the per-page settings. Used by the `page` fixture and by openPage, so a test that makes its own context gets the same.
async function prepare(page) {
  if (CPU_THROTTLE > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  }
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const unmocked = [];
    await guardApi(page.context(), unmocked);
    await prepare(page);
    await use(page);
    assertNoneUnmocked(unmocked);
  }
});

// A page in its own context, for a test that needs a viewport of its own. Call done() when finished: it closes the context and fails
// the test if the page made an /api request nothing mocked.
export async function openPage(browser, contextOptions) {
  const context = await browser.newContext(contextOptions);
  const unmocked = [];
  await guardApi(context, unmocked);
  const page = await context.newPage();
  await prepare(page);
  return {
    context,
    page,
    done: async () => {
        await context.close();
      assertNoneUnmocked(unmocked);
    }
  };
}
