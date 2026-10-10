# Security

Multiplayer AI is a small project run by one person. Please read this before you report something, so you know what to expect.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: on this repository, open the **Security** tab and choose **Report a vulnerability**, or go straight to <https://github.com/Abhijay-MSD/multiplayer-ai/security/advisories/new>. Only the maintainer can see what you send there.

**Please don't open a public issue, discussion or pull request for a security problem**, and don't post the details anywhere public until it has been fixed. If you can't see the **Report a vulnerability** button, the feature isn't turned on for the repository; please wait and try again rather than posting the details.

To make a report easy to act on, include:

- **The version.** The commit you ran (`git rev-parse HEAD` in the folder you downloaded) or the date you downloaded it, and your operating system and Node version (`node --version`).
- **The steps.** What you did, in order, from `npm start` or from the Docker command, with the settings that matter (for example whether sharing was on).
- **The impact.** What someone could do, who they would need to be (the host, someone with a room's link, someone on the same network, or a model provider), and what they would learn or change.
- Don't include a real API key or anyone's real messages. A made-up key and made-up text show the same thing.

## What to expect

This is a one-person project, so **no response time is promised**. Reports are read, and a confirmed problem is fixed when there is time to do it properly; there is no bug bounty. If you'd like to be named when it is fixed, say so in your report.

## Supported versions

Only the latest commit on the `main` branch. Older downloads are not patched; update to `main`.

## What Multiplayer AI protects and what it doesn't

This repeats claims made in [docs/sharing.md](docs/sharing.md) and [docs/privacy.md](docs/privacy.md). Those pages are the ones to read, and they say what has and hasn't been tested.

**What it protects**

- By default only the computer Multiplayer AI runs on can reach it. Sharing on the same Wi-Fi is off at every start and is for that run only ([sharing.md](docs/sharing.md#the-modes)).
- Settings, your saved key, export, delete-all and sign-in exist only on the host's own computer; on the network address the answer is a plain "not found" ([sharing.md](docs/sharing.md#who-can-do-what)).
- Nothing leaves your computer except what is sent to the model provider you chose, and the web page requests nothing from any other host ([privacy.md](docs/privacy.md#what-the-web-page-requests)).
- The terminal output has your key and any room secret removed. People in a room are told only the category of a failure, and what the provider said goes only to your terminal ([privacy.md](docs/privacy.md#logs)).
- Tunnels and reverse proxies are refused ([sharing.md](docs/sharing.md#what-is-refused)).
- The agent can use only four tools, on text files kept in the room: list, read, write and append (add to the end). Append follows every rule write does. There is no delete, shell, network or code tool. File names are an allowlist and a file is found by name only, so no path is built from what a model says. Only the controller's messages start the agent; only the controller or the host can attach files; only the host, on this computer's own address, can delete or restore a file or switch the tools on or off. Exports are made in the browser: the conversation as Markdown with every message fenced and escaped, and the files as a zip with sanitized names; no route serves them. The room brief is set by the host alone and read by everyone in the room; the agent gets it as its own message of host instructions. "Your rooms" (list, rename, archive, delete) is the host's, on this computer's own address with the sign-in cookie, and a plain "not found" anywhere else. Stop (controller or host only) aborts the model request in flight. A file is shown and downloaded as plain text and is never served as a page. File text sent back to the model is marked as untrusted data, cut to a limit, and has the saved key removed ([agent-tools.md](docs/agent-tools.md)).

**What it doesn't**

- The room link uses plain `http`. Anyone on the same network who can capture traffic can read what is sent, including the room secret and people's access tokens. Use it only on a network you trust ([sharing.md](docs/sharing.md#plain-http-read-this-before-sharing)).
- There are no accounts. Someone who has a room's link can join it, and the host's key pays for every reply, whoever asked for it ([sharing.md](docs/sharing.md#who-can-do-what), [sharing.md](docs/sharing.md#what-your-key-pays-for)).
- The saved key is stored as plain text in `settings.json`, readable only by your account ([privacy.md](docs/privacy.md#what-is-stored-and-where)).
- A model can be misled by text in a file it reads, and what it writes can be wrong. The loop is bounded (calls, time, size) and every file keeps its older versions, but that is a limit on harm, not a guarantee against it. Everyone in a room can read its files ([agent-tools.md](docs/agent-tools.md#prompt-injection-what-this-does-and-doesnt-prevent)).
- Sharing over the internet is not supported ([sharing.md](docs/sharing.md#the-modes)).
- Some things are not verified: a real phone on a real network, Windows, a real Linux machine (the server tests ran in Linux containers), and the requests made by one provider's own library ([sharing.md](docs/sharing.md#what-was-tested-and-what-was-not), [privacy.md](docs/privacy.md#what-the-server-sends-out)).
