# What stays on your computer, and what doesn't

This describes Multiplayer AI as you run it yourself with `npm start` (the default local setup). It describes what the software does and is not legal advice; no lawyer has reviewed it.

**Nothing leaves your computer except what Multiplayer AI sends to the model provider you chose.** There is no account, no analytics, no update check and no reporting back to anyone.

## What is stored, and where

All of it is in one folder on your computer: `.multiplayer-ai` in your home folder, or the folder named in `MULTIPLAYER_AI_DATA_DIR`. Only your account can read it.

| File | What it holds |
|---|---|
| `multiplayer-ai.db` | Your rooms: titles, tasks, messages, comments, the agent's replies, the text files in each room with their kept versions, the names people used, and a one-way hash of each person's access token |
| `settings.json` | Which provider you chose, and the key you saved, **as plain text** |
| `instance.key` | A secret used to make room links; it is never in an export |
| `multiplayer-ai.db.bak-v…` | A copy made before the data file was upgraded, if it ever was |

**Settings** can export everything (including each room's files and their kept versions) to a file, delete every room, and delete the saved key. A deleted room is overwritten in the file, not only unlinked. Deleting every room also replaces `instance.key`, so old links stop working.

When the controller or the host attaches a file, the browser reads the file they chose and sends its text to this computer's server; nothing is sent anywhere else. A download is made in the browser and saved as plain text.

In each person's browser, Multiplayer AI keeps a few items in local storage (your name, a per-room access token, the theme and light or dark choice, and whether the side panel is open). The only cookie is the host's sign-in cookie: it is HttpOnly, is not sent to other sites, and stops working when Multiplayer AI stops.

## What the web page requests

Only Multiplayer AI's own address, nothing else. That includes fonts: they are bundled with the app. A browser test (`web/qa/external-requests.spec.js`) opens the landing page, Start a room, Setup, Settings, the expired sign-in page and a room, and fails if any of them asks another host for anything. The smoke test also checks that the built page and its styles name no other host.

## What the server sends out

| When | To where | What |
|---|---|---|
| The agent replies (and when it writes a rolling summary of a long room) | The provider you chose, at the host Settings shows before you save | Your key, as the request's credential; the room's task, the host's brief if there is one, its summary so far, and the most recent messages that fit, in the form the provider expects. Comments are not sent. If the agent uses the room's files ([agent-tools.md](agent-tools.md)), also the names and sizes of the room's files, the text of any file it reads, and the text it writes. |
| You press **Test key** | The same host | Your key and one small request |
| First start (and Docker builds) | The npm package registry; for Docker builds, also Docker's registry for the base image | The names of the packages and the image to download. Nothing about you or your rooms. |
| Only if you set Supabase storage | Your Supabase project | Your rooms and people's names. This is an option, off by default, and was not checked against a live project in this version. See [supabase.md](supabase.md). |

The exact host each choice talks to is in the table in [providers.md](providers.md#the-four-choices). Setup has links to each provider's key page; they are ordinary links and nothing is requested from them unless you click one.

The provider's own terms and privacy policy decide what it does with what it receives. [providers.md](providers.md) lists which host each choice talks to. If you choose a provider address that is on your own computer, nothing leaves it at all.

**Not verified:** one of the built-in provider choices makes its requests through that vendor's own library. Its requests to the host Settings names are expected; whether the library makes any other, we have not checked. The other two choices (the second built-in one, and an address you enter yourself) use plain requests written in this project, which we have read.

## What other people can see

If you let people on your Wi-Fi in (see [sharing.md](sharing.md)), they reach your computer over plain `http`. They see what is said in the rooms they join: names, messages, comments and the agent's replies, and they can open, copy and download every file in those rooms. Anyone on that network who can capture traffic can read it too, including the room secret and access tokens. They cannot see your key, your settings or your export, and those pages do not exist on the network address. They can see another room only if they have that room's link.

## Logs

What Multiplayer AI prints in the terminal has your key and any room secret removed. The reason a reply failed is shown to people in the room as a category ("the provider didn't accept the key"); what the provider actually said goes only to your terminal. Text that other people or a provider control (a name, a title, an error message) is printed with control characters shown as escapes such as `\x1b`, so it cannot repaint your terminal or fake a log line. Names and titles that hold control characters are refused when they are set.
