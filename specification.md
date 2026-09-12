# cara-transfer — Chrome extension specification

Transfer the patient's own EPR documents that still live in a foreign community (e.g. the former Sanela community) into the CARA community, delete foreign documents that should not be copied, and back up any documents to the local computer — all from inside the logged-in CARA patient portal, in the portal's language (German, French, English; Italian optional). Self-contained: everything needed to build the extension is in this file plus the referenced files in this repository.

Status of the groundwork (2026-09-12): every API call used below has been executed successfully against the production portal with the patient's own account (see `portal-api-analysis.md` §5.4 and §5.5 and the scripts in `scripts/`). Nothing in this spec is speculative unless marked **UNVERIFIED**.

---

## 1. Context

### 1.1 Systems and identifiers

| Thing | Value |
|---|---|
| Patient portal (SPA) | `https://patient.cara.ch` — Vue 2 app by phellow seven ("phidy"/"aphinity"), version tag 25.4.3 at time of analysis |
| Backend host | `https://api-portals.cara.ch` |
| OAuth/OIDC broker ("phidy") | `https://api-portals.cara.ch/tenant/<tenant>/openid-connect/{auth,token,logout}` and `…/tenant/<tenant>/session` |
| FHIR R4 MHD facade ("ad-adaptor") | `https://api-portals.cara.ch/ad-adaptor/api/r4/` |
| Portal services ("epd-adaptor") | `https://api-portals.cara.ch/epd-adaptor/api/v1/…` (only `Conversion` is relevant here) |
| OAuth client id | `emedo-pr-web` (public client, no secret, no PKCE) |
| Tenants (one per identity provider) | `realm-pat-swissid`, `realm-pat-trustid`, `realm-pat-vaudid`, `realm-pat-geneveid`. The active one is in `localStorage['phellow:state:selectedIdP']` (`SwissID`, `TrustID`, `VaudID`, `GeneveID`) → tenant = `realm-pat-` + lowercase name. |
| CARA home community OID | `2.16.756.5.30.1.177` (`urn:oid:2.16.756.5.30.1.177`) |
| CARA repository OID | `2.16.756.5.30.1.177.2.2.2.1.2` |
| Example foreign community (test account) | `urn:oid:2.16.756.5.30.1.194.3.0`, repository `2.16.756.5.30.1.194.3.0.12.1.101.31` |
| Role code system | `2.16.756.5.30.1.127.3.10.6` (codes `PAT`, `HCP`, `REP`, `ASS`, `DADM`, `PADM`) |
| EPR-SPID assigning authority | `2.16.756.5.30.1.127.3.10.3` |

The portal's runtime config is embedded in `index.html` as a `data-content` JSON attribute (`VUE_APP_*` keys); the values above come from it. Read `VUE_APP_HOME_COMMUNITY_ID` at runtime instead of hard-coding, with `2.16.756.5.30.1.177` as fallback.

### 1.2 Why documents sit in a foreign community

After a community change the CARA registry lists the patient's old documents with their original `homeCommunityId`/`repositoryUniqueId`; CARA retrieves them on demand via XCA from the old community. When the old community is shut down those documents disappear. A metadata update cannot move a document (home community and repository are registry facts). The only way to keep a document is to **create a new document in CARA** (copy) and then **request deletion of the original**.

Consequences the user must accept (put them in the disclaimer): the copy is a new document authored by the patient (role `PAT`), with new identifiers; original authorship (e.g. the hospital) is not preserved; only the version that is copied survives (no version chain); the original is deleted immediately and irrevocably by the foreign community.

**Update 2026-09-12 (verified live):** the document-level author metadata *can* be preserved. When the ProvideBundle carries the source's contained `PractitionerRole`/`Practitioner`/`Organization` and `author` reference (option "keep original author", default on in the panel), the CARA copy shows the original person and organisation (role `HCP` in the contained PractitionerRole). The server still sets `ch-ext-author-authorrole = PAT` and `extraMetadata originalProviderRole = PAT` (the submitter), and the SubmissionSet author is the patient. So the disclaimer now distinguishes the two cases; only submission history and versions are lost.

