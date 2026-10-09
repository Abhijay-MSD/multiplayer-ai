import { test, expect, openPage, CPU_THROTTLE } from "./test-base.js";
import { settle } from "./helpers.js";

// Fails when a long transcript starts costing more to draw or scroll than it should, without depending on how fast the runner is.
//
// A runner's absolute speed says nothing about the page: the same 200-event room scrolls at 17 ms a frame on a laptop and 70 to 120 ms on
// a shared macOS runner, where the time goes to putting the screen on the display, not to the events. So there is no fixed limit in
// milliseconds here (PERF_STRICT=1 brings one back for a local run: p95 at most 50 ms at both sizes). The gate checks:
//   1. DOM nodes. The same events draw the same number of nodes on every machine, so a budget for N events is exact, and it is the
//      check that notices a transcript growing heavier per event on any runner, however fast.
//   2. The ratio of the 2000-event frame time (p95) to the 200-event frame time, measured one after the other in this run on this
//      machine. Whatever the machine adds to a frame, it adds to both.
// Measured ratios, this page as it is, scrolled by the wheel: 1.1 on a laptop at full speed, 1.8 with its CPU slowed 4x, 3.4 slowed 8x;
// 0.95 on the macOS runner (old scroll method), 1.9 on the Linux runner. The bound is 4. A test handler that re-measured every entry on
// each scroll gave 3.7 at 4x and 1.0 at full speed: the ratio only sees extra work that costs more than a frame (17 ms) on the machine
// it runs on, because a frame cannot be faster than the display. Slower runners see more; fast ones rely on the node budget.
// The numbers are always printed.

const SMALL = 200;
const LARGE = 2000;
const NODES_BASE = 200; // the page around the transcript
const NODES_PER_EVENT = 9; // measured: 8.2 (an event is a few elements: author line, time, copy button, body)
const RATIO_MAX = 4;
const STRICT = process.env.PERF_STRICT === "1";
const STRICT_P95_MS = 50;
const PASSES = 2;
const STEPS = 120; // wheel turns from the end of the transcript to the top, one per frame

// Each measurement gets a browser context of its own. How fast a page scrolls depends on what the browser has already shown (a 2000-event
// page opened after a 200-event one in the same tab can behave differently from one opened first), so every measurement starts the same.
//
// The transcript is scrolled with the mouse wheel, the way a person does it, so the browser scrolls it on its own thread. Setting
// scrollTop from a script every frame (what this test used to do) makes the main thread redo the page each frame, which costs 30 ms at
// 2000 events on a laptop slowed 4x and is not what a reader sees: a real wheel scroll of the same page costs about 1 ms.
async function measure(browser, count) {
  const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const start = Date.now();
  await page.goto(`/__fixture/room?as=Dev&count=${count}`);
  await page.waitForSelector('[data-part="entry"]');
  await settle(page);
  const loadMs = Date.now() - start;
  const page_ = await page.evaluate(() => {
    const el = document.querySelector('[data-part="transcript"]');
    const r = el.getBoundingClientRect();
    return { nodes: document.querySelectorAll("*").length, entries: document.querySelectorAll('[data-part="entry"]').length, x: r.left + r.width / 2, y: r.top + r.height / 2, scrollHeight: el.scrollHeight };
  });
  await page.mouse.move(page_.x, page_.y);
  const step = Math.round(page_.scrollHeight / STEPS);
  const frames = [];
  for (let p = 0; p < PASSES; p++) {
    await page.evaluate(() => {
      const el = document.querySelector('[data-part="transcript"]');
      el.scrollTop = el.scrollHeight;
      window.__frames = [];
      let last = performance.now();
      window.__recording = true;
      const tick = () => {
        const now = performance.now();
        window.__frames.push(now - last);
        last = now;
        if (window.__recording) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (let i = 0; i < STEPS; i++) {
      await page.mouse.wheel(0, -step);
      await page.waitForTimeout(16);
    }
    frames.push(...(await page.evaluate(() => ((window.__recording = false), window.__frames))));
  }
  await context.close();
  frames.sort((a, b) => a - b);
  const at = (q) => frames[Math.min(frames.length - 1, Math.floor(frames.length * q))];
  return { count, loadMs, nodes: page_.nodes, entries: page_.entries, frames: frames.length, p50: at(0.5), p95: at(0.95), max: frames.at(-1) };
}

test(`a transcript of ${LARGE} events is no more than ${RATIO_MAX}x the cost of ${SMALL}, within the node budget`, async ({ browser }, info) => {
  test.setTimeout(180_000); // three page loads and nine scrolls, on a runner that may be several times slower than a laptop
  // 200, 2000, 200: the second 200 shows whether the machine got slower or faster while this ran; the ratio uses the slower of the two.
    const small = await measure(browser, SMALL);
  const large = await measure(browser, LARGE);
  const smallAgain = await measure(browser, SMALL);
  const base = Math.max(small.p95, smallAgain.p95);
  const ratio = large.p95 / base;
  const perEvent = (large.nodes - small.nodes) / (LARGE - SMALL);

  for (const m of [small, large, smallAgain]) {
    console.log(`[${m.count} events] load ${m.loadMs}ms, ${m.nodes} DOM nodes (${m.entries} entries), frame p50 ${m.p50.toFixed(1)}ms, p95 ${m.p95.toFixed(1)}ms, max ${m.max.toFixed(1)}ms over ${m.frames} frames`);
  }
  console.log(`[ratio] p95 ${LARGE}/${SMALL} = ${ratio.toFixed(2)} (limit ${RATIO_MAX}); ${perEvent.toFixed(2)} nodes per event (limit ${NODES_PER_EVENT}); cpu throttle ${CPU_THROTTLE}x; strict ${STRICT ? "on" : "off"}`);
  info.annotations.push({ type: "measure", description: JSON.stringify({ small, large, smallAgain, ratio, perEvent }) });

  const problems = [];
  for (const m of [small, large]) {
    if (m.nodes > NODES_BASE + NODES_PER_EVENT * m.count) problems.push(`${m.count} events drew ${m.nodes} DOM nodes, over the budget of ${NODES_BASE + NODES_PER_EVENT * m.count}`);
  }
  if (perEvent > NODES_PER_EVENT) problems.push(`each event costs ${perEvent.toFixed(2)} DOM nodes, over ${NODES_PER_EVENT}`);
  if (ratio > RATIO_MAX) problems.push(`${LARGE} events scroll ${ratio.toFixed(2)}x as slowly as ${SMALL} (p95 ${large.p95.toFixed(1)}ms against ${base.toFixed(1)}ms), over ${RATIO_MAX}x`);
  if (STRICT) {
    for (const m of [small, large]) if (m.p95 > STRICT_P95_MS) problems.push(`scrolling is janky at ${m.count} events (p95 ${m.p95.toFixed(1)}ms, limit ${STRICT_P95_MS}ms)`);
  }
  expect(problems, "transcript size").toEqual([]);
});
