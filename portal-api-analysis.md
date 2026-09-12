# CARA patient portal – API and auth analysis (Playwright capture, 2026-09-12)

Portal: `https://patient.cara.ch` (Vue SPA by phellow seven, version tag 25.4.3, commit 50dab1b8).
Backend: `https://api-portals.cara.ch` with three services (from `window.__env__` in index.html):

| Env var | Base URL | Role |
|---|---|---|
| `VUE_APP_API_PHIDY` | `https://api-portals.cara.ch` | OAuth/OIDC broker ("phidy"), tenants per IdP |
| `VUE_APP_API_APHINITY` | `https://api-portals.cara.ch/ad-adaptor/api/` | FHIR R4 MHD facade ("aphinity") |
| `VUE_APP_API_EPD_SERVICES` | `https://api-portals.cara.ch/epd-adaptor/api/` | Non-FHIR portal services |

Other config: home community `2.16.756.5.30.1.177` (name "emedo"), STS OID `2.16.756.5.30.1.177.2.2.2.1.8`, OAuth client `emedo-pr-web` (public client, no secret, PKCE **off**), redirect `https://patient.cara.ch/login`, tenants `realm-pat-{swissid,trustid,vaudid,geneveid}`, session idle timeout 900 s, max age 3600 s.

## 1. Login flow (as observed)

1. `GET patient.cara.ch/documents/` → SPA redirects to `/login`, then to
   `GET api-portals.cara.ch/tenant/realm-pat-swissid/openid-connect/auth?redirect_uri=…&client_id=emedo-pr-web&response_type=code&state=…` (plain auth-code flow, no PKCE, no scope).
2. phidy acts as SAML SP and bounces to SwissID (`login.swissid.ch/idp/SSOPOST/metaAlias/sesam/idp`, SP entity `https://api-portals.cara.ch/tenant/realm-pat-swissid`). SwissID does passkey → password → mTAN → device fingerprint.
3. SAML artifact back to `api-portals.cara.ch/tenant/realm-pat-swissid/saml?SAMLart=…`, phidy sets cookie `phidy:session` (HttpOnly, Secure, SameSite=None) and redirects to `patient.cara.ch/login?code=<JWT code>`.
4. SPA: `POST /tenant/realm-pat-swissid/openid-connect/token` with `grant_type=authorization_code&client_id=emedo-pr-web&redirect_uri=…&code=…` → `{access_token, refresh_token, id_token, expires_in≈270-300}`.
   - Stored in **localStorage** under `phellow:oauth2:accessToken`, `…:refreshToken`, `…:idToken`, `…:accessToken:type`, `…:accessToken:expiresAt`, `phellow:state:selectedIdP`.
   - The IdP access token is an HS256 JWT (`{"tenant":"realm-pat-swissid","alg":"HS256"}`), `cty: D-SAML`, 5-minute lifetime, containing the deflated SwissID SAML assertion (`sts` claim) plus `spid`, `uid`, name, birthdate.
5. Before every EPR call the SPA does an **OAuth token exchange** (RFC 8693) to obtain an IHE XUA token:
   `POST …/openid-connect/token` with
   `client_id=emedo-pr-web&grant_type=urn:ietf:params:oauth:grant-type:token-exchange&subject_token=<IdP access token>&subject_token_type=urn:ietf:params:oauth:token-type:access_token&home_community_id=urn:oid:2.16.756.5.30.1.177` (+ `resource_id=<SPID>` for HCP roles; for PAT the role branch appends its own params, see app.js).
   Result: `{access_token, token_type:"Bearer", expires_in:299, issued_token_type:"urn:ietf:params:oauth:token-type:jwt"}`. This XUA token is kept **in memory only** (Vuex store `xuaToken`), refreshed when < 5 s to expiry. Its claims: `iss = 2.16.756.5.30.1.177.2.2.2.1.8` (STS), `aud = urn:e-health-suisse:token-audience:all-communities`, `cty = D-IHE-SAML`, `SubjectRole PAT`, `PurposeOfUse NORM`, `resourceID = <SPID>^^^&2.16.756.5.30.1.127.3.10.3&ISO`, `HomeCommunityID urn:oid:2.16.756.5.30.1.177`, and `sts` = deflated, signed XUA SAML 2.0 assertion (audience all-communities, 5 min validity).
