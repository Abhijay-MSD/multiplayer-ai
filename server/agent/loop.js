// The provider-neutral tool loop: ask the model, run the tools it asks for, give it the results, and repeat until it
// answers in text or something says stop. Nothing here knows a provider's format; an adapter turns the internal messages
// (providers/tool-format.js) into its own, and turns its answer back.
//
// Every way out is named, so the host can be told which one it was:
//   model_calls, tool_calls, room_calls   one of the caps in docs/limits.md
//   time                                  DIRECTIVE_SECONDS passed
//   budget                                the daily step budget is spent
//   stopped                               someone pressed Stop (the signal's reason says who)
//   room_closed, files_off, deleted       the room was archived or ended, the host turned the files off, or the room is gone
// Separately, `stoppedForLength` says the provider cut the last answer at its own length limit: that is not a way out of the loop
// (the answer is complete as far as it goes), only something the caller tells the room.
// A way out is not an error: what was written stays, and the caller writes one status line from `stopped.line`. A failure
// from the provider is an error: it is thrown as the adapter threw it, and the caller reports its category.
import { executeTool } from "./tools.js";
import { toolsRejected } from "../providers/tool-format.js";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const CAP_LINES = {
  model_calls: (l) => `Stopped: the agent used all ${plural(l.modelCalls, "model call", "model calls")} allowed for one message (MODEL_CALLS_PER_DIRECTIVE).`,
  tool_calls: (l) => `Stopped: the agent used all ${plural(l.toolCalls, "file tool call", "file tool calls")} allowed for one message (TOOL_CALLS_PER_DIRECTIVE).`,
  room_calls: (l) => `Stopped: this room has used all ${plural(l.roomModelCalls, "model call", "model calls")} it is allowed (MODEL_CALLS_PER_ROOM).`,
  time: (l) => `Stopped: answering took longer than ${plural(Math.round(l.wallMs / 1000), "second", "seconds")} (DIRECTIVE_SECONDS).`,
  budget: () => "Stopped: today's step budget is spent (DAILY_STEP_BUDGET).",
};

/**
 * @param {object} o
 *   store, sessionId       where the files are
 *   author                 whose message this answers; the agent's writes are made on their behalf, whoever holds control now
 *   messages               the context, in the internal format
 *   call                   ({ messages, tools, signal }) -> { text, toolCalls, model, usage, raw?, usedFallback? }
 *   tools                  the tool definitions to offer ([] for none)
 *   limits, fileLimits     loopLimits() and fileLimits()
 *   roomCalls              model calls this room has already made
 *   signal                 aborted by Stop; its reason may be { stoppedBy: name }
 *   claim                  async: take one step from the daily budget (called before every call but the first)
 *   shouldStop             async: null, or { reason, line } when the room no longer allows this
 *   hooks                  { line(text), noteCall(n), toolsRejected() }
 *   now                    a clock, for tests
 */
export async function runAgentLoop({ store, sessionId, author, messages, call, tools, limits, fileLimits, roomCalls = 0, signal, claim, shouldStop, hooks, now = Date.now }) {
  const started = now();
  const deadline = started + limits.wallMs;
  const msgs = [...messages];
  let toolsOn = tools.length > 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let text = "";
  let model = null;
  let usedFallback = false;
  let noTools = false;
  let stoppedForLength = false; // did the provider cut the last answer at its length limit?
  const total = { inputTokens: 0, outputTokens: 0, reported: 0 };

  const done = (extra = {}) => ({
    text, model, usedFallback, modelCalls, toolCalls, noTools, stoppedForLength,
    usage: total.reported ? { inputTokens: total.inputTokens, outputTokens: total.outputTokens } : null,
    usageComplete: modelCalls > 0 && total.reported === modelCalls,
    stopped: null,
    ...extra
  });
  const stop = (reason, line, extra = {}) => done({ stopped: { reason, line: line ?? CAP_LINES[reason]?.(limits), ...extra } });
  const stoppedByPerson = () => {
    const by = signal?.reason?.stoppedBy;
    return stop("stopped", by ? `Stopped by ${by}` : "Stopped", { by });
  };
  // Is there a reason to end now, before the next model call or tool call?
  const precheck = async () => {
    if (signal?.aborted) return stoppedByPerson();
    if (now() >= deadline) return stop("time");
    const outside = await shouldStop?.();
    return outside ? done({ stopped: outside }) : null;
  };

  for (;;) {
    let ended = await precheck();
    if (ended) return ended;
    if (modelCalls >= limits.modelCalls) return stop("model_calls");
    if (roomCalls + modelCalls >= limits.roomModelCalls) return stop("room_calls");
    if (modelCalls > 0) {
      try {
        await claim?.();
      } catch (e) {
        if (e?.code === "AT_CAPACITY") return stop("budget");
        throw e;
      }
    }

    // The model call is cut off by Stop and by the deadline; which one decides how the loop ends.
    const timer = AbortSignal.timeout(Math.max(1, deadline - now()));
    const reasons = [timer, signal].filter(Boolean);
    let result;
    try {
      result = await call({ messages: msgs, tools: toolsOn ? tools : [], signal: AbortSignal.any(reasons) });
    } catch (e) {
      if (signal?.aborted) return stoppedByPerson();
      if (timer.aborted || now() >= deadline) {
        modelCalls++;
        await hooks.noteCall?.(modelCalls);
        return stop("time");
      }
      if (toolsOn && modelCalls === 0 && toolsRejected(e)) {
        // This model or provider doesn't take tools: say so once, and answer in text. The refused call still counted.
        toolsOn = false;
        noTools = true;
        modelCalls++;
        await hooks.noteCall?.(modelCalls);
        await hooks.toolsRejected?.();
        continue;
      }
      throw e;
    }

    modelCalls++;
    await hooks.noteCall?.(modelCalls);
    model = result.model ?? model;
    usedFallback = usedFallback || Boolean(result.usedFallback);
    if (result.usage) {
      total.reported++;
      total.inputTokens += result.usage.inputTokens ?? 0;
      total.outputTokens += result.usage.outputTokens ?? 0;
    }
    if (result.text) text = result.text;
    stoppedForLength = Boolean(result.stoppedForLength);

    const asked = toolsOn && Array.isArray(result.toolCalls) ? result.toolCalls : [];
    if (!asked.length) return done();

    msgs.push({ role: "assistant", content: result.text ?? "", toolCalls: asked, ...(result.raw ? { raw: result.raw } : {}) });
    let capped = false;
    for (const c of asked) {
      ended = await precheck();
      if (ended) return ended;
      if (toolCalls >= limits.toolCalls) {
        capped = true;
        break;
      }
      toolCalls++;
      const r = await executeTool({ call: c, store, sessionId, author, fileLimits, limits });
      await hooks.line?.(r.line);
      msgs.push({ role: "tool", toolCallId: c.id, name: c.name, content: r.content, isError: !r.ok });
    }
    if (capped) return stop("tool_calls");
  }
}
