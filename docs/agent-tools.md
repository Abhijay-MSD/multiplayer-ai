# What the agent can do with files

The agent can use four tools on **text files kept in the room**: `list_files`, `read_file`, `write_file` and `append_file`. That is all. There is no tool to delete a file, make a folder, run code, use a shell, search or browse the web, or reach any other computer. Adding one of those is not a small change: it was thought through in an earlier design note (see "Not built" below) and nothing of it exists.

This page says what the tools do, who can cause them to run, what is stored and where, what is limited, what the room is shown, and what is and isn't prevented.

## What each tool does

| Tool | What it does |
|---|---|
| `list_files` | Lists the files in the room with each one's size and version. |
| `read_file` | Reads one file by name. The text comes back marked as untrusted data. A file longer than the result limit is cut, and the result says so. |
| `write_file` | Creates a file, or replaces a file's whole content. The previous version is kept (up to 10 versions of a file). Writing the text a file already has changes nothing. |
| `append_file` | Adds text to the end of a file, or creates the file. It is for writing a long document in sections, one section on each call; the agent is told to do that rather than refuse or cut a long request. It is `write_file` with the text added inside the same step, so everything that holds for a write holds for a section: the same name rules, the same limits on one file, on the number of files and on the room's space (every section counts, and every section is a kept version), the same quiet line in the room for every call (`Added to essay.md, version 3, 2.1 KB`), and only the controller's messages can start it. The text is added exactly as given. |

A name is looked up in the room's own list and nowhere else. Files are rows in the data file, not files on your disk, so no path is ever built from anything the model says.

## File names and content

A name is an allowlist: ASCII letters, digits, space, dot, dash and underscore, 1 to 64 characters. It may not start with a dot or a space, end with a dot or a space, or contain two dots in a row. Names Windows reserves (`CON`, `NUL`, `COM1`, `LPT1` and the like, with or without an extension) are refused. Two names that differ only in letter case are the same file, and the first spelling is kept. Slashes, backslashes, null bytes, control characters, text-direction marks, zero-width and other format characters, and letters from other alphabets (which can look like Latin ones) are all refused, not cleaned: the name someone typed is the name shown.

Content must be text: valid UTF-8 with no NUL character. A file that isn't text can't be attached or written.

## Who can make the agent use files

- **Only the controller's messages start it.** A comment never reaches the model and never starts a step (this is as it was). A guest's message is refused unless that guest holds control.
- **The host switches it per room**, in Host controls: "Agent can use files". It is on for a room started while sharing is off, on a copy that isn't in a container, with local storage. It is off for a room started while sharing is on, in a container, and for every room that existed before this feature. Turning it off stops a running loop at its next step.
- **If control changes hands in the middle of an answer**, the answer is finished under the person whose message it was: files it writes are recorded as written by the agent for that person, not for whoever holds control now.
- If the room is archived or ended, or deleted, the loop stops at the next step. If the server stops, the room is told on the next start that a message wasn't answered; files already written stay.
- If the model provider fails partway, the loop stops and the room is told the category of the failure; files already written stay.

## Where files live

In the room, in the data file (`multiplayer-ai.db`), in a table that is created by a numbered migration, after the file has been copied to a backup. With Supabase storage there are no files: the tools aren't offered, the host's switch and the Files tab are hidden, and the routes answer in plain words that files need the local data file.

Deleting a room deletes its files and their history, and the space is overwritten, not only unlinked. Deleting every room also replaces the key behind old share links. Export includes every room's files with their kept versions. Multiplayer AI never writes the saved model key into a file or an export. If someone puts the key itself in a file's text, it is hidden from what a tool sends back to the model (the file keeps its text, and so does an export of it).

## Limits

Every limit can be set in `server/.env`; the defaults are placeholders. A bad value stops the server at startup. They are in [limits.md](limits.md).