---

## 2. Authentication and tokens (as the portal does it)

All values live in the portal's origin (`https://patient.cara.ch`), so a content script can read them.

### 2.1 Stored by the portal in `localStorage`

| Key | Content |
|---|---|
| `phellow:oauth2:accessToken` | broker JWT (HS256, `cty: D-SAML`), ~5 min lifetime |
| `phellow:oauth2:refreshToken` | broker JWT, ~5 min lifetime, **rotated on every refresh; the previous one stays valid until its own expiry** |
| `phellow:oauth2:idToken` | JWT with claims `spid` (EPR-SPID), `given_name`, `family_name`, `birthdate`, `email`, `uid`, `idp_alias` |
| `phellow:oauth2:accessToken:expiresAt` | ISO timestamp |
| `phellow:state:selectedIdP` | e.g. `SwissID` |

The XUA token used for FHIR calls is **not** stored; the SPA keeps it in memory and obtains it with the exchange below whenever needed.

### 2.2 Getting a FHIR bearer token (two POSTs, `application/x-www-form-urlencoded`, no cookies needed)

```
POST https://api-portals.cara.ch/tenant/<tenant>/openid-connect/token
grant_type=refresh_token&client_id=emedo-pr-web&redirect_uri=https%3A%2F%2Fpatient.cara.ch%2Flogin&refresh_token=<refreshToken>
→ { access_token, refresh_token (new), id_token, token_type:"Bearer", expires_in≈300 }

POST https://api-portals.cara.ch/tenant/<tenant>/openid-connect/token
client_id=emedo-pr-web
&grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<access_token from step 1>
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&home_community_id=urn:oid:2.16.756.5.30.1.177
&purpose_of_use=NORM
&role=PAT
&resource_id=<spid claim of id_token>
→ { access_token (XUA JWT, cty D-IHE-SAML), token_type:"Bearer", expires_in≈300 }
```

Use `Authorization: Bearer <XUA access_token>` for every `ad-adaptor` and `epd-adaptor` call. Without `purpose_of_use`/`role`/`resource_id` the exchange answers `400` with an HTML page. The XUA token contains `SubjectRole PAT`, `resourceID <SPID>^^^&2.16.756.5.30.1.127.3.10.3&ISO`, `HomeCommunityID`, `exp = iat+300`.

Simplest implementation inside the extension: after a refresh, **write the new tokens back** to the same `localStorage` keys the portal uses (`accessToken`, `refreshToken`, `idToken`, `expiresAt`) so the SPA and the extension share one token chain. Cache the XUA token in memory and re-exchange when < 30 s remain. Alternative: hook `window.fetch` in the MAIN world and copy the `Authorization` header of the portal's own FHIR calls; this avoids any token handling but only yields a token when the portal itself makes a call.

Session keep-alive: the server session idles out after ~15 min without calls; the portal polls `GET …/tenant/<tenant>/session` (`credentials:'include'`) and logs out on `401`. A long transfer keeps the session alive by itself.

### 2.3 Author identity

The name for the `contained Practitioner` in uploads comes from the id_token claims `given_name`/`family_name`. The server adds the SPID to the SubmissionSet author itself.

---

## 3. API contracts used by the extension

