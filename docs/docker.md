# Running Multiplayer AI in Docker

```bash
docker run --rm -it -p 127.0.0.1:3737:3737 -v multiplayer-ai-data:/data "$(docker build -q .)"
```

Run it from the repository folder. `docker build -q .` builds the image and prints its id; `docker run` starts it.
The `$(...)` form works in bash, zsh and PowerShell, not in cmd.exe (build first with `docker build -t multiplayer-ai .`, then run `multiplayer-ai`).

## What is in the image

Only what runs: the server's own code, its production packages, and the built web app, as the unprivileged user
`node`. The build excludes (`.dockerignore`) and then deletes: any `.env` file, the tests, your computer's
`node_modules`, `.git`, tool settings folders and the docs. Nothing from your computer's packages is copied; the packages
are installed inside the build from the lockfiles.

The image has no key in it. Keys are saved by Setup into the volume.

## The port: publish it on your own computer only

Inside a container, Multiplayer AI has to listen on every interface for Docker to be able to reach it. What decides who
can reach it is how the port is published:

| You publish | Who can connect |
|---|---|
| `-p 127.0.0.1:3737:3737` | Only this computer. Use this. |
| `-p 3737:3737` | Every computer that can reach yours can connect, but only with a `Host` that is `localhost` or `127.0.0.1` (or the address you entered under Sharing), and a container always counts as shared: only the host's browser can start a room, and joining a room needs its link. Setup, Settings, export and delete need the sign-in link. See [sharing.md](sharing.md). |

A browser on the host can't be told apart from a stranger by its address, because Docker's network sits in between. So
inside a container Multiplayer AI cannot do the check that a connection comes from this computer. Setup and Settings rest on
the sign-in link and the cookie it sets, which are required with no exception: with no cookie they answer 401, and a
cookie can only come from spending a link, which works once and lasts 5 minutes. The other checks stay on: the Host must
be `localhost` or `127.0.0.1` with the port, there must be no proxy headers, a change must carry our own Origin, and the
browser must say the request is from the page itself.

## Sign-in links

The link is printed in the container's output. A container has no browser to open for you.

- With `-it`, press Enter in the terminal for a new link.
- Without a terminal (for example `docker run -d`): `docker kill -s USR2 <container name>` makes it print a new one,
  and `docker logs <container name>` shows it.

## Changing the port

To publish on a different port on your computer, say 8080, tell Multiplayer AI which port the browser will use so that the
address check still matches:

```bash
docker run --rm -it -p 127.0.0.1:8080:3737 -e MULTIPLAYER_AI_PUBLIC_PORT=8080 -v multiplayer-ai-data:/data "$(docker build -q .)"
```

## Variables the image sets

| Variable | Why |
|---|---|
| `MULTIPLAYER_AI_CONTAINER=1` | Listens on every interface and makes the sign-in cookie the only proof of who is asking. It does nothing unless the process really is in a container; on an ordinary computer it is ignored, with a warning. |
| `MULTIPLAYER_AI_DATA_DIR=/data` | Where the rooms and the settings file are kept; the volume is mounted here. |
| `MULTIPLAYER_AI_NO_DOTENV=1` | Do not read a `server/.env` file. The image has none. |

## Your data

The settings file (with your key, as plain text) and the rooms are in the volume, readable only by the container's user. That
protects them from other users inside the container. On your computer they are inside Docker's own storage, which anyone who
can use your Docker can read. See [providers.md](providers.md) for what the saved key does and does not protect against.

## What was run, and what was not

The image was built and started with an empty volume on Docker Desktop for macOS. With a made-up key and a stand-in provider listening on the container's own loopback address, it was checked that: settings and starting a room fail without the sign-in cookie; a forged `Host` and a foreign `Origin` are refused; the sign-in link works once; a reply arrives; a stand-in provider's tool call writes a file (after the host turns the agent's use of files on: in a container it starts off); `docker stop` ends it at once; and after starting it again with the same volume the room and the saved key are still there. The image holds no `.env`, no tests and no `instance.key`, and runs as the unprivileged `node` user.

Not run: a Windows or Linux Docker host, `-p 3737:3737` from another computer on a network, and a build for another CPU type.
