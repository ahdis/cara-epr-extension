# Notes for coding agents

Read [README.md](README.md) and [specification.md](specification.md) first. Things that are easy to get wrong:

- **Releasing** follows README → [Releasing](README.md#releasing). Tags go to the `ahdis` remote; CI uploads the zip to the Chrome Web Store as a draft only. Never submit for review or publish on the user's behalf.
- **The Chrome Web Store dashboard cannot be automated from a browser extension** (Chrome blocks scripting on Web Store pages, including Claude in Chrome). Dashboard steps are for the user.
- **The portal is undocumented and changes without notice.** The panel reports any HTTP 401 as "portal session has expired". If that happens while the portal's localStorage tokens are still valid, suspect a portal change first. Example from 2026-10: the portal moved from Vue CLI to Vite, its runtime config keys changed from `VUE_APP_*` to `VITE_*`, and the OAuth client changed from `emedo-pr-web` to `pat-portal`. Compare the `data-content` config of patient.cara.ch with what [src/content.js](src/content.js) reads.
- **Personal data:** the sample data in git (`DocumentReferenceOE.json`) is anonymised. Untracked local data files (e.g. `DocumentReference-metadata.*`) can contain real patient data: stage explicit paths, never `git add -A`, and push only `main` and release tags to `ahdis`.
- **Tokens:** never log or print token values, not even in debugging output; decode claims (exp, spid present) instead.
- **Tests:** `npm test` (unit) and `node test/e2e/fake-portal.mjs` (offline Playwright, fake portal and API). Run both before a release.
- **Installed copy:** a zip dropped onto `chrome://extensions` runs from a snapshot under Chrome's profile (`UnpackedExtensions/`), not from this repo. Edits here have no effect there until the extension is reinstalled or "Load unpacked" points at this folder.