Base `FHIR = https://api-portals.cara.ch/ad-adaptor/api/r4`. Responses are `application/fhir+json`. CORS allows origin `https://patient.cara.ch` with credentials and the `Authorization` header, so calls from a content script (page origin) pass. **Verified 2026-09-12 (live):** the server itself validates the `Origin` header on `POST {FHIR}/` and answers `403 Invalid CORS request` for `Origin: chrome-extension://…`, even with `host_permissions` declared (GETs and the token endpoint accept it because Chrome sends no `Origin` on those, or the broker ignores it). Therefore **all API calls must be executed in the portal tab** (content script, page origin); the panel relays them (`src/portal.js portalFetch` ↔ `content.js cara:fetch`). Note also that error responses from the facade (4xx/5xx) carry no `Access-Control-Allow-Origin`, so from the page origin a failed write surfaces as a network error (`Failed to fetch`) instead of an `OperationOutcome`.

### 3.1 List documents (ITI-67)

```
GET {FHIR}/DocumentReference?status=current,superseded&_revinclude=List:item
```
Bundle `searchset`; entries are `DocumentReference` (profile IHE.MHD.Comprehensive.DocumentReference) and `List` (SubmissionSets, only for CARA-native docs). The patient is implied by the token. Relevant fields per DocumentReference:

| Field | Meaning |
|---|---|
| `id` | base64 of `<entryUUID>@urn:oid:<homeCommunityId>` — routing key for updates |
| `extension[url=https://api.phellowseven.com/fhir/StructureDefinition/homeCommunityId].valueString` | `urn:oid:…` — **the community filter** |
| `extension[…/repositoryUniqueId].valueString` | repository OID |
| `extension[…/logicalEntry]` | reference + `urn:uuid:` entryUUID |
| `extension[http://fhir.ch/ig/ch-epr-mhealth/StructureDefinition/ch-ext-deletionstatus].valueCoding.code` | `deletionNotRequested` / `deletionRequested` (CARA-native docs only; foreign docs carry it inside `…/extraMetadata` as `urn:e-health-suisse:2019:deletionStatus` or not at all) |
| `status` | `current` / `superseded` |
| `masterIdentifier`, `identifier[0]` (urn:uuid) | XDS uniqueId / entryUUID |
| `type`, `category`, `securityLabel`, `context.facilityType`, `context.practiceSetting` | copied 1:1 into the new document |
| `content[0].attachment.{contentType,language,url,size,hash,title,creation}` | `url` is the ITI-68 URL; `hash` is SHA-1 base64 — idempotency key |
| `content[0].format` | formatCode, copied 1:1 |
| `author[0]` → contained PractitionerRole/Practitioner/Organization | display only |
| `relatesTo` | version links (display only) |

### 3.2 Retrieve document (ITI-68)

```
GET <content[0].attachment.url>        (= {FHIR}/Binary/<base64(uniqueId@repositoryUniqueId@homeCommunityId)>)
→ 200, Content-Type = attachment.contentType (application/pdf or application/fhir+json), raw bytes
```
Verify `SHA-1(bytes)` (base64) equals `attachment.hash` before uploading or saving.

Multi-document zip (from the portal code, **not executed yet**): `POST {FHIR}/Binary/$zip` with `Content-Type: application/json` and body `{"resourceType":"Parameters","parameter":[{"name":"_id","valueString":"<attachment.url>,<attachment.url>,…"}]}` → zip file as blob. Optional optimisation for backups; the per-document ITI-68 path is the verified one.

### 3.3 Upload a new document (ITI-65 Provide Document Bundle, vendor flavour)

```
POST {FHIR}/                     Authorization: Bearer <XUA>
Content-Type: multipart/form-data (let the browser set the boundary)
  part name "bundle"  → Blob(JSON of the Bundle below, type application/fhir+json)
  part name <docPart> → Blob(file bytes, type = attachment.contentType)     // <docPart> = "urn:uuid:<uuid>" = DocumentReference.content[0].attachment.url
```
Bundle (`meta.profile = http://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Comprehensive.ProvideBundle`, `type: transaction`, **no** `request` elements, **no** Binary resource):