6. The SPA refreshes the IdP token with `grant_type=refresh_token&client_id=emedo-pr-web&redirect_uri=…&refresh_token=…` before each XUA call, and polls `GET /tenant/realm-pat-swissid/session` with `credentials:"include"` (cookie `phidy:session`). A `401` from `/session` triggers logout (`/openid-connect/logout?id_token_hint=…` → SwissID SLO). Observed: `/session` reported `expiresAt` = login + 15 min (sliding idle window); a fresh page load ~8 min after the last activity still refreshed and loaded documents, then `/session` returned 401 and the app logged out.

### 1a. Where the EPR-SPID comes from

SwissID does not know the SPID; CARA's broker adds it. Evidence from the captured tokens:

- The SwissID SAML assertion (inflated from the `sts` claim of the broker token, `cty: D-SAML`) has issuer "SwissID SAML2 IDP", audience `https://api-portals.cara.ch/tenant/realm-pat-swissid`, a `persistent` NameID, `AuthnContextClassRef http://bag.admin.ch/LOA/3/` and exactly seven attributes: `dateofbirth`, `updated`, `email`, `givenname`, `sn`, `gender`, `qor` (= 2). The SPID string does not occur anywhere in it.
- The JWT the portal stores as "IdP access token" is minted by phidy after it consumed the assertion as SAML SP: header `{"tenant":"realm-pat-swissid","alg":"HS256"}` (symmetric key of the broker), claims = SwissID attributes + broker-only fields `spid`, `uid` (local account id), `idp_alias: SwissID`, `sid`. The `iss` claim "SwissID SAML2 IDP" is copied from the assertion issuer and is misleading.
- phidy maps the persistent NameID to its local account (`uid`) and attaches the SPID linked to that account, i.e. the identity-to-EPR binding created at onboarding when the community verified the person against the ZAS SPID service. Whether phidy stores the SPID in the user record or re-queries the community MPI per login is not observable from outside.

Consequences for a client: `resource_id` in the token exchange must be taken from the broker's `spid` claim (the portal's `loadUserSPID` does the same). The STS, not the client, decides what ends up in the XUA assertion's `resource-id` attribute, so a mismatching `resource_id` is the interesting case for probing the authorization boundary.

## 2. API surface

All EPR calls: `Authorization: Bearer <XUA token>`, **no cookies**. CORS: `Access-Control-Allow-Origin: https://patient.cara.ch`, `Allow-Credentials: true`, allowed headers include `Authorization`, `Prefer`, `Content-Type`. CORS only restricts browsers; non-browser clients (curl, Node, MCP server) are not affected by it.

FHIR R4 (ad-adaptor, `…/ad-adaptor/api/r4/`), from network + app.js:

| Call | Purpose (IHE) |
|---|---|
| `GET DocumentReference?status=current,superseded&_revinclude=List:item` | ITI-67 Find Document References + SubmissionSets (patient inferred from token) |
| `GET DocumentReference/{id}` , `GET DocumentReference?<params>` | single / filtered |
| `GET Binary/{base64(docUniqueId@repositoryUniqueId@homeCommunityId)}` | ITI-68 Retrieve Document (cross-community XCA underneath) |
| `POST Binary/$zip` (Parameters `_id` = comma-separated Binary URLs) | multi-download |
| `POST r4/` transaction Bundle (List submissionset + DocumentReference + Binary) | ITI-65 Provide Document Bundle (upload, PDF/A filter) |
| `POST r4/` transaction Bundle with profile `IHE.MHD.Metadata.Update` | metadata update / supersede / `ch-ext-deletionstatus` deletion request |
| `POST r4/` batch Bundle | bulk reads |
| `POST r4/$convert` | structured document → PDF rendering |
| `GET/POST Consent`, `AuditEvent`, `Patient`, `Patient/$ihe-pix`, `Organization`, `PractitionerRole` | access policies (PPQ), audit trail (ATNA), PIX |

