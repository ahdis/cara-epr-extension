# Privacy policy — cara-transfer

*Version 1, 2026-09-12. Provider: ahdis ag, Zürich, Switzerland, https://ahdis.ch*

cara-transfer is a browser extension that lets a patient who is logged in to the CARA patient portal (https://patient.cara.ch) copy their own electronic patient record (EPR) documents from other communities into CARA, delete such documents, and save documents to their own computer.

## What data the extension processes

- **Session tokens** of the portal (refresh token, id token, access token). They are read from the portal's own browser storage and written back there after the extension has refreshed them, so that the portal and the extension share one session. Tokens are held in memory only while the panel is open. They are never stored by the extension, never logged and never sent anywhere except to the CARA backend (`api-portals.cara.ch`) that issued them.
- **Your name and EPR identifier** from the id token, used only to name you as the submitter of copied documents and to display your name in the panel.
- **Document metadata and document content** retrieved from the CARA backend while you use the panel. Content is held in memory for the duration of a transfer or backup and, if you choose so, written to files on your computer.

## Where data goes

- The only remote host the extension talks to is the CARA backend itself, `api-portals.cara.ch`, through the portal page in your browser. The extension's own pages are technically prevented from contacting any host by a content security policy (`default-src 'self'`).
- No analytics, no telemetry, no crash reporting, no remote configuration, no third-party scripts.
- Backups and safety copies are written unencrypted to `Downloads/cara-backup/<date>/` on your computer. They contain medical data. You are responsible for that folder.

## What is stored on your computer by the extension

- A local log of transfers, deletions and backups (`chrome.storage.local`, key `transferLog`) with document titles, identifiers, hashes, timestamps and outcomes. It exists so you have an audit copy. You can clear it from the panel at any time.
- Whether you have accepted the first-run notice.

## What the extension does not do

- It does not access documents of other patients and refuses to run for representative or professional roles.
- It does not contact any server other than the CARA backend.
- It does not store or transmit tokens.

## Source code

The complete source code is published under the Apache-2.0 licence at https://github.com/ahdis/cara-epr-extension. The published extension package is built from a tagged commit without any build step, so it can be compared with the source byte for byte.

## Contact

ahdis ag, https://ahdis.ch
