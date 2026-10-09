# Changelog

## 0.2.0 (candidate, not released)

Built on top of 0.1.0. Not published; the list below is only what is built and passing.

Not verified in this candidate: tool calling against any provider's real service (each format was written to its documentation, or for Gemini to the library's type definitions, and run against stand-ins), Windows, a Linux desktop, Firefox, Safari, screen readers, and the optional Supabase storage (which has none of the new features).

- **Files the agent can use.** Three tools on text files kept in the room: list, read and write (no delete, no folders, no shell, no network, no code). Files are stored in the data file by a numbered migration (with a backup first); with Supabase storage the feature is off. Names are an allowlist; content must be text. Each write keeps the previous version, up to 10 per file. Limits for file size, number of files, room total, tool calls, model calls, tool result size, time and model calls per room are settings (`docs/limits.md`). A message is still one step; every model call counts toward the daily budget when one is set. The host switches the agent's use of files per room; it is on for a room started while sharing is off, not in a container, and off otherwise. Tool calls leave quiet lines in the room. File text is sent to the model as marked, cut, untrusted data. Tool calling is implemented for Groq, the OpenAI-compatible choice, Gemini and Claude, each in its own format (`docs/providers.md`); a model that rejects tools is answered in text with a notice.
- **Stop and usage.** The controller and the host can stop a running answer: the request to the model is aborted, the room is told who stopped it, files already written stay, and waiting messages are dropped. Each answer ends with a quiet line of model calls, file tool calls and tokens ("not reported" when the provider didn't say). The host panel shows the room's model calls against their cap.
- **Ideas to start from.** Six hand-written starter tasks on the start screen. Choosing one only fills the task box; nothing is sent until the room is started.
- **Tables and links in replies.** The hand-written reply renderer draws simple tables (cut at 200 rows and 20 columns, saying so) and `[text](address)` links for full `http` and `https` addresses only, opening in a new tab with `rel="noopener noreferrer nofollow"` and the address as hover text. No images, no raw HTML; `javascript:`, `data:` and other addresses stay text.
- **Retry, shortcuts, copy and search.** "Send my last message again" for the controller: the last message is sent as a new message, so the guest cap, the pace limit, the daily budget and the step cap all apply, and it is refused while the agent is working. Ctrl+Enter or Cmd+Enter sends, Escape closes panels and clears a search, every message has a Copy button, and a search box above the conversation keeps the messages that hold the words (compared as text, never as markup).
- **Exports.** Save the conversation as Markdown (comments labelled, every message in a fence nothing can close, names and titles escaped, a sanitized file name), and download all of a room's files as a zip made by a hand-written store-only zip writer with sanitized names. Both are made in the browser; checked with `unzip -t` and by comparing bytes.
- **Room brief.** The host can set a brief of up to 1500 characters for a room in Host controls. It is shown to everyone in the room above the conversation, given to the agent as the host's instructions, noted in the room whenever it changes, and part of an export. Only the host can set it.
- **Your rooms.** `/rooms`, for the signed-in host on this computer's own address only (a plain "not found" elsewhere): every room with its title, last activity, people and state, newest activity first; rename, archive and unarchive, and delete one room behind typed words. Linked from the room's header and the landing page for the host only. A numbered migration adds the host's archive mark.
- **Files tab and attachments.** A Files tab beside Outputs lists each file with size, version, who changed it and when; view as plain text, copy, download. The controller or the host can attach text files from the message box (button or drag and drop). The host can see a file's history, restore a version and delete a file.

## 0.1.0

The first release. The app has been run on macOS with Node 24. Its server tests and the Docker image have also been run on Linux, in containers, on Node 22.13.0, 22.23.3 and 24. It has not been published anywhere before this.

What exists:

- A shared room: one transcript, one agent, and one person steering at a time. The controller messages the agent; everyone else can comment, and the agent never sees comments.
- Hand-off and take-control rules, presence (who is here, who is away), messages queued per room and answered one at a time, a step limit per room, and rooms that become read-only after a period with no activity.
- Start with `npm start`: the launcher installs what it needs, builds the web page, starts the server and prints a one-time sign-in link for the host.
- First-run Setup and Settings in the browser: choose a model provider, paste a key, test it, save it. Providers: Groq, Gemini, any service that speaks the OpenAI chat format, and Claude, which is experimental and not yet tested against the real service.
- Local storage in a single SQLite file in your data folder, with numbered migrations and a backup copy made before an upgrade. No accounts and no database to set up. An optional Supabase storage mode is kept but frozen and was not checked against a live project.
- Sharing on the same Wi-Fi for one run, with a link and QR code, host-chosen control policy, a cap on guests' messages, a new-link action and removal of a person. Settings, the key, export and delete exist only on the host's own computer address. Requests carrying proxy or tunnel headers are refused.
- Export of all rooms to a file, deletion of all rooms, and deletion of the saved key from Settings.
- Copy and download of code from replies, in an Outputs tab.
- Limits on replies, messages, names, titles and request size, all set in `server/.env` (see `docs/limits.md`).
- An MCP server (`server/server.js`) with tools to create and join rooms, send directives and comments, step the agent, take or hand over control, and set status.
- Four themes, each in light and dark. Fonts are bundled; the web page makes no requests to other hosts.
- A Dockerfile and a Docker guide. Node 22.13 or newer is required.
- A copy check, a secrets scan, a server test suite and a browser test suite.

Not verified in this release: the GitHub Actions workflow (it has not run), the Claude adapter against the real service, Supabase storage, Windows, a Linux desktop, Firefox, Safari, screen readers and real phones on a real network. See the README.
