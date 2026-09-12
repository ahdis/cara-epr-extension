# cara-transfer — Chrome extension

Transfer your own EPR documents that still live in a foreign community into the CARA community, delete foreign documents that should not be copied, and back up documents to your computer — from inside the logged-in CARA patient portal. Specification: [specification.md](specification.md).

## Layout

```
manifest.json            MV3, side panel, content script on https://patient.cara.ch/*
src/background.js        service worker: opens the side panel (popup window fallback)
src/content.js           reads/writes the portal's localStorage tokens and config on request
src/portal.js            panel-side bridge to the portal tab (content script, scripting fallback)
src/api.js               pure API layer: tokens, ITI-67/68/65, deletion request, bundle builders
src/transfer.js          run engine: transfer / delete-only / backup, sequential, with log entries
src/log.js               transfer log in chrome.storage.local
src/i18n.js + i18n/*.json  panel translations (de, fr, it, en); _locales/ for the manifest
src/panel.html|js|css    the side panel UI
scripts/transfer-one.mjs integration script using the same api.js/transfer.js (--dry-run)
test/*.test.mjs          unit tests (node --test), no dependencies
```

Design choice: the panel owns the logic (`api.js`, `transfer.js`) but every HTTP request is relayed to the content script and executed inside the portal tab (`portalFetch` in `portal.js` ↔ `cara:fetch` in `content.js`). The FHIR facade rejects write requests whose `Origin` is not `https://patient.cara.ch` with `403 Invalid CORS request`, so requests from the extension origin cannot be used even with host permissions. The content script also reads and writes the portal's own `localStorage` keys so the SPA and the extension share one refresh-token chain.

## Trust and safety measures

- **No dependencies, no build step.** The published package is the repository content; diff the zip from a GitHub release (or the CRX from the store) against the tagged source.
- **Minimal permissions:** `sidePanel`, `storage`, `downloads`; host permission only for `https://patient.cara.ch/*`. The CI fails if that list grows.
- **Content security policy** `default-src 'self'` for extension pages: the panel cannot contact any host. The only network path is the content script inside the portal tab, bound by the portal's own CSP and CORS.
- **Compatibility self-check:** if the document list no longer has the shape verified on 2026-09-12 (MHD profile, phellowseven extensions, Binary URLs, hashes), transfer and delete are disabled.
- **Safety copy before deletion:** every document is written to `Downloads/cara-backup/<date>/` (file + metadata JSON) before its deletion request; if the write fails, nothing is deleted. Can be switched off per run.
- **Upload first, delete last; hash is the identity; sequential; PAT role only.** See [specification.md](specification.md) §4.4.
- **First-run notice** (as-is, own risk, not affiliated with CARA/phellow seven/eHealth Suisse, undocumented interfaces) must be accepted once per notice version.
- Local log of all runs with a clear button; see [PRIVACY.md](PRIVACY.md).

To audit the network behaviour yourself: `grep -rn "fetch(" src/` shows exactly two call sites (the content script relay and the api layer, which only ever receives that relay in the panel), and `grep -rn "https://" src/` lists every literal host.

## Distribution

- Trial phase: publish on the Chrome Web Store with visibility **Private** and a trusted-tester list (Google accounts), or **Unlisted** (install by link). Side-loading unpacked builds is for developers only.
- Store listing must link the privacy policy ([PRIVACY.md](PRIVACY.md)), the source and the release commit.
- Releases: tag `vX.Y.Z` matching `manifest.json`; the CI builds `dist/cara-transfer-X.Y.Z.zip` with a SHA-256 file and attaches both to a GitHub release.
- Open with the operator before wide release: the extension reuses the portal's OAuth client id; the clean path is an mHealth client registration with CARA.

## Development

```
npm test                                  # unit tests against DocumentReferenceOE.json and a fake server
npm run icons                             # regenerate icons/
npm run zip                               # dist/cara-transfer-<version>.zip
```

Load unpacked: `chrome://extensions` → Developer mode → "Load unpacked" → this folder. Open `https://patient.cara.ch`, log in, click the toolbar icon → side panel.

Integration dry run against the live API (refresh token from DevTools → Application → Local Storage → `phellow:oauth2:refreshToken`, valid ~5 min):

```
EPR_REFRESH_TOKEN='…' node scripts/transfer-one.mjs --dry-run --title Covid
EPR_REFRESH_TOKEN='…' node scripts/transfer-one.mjs --dry-run --mode delete --status superseded --title FluarixTextra --first
EPR_REFRESH_TOKEN='…' node scripts/transfer-one.mjs --mode backup --out ./backup-test
```

A real transfer of one document needs `--really` and refuses to run unless exactly one candidate matches.

## Live verification (2026-09-12)

- Transfer of a 1.2 MB PDF (patient-authored) and of a hospital discharge letter with the original author metadata copied (the default): copy verified byte-identical in CARA, original deleted (404) in the foreign community, author person/organisation preserved on the copy, submitter role PAT set by the server.
- Transfer of a FHIR JSON immunization document (CH VACD): copy byte-identical, content type and format code preserved. FHIR JSON is therefore supported by default.
- Backup of one PDF and one FHIR JSON document with metadata JSON.
- Writes must originate from the portal origin (see design choice above).

## Privacy

Data goes only to `api-portals.cara.ch`. Tokens stay in memory and in the portal's own `localStorage`; the extension never stores them in `chrome.storage` and never logs them. The local log (`chrome.storage.local.transferLog`) contains document titles and identifiers and can be cleared from the panel. Backups are written unencrypted to `Downloads/cara-backup/<date>/`.