```json
{ "resourceType":"Bundle","meta":{"profile":["http://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Comprehensive.ProvideBundle"]},"type":"transaction","entry":[
  { "fullUrl":"<listUuid>", "resource":{
      "resourceType":"List","id":"<listUuid>",
      "contained":[{"resourceType":"PractitionerRole","id":"1","code":[{"coding":[{"system":"2.16.756.5.30.1.127.3.10.6","code":"PAT"}]}]}],
      "extension":[{"url":"http://profiles.ihe.net/ITI/MHD/StructureDefinition/ihe-designationType","valueCodeableConcept":{"coding":[{"system":"2.16.840.1.113883.6.96","code":"71388002","display":"Procedure (procedure)"}]}}],
      "identifier":[{"system":"urn:ietf:rfc:3986","value":"urn:oid:2.25.<decimal(uuid)>"},{"system":"urn:ietf:rfc:3986","value":"urn:uuid:<uuid>"}],
      "status":"current","code":{"coding":[{"system":"http://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes","code":"submissionset"}]},
      "date":"<now, ISO with offset>","source":{"reference":"#1"},
      "entry":[{"item":{"reference":"<docUrn>"}}] } },
  { "fullUrl":"<docUrn>", "resource":{
      "resourceType":"DocumentReference","id":"<docUrn>",
      "contained":[{"resourceType":"Practitioner","id":"2","name":[{"family":"<family_name>","given":["<given_name>"]}]},
                   {"resourceType":"PractitionerRole","id":"1","practitioner":{"reference":"#2"}}],
      "masterIdentifier":{"system":"urn:ietf:rfc:3986","value":"2.25.<decimal(uuid)>"},
      "identifier":[{"system":"urn:ietf:rfc:3986","value":"<docUrn>"}],
      "status":"current",
      "type": <copied>, "category": <copied>, "securityLabel": <copied>,
      "author":[{"reference":"#1"}],
      "content":[{"attachment":{"contentType":"<copied>","language":"<copied>","url":"<docPart>","size":<bytes.length>,"hash":"<sha1 base64>","title":"<copied>","creation":"<copied>"},"format": <copied>}],
      "context":{"facilityType": <copied>, "practiceSetting": <copied>} } } ] }
```
`<docUrn>` = `"urn:uuid:<uuid>"`; `decimal(uuid)` = the 128-bit uuid as a decimal integer (BigInt). Do **not** send `subject`, `sourcePatientInfo`, or any phellowseven extension: the server derives `subject` (CARA MPI-PID), `sourcePatientInfo`, `homeCommunityId`, `repositoryUniqueId`, `deletionstatus`, `originalProviderRole` from the token.

Response `200`: the Bundle echoed with server additions (List author gets the SPID identifier, DocumentReference gets `extraMetadata`, a synthetic `Binary` entry with `data:"PDxzdHJlYW0+Pg=="`, and `request` elements). Any non-2xx or an `OperationOutcome` body = failure; show `issue[0].diagnostics`.

Verification after upload: re-run 3.1 and find a DocumentReference with `homeCommunityId == CARA` and `attachment.hash == source hash` (and `identifier` containing `<docUrn>`); optionally GET its Binary and compare bytes.

### 3.4 Deletion request / deprecate (metadata update)

