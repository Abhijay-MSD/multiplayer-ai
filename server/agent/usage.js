// The quiet line left after each answered message: how many model calls and file tool calls it took, and how many tokens as far
// as the provider said. A count the provider didn't give is "not reported". Nothing here estimates.
const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const count = (n) => (n === null || n === undefined ? "not reported" : n.toLocaleString("en-US"));

export function usageLine({ modelCalls, toolCalls, usage, usageComplete }) {
  const used = `Used ${plural(modelCalls, "model call", "model calls")}${toolCalls ? ` and ${plural(toolCalls, "file tool call", "file tool calls")}` : ""}.`;
  if (!usage) return `${used} Tokens: not reported.`;
  const partial = usageComplete ? "" : " (the provider didn't report every call)";
  return `${used} Tokens: ${count(usage.inputTokens)} in, ${count(usage.outputTokens)} out${partial}.`;
}
