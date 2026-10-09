import { test } from "@playwright/test";
import { settle } from "./helpers.js";

// Measures whether a long transcript needs virtualizing. Prints numbers; it
// fails only if scrolling is clearly janky.
for (const count of [200, 2000]) {
  test(`transcript of ${count} events`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const start = Date.now();
    await page.goto(`/__fixture/room?as=Dev&count=${count}`);
    await page.waitForSelector('[data-part="entry"]');
    await settle(page);
    const loadMs = Date.now() - start;
    const stats = await page.evaluate(async () => {
      const el = document.querySelector('[data-part="transcript"]');
      const nodes = document.querySelectorAll("*").length;
      const frames = [];
      let last = performance.now();
      let y = el.scrollHeight;
      await new Promise((resolve) => {
        const step = () => {
          const now = performance.now();
          frames.push(now - last);
          last = now;
          y -= el.scrollHeight / 120;
          el.scrollTop = Math.max(0, y);
          if (y > 0 && frames.length < 400) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      frames.sort((a, b) => a - b);
      return { nodes, p50: frames[Math.floor(frames.length / 2)], p95: frames[Math.floor(frames.length * 0.95)], max: frames.at(-1) };
    });
    console.log(`[${count} events] load ${loadMs}ms, ${stats.nodes} DOM nodes, frame p50 ${stats.p50.toFixed(1)}ms, p95 ${stats.p95.toFixed(1)}ms, max ${stats.max.toFixed(1)}ms`);
    info.annotations.push({ type: "measure", description: JSON.stringify(stats) });
    if (stats.p95 > 50) throw new Error(`Scrolling is janky at ${count} events (p95 ${stats.p95.toFixed(1)}ms)`);
  });
}