epd-adaptor (`…/epd-adaptor/api/`): `v1/Setting/Notifications`, `v1/RepresentedPerson`, `v1/AssistedPerson`, `v1/Patient`, `v1/Practitioner`, `v1/ParentOrganization`, `v1/Notification`, `v1/Conversion`, `v1/VaccinationRequest`, `r4/Person`, `r4/RelatedPerson`.

## 3. Feasibility: Chrome extension

### a) Show additional metadata in the portal – **yes, straightforward**
- Manifest V3, `content_scripts` on `https://patient.cara.ch/*`.
- Two ways to get the data:
  1. **Passive**: inject a MAIN-world script that wraps `window.fetch`, clones responses for `…/r4/DocumentReference*` and posts the Bundle to the content script. Zero extra API calls, always in sync with what the UI shows.
  2. **Active**: the content script runs on the page origin, so a plain `fetch` to `…/r4/DocumentReference` passes CORS. It needs the XUA token, which is in memory only, so either wrap `fetch` to capture the `Authorization` header (simplest) or replay the refresh + token-exchange calls yourself using `localStorage['phellow:oauth2:refreshToken']` (public client, no PKCE, so this is trivial).
- Render: add a "Community / Repository / masterIdentifier / sourceId" line to each row and to the details dialog (`newMetadata` feature is behind `VUE_APP_FEATURE_NEW_METADATA`, the details dialog is `showMetadata` in documents.js). Match rows by `content[0].attachment.title` + `creation`, or by the DocumentReference `id` visible in the row's DOM key `${homeCommunityId}-${id}`.

### b) Expose the API to a CLI / local MCP server while logged in – **yes, with caveats**
What a non-browser client needs: a valid XUA Bearer token, obtained from a valid IdP refresh token via two POSTs to the token endpoint. Both are plain form posts with only `client_id`. The refresh token is a JWT with a 5-minute lifetime that is rotated on every refresh, so a client must keep refreshing (every ≤4 min) from the moment it receives one; and the server session is idle-limited (~15 min sliding, max age 1 h client-side) and shared with the browser, so a CLI refresh also keeps the browser session alive and vice versa.

**Verified 2026-09-12 with `scripts/epr-fetch.mjs` from plain Node (no cookies, no browser):**
- `grant_type=refresh_token` with only `client_id` + `redirect_uri` works without the `phidy:session` cookie.
- The token exchange for role PAT needs, in addition to `subject_token`/`home_community_id`: `purpose_of_use=NORM`, `role=PAT`, `resource_id=<own EPR-SPID>` (the `spid` claim of the id_token). Without them the endpoint answers 400 with an HTML error page.
- `GET DocumentReference?status=current,superseded&_revinclude=List:item` → 200, same 25-entry bundle as the portal.
- `GET Binary/{id}` → 200 for both communities: the community-X PDF (1.2 MB, XCA retrieve, ~1.6 s) and the CARA-native "Immunization Administration" document, which is delivered as `application/fhir+json` (a CH VACD FHIR document, 217 kB).
- Refresh-token rotation did not log the browser out: the browser's stored refresh token was still accepted after the CLI had used it, so a CLI and the portal tab can share one login within the token lifetime.

Architecture options, easiest first:
1. **No extension: Playwright-driven local MCP server.** Launch a persistent Chromium profile (as done in this analysis), let the user log in once via SwissID, then call the API from inside the page (`page.evaluate(fetch…)` or `page.request` with the captured bearer). The SPA handles refresh, exchange and session keep-alive itself. Add an MCP tool `list_documents` / `get_document(binaryId)`; the persistent profile keeps the `phidy:session` cookie, and a reload within the idle window resumes without re-login (observed). This is the fastest way to a working `epr` CLI/MCP.
2. **Extension + native messaging host.** Extensions cannot open a listening socket, so a local endpoint needs a native host (`chrome.runtime.connectNative`) or the extension can push tokens to a local server that the user starts (`fetch('http://127.0.0.1:port/token', …)` from the service worker with `host_permissions`). The extension's service worker reads `localStorage` tokens via the content script (or wraps fetch to capture XUA tokens), refreshes them, and forwards `{xuaToken, expiresAt}` to the local MCP server, which then calls `api-portals.cara.ch` directly (no CORS for non-browser clients). Keep-alive: the extension can call `/session` every few minutes while the tab is open.
3. **Extension as the endpoint itself.** `chrome.runtime.connect` from a local process is not possible, but a local CLI can use the **DevTools protocol** of a Chrome started with `--remote-debugging-port` to evaluate `fetch` inside the portal tab. Works without an extension at all.

