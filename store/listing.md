# Chrome Web Store listing — cara-transfer

Everything needed for the developer dashboard (https://chrome.google.com/webstore/devconsole). Copy the texts as they are; the store limits are respected (summary ≤ 132 characters, description ≤ 16 000).

## Package

- Upload `cara-transfer-<version>.zip` from the GitHub release of the tag `v<version>` (built by CI from the tagged commit, SHA-256 next to it). Do not zip the working directory by hand.
- Version in the store = `manifest.json` version.

## Store listing

**Name:** cara-transfer (taken from the manifest, localised)

**Summary** (from `_locales/*/messages.json`):

- en: Transfer, delete or back up your own EPR documents from other communities inside the CARA patient portal.
- de: Eigene EPD-Dokumente aus anderen Gemeinschaften im CARA-Patientenportal übertragen, löschen oder sichern.
- fr: Transférer, supprimer ou sauvegarder vos propres documents du DEP provenant d'autres communautés depuis le portail patient CARA.
- it: Trasferire, eliminare o salvare i propri documenti CIP provenienti da altre comunità dal portale pazienti CARA.

**Description (en):**

cara-transfer adds a side panel to the CARA patient portal (patient.cara.ch). While you are logged in, it lists your electronic patient record (EPR) documents that still live in another community, for example a community that is closing down, and lets you

- transfer them into CARA: the document is retrieved, its hash verified, uploaded to CARA as a new document submitted by you, verified byte for byte in CARA, saved as a local safety copy, and only then deleted in the other community;
- delete documents in the other community without copying them (for example old versions);
- back up any document, including CARA's own, to your computer as file plus metadata JSON.

Documents whose content already exists in CARA are recognised by their hash and never uploaded twice. Everything runs sequentially with a progress view, a local log and a stop button. Every destructive action needs an explicit acknowledgement in the same run. Only PDF and FHIR JSON documents are transferred; everything can be backed up.

Privacy: the extension talks only to the CARA backend (api-portals.cara.ch) from inside the portal page. There is no telemetry, no analytics, no third-party script and no remote configuration. Session tokens stay in your browser and are never stored by the extension. The source code is published under the Apache-2.0 licence.

Important: cara-transfer is an independent tool by ahdis ag. It is not provided by, affiliated with or endorsed by CARA, phellow seven or eHealth Suisse. It uses internal interfaces of the portal that are not a public or guaranteed API and can stop working when the portal changes. Transfers and deletions are irreversible in the original community. The software is provided "as is", without warranty of any kind; use it at your own risk and keep your own backups.

**Description (de):**

cara-transfer ergänzt das CARA-Patientenportal (patient.cara.ch) um ein Seitenpanel. Solange Sie angemeldet sind, zeigt es Ihre EPD-Dokumente, die noch in einer anderen Gemeinschaft liegen (zum Beispiel einer Gemeinschaft, die ihren Betrieb einstellt), und erlaubt Ihnen,

- sie nach CARA zu übertragen: das Dokument wird abgerufen, sein Hash geprüft, als neues, von Ihnen eingereichtes Dokument nach CARA hochgeladen, dort Byte für Byte verifiziert, lokal als Sicherungskopie gespeichert und erst dann in der anderen Gemeinschaft gelöscht;
- Dokumente in der anderen Gemeinschaft ohne Kopie zu löschen (zum Beispiel alte Versionen);
- beliebige Dokumente, auch die in CARA, als Datei plus Metadaten-JSON auf Ihrem Computer zu sichern.

Dokumente, deren Inhalt bereits in CARA vorhanden ist, werden am Hash erkannt und nie doppelt hochgeladen. Alles läuft nacheinander mit Fortschrittsanzeige, lokalem Protokoll und Stopp-Taste. Jede unwiderrufliche Aktion verlangt eine ausdrückliche Bestätigung im selben Lauf. Übertragen werden PDF- und FHIR-JSON-Dokumente; sichern lässt sich alles.

Datenschutz: Die Erweiterung kommuniziert ausschliesslich mit dem CARA-Backend (api-portals.cara.ch), und zwar aus der Portalseite heraus. Keine Telemetrie, keine Analyse, keine Fremdskripte, keine Fernkonfiguration. Sitzungs-Tokens bleiben in Ihrem Browser und werden von der Erweiterung nie gespeichert. Der Quellcode ist unter der Apache-2.0-Lizenz veröffentlicht.

Wichtig: cara-transfer ist ein unabhängiges Werkzeug der ahdis ag. Es wird nicht von CARA, phellow seven oder eHealth Suisse bereitgestellt, ist nicht mit ihnen verbunden und nicht von ihnen freigegeben. Es nutzt interne Schnittstellen des Portals, die keine öffentliche oder garantierte API sind, und kann bei Änderungen am Portal jederzeit aufhören zu funktionieren. Übertragungen und Löschungen sind in der ursprünglichen Gemeinschaft unwiderruflich. Die Software wird «wie besehen» ohne jegliche Gewährleistung bereitgestellt; die Nutzung erfolgt auf eigenes Risiko, bewahren Sie eigene Sicherungen auf.

**Category:** Productivity → Tools (or "Health" if offered in your dashboard)

**Language:** German (default), plus English, French, Italian

**Screenshots (1280×800):** `store/store-1-list.png`, `store/store-2-disclaimer.png`, `store/store-3-progress.png` (taken from the offline test with anonymised sample data; no real patient data)

**Icon:** `icons/icon128.png`

**Homepage:** https://github.com/ahdis/cara-epr-extension

**Support:** the repository's issues page (or an ahdis contact address of your choice)

## Privacy practices tab

**Single purpose:** Transfer, delete or back up the logged-in patient's own EPR documents between communities inside the CARA patient portal.

**Permission justifications:**

- `sidePanel`: the user interface is a side panel next to the portal.
- `storage`: local log of transfers/backups and the acceptance of the first-run notice; no tokens, no document content.
- `downloads`: writes backups and safety copies to Downloads/cara-backup/<date>/.
- Host permission `https://patient.cara.ch/*`: content script on the portal; it reads and refreshes the portal's own session tokens and performs the API requests with the portal's origin. No other host.

**Remote code:** No.

**Data usage:** the extension handles *health information* and *personally identifiable information* (name, EPR identifier) and *authentication information* (portal session tokens). All of it is processed locally in the browser and sent only to the CARA backend that the portal itself uses; nothing is sold, transferred to third parties, or used for purposes unrelated to the single purpose. Tick the three certification statements.

**Privacy policy URL:** raw link to `PRIVACY.md` in the repository, e.g. https://github.com/ahdis/cara-epr-extension/blob/main/PRIVACY.md (must be publicly reachable: either make the repository public or host the policy on ahdis.ch).

## Distribution tab

- **Visibility:** Private → "Trusted testers".
- **Trusted testers:** add `oliver.egger@gmail.com` (one address per line). Testers install from the store URL of the item; they must be signed in to Chrome with that Google account.
- **Regions:** Switzerland (or all).
- Payments: free.

## After publishing

- Testers install via the item URL shown in the dashboard ("View in store"). Installation is only possible for the listed accounts; the page is not searchable.
- Every new version: bump `manifest.json` version, tag `v<version>`, upload the CI zip, submit for review. Private items are reviewed as well; a first review can take a few days.
- Before switching to Unlisted or Public: settle the client-id question with CARA, and complete the impressum in the first-run notice.
