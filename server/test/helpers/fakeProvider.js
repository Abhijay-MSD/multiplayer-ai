// A model provider on this computer, for tests. It speaks the OpenAI chat-completions
// format at http://127.0.0.1:<port>/v1, records every request, and answers with whatever
// the test says: a reply, an error, an error that echoes the request (as some real
// providers do), a hang, or a dropped connection.
import http from "node:http";

export async function startFakeProvider(handler = ok("fine")) {
  const requests = [];
  let current = handler;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const seen = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(seen);
      Promise.resolve(current(seen, res)).catch((e) => res.destroy(e));
    });
  });
  server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    port,
    base: `http://127.0.0.1:${port}/v1`,
    requests,
    use: (h) => (current = h),
    close: () => new Promise((r) => (sockets.forEach((s) => s.destroy()), server.close(r)))
  };
}

const send = (res, status, json) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(json));
};

/** A normal reply. */
export const ok = (text) => (req, res) => send(res, 200, { choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } });

/** An error with a message the provider chose. */
export const fail = (status, message, extra = {}) => (req, res) => send(res, status, { error: { message, ...extra } });

/** An error whose message repeats the request back: its Authorization header, its body, and the account it belongs to. */
export const echoError = (status, { account = "acme-corp" } = {}) => (req, res) =>
  send(res, status, {
    error: {
      message: `Request rejected for account ${account}. You sent: Authorization: ${req.headers.authorization}; body=${req.body}`,
      type: "invalid_request_error",
      param: req.headers.authorization
    }
  });

/** Never answers. */
export const hang = () => () => new Promise(() => {});

/** Drops the connection without an answer. */
export const drop = () => (req, res) => res.socket.destroy();
