# Sharing a room

By default only the computer Multiplayer AI runs on can reach it. You can let people on the same Wi-Fi in, for this run only. Sharing over the internet is not supported yet.

## The modes

| Mode | Who can reach Multiplayer AI | How |
|---|---|---|
| **This computer only** (default) | Only you, on this computer | Nothing to do. Every start begins here; the choice is never remembered. |
| **Same Wi-Fi** | You, plus devices on the same local network | Settings > Sharing, or `npm start -- --share=wifi` (the same as `MULTIPLAYER_AI_SHARE=wifi`). |
| Over the internet | Not supported | Tunnels and public addresses are not supported yet. See "What is refused" below. |

## Turning on Same Wi-Fi

Multiplayer AI listens on this computer (`127.0.0.1`) and on **one** address of your local network, never on every address.

- It accepts only addresses in the ranges home and office networks use: `10.x.x.x`, `172.16.x.x` to `172.31.x.x` and `192.168.x.x`. A public address is refused.
- Two other kinds can be chosen, but only after a deliberate yes and with a plain note about why they are unusual: `169.254.x.x` (the address a computer gives itself when it found no network) and `100.64.x.x` to `100.127.x.x` (shared carrier networks and some VPNs).
- If this computer has several addresses, `--share=wifi` does not guess. It says so and leaves sharing off; choose the address in Settings > Sharing.
- If the address goes away while sharing is on (you left the network, the Wi-Fi dropped), Multiplayer AI closes the listener, tells you in Settings, and does **not** fall back to a wider one. Turn sharing on again to choose an address.
- Turning sharing off ends the connections that came in on that address.

On a Mac, the first time you turn sharing on, macOS may ask whether to allow incoming connections for `node`. Choose Allow; without it other devices can't connect. If you chose Don't Allow, change it in your Mac's firewall settings.

## Plain http: read this before sharing

The link uses plain `http` on your local network. Anyone on the same network who can capture traffic can read what is sent, including the room secret and people's access tokens. Use it only on a network you trust, like your home or your own hotspot. Don't use it on café, hotel, school or office Wi-Fi.

What Multiplayer AI can tell about the network: this computer's addresses, and whether the one you pick is an ordinary home-network kind. What it can't: whether this is a café, hotel, school or office network, who else is on it, or whether a firewall or router stops other devices reaching it. Those are yours to judge.

## The link and the QR code

Open a room **on this computer's own address** (`http://127.0.0.1:<port>` or `http://localhost:<port>`) and choose Host controls. You get:

- the link for guests, `http://<network address>:<port>/s/<room>/join#k=<secret>`, with a Copy link button. The Copy link button in the room's header copies the same link.
- a QR code of the same link, drawn by the server and checked by decoding it.

The room secret is after the `#`. A browser doesn't send the part after `#` in a request, so it isn't in the request line or in any log. The page reads it, sends it once in the body of the join request, and removes it from the address bar. The secret is derived from the room and a per-room version, with a key kept in `instance.key` in your data folder (readable by you only). **Make a new link** raises the version: the old link stops working for new people, and everyone already in the room keeps their place.

Multiplayer AI never prints the link or the secret in the terminal. They appear only in your browser, on this computer.

## Who can do what

| | You (the host) | A guest with the link | Someone on the network without the link |
|---|---|---|---|
| Start a room | Yes | No. `/new` says "Ask the host to start a room" | No |
| Join a room | Yes | Yes, with the link (or the access token from joining before) | No: the room asks for its link |
| Comment | Yes | Yes | No |
| Message the agent | When steering | Only while holding the steering seat | No |
| Take or hand over steering | Immediately | Needs your approval (by default) | No |
| Settings, key, export, delete all rooms, sign-in | Yes, on this computer's own address | **They do not exist on the network address.** The answer is a plain "not found", even with a copied cookie | Same |
| See, open, copy and download a room's files | Yes | Yes | No |
| Attach a text file | Yes | No, unless they hold the steering seat | No |
| Set the room brief | Yes, on this computer's own address | No: that route does not exist on the network address (everyone can read the brief) | No |
| See, rename, archive or delete rooms ("Your rooms") | Yes, on this computer's own address | No: it does not exist on the network address | No |
| Stop a running agent step | Yes | No, unless they hold the steering seat | No |
| Delete or restore a file, switch the agent's use of files | Yes, on this computer's own address | No: those routes do not exist on the network address | No |
| Host controls (this page) | Yes | No | No |

You are the host because your browser holds the sign-in cookie from the link Multiplayer AI printed when it started, and because you are using `127.0.0.1` or `localhost`. If you open the app by the network address, you are treated as a guest. That is on purpose.

## Control: who steers

Per room, in Host controls:

- **Locked.** Only you change who is steering.
- **Ask me** (the default). A guest who asks to take control, or to hand it to someone, waits. You see the request in your browser, with Approve and Deny. A request expires after 5 minutes. The guest's page shows "Waiting for the host" and then the answer.
- **Allow freely.** The usual rules: someone can take control if nobody holds it or the person holding it is away.

You can take control yourself at any time, without asking.

## The room brief

