// Run: node --test test/   (no network, no real model)
// Nothing in what the agent is told may push it to refuse or cut a long piece of work, and nothing may stop a short question
// from getting a short answer. These read the text the model is given; what a real model then does with it has not been tested.
import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT, buildContext } from "../context.js";

const sentences = (text) => text.split(/(?<=[.!?])\s+/);

test("the system prompt says to do what was asked at the length asked, long work included", () => {
  assert.match(SYSTEM_PROMPT, /Do what the message asks, at the length it asks for/);
  assert.match(SYSTEM_PROMPT, /an essay, a report or a story gets its full length/);
});

test("the system prompt never lets length be a reason to refuse, shorten or decline", () => {
  assert.match(SYSTEM_PROMPT, /Never refuse, shorten or water down a request because of its length/);
});

test("when the work will not fit in one reply it says so plainly and writes in parts", () => {
  assert.match(SYSTEM_PROMPT, /If the work will not fit in one reply, say so plainly/);
  assert.match(SYSTEM_PROMPT, /write it in parts/);
});

test("short questions still get short answers", () => {
  assert.match(SYSTEM_PROMPT, /a greeting or a short question gets one or two sentences/);
});

test("no sentence of the prompt that mentions length, size or brevity tells the model to keep things short in general", () => {
  const about = sentences(SYSTEM_PROMPT).filter((s) => /length|long|short|brief|concise|words|sentences/i.test(s));
  assert.ok(about.length >= 2, "there are sentences about length to check");
  for (const s of about) {
    assert.doesNotMatch(s, /avoid|extremely long|too long|keep (it|answers|replies|your answer) (short|brief)|be (brief|concise)|as short as/i, s);
  }
  // The one old rule that was the whole of it: "Match the length of your answer to the question", with nothing for long requests.
  assert.doesNotMatch(SYSTEM_PROMPT, /Match the length of your answer to the question/);
});

test("every step starts from this prompt, as the first message", () => {
  const { messages } = buildContext({ session: { task: "x" }, events: [], directiveId: null });
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, SYSTEM_PROMPT);
});