```
POST {FHIR}/                     Authorization: Bearer <XUA>,  Content-Type: application/json
{ "resourceType":"Bundle","meta":{"profile":["https://api.phellowseven.com/fhir/StructureDefinition/IHE.MHD.Metadata.Update"]},"type":"transaction","entry":[
  { "fullUrl":"List/<listUuid>", "resource": <SubmissionSet exactly as in 3.3, entry.item.reference = <DocumentReference.id> (the base64 id)>,
    "request":{"method":"POST","url":"List/<listUuid>"} },
  { "fullUrl":"DocumentReference/<id>", "resource":{
      "resourceType":"DocumentReference","id":"<id>",
      "extension":[{"url":"http://fhir.ch/ig/ch-epr-mhealth/StructureDefinition/ch-ext-deletionstatus",
                    "valueCoding":{"system":"http://fhir.ch/ig/ch-epr-mhealth/CodeSystem/ch-ehealth-codesystem-deletionstatus","code":"deletionRequested"}}],
      "content":[] },
    "request":{"method":"PUT","url":"DocumentReference/<id>"} } ] }
```
Works for foreign-community documents (CARA relays it; the foreign community executed the deletion within a second, audit shows `ATC_DOC_UPDATE` → `ATC_DOC_DELETE` by the requesting patient) and for CARA-native ones. Response `200` transaction-response with `"status":"200 OK"` per entry; afterwards `GET {FHIR}/DocumentReference/<id>` → `404` and the entry is gone from all searches. **There is no undo.** Use exactly this coding (not the `urn:e-health-suisse:2019:deletionStatus:deletionRequested` form of ch-epr-fhir 5.0 — untested).

"Deprecate" instead of delete: same bundle with resource `{ "resourceType":"DocumentReference","id":"<id>","status":"superseded","content":[] }` (not needed by this extension; documented for completeness).

### 3.5 PDF/A conversion (only if a source is not PDF/A) — **UNVERIFIED for this use**

The portal converts uploads through `POST https://api-portals.cara.ch/epd-adaptor/api/v1/Conversion` (body = the PDF, `Content-Type: application/pdf`) → `202`, then polls `GET …/v1/Conversion/pdf-tools/<job token>` until it returns `200 application/pdf` (the converted bytes), and uploads those. The 202 body/`Location` was not captured. Documents already in an EPR are PDF/A (the test file contained the `pdfaid:part` XMP marker), so v1 of the extension skips conversion and reports a failure if the server rejects a file.

---

## 4. Extension design

### 4.1 Form factor

Manifest V3, **side panel** (`chrome.sidePanel`) opened from the toolbar action while a `https://patient.cara.ch/*` tab is active. No DOM injection into the portal (the portal is a minified Vue build with hashed chunks; row markup is not stable). The panel renders its own list from the API. Fallback if the side panel API is unavailable: a popup with the same page.

### 4.2 Components

```
manifest.json
src/background.js        service worker: opens side panel on action click, relays messages
src/content.js           content script on https://patient.cara.ch/*: reads/writes localStorage tokens, performs all HTTP calls on request from the panel (page origin → CORS-safe), reports progress
src/panel.html / panel.js / panel.css   UI (list, selection, disclaimer, progress, results)
src/api.js               pure functions: token refresh/exchange, list, retrieve, buildUploadBundle, upload, buildDeletionBundle, requestDeletion, verify; no DOM
src/i18n/{de,fr,it,en}.json
```
Messaging: panel ↔ content script via `chrome.tabs.sendMessage` / `chrome.runtime.onMessage` (long-running work in the content script; progress events back to the panel). Alternatively run `api.js` in the panel with `host_permissions` for `https://api-portals.cara.ch/*` and only use the content script to read/write `localStorage`; choose one and keep `api.js` environment-agnostic (uses `fetch`, `crypto.subtle`, `FormData`, `Blob` only).

`manifest.json` essentials (reduced 2026-09-12 after the CORS finding, see 3.): `"permissions": ["sidePanel","storage","downloads"]`, `"host_permissions": ["https://patient.cara.ch/*"]` (no backend host permission: all requests run in the portal tab), `"content_security_policy": {"extension_pages": "default-src 'self'; frame-ancestors 'none'"}`, `"content_scripts": [{"matches":["https://patient.cara.ch/*"],"js":["src/content.js"],"run_at":"document_idle"}]`, `"side_panel": {"default_path":"src/panel.html"}`, `"action": {}`. No remote code, no analytics.

### 4.3 Panel UI