Security notes: the tokens grant full patient-level EPR access (read, upload, metadata update, deletion request, policy changes). Keep them in memory or OS keychain, never in files in this repo; the 5-minute lifetime helps. The IdP token contains your SwissID assertion, name, birthdate and email.

## 4. Sanela → CARA migration question

See [DocumentReference-metadata.md](DocumentReference-metadata.md): 19 of 22 documents still have `homeCommunityId urn:oid:2.16.756.5.30.1.194.3.0` and repository `…194.3.0.12.1.101.31`; their Binary URLs encode that home community, so CARA retrieves them by XCA from the other community's repository. Only 3 documents are registered in CARA (`…177`). If documents get physically migrated, they will show up with `homeCommunityId = urn:oid:2.16.756.5.30.1.177` and repository `2.16.756.5.30.1.177.2.2.2.1.2`.

## 5. Re-uploading documents into CARA, and client options

### 5.1 What the portal itself can write (from app.js / documents.js)

**Upload = ITI-65 Provide Document Bundle, vendor flavour.** `POST …/ad-adaptor/api/r4/` as `multipart/form-data`:
- part `bundle` (`application/fhir+json`): transaction Bundle, profile `http://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Comprehensive.ProvideBundle`, two entries with `fullUrl` = resource id: the `List` (SubmissionSet) and the `DocumentReference`. No `request` elements, no `Binary` resource.
- one part per document whose **part name is `DocumentReference.content[0].attachment.url`**, carrying the file bytes with the declared `contentType`.
- Response: JSON (Bundle or `OperationOutcome`; the portal surfaces `issue[0].diagnostics`).
- SubmissionSet generated client-side: `identifier` = `urn:oid:2.25.<uuid as decimal>` + `urn:uuid:<uuid>` (both `urn:ietf:rfc:3986`), `code` submissionset, `designationType` 71388002, `status current`, `date now`, `source` = contained `PractitionerRole` with role `PAT`, `entry.item.reference` = DocumentReference id.
- Client-side constraints: `VUE_APP_DOCUMENT_UPLOAD_FILTER=pdf-a` (PDF/A check in the browser, `debug.disablePdfACheck` exists), `VUE_APP_DOCUMENT_MAX_SIZE`. Server-side enforcement unknown; the community clearly stores non-PDF (the CARA-native FHIR JSON immunization documents), but those were written by HCP systems.

**Metadata update = ITI-57-style update through MHD.** `POST …/ad-adaptor/api/r4/` (same URL, JSON body): transaction Bundle with `meta.profile = https://api.phellowseven.com/fhir/StructureDefinition/IHE.MHD.Metadata.Update`, entries: `POST List/{newId}` (a fresh SubmissionSet, as above) + one `PUT DocumentReference/{id}` per document. The portal uses it for three things:
1. Edit metadata dialog: PUT with the full DocumentReference.
2. Deprecate: PUT with a partial resource `{resourceType, id, status:"superseded", content:[]}`.
3. Delete request: PUT with extension `ch-ext-deletionstatus` = `deletionRequested` (CH EPR mHealth); the community's document administrator then executes the deletion.