In Host controls you can write a short **brief** for a room (up to 1500 characters, line breaks allowed; control characters, text-direction marks and zero-width characters are refused). Everyone in the room reads it above the conversation, guests included, and it is never hidden. The agent is given it as your instructions, as its own message after the system prompt, not as something a person said. Every change leaves a line in the room ("The host set the room brief.", "...changed...", "...cleared..."). Only you can set it, on this computer's own address with the sign-in cookie; a guest has no way to. The brief is part of an export.

## Your rooms

`/rooms` (linked as "Your rooms" from the room's header and the landing page, for you only) lists every room on this computer, the one with the latest activity first, with its title, last activity, how many people are in it and whether it is open, ended or archived. You can open a room, rename it, archive or unarchive it, and delete one room (you type "delete room"; its messages, people and files go with it, and its share link stops working). Archiving makes a room read-only for everyone, and unarchiving also reopens a room that was archived by silence. A room can't be deleted while its agent is replying.

The page and its routes are on this computer's own address only, with the sign-in cookie. On the network address, and in any request without the cookie or with a proxy header, they are a plain "not found". With Supabase storage the page says it isn't available.

## Files in a shared room

A room started while sharing is on has the agent's use of files **off**, and so does every room in a container. You can turn it on for a room in Host controls ("Agent can use files"). Guests can read every file in a room they are in, like the conversation. Only the controller and the host can attach files, because the agent can read what is attached. See [agent-tools.md](agent-tools.md).

## What your key pays for

Your key pays for every reply the agent makes, whoever asked for it. Two limits, shown in Host controls as "Guests: n of 20 · Room: n of 50":

- **Guests' messages to the agent**, per room: 20 by default (`GUEST_STEP_CAP_PER_ROOM`, or change it for one room in Host controls). Your own messages don't count against it.
- **Replies in the room**: 50 by default (`MAX_STEPS_PER_SESSION`), as before.
- **Model calls**: when the agent uses files, one message can take several model calls (at most 8 by default, `MODEL_CALLS_PER_DIRECTIVE`), and a room may make 200 in all (`MODEL_CALLS_PER_ROOM`). Every call counts toward the daily budget when you have set one. See [limits.md](limits.md).

**Remove** next to a person ends their live connection, revokes their access token and frees their name. They can come back with the link unless you made a new one. Wrong guesses at the room secret are counted per address and slowed down after `INVITE_FAILURES_PER_10_MIN` (50) in 10 minutes; correct joins are never slowed, because devices behind one Docker port can share an address.

## What is refused

- **Tunnels and reverse proxies.** A request carrying a header that proxies and tunnels add (`Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`, `True-Client-IP`, `X-Original-Host`, or anything starting `CF-`) is refused on every route and every listener, with the code `PROXY_NOT_SUPPORTED`. Tunnels are therefore not supported yet; no instructions are given for them. This is a check on request headers: a tunnel that adds none would not be recognised, which is one more reason not to try.
- **A wrong `Host`.** On the network address, the `Host` must be exactly that address and port. On this computer's address it must be `127.0.0.1` or `localhost` with the port.
- **A wrong `Origin`** on any change, as before.
- **Supabase storage.** Sharing needs the local data file. With Supabase storage, Multiplayer AI says so plainly and doesn't share.

## In a container

Inside Docker Multiplayer AI can't see your network, so it always counts as shared: only the host (the sign-in cookie) starts rooms, and guests need the link. You tell it the address people will use: Settings > Sharing > "Address people will use", or `MULTIPLAYER_AI_SHARE_ADDRESS` (for example `192.168.1.20` or `my-laptop.local`). Exactly that name, plus this computer's own, is accepted as the `Host`. Publish the port as `127.0.0.1:3737:3737` to keep it on this computer, or `3737:3737` to let your network reach it. More in [docker.md](docker.md).

What Multiplayer AI can't verify there: that the address you typed is really this computer's, or that the port is published the way you think.

## What was tested, and what was not

Tested, with automated tests (server and browser): every row of the table above, in each mode; a client on the network address with the link and every header correct, and with the host's cookie copied, not reaching settings, key, export, delete or sign-in; control policies, expiry and two requests at once; the guest cap; that the room secret and `instance.key` appear in no guest response, log, export, data file or terminal output; the QR code, decoded on macOS; and a throwaway container making guest requests to this computer's network address (Docker Desktop on macOS; the server saw them come from this computer's own network address, because Docker translates the source, and not from a loopback address).

**Not tested:** a real phone on real Wi-Fi; other devices on a real network; Windows; a real Linux machine (the server tests ran in Linux containers, but nothing here was run on a Linux network); any tunnel. Run through this before relying on it:

1. Start with `npm start -- --share=wifi`, open the sign-in link on the computer, and start a room.
2. Open Host controls. Check the link's address is the one you expect, and the warning is shown.
3. On a phone on the same Wi-Fi, scan the QR code. You should land in the room as a guest, without the `#k=…` part in the address bar afterwards.
4. Send a comment from the phone. Ask for control from the phone. Approve it on the computer. Send a message from the phone and check the agent replies.
5. Try the same link from a device on mobile data. It should not connect.
6. Choose Make a new link, then try the old link on a second phone. It should be refused.
7. Remove the phone from the room. Its page should stop updating.
8. Turn sharing off. The phone should fail to reach the app.