1. **Header**: patient name (id_token), community name from config (`VUE_APP_HOME_COMMUNITY_NAME`), "Reload" button, language follows the portal (see 4.7); a manual override in the panel is allowed but not persisted beyond the session.
2. **Not logged in / no token** → message "Log in to the CARA portal first", nothing else.
3. **Document table**. Default filter: only entries whose `homeCommunityId ≠ CARA`; a toggle "Show CARA documents too" adds the CARA-native entries (needed for backups; transfer and delete stay disabled for them, see 4.6). Grouped by community OID, sorted by `attachment.creation` desc. Columns: checkbox · title · creation date · type display · status (`current`/`superseded`) · content type · size · state badge. State badge values:
   - `copy exists` — a CARA document with the same `attachment.hash` exists (checkbox default off, transfer disabled, delete-only allowed)
   - `transferable` — `status == current` (checkbox default on)
   - `superseded` — old version; **transfer disabled, delete-only allowed** (versions cannot be reproduced in CARA)
   - `unsupported` — content type not in {`application/pdf`, `application/fhir+json`} (transfer disabled)
4. **Actions**: "Transfer selected to CARA" (copy → verify → delete original), "Delete selected only" (deletion request without copy) and "Backup selected" (download to the computer, 4.6). Transfer and delete open the disclaimer dialog; backup does not (non-destructive) but shows a short note that the files contain medical data. A summary line shows counts by state.
5. **Disclaimer dialog** (must be scrolled/acknowledged with a checkbox before the confirm button enables). Text for transfer:
   > The selected documents will be uploaded to CARA as new documents **submitted by you in the patient role** (new identifiers). The author shown in the metadata is copied from the original document. Submission history and older versions are **not** carried over. After each successful upload the original in the other community is **deleted immediately and irrevocably**. Documents whose content already exists in CARA are skipped. Continue?
   (Wording updated 2026-09-12 after verifying that the author metadata survives the copy; the previous text said the copy is authored by the patient.)
   Text for delete-only:
   > The selected documents will be deleted in their community **immediately and irrevocably**. They are **not** copied to CARA. Continue?
6. **Progress view**: one row per document with step status (`retrieve` → `verify hash` → `upload` → `verify in CARA` → `delete original`), elapsed time, and the error text on failure. A "Stop after current document" button. At the end: totals and a "Download log" (JSON) button.
7. **Results** persist in `chrome.storage.local` under `transferLog` (array of `{when, sourceId, sourceUniqueId, title, hash, newDocUrn, newMasterIdentifier, steps, error}`) so an interrupted run can be resumed and the user has an audit copy.

### 4.4 Transfer algorithm (per selected document, sequential, never parallel)

```
0  ensure XUA token (refresh + exchange if < 30 s left)
1  GET attachment.url → bytes; if status ≠ 200 → fail "retrieve"
2  sha1(bytes) == attachment.hash ? else fail "hash mismatch, not uploading"
3  if a CARA doc with this hash already exists → skip upload (state 'copy exists'), continue with 6 only if the user chose transfer (delete original)
4  build ProvideBundle (3.3): copy type, category, securityLabel, context.facilityType, context.practiceSetting, content[0].format, attachment.{contentType,language,title,creation}; new masterIdentifier/identifier/docUrn/docPart; author = patient (name from id_token)
5  POST multipart → must be 200 and not OperationOutcome; then re-list and find CARA doc with same hash; optional: GET its Binary and byte-compare → else fail "verify" (original is NOT deleted)
6  POST deletion request (3.4) for the source id → must be 200 with "200 OK" for the PUT entry; re-read source id → expect 404
7  append to transferLog; update row; continue
```
Stop the whole run on the first unexpected HTTP status ≥ 500 or on `401` (token problem); continue past per-document 4xx failures but never delete a source whose copy was not verified. Delete-only runs execute step 0 and 6 only.