**Cross-community deletion request: what the portal code supports.** Nothing on the client side restricts the update to CARA-native documents:
- The DocumentReference `id` is `base64(<entryUUID>@urn:oid:<homeCommunityId>)` (e.g. `297e1ab2-…@urn:oid:2.16.756.5.30.1.194.3.0`), and the update is `PUT DocumentReference/{id}`, so every update carries the target community; the adaptor has what it needs to route it.
- The batch actions "delete" (deletion request) and "deprecate" are unconditional menu items for any selected entries; selection ("select all") includes every entry with an `attachment.url`, i.e. the community-X documents too. There is no comparison against the configured `homeCommunity.id` anywhere in the documents module (its five uses in app.js are the token exchange, a fallback when the `homeCommunityId` extension is missing, building ids for bare UUIDs, and mapping SubmissionSets to entries).
- Version tree, details and edit routes are keyed by `<homeCommunityId>-<id>`, i.e. the UI is built for a mixed-community list.
- The deletion request is the same call as a local one (`IHE.MHD.Metadata.Update` bundle with `ch-ext-deletionstatus = deletionRequested`); from the portal's point of view there is no separate cross-community path.

What the code cannot show is the backend: whether CARA's adaptor forwards such a `PUT` to community X (and how X's DADM sees the request). The patient right to delete any document in the own EPR, regardless of which repository holds it, supports expecting it to work. One deletion request or deprecation on a single superseded X document (e.g. one of the ten "FluarixTextra-working" versions) would settle it with negligible risk.

### 5.2 Re-upload analysis (question 1)

