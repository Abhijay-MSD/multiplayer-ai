## What this changes

<!-- One or two sentences. -->

## How you checked it

<!-- The tests you added or ran. A bug fix should come with a test that failed before the fix. -->

- [ ] `(cd server && npm test)` passes
- [ ] `npm run check:copy` and `node scripts/scan-secrets.mjs` pass
- [ ] Browser tests pass, if the web page changed (`cd web/qa && npm test`)
- [ ] No real key, address or personal text in the change
