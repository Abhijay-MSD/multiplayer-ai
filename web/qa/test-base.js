// The `test` every spec imports instead of the one from @playwright/test. It adds what every browser test needs and none should repeat.
//
//   PW_CPU_THROTTLE=4  slows the page's CPU 4x through the DevTools protocol, to see how a test behaves on a slow runner.
//                      Unset (or 1) is full speed.
import { test as base, expect } from "@playwright/test";

export { expect };

export const CPU_THROTTLE = Math.max(1, Number(process.env.PW_CPU_THROTTLE) || 1);

// Applies the per-page settings. Used by the `page` fixture and by openPage, so a test that makes its own context gets the same.
async function prepare(page) {
  if (CPU_THROTTLE > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  }
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await prepare(page);
    await use(page);
  }
});

// A page in its own context, for a test that needs a viewport of its own. Close the returned context when done.
export async function openPage(browser, contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await prepare(page);
  return { context, page };
}