A "Copy to CARA" button in an extension is feasible with the calls above, entirely from the page origin (content script, page's XUA token). Per selected community-X document:
1. `GET Binary/{id}` → bytes (works, verified from CLI too).
2. Build a new DocumentReference: copy `type`, `category`, `content[0].format`, `attachment.contentType/language/title/creation`, `securityLabel`, `context.facilityType/practiceSetting/period`, `sourcePatientInfo`; set a **new** `masterIdentifier` (`urn:oid:2.25.<n>`) and `identifier` (`urn:uuid`), `status current`, `author` = contained PractitionerRole PAT (the STS role is PAT, so the server will not accept an HCP author), `attachment.url` = a fresh part name. Drop the phellow extensions (`homeCommunityId`, `repositoryUniqueId`, `logicalEntry`, `extraMetadata`), the server sets them.
3. `POST` multipart with `bundle` + file part.
4. Optionally deprecate or request deletion of the X original (5.1, if cross-community update works), so the list does not show duplicates.

What is lost or changes by design, because a copy is a new document, not a move:
- `author` becomes you (PAT) instead of the original HCP/organisation (e.g. the Triemli discharge letter, the SteHAG and xsana documents). `originalProviderRole` becomes PAT. Only `attachment.creation` can preserve the original date.
- `masterIdentifier`/entryUUID change; a `relatesTo replaces` (XDS RPLC) to the X original is not possible, the replaced document must live in the same registry.
- Version history (the 11 superseded X versions) is not carried over; copy only the current ones.
- PDF/A: the portal blocks non-PDF/A uploads client-side; an extension calling the API directly bypasses that check, but the server may reject. Test with one document.
- Metadata update cannot achieve the move: `homeCommunityId` and `repositoryUniqueId` are registry facts, not editable attributes.

The three CARA-native documents (`…177`) do not need copying.

### 5.3 Java instead of Node (question 2)

No Node facade or proxy is required. Everything the CLI did is plain HTTPS: two `application/x-www-form-urlencoded` POSTs to the token endpoint, then FHIR calls with `Authorization: Bearer …`. There is no CORS (that is browser-only), no cookie, no JavaScript execution involved. `java.net.http.HttpClient` is enough; for the FHIR reads a HAPI `IGenericClient` with `BearerTokenAuthInterceptor` against `https://api-portals.cara.ch/ad-adaptor/api/r4` works (server returns `application/fhir+json`). The multipart upload in 5.1 is not standard FHIR, so do that with the raw HTTP client.

The only browser-bound step is the initial login (SwissID passkey/mTAN) and getting the first refresh token out of the portal's `localStorage`. Options, no Node needed in any of them:
1. **Manual bootstrap**: copy `phellow:oauth2:refreshToken` from DevTools into the Java app within 5 minutes; the app then refreshes every ≤4 min to stay alive (refresh tokens rotate but the previous one stayed valid within its lifetime).
2. **Extension → local Java app**: the extension's service worker posts the token to `http://127.0.0.1:<port>/token` served by the Java app (`host_permissions` for that origin; you control its CORS), or the Java app is registered as a **native messaging host** (stdio JSON protocol, any executable).
3. **Java drives the browser**: Playwright for Java or Selenium with a persistent profile; the user logs in once in the window, the app reads `localStorage` and cookies survive restarts for the session lifetime. This is what the Playwright capture in this analysis did, just in Node.

A Node proxy would only make sense if you wanted to reuse the portal's own JavaScript (token-exchange logic, submission-set builder) instead of re-implementing ~60 lines of it.

### 5.4 Experiment 2026-09-12: cross-community deletion request (executed)

Target: one of ten superseded versions of "2024-12-13-FluarixTextra-working" in community X
(entryUUID `5a731b3e-bf10-45a4-a913-3855a7927cc6`, uniqueId `2.16.756.5.30.1.194.3.0.12.3.101^9a84de12-06a9-4aab-b934-a77bf4043a95`, creation 2024-12-20T16:36:02+01:00). Sent from plain Node with the patient XUA token, mirroring `updateMetadata()`:

```
POST https://api-portals.cara.ch/ad-adaptor/api/r4/      Content-Type: application/json
Bundle transaction, meta.profile IHE.MHD.Metadata.Update (phellowseven)
  POST List/<uuid>                   new SubmissionSet, source contained PractitionerRole PAT
  PUT  DocumentReference/<b64(entryUUID@urn:oid:2.16.756.5.30.1.194.3.0)>
       { resourceType, id, extension:[ ch-ext-deletionstatus = deletionRequested ], content:[] }
```

Result:
- `200`, transaction-response: List `200 OK` (server added the PAT's SPID identifier and `ch-ext-author-authorrole` to the contained PractitionerRole), DocumentReference PUT `200 OK`.
- Two seconds later `GET DocumentReference/{id}` → `404 Resource Not Found`, while read-by-id of an untouched X document and of a CARA document still returned 200. The document is gone from every search (`status=current,superseded`, `entered-in-error`, no filter, `identifier=urn:uuid:…`): 21 instead of 22 entries, 9 instead of 10 FluarixTextra versions.
- `GET AuditEvent?date=ge2026-09-12` (patient audit trail, ATNA) shows at 10:10:18.437–.473 +02:00, all with agent PAT/requestor and outcome 0, emitted by community X's own systems (`source.observer` `2.16.756.5.30.1.194.3.0.12.1.101.3` and `…101.4.2`):
  `110107 ATC_DOC_UPDATE` (U) → `110110 ATC_DOC_DELETE` (D) → `110106/110107 ATC_DOC_UPDATE` (U), each naming the uniqueId above with details `homeCommunityID 2.16.756.5.30.1.194.3.0`, `Repository Unique Id …194.3.0.12.1.101.31`, `EprDocumentTypeCode 41000179103`, `title NOT_RESOLVABLE`.

Conclusions:
1. The CARA adaptor relays a patient's metadata update to the document's home community; the `PUT DocumentReference/<uuid@homeCommunity>` is routed by the community OID in the id.
2. For a patient-initiated request the foreign community executed the deletion immediately (update → delete → update within 40 ms); there was no pending `deletionRequested` state to observe, i.e. no DADM approval step for the patient's own request.
3. The same call therefore works for "clean up after copying to CARA" (5.2 step 4). The portal's exact coding was used: system `http://fhir.ch/ig/ch-epr-mhealth/CodeSystem/ch-ehealth-codesystem-deletionstatus`, code `deletionRequested` (not the `urn:e-health-suisse:2019:deletionStatus:deletionRequested` form of ch-epr-fhir 5.0; that form was not tested).
4. Side observation: the patient audit trail is federated too; today's `ATC_LOG_READ` events came from sources in community X (`…194…`) and a third community (`2.16.756.5.30.1.214.3.0.12.1.101.1`).

Scripts used: `scripts/deletion-request.mjs` (supports `--dry-run`), `scripts/check-after.mjs`, `scripts/check-audit2.mjs`; same token flow as `scripts/epr-fetch.mjs`.

### 5.5 Experiment 2026-09-12: upload (ITI-65) from a manual capture and a programmatic copy (executed)

**Manual upload captured (portal, "TestPDF", 8.9 kB).** Sequence: `POST epd-adaptor/api/v1/Conversion` with body `application/pdf` → `202`; poll `GET …/v1/Conversion/pdf-tools/<job JWT>` → `200 application/pdf` (server-side PDF/A conversion of the chosen file); then `POST ad-adaptor/api/r4/` as multipart. The Conversion service is also what renders CDA/FHIR documents to PDF (`Content-Type: text/xml; format=<formatCode>` or `application/fhir+xml; format=…`, `Accept: application/pdf`).

**What the client actually sends** (reconstructed from the server's echo in the transaction response plus app.js; Playwright cannot dump multipart bodies):
```
POST https://api-portals.cara.ch/ad-adaptor/api/r4/     Authorization: Bearer <XUA>
multipart/form-data
  part "bundle" (application/fhir+json): Bundle transaction, meta.profile IHE.MHD.Comprehensive.ProvideBundle
     entry[0] fullUrl <listUuid>       List   (SubmissionSet, as in 5.1; entry.item.reference = <docUrn>)
     entry[1] fullUrl <docUrn>         DocumentReference  id = <docUrn> ("urn:uuid:…")
  part "<attachment.url>" = "urn:uuid:<partUuid>" (contentType of the file): the file bytes
```
DocumentReference fields sent: `contained` Practitioner (name from id_token) + PractitionerRole `#1`→`#2`, `masterIdentifier {system urn:ietf:rfc:3986, value "2.25.<decimal uuid>"}` (server normalises to `urn:oid:2.25.…`), `identifier[urn:uuid = docUrn]`, `status current`, `type`, `category`, `author [#1]`, `securityLabel`, `content[0].attachment {contentType, language, url = part name, size, hash (SHA-1 base64), title, creation}`, `content[0].format`, `context.facilityType`, `context.practiceSetting`. **No `subject`, no `sourcePatientInfo`, no home-community or repository extension**: the server derives `subject = Patient/<CARA MPI-PID>` (<MPI-PID>), a contained sourcePatientInfo, `homeCommunityId`, `repositoryUniqueId 2.16.756.5.30.1.177.2.2.2.1.2`, `ch-ext-deletionstatus deletionNotRequested`, `originalProviderRole PAT`, `urn:healthshare:slots:sourceId` from the token. The response echoes the bundle with the server-added fields and a synthetic `Binary` entry (`data "<<stream>>"` placeholder) plus `request` elements.

**Programmatic copy of one community-X document** (`scripts/upload-copy.mjs`, `--dry-run` supported): source "Covid_vaccination_certificate" (X, 145 525 B PDF/A, format `urn:ihe:pcc:ic:2009`, type 41000179103). Steps: ITI-68 retrieve → SHA-1 verified against metadata → new DocumentReference built from the source's type/category/format/securityLabel/context/attachment fields with fresh masterIdentifier and identifiers → multipart POST without using the Conversion service.
Result: `200`; the new entry appears in the list with `homeCommunityId urn:oid:2.16.756.5.30.1.177`, repository `…177.2.2.2.1.2`, `subject Patient/<MPI-PID>`, `masterIdentifier urn:oid:2.25.291202337443787119596504217999246195679`, same hash and size; ITI-68 of the copy returns byte-identical content. Server-side PDF/A enforcement was not triggered (the file already was PDF/A); non-PDF/A input would need the Conversion call first. The original X document was **left in place** (the migration flow would send the deletion request of 5.4 after this verification). The manual "TestPDF" from the capture is also still in the record.

Consequences for the extension: no patient identifier is needed anywhere in the upload; the id_token gives the author name; the hash in the metadata makes the copy idempotent (skip when a CARA document with the same hash exists); a transfer is retrieve → upload → verify hash in list → deletion request on the source.
