// Some tests wait on a timeout that Node itself unrefs (AbortSignal.timeout, a request timer). Nothing else keeps
// the event loop alive then, and Node 22's test runner cancels the test as "event loop already resolved". A test
// file that waits on such a timeout calls this once at the top.
import { after } from "node:test";

export function keepLoopAlive() {
  const timer = setInterval(() => {}, 1000);
  after(() => clearInterval(timer));
}