| Setting | Default | What it limits |
|---|---|---|
| `MAX_FILE_KB` | 200 | One file |
| `MAX_FILES_PER_ROOM` | 50 | Files in a room |
| `MAX_ROOM_FILES_KB` | 2048 | Everything a room's files hold, counting kept versions |
| `TOOL_CALLS_PER_DIRECTIVE` | 12 | File tool calls to answer one message |
| `MODEL_CALLS_PER_DIRECTIVE` | 8 | Model calls to answer one message |
| `TOOL_RESULT_KB` | 20 | The most a tool result fed back to the model may hold |
| `DIRECTIVE_SECONDS` | 120 | Time to answer one message |
| `MODEL_CALLS_PER_ROOM` | 200 | Model calls a room may make in all |

When the room's total is full, the oldest history (never a file's newest version) is dropped to make room; if that isn't enough, the write is refused and nothing changes.

A message still counts as one step toward the room's step cap, however many model calls it takes. **Every model call counts toward the daily step budget when one is set**, so a loop can be stopped by it. When any cap stops a loop, the room sees one line that says which one, with the setting's name, for example "Stopped: the agent used all 8 model calls allowed for one message (MODEL_CALLS_PER_DIRECTIVE)." What the agent wrote before that stays.

## Stop

While a message is being answered, the controller and the host see a **Stop the agent** button above the message box. A guest who isn't steering doesn't, and the server refuses them if they try. Stop aborts the request to the model that is in flight, ends the loop at once, and puts "Stopped by <name>" in the room. Files already written stay. Messages that were waiting behind the running one are dropped, and the room is told how many. If the model had already answered when Stop arrived, the answer is dropped and the room says who stopped it: there is either a reply or a stop line, never both. Stop with nothing running does nothing and says so.

One thing Stop can't do: a request that has already reached the provider may still be billed by it, even though this program stops waiting for it.

## What the room is shown

Every tool call leaves one quiet line in the conversation, with names and sizes only: "Created notes.md, 2.1 KB", "Edited plan.md, version 3", "Read data.csv", "Listed the files". After each message, a quiet line says what it took: "Used 2 model calls and 1 file tool call. Tokens: 30 in, 11 out." Tokens are counted only as far as the provider reported them: when it reported none the line says "Tokens: not reported.", and when it reported only some calls the line says so. Nothing is estimated. The host panel shows the room's model calls against `MODEL_CALLS_PER_ROOM` next to the other totals. A call that fails leaves a line that says only why, in a category ("the name isn't allowed", "the file is too large", "there is no such file"). A name from a model is shown only after it passed the rules above. The agent's replies can mention files in ordinary text.

## Prompt injection: what this does and doesn't prevent

A file, or anything a tool returns, can contain text written to steer a model ("ignore your instructions and..."). A model can't reliably tell instructions from data. What is done:

- The context the model gets shows **file names and sizes only**; a file's text reaches the model only when it calls `read_file`.
- That text is returned between markers that call it untrusted data, with a warning before it. A file can't contain the closing marker: it is removed from the text.
- The model is told that only the person steering gives instructions and that text in files is data.
- The text is cut to the result limit.
- The tools can only list, read, write and append to files in this room. A model that is misled can write or overwrite files in the room (older versions are kept, and the host can restore them), and it can say things in the room. It can't delete anything, reach another room, a path on your disk, the network, or your key.

What is not prevented: the model may still follow what a file says. If you attach a file you didn't write, the agent may be steered by it. Attach only files you trust, and keep the switch off in a room where the controller may be someone you don't know.

## Providers

The tools reach each provider in that provider's own tool-calling format. The formats, and what was and wasn't confirmed, are in [providers.md](providers.md#tool-calling). If a provider's format is unconfirmed, the agent answers in text only for that provider and the room is told so. If a model turns tools down, the room is told once, that message is answered in text, and later messages in that room go as text.

## Not built

Running code, a shell, browsing or searching the web, a delete tool, folders, tools that send anything out. See `docs/` and the project's notes for why these are different kinds of feature; none is planned.