Idempotency and safety rules:
- **Hash is the identity.** Never upload when a CARA document with the same `attachment.hash` exists.
- **Exactly-one guard.** A deletion request is only sent for the specific `DocumentReference.id` selected from the list fetched in the same run; never by title.
- **Upload first, delete last.** A copy that cannot be verified leaves the original untouched and reports the error.
- **Superseded documents are never uploaded** (they would appear as new current documents in CARA).
- **No parallel requests** (foreign-community XCA retrieval takes 1–2 s per document; the token exchange rate is unknown).
- All state changes are logged locally before and after the call.

### 4.5 Content types

| Source contentType | Handling |
|---|---|
| `application/pdf` | upload as is (verified end to end) |
| `application/fhir+json` (CH VACD immunization documents, format `urn:che:epr:ch-vacd:immunization-administration:2022`) | upload as is with the same contentType/format — **verified live 2026-09-12** ("Vaccination - Fluarix Tetra", 6154 B: copy byte-identical, contentType/format preserved, portal lists it). Supported by default, no toggle. |
| anything else | `unsupported` |

Portal-side limits from its config: upload filter `pdf-a`, page size 500, `VUE_APP_DOCUMENT_MAX_SIZE` (value not captured). The 1.28 MB discharge letter is the largest test document.

### 4.6 Backup (download to the computer)

Purpose: let the patient keep a local copy of any document (foreign or CARA-native) before the foreign community disappears, or simply as an export. Non-destructive; available for every row regardless of state, including `superseded` and `unsupported`.

Algorithm per selected document (sequential):
```
0  ensure XUA token
1  GET attachment.url → bytes (ITI-68); status ≠ 200 → row error
2  sha1(bytes) == attachment.hash ? else mark "hash mismatch" (still save, flag in the log)
3  save file  <creation YYYY-MM-DD>_<sanitised title>.<ext>          ext from contentType: pdf → .pdf, application/fhir+json → .json, else from the mime subtype
4  save file  <same base name>.metadata.json                          the DocumentReference resource as returned by the list call (includes homeCommunityId, repositoryUniqueId, masterIdentifier, author, type/category, hash)
```
Saving: `chrome.downloads.download({url: URL.createObjectURL(blob), filename: "cara-backup/<date of run>/<name>", saveAs: false, conflictAction: "uniquify"})` from the panel/service worker (permission `downloads`); revoke the object URL after `onChanged` reports `complete`. The first save triggers Chrome's folder prompt only if the user has "Ask where to save" enabled; otherwise everything lands in `Downloads/cara-backup/<date>/`. Do **not** use `<a download>` from the content script (page origin) — the portal's CSP and the page context make it unreliable.

Options in the backup dialog: "include metadata JSON" (default on), "one zip instead of single files" (default off; implement with `Binary/$zip` from 3.2 once verified, or client-side zipping with a small vendored library — no CDN loading in an extension).

Progress and log as in 4.3 (steps `retrieve` → `verify hash` → `save`), log entries carry the local filename.

### 4.7 Localisation

The panel language follows the portal login language. Source: `localStorage['phellow:language']` on `https://patient.cara.ch` (values seen in the portal config: `de-ch`, `fr-ch`, `it-ch`, `en-us`); if absent, use `navigator.language`; final fallback `en`. Map: `de-*` → de, `fr-*` → fr, `it-*` → it (optional, falls back to en until translated), everything else → en.

Implementation: one JSON file per language under `src/i18n/`, flat keys (`list.title`, `state.copyExists`, `disclaimer.transfer`, …), a tiny `t(key, params)` helper; also `_locales/{de,fr,en}/messages.json` for the manifest `name`/`description` (`"default_locale": "en"`). Every user-visible string, including the disclaimer texts in 4.3, error messages and the download folder name, goes through `t()`. Dates and sizes formatted with `Intl.DateTimeFormat` / `Intl.NumberFormat` for the active locale. Re-read the language on every panel open (the user can switch it in the portal header).

Required translations for v1: German, French, English. The disclaimer wording must be reviewed by a human in each language before release; the reference (English) texts are in 4.3.

