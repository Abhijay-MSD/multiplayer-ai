# Contributing

Thanks for looking. This is a small project; a change is easiest to review when it is small and has a test.

## Run it

You need Node 22.13 or newer. Get the code with `git clone https://github.com/Abhijay-MSD/multiplayer-ai.git`, then from the project folder:

```bash
npm start
```

That installs what it needs, builds the web app and prints a sign-in link. To see a change to the web page, run `npm start` again: it rebuilds the web app when its source changed. (`npm run dev` in `web/` starts a hot-reload server that proxies `/api` to port 3001 by default. It has not been checked against the server `npm start` runs, which uses port 3737 and checks the Host header, so don't rely on it.)

## The checks

Each line starts from the project folder. All of them need to pass before a change is merged.

```bash
(cd server && npm ci && npm test)                                                      # server tests: no network, no key
(cd web && npm ci && cd qa && npm ci && npx playwright install chromium && npm test)   # browser tests
npm run check:copy                                                                     # banned phrases and product names in the page text and docs
node scripts/scan-secrets.mjs                                                          # anything shaped like a key, in files, history and the built app (a shallow clone is refused: git fetch --unshallow first)
```

`.github/workflows/ci.yml` runs on every pull request and on pushes to main, in two jobs that do not wait for each other. The checks job runs, in this order: on Node 24 only the copy check and the secrets scan (neither needs an install, so they come first); then, on Node 22.13.0 and 24, the installs, the build and the server tests (two of them start the real launcher and fail without `web/node_modules`, so the installs and the build come before them); then, on 24 only, the secrets scan again on the built app, and the audit. The browser job runs the browser tests once on Linux and once on macOS, on Node 24, and keeps `web/qa/.results` for 7 days when they fail. It has passed on GitHub: all four jobs, the checks on Node 22.13.0 and 24 and the browser tests on Linux and macOS. It covers the copy check, the secrets scan over the whole history and over the built app, the installs, the build, the server tests and the audit at high severity, all on Linux, and the browser tests in Chromium on Linux and macOS. It does not cover Windows, Firefox or Safari, the Docker test or the live Supabase tests, and the QR decoding tests that need macOS are skipped in the checks job, which runs on Linux. `.github/dependabot.yml` asks for update pull requests once a month, at most two open per folder, never for a new major version (the GitHub Actions included) and, in `server`, never for a new minor version of `@google/generative-ai` (it is 0.x); `react` and `react-dom` come in one pull request. It has not been used yet.

## How changes are made here

- **Write the test first and see it fail.** For a rule or a bug, show the test failing on the old code, then fix it. When you add a check, break the code on purpose once to be sure the check notices.
- **Never print, log, return or store a key where it doesn't belong.** There are tests that search logs, responses, exports and the data file for a key that was put in; keep them passing and add one when you add a path a key could travel. Use made-up keys in tests, and run the app with `MULTIPLAYER_AI_NO_DOTENV=1`, `MULTIPLAYER_AI_DATA_DIR` set to a temporary folder, and a provider that runs on this computer (`server/test/helpers/fakeProvider.js`).
- **Don't write what isn't true.** Words on the page and in the docs must match what the code does. If you can't check a claim, say that you couldn't.
- **The page text follows the copy check** (`scripts/check-copy.mjs`): no marketing filler and no product names, except in the provider picker and the providers doc, which `scripts/copy-exemptions.json` lists by exact path.
- **Don't change the queue, the step limit, the steering rules or the visual design** without opening an issue first.
- **A new package is a decision.** Say what it is for, its license, whether it runs anything at install time, and what you looked at to decide. Pin it to an exact version.
- **Tests must not change tracked files.** The screenshots in `web/qa/screenshots` are replaced only by `npm run qa:update-screenshots` (from `web/`).

## What is out of scope for now

Accounts, billing, a hosted version, a desktop app, a browser extension, sharing over the internet (tunnels), and letting the agent run code, use a shell or browse the web. The agent can use the room's text files and nothing else; [docs/agent-tools.md](docs/agent-tools.md) says what it can and can't do.

## Security

Please don't put a key, or the details of a weakness, in a public issue. [SECURITY.md](SECURITY.md) says how to report a vulnerability privately.

## Windows and Linux

Multiplayer AI has been run on macOS, and its server tests have run in Linux containers (Node 22.13.0, 22.23.3 and 24). It has not been run on Windows or on a Linux desktop. If you try it elsewhere, an issue saying what worked and what didn't is the most useful contribution there is.
