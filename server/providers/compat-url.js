// The address of an OpenAI-compatible provider, checked before a key is ever sent to it.
//
//   * https, or plain http only for this computer (localhost, 127.0.0.1, ::1), where a
//     local model server usually listens;
//   * no user name or password in the address, no query, no fragment;
//   * the host the key will go to is returned exactly as the network will see it
//     (non-ASCII names appear in their ASCII form, so a look-alike is visible).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Returns { ok: true, base, host, port, scheme, local, display } or { ok: false, message }.
 * `base` has no trailing slash; the chat endpoint is `${base}/chat/completions`.
 */
export function parseCompatBaseUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, message: "Enter the address of the provider, such as https://api.example.com/v1." };
  if (text.length > 300) return { ok: false, message: "That address is too long." };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: "That isn't a web address. It should start with https://." };
  }
  const scheme = url.protocol.replace(":", "");
  const local = LOCAL_HOSTS.has(url.hostname);
  if (scheme !== "https" && !(scheme === "http" && local)) {
    return {
      ok: false,
      message: scheme === "http"
        ? "Plain http would send your key unprotected. Use an https address (http is allowed only for this computer, such as http://localhost:11434/v1)."
        : "The address must start with https://."
    };
  }
  if (url.username || url.password) return { ok: false, message: "Leave the user name and password out of the address." };
  if (url.search || url.hash) return { ok: false, message: "Leave the ? and # parts out of the address." };
  const port = url.port || (scheme === "https" ? "443" : "80");
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return { ok: true, base, host: url.hostname, port, scheme, local, display: `${url.hostname} (${scheme}, port ${port})` };
}