---

## 5. Build, test, distribute

- Plain ES modules, no bundler required (MV3 supports `"type":"module"` for the service worker and `<script type="module">` in the panel). If a bundler is wanted, use Vite with `@crxjs/vite-plugin`.
- `api.js` must run in Node too (it only uses `fetch`, `FormData`, `Blob`, `crypto.subtle`): reuse it in the CLI scripts and in tests.
- Tests: (1) unit tests for bundle builders against the captured shapes in `portal-api-analysis.md` §5.5; (2) an integration script `scripts/transfer-one.mjs --dry-run` that runs the algorithm against the live API with the refresh token from `localStorage` (copy it from DevTools → Application → Local Storage, valid 5 min) and prints the bundles without sending; (3) a real run on **one** document.
- Manual test plan on the portal: login with SwissID (passkey/mTAN) → open panel → list shows only foreign documents → transfer one current PDF → it appears in the portal list under CARA, the original disappears → delete-only one superseded version → it disappears → run again: the copied document shows `copy exists`, nothing is re-uploaded → backup two documents (one PDF, one FHIR JSON) and check the files and metadata JSON in `Downloads/cara-backup/<date>/` → switch the portal language to French and reopen the panel: all texts change.
- Existing reference scripts (Node 20+, no dependencies): `scripts/epr-fetch.mjs` (token flow + list), `scripts/upload-copy.mjs` (copy one PDF, `--dry-run`, `--title`), `scripts/deletion-request.mjs` (`--title`, `--hc X|CARA`, `--status`, `--dry-run`, exactly-one guard), `scripts/check-after.mjs`, `scripts/check-audit2.mjs` (audit trail `GET {FHIR}/AuditEvent?date=ge<date>`).
- Load unpacked (`chrome://extensions` → Developer mode) for development; Chrome Web Store listing for distribution (privacy policy required: no data leaves the browser except to `api-portals.cara.ch`).

---

## 6. Security and privacy

- Tokens grant full patient-level EPR access (read, upload, metadata update, deletion, policies). Keep them only in memory / the portal's `localStorage`; never in `chrome.storage`, never logged. Redact `Authorization` and token bodies from any debug output.
- The id_token contains name, birthdate, email; use only `given_name`, `family_name`, `spid`.
- The extension must not add third-party scripts, telemetry, or remote configuration.
- Every destructive action requires the acknowledged disclaimer in the same run; there is no "always" setting.
- The transfer log stored locally contains document titles; offer a "clear log" button.
- Backups write medical documents to the local disk in clear text; say so in the backup note and never upload them anywhere.

---

## 7. Open points / UNVERIFIED

1. ~~Upload of `application/fhir+json` documents (see 4.5).~~ Verified 2026-09-12.
2. Server-side reaction to non-PDF/A PDFs and the exact protocol of the Conversion job (3.5).
3. `VUE_APP_DOCUMENT_MAX_SIZE` and any server-side size limit.
4. Behaviour for representatives (role `REP`, `phellow:state:spid` of the represented patient): out of scope for v1; the panel should refuse when `localStorage['phellow:state:role']` is not `PAT`.
5. Other identity providers than SwissID were not exercised; the tenant derivation in 1.1 is inferred from the config keys.
6. What the foreign community does with a deletion request coming from a **HCP** is irrelevant here; for the patient it deleted immediately.
7. `Binary/$zip` (3.2) is taken from the portal code and has not been executed.

---

## 8. Reference material in this repository

- `portal-api-analysis.md` — full analysis: login flow, token claims, API map, feasibility, and the executed experiments (§5.4 deletion, §5.5 upload with the captured request anatomy).
- `DocumentReferenceOE.json` — a real ITI-67 response bundle (25 entries, person names, dates, addresses and patient identifiers anonymised) to develop the list view against.
- `scripts/*.mjs` — working Node implementations of every call.
