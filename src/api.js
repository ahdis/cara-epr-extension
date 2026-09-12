// cara-transfer — pure API layer. Environment-agnostic: only uses fetch, FormData, Blob,
// crypto.subtle, crypto.randomUUID, btoa/atob. Runs in the extension panel and in Node 20+.
// No DOM, no chrome.* APIs, no logging of tokens.

export const DEFAULTS = Object.freeze({
  apiBase: 'https://api-portals.cara.ch',
  clientId: 'emedo-pr-web',
  redirectUri: 'https://patient.cara.ch/login',
  homeCommunityId: 'urn:oid:2.16.756.5.30.1.177',
  homeCommunityName: 'CARA',
});

export const EXT = Object.freeze({
  homeCommunityId: 'https://api.phellowseven.com/fhir/StructureDefinition/homeCommunityId',
  repositoryUniqueId: 'https://api.phellowseven.com/fhir/StructureDefinition/repositoryUniqueId',
  logicalEntry: 'https://api.phellowseven.com/fhir/StructureDefinition/logicalEntry',
  extraMetadata: 'https://api.phellowseven.com/fhir/StructureDefinition/extraMetadata',
  deletionStatus: 'http://fhir.ch/ig/ch-epr-mhealth/StructureDefinition/ch-ext-deletionstatus',
  designationType: 'http://profiles.ihe.net/ITI/MHD/StructureDefinition/ihe-designationType',
});

export const PROFILES = Object.freeze({
  provideBundle: 'http://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.Comprehensive.ProvideBundle',
  metadataUpdate: 'https://api.phellowseven.com/fhir/StructureDefinition/IHE.MHD.Metadata.Update',
});

// Both verified live on 2026-09-12 (PDF and CH VACD immunization documents as application/fhir+json).
export const SUPPORTED_TYPES = Object.freeze({
  'application/pdf': 'verified',
  'application/fhir+json': 'verified',
});

// Injectable HTTP layer: the extension panel relays requests through the content script (portal origin),
// because the FHIR facade rejects write requests from other origins ("Invalid CORS request", 403).
let httpFetch = (...a) => globalThis.fetch(...a);
export function setFetch(fn) { httpFetch = fn ?? ((...a) => globalThis.fetch(...a)); }

export class ApiError extends Error {
  constructor(message, { status = 0, body = '', step = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = typeof body === 'string' ? body.slice(0, 1000) : body;
    this.step = step;
  }
  /** true when the whole run must stop (token problem or server failure) */
  get fatal() { return this.status === 401 || this.status >= 500; }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

export function tenantForIdp(idpName) {
  if (!idpName) return 'realm-pat-swissid';
  return 'realm-pat-' + String(idpName).toLowerCase();
}

export function tokenUrl(tenant, apiBase = DEFAULTS.apiBase) {
  return `${apiBase}/tenant/${tenant}/openid-connect/token`;
}

export function fhirBase(apiBase = DEFAULTS.apiBase) {
  return `${apiBase}/ad-adaptor/api/r4`;
}

export function decodeJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
}

function base64UrlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function base64Decode(s) {
  return base64UrlDecode(s);
}

export function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export async function sha1Base64(bytes) {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return bytesToBase64(new Uint8Array(digest));
}

export function uuid() {
  return crypto.randomUUID();
}

export function uuidToDecimal(u) {
  return BigInt('0x' + u.replace(/-/g, '')).toString();
}

export function uuidToOidUrn(u) {
  return 'urn:oid:2.25.' + uuidToDecimal(u);
}

/** ISO 8601 with local offset, seconds precision (the portal's own format) */
export function isoWithOffset(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Decode the routing id `base64(<entryUUID>@urn:oid:<homeCommunityId>)` */
export function decodeDocumentId(id) {
  try {
    const s = base64Decode(id);
    const at = s.indexOf('@');
    if (at < 0) return { entryUuid: s, homeCommunityId: null };
    return { entryUuid: s.slice(0, at), homeCommunityId: s.slice(at + 1) };
  } catch {
    return { entryUuid: null, homeCommunityId: null };
  }
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// DocumentReference accessors
// ---------------------------------------------------------------------------

export function extension(resource, url) {
  return resource?.extension?.find(x => x.url === url);
}

export function homeCommunityOf(doc) {
  return extension(doc, EXT.homeCommunityId)?.valueString ?? decodeDocumentId(doc.id).homeCommunityId ?? null;
}

export function repositoryOf(doc) {
  return extension(doc, EXT.repositoryUniqueId)?.valueString ?? null;
}

export function deletionStatusOf(doc) {
  const direct = extension(doc, EXT.deletionStatus)?.valueCoding?.code;
  if (direct) return direct;
  const extra = extension(doc, EXT.extraMetadata)?.extension?.find(x => x.url === 'urn:e-health-suisse:2019:deletionStatus')?.valueString;
  return extra ?? null;
}

export function attachmentOf(doc) {
  return doc?.content?.[0]?.attachment ?? {};
}

export function formatOf(doc) {
  return doc?.content?.[0]?.format ?? null;
}

export function uniqueIdOf(doc) {
  const mi = doc?.masterIdentifier;
  if (!mi) return null;
  return mi.system && !mi.system.startsWith('urn:ietf') && !mi.value.startsWith('urn:') ? `${mi.system.replace(/^urn:oid:/, '')}^${mi.value}` : mi.value;
}

export function entryUuidOf(doc) {
  return doc?.identifier?.find(i => i.value?.startsWith('urn:uuid:'))?.value ?? decodeDocumentId(doc.id).entryUuid ?? null;
}

export function authorDisplayOf(doc) {
  const contained = doc?.contained ?? [];
  const byRef = ref => contained.find(c => '#' + c.id === ref);
  const role = byRef(doc?.author?.[0]?.reference);
  const pr = role?.resourceType === 'Practitioner' ? role : byRef(role?.practitioner?.reference);
  const org = byRef(role?.organization?.reference);
  const name = pr?.name?.[0];
  const person = name ? [...(name.given ?? []), name.family].filter(Boolean).join(' ') : '';
  const orgName = org?.name ?? '';
  return [person, orgName].filter(Boolean).join(', ') || (role?.code?.[0]?.coding?.[0]?.code ?? '');
}

export function splitBundle(bundle) {
  const docs = [];
  const lists = [];
  for (const e of bundle?.entry ?? []) {
    const r = e.resource;
    if (!r) continue;
    if (r.resourceType === 'DocumentReference') docs.push(r);
    else if (r.resourceType === 'List') lists.push(r);
  }
  return { docs, lists };
}

/**
 * Classify a document for the panel.
 * @returns 'copyExists' | 'transferable' | 'superseded' | 'unsupported' | 'native'
 */
export function classify(doc, { caraHashes, homeCommunityId }) {
  const att = attachmentOf(doc);
  const hc = homeCommunityOf(doc);
  if (hc === homeCommunityId) return 'native';
  if (caraHashes.has(att.hash)) return 'copyExists';
  if (doc.status !== 'current') return 'superseded';
  if (!SUPPORTED_TYPES[att.contentType]) return 'unsupported';
  return 'transferable';
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

async function postForm(url, params, step) {
  let r;
  try {
    r = await httpFetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  } catch (e) {
    throw new ApiError(`network error: ${e.message}`, { step });
  }
  const txt = await r.text();
  if (!r.ok) throw new ApiError(`${step} failed with HTTP ${r.status}`, { status: r.status, body: stripHtml(txt), step });
  try {
    return JSON.parse(txt);
  } catch {
    throw new ApiError(`${step}: non-JSON response`, { status: r.status, body: txt, step });
  }
}

function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export async function refreshIdpToken({ tenant, refreshToken, apiBase = DEFAULTS.apiBase, clientId = DEFAULTS.clientId, redirectUri = DEFAULTS.redirectUri }) {
  return postForm(tokenUrl(tenant, apiBase), {
    grant_type: 'refresh_token',
    client_id: clientId,
    redirect_uri: redirectUri,
    refresh_token: refreshToken,
  }, 'token refresh');
}

export async function exchangeXuaToken({ tenant, accessToken, spid, homeCommunityId = DEFAULTS.homeCommunityId, apiBase = DEFAULTS.apiBase, clientId = DEFAULTS.clientId, role = 'PAT' }) {
  return postForm(tokenUrl(tenant, apiBase), {
    client_id: clientId,
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: accessToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    home_community_id: homeCommunityId,
    purpose_of_use: 'NORM',
    role,
    resource_id: spid,
  }, 'token exchange');
}

/**
 * Token session shared with the portal.
 * @param {object} o
 * @param {() => Promise<{refreshToken:string, idToken?:string}>} o.readTokens  read the portal's current tokens (newest refresh token)
 * @param {(t:{accessToken,refreshToken,idToken,expiresAt}) => Promise<void>} o.writeTokens  write rotated tokens back to the portal
 */
export function createSession({ tenant, readTokens, writeTokens, homeCommunityId = DEFAULTS.homeCommunityId, apiBase = DEFAULTS.apiBase, minRemainingMs = 30_000, now = () => Date.now() }) {
  let xua = null; // { token, expMs }
  let author = null; // { given, family, spid }
  let pending = null;

  async function refreshAndExchange() {
    const { refreshToken, idToken } = await readTokens();
    if (!refreshToken) throw new ApiError('not logged in (no refresh token)', { status: 401, step: 'token refresh' });
    const idp = await refreshIdpToken({ tenant, refreshToken, apiBase });
    const claims = decodeJwt(idp.id_token) ?? decodeJwt(idToken) ?? {};
    const expiresAt = new Date(now() + (idp.expires_in ?? 300) * 1000).toISOString();
    if (writeTokens) {
      await writeTokens({ accessToken: idp.access_token, refreshToken: idp.refresh_token, idToken: idp.id_token ?? idToken, expiresAt, tokenType: idp.token_type ?? 'Bearer' });
    }
    author = { given: claims.given_name ?? '', family: claims.family_name ?? '', spid: claims.spid ?? null };
    if (!author.spid) throw new ApiError('id_token has no spid claim', { status: 401, step: 'token exchange' });
    const x = await exchangeXuaToken({ tenant, accessToken: idp.access_token, spid: author.spid, homeCommunityId, apiBase });
    const c = decodeJwt(x.access_token);
    const expMs = c?.exp ? c.exp * 1000 : now() + (x.expires_in ?? 300) * 1000;
    xua = { token: x.access_token, expMs };
    return xua.token;
  }

  return {
    get author() { return author; },
    async getXua() {
      if (xua && xua.expMs - now() > minRemainingMs) return xua.token;
      if (!pending) pending = refreshAndExchange().finally(() => { pending = null; });
      return pending;
    },
    async getAuthor() {
      if (!author) await this.getXua();
      return author;
    },
    invalidate() { xua = null; },
  };
}

// ---------------------------------------------------------------------------
// FHIR calls
// ---------------------------------------------------------------------------

async function fhirFetch(url, xua, init = {}, step = 'request') {
  let r;
  try {
    r = await httpFetch(url, { ...init, headers: { authorization: `Bearer ${xua}`, accept: 'application/fhir+json', ...(init.headers ?? {}) } });
  } catch (e) {
    throw new ApiError(`network error: ${e.message}`, { step });
  }
  return r;
}

export async function listDocuments({ fhir, xua }) {
  const r = await fhirFetch(`${fhir}/DocumentReference?status=current,superseded&_revinclude=List:item`, xua, {}, 'list');
  const txt = await r.text();
  if (!r.ok) throw new ApiError(`list failed with HTTP ${r.status}`, { status: r.status, body: txt, step: 'list' });
  const bundle = JSON.parse(txt);
  if (bundle.resourceType === 'OperationOutcome') throw new ApiError(outcomeText(bundle), { status: r.status, body: txt, step: 'list' });
  return bundle;
}

export async function getDocumentReferenceStatus({ fhir, xua, id }) {
  const r = await fhirFetch(`${fhir}/DocumentReference/${id}`, xua, {}, 'read');
  await r.text().catch(() => '');
  return r.status;
}

export async function retrieveDocument({ url, xua }) {
  const r = await fhirFetch(url, xua, { headers: { accept: '*/*' } }, 'retrieve');
  if (r.status !== 200) {
    const txt = await r.text().catch(() => '');
    throw new ApiError(`retrieve failed with HTTP ${r.status}`, { status: r.status, body: txt, step: 'retrieve' });
  }
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { bytes, contentType: r.headers.get('content-type') ?? '' };
}

export function outcomeText(oo) {
  const issue = oo?.issue?.[0];
  return issue?.diagnostics ?? issue?.details?.text ?? issue?.code ?? 'OperationOutcome';
}

// ---------------------------------------------------------------------------
// Bundle builders (pure)
// ---------------------------------------------------------------------------

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

export function buildSubmissionSet({ listId, itemReference, date, oidUuid, urnUuid }) {
  return {
    resourceType: 'List',
    id: listId,
    contained: [{ resourceType: 'PractitionerRole', id: '1', code: [{ coding: [{ system: '2.16.756.5.30.1.127.3.10.6', code: 'PAT' }] }] }],
    extension: [{ url: EXT.designationType, valueCodeableConcept: { coding: [{ system: '2.16.840.1.113883.6.96', code: '71388002', display: 'Procedure (procedure)' }] } }],
    identifier: [
      { system: 'urn:ietf:rfc:3986', value: uuidToOidUrn(oidUuid) },
      { system: 'urn:ietf:rfc:3986', value: 'urn:uuid:' + urnUuid },
    ],
    status: 'current',
    code: { coding: [{ system: 'http://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes', code: 'submissionset' }] },
    date,
    source: { reference: '#1' },
    entry: [{ item: { reference: itemReference } }],
  };
}

/**
 * ITI-65 Provide Document Bundle (vendor flavour, see spec 3.3).
 * @param {object} o
 * @param {object} o.source   the source DocumentReference (from ITI-67)
 * @param {number} o.size     byte length of the retrieved document
 * @param {string} o.hash     SHA-1 base64 of the retrieved document
 * @param {{given:string,family:string}} o.author
 * @param {() => string} [o.newUuid]   uuid generator (injectable for tests)
 * @param {string} [o.date]            ISO date with offset
 * @param {boolean} [o.keepAuthor]     default true: copy the source's author metadata (contained Practitioner/Organization/
 *                                     PractitionerRole). Falls back to the patient (name from the id_token) when the source has
 *                                     no resolvable contained author. The SubmissionSet author and originalProviderRole are set
 *                                     by the server from the token (PAT) either way. Verified live 2026-09-12.
 */
export function buildProvideBundle({ source, size, hash, author, newUuid = uuid, date = isoWithOffset(), keepAuthor = true }) {
  const docUuid = newUuid();
  const docUrn = 'urn:uuid:' + docUuid;
  const docPart = 'urn:uuid:' + newUuid();
  const listId = newUuid();
  const masterUuid = newUuid();
  const masterIdentifier = '2.25.' + uuidToDecimal(masterUuid);
  const att = attachmentOf(source);

  const original = keepAuthor ? sourceAuthor(source) : null;
  const authorKept = !!original;
  const contained = original ? original.contained : [
    { resourceType: 'Practitioner', id: '2', name: [{ family: author.family, given: [author.given] }] },
    { resourceType: 'PractitionerRole', id: '1', practitioner: { reference: '#2' } },
  ];
  const authorRef = original ? original.author : [{ reference: '#1' }];

  const documentReference = {
    resourceType: 'DocumentReference',
    id: docUrn,
    contained,
    masterIdentifier: { system: 'urn:ietf:rfc:3986', value: masterIdentifier },
    identifier: [{ system: 'urn:ietf:rfc:3986', value: docUrn }],
    status: 'current',
    ...pick(source, ['type', 'category', 'securityLabel']),
    author: authorRef,
    content: [{
      attachment: {
        contentType: att.contentType,
        ...(att.language ? { language: att.language } : {}),
        url: docPart,
        size,
        hash,
        ...(att.title ? { title: att.title } : {}),
        ...(att.creation ? { creation: att.creation } : {}),
      },
      ...(formatOf(source) ? { format: formatOf(source) } : {}),
    }],
    context: pick(source.context, ['facilityType', 'practiceSetting']),
  };

  const list = buildSubmissionSet({ listId, itemReference: docUrn, date, oidUuid: newUuid(), urnUuid: newUuid() });

  const bundle = {
    resourceType: 'Bundle',
    meta: { profile: [PROFILES.provideBundle] },
    type: 'transaction',
    entry: [
      { fullUrl: listId, resource: list },
      { fullUrl: docUrn, resource: documentReference },
    ],
  };
  return { bundle, docUrn, docPart, listId, masterIdentifier, authorKept };
}

/**
 * The source document's author metadata: the contained resources reachable from author[*] (PractitionerRole →
 * Practitioner / Organization, or a Practitioner/Organization referenced directly), deep-copied with their ids.
 * Returns null when the source has no resolvable contained author.
 */
export function sourceAuthor(source) {
  const contained = source?.contained ?? [];
  const byRef = ref => (typeof ref === 'string' && ref.startsWith('#')) ? contained.find(c => c.id === ref.slice(1)) : null;
  const picked = new Map();
  const authors = [];
  for (const a of source?.author ?? []) {
    const root = byRef(a.reference);
    if (!root || !['PractitionerRole', 'Practitioner', 'Organization'].includes(root.resourceType)) continue;
    picked.set(root.id, root);
    for (const ref of [root.practitioner?.reference, root.organization?.reference]) {
      const r = byRef(ref);
      if (r) picked.set(r.id, r);
    }
    authors.push({ reference: a.reference });
  }
  if (!authors.length) return null;
  const clean = JSON.parse(JSON.stringify([...picked.values()]));
  return { contained: clean, author: authors };
}

/**
 * Deletion request (metadata update, spec 3.4) for exactly one DocumentReference id.
 */
export function buildDeletionBundle({ sourceId, newUuid = uuid, date = isoWithOffset() }) {
  if (!sourceId || typeof sourceId !== 'string') throw new Error('sourceId required');
  const listId = newUuid();
  const list = buildSubmissionSet({ listId, itemReference: sourceId, date, oidUuid: newUuid(), urnUuid: newUuid() });
  const bundle = {
    resourceType: 'Bundle',
    meta: { profile: [PROFILES.metadataUpdate] },
    type: 'transaction',
    entry: [
      { fullUrl: 'List/' + listId, resource: list, request: { method: 'POST', url: 'List/' + listId } },
      {
        fullUrl: 'DocumentReference/' + sourceId,
        resource: {
          resourceType: 'DocumentReference',
          id: sourceId,
          extension: [{ url: EXT.deletionStatus, valueCoding: { system: 'http://fhir.ch/ig/ch-epr-mhealth/CodeSystem/ch-ehealth-codesystem-deletionstatus', code: 'deletionRequested' } }],
          content: [],
        },
        request: { method: 'PUT', url: 'DocumentReference/' + sourceId },
      },
    ],
  };
  return { bundle, listId };
}

// ---------------------------------------------------------------------------
// Write calls
// ---------------------------------------------------------------------------

export async function uploadDocument({ fhir, xua, bundle, docPart, bytes, contentType }) {
  const fd = new FormData();
  fd.append('bundle', new Blob([JSON.stringify(bundle)], { type: 'application/fhir+json' }));
  fd.append(docPart, new Blob([bytes], { type: contentType }));
  const r = await fhirFetch(`${fhir}/`, xua, { method: 'POST', body: fd }, 'upload');
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* not JSON */ }
  if (!r.ok) throw new ApiError(json?.resourceType === 'OperationOutcome' ? outcomeText(json) : `upload failed with HTTP ${r.status}`, { status: r.status, body: txt, step: 'upload' });
  if (!json) throw new ApiError('upload: non-JSON response', { status: r.status, body: txt, step: 'upload' });
  if (json.resourceType === 'OperationOutcome') throw new ApiError(outcomeText(json), { status: r.status, body: txt, step: 'upload' });
  return json;
}

export async function requestDeletion({ fhir, xua, bundle }) {
  const r = await fhirFetch(`${fhir}/`, xua, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bundle) }, 'delete');
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* not JSON */ }
  if (!r.ok) throw new ApiError(json?.resourceType === 'OperationOutcome' ? outcomeText(json) : `deletion request failed with HTTP ${r.status}`, { status: r.status, body: txt, step: 'delete' });
  if (!json || json.resourceType === 'OperationOutcome') throw new ApiError(json ? outcomeText(json) : 'deletion request: non-JSON response', { status: r.status, body: txt, step: 'delete' });
  const putEntry = json.entry?.find(e => e.response && (e.resource?.resourceType === 'DocumentReference' || /DocumentReference/.test(e.response.location ?? '') )) ?? json.entry?.[1];
  const status = putEntry?.response?.status ?? '';
  if (!/^200\b/.test(status)) throw new ApiError(`deletion request: unexpected entry status "${status}"`, { status: r.status, body: txt, step: 'delete' });
  return json;
}

/** Find the CARA-native copy of a document by hash (and optionally by identifier) in a fresh list */
export function findCopy(docs, { hash, homeCommunityId, docUrn = null }) {
  const cara = docs.filter(d => homeCommunityOf(d) === homeCommunityId && attachmentOf(d).hash === hash);
  if (docUrn) {
    const exact = cara.find(d => d.identifier?.some(i => i.value === docUrn));
    if (exact) return exact;
  }
  return cara[0] ?? null;
}

export function caraHashSet(docs, homeCommunityId) {
  return new Set(docs.filter(d => homeCommunityOf(d) === homeCommunityId).map(d => attachmentOf(d).hash).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Compatibility self-check: the extension relies on undocumented portal interfaces.
// If the list no longer looks like what was verified on 2026-09-12, destructive
// actions must be refused (backup may still work).
// ---------------------------------------------------------------------------
export const VERIFIED_PORTAL_VERSION = '25.4.3';

/** @returns {{ok:boolean, problems:string[]}} codes: notBundle, profile, noHomeCommunityExtension, noBinaryUrl, noHash, idFormat */
export function checkCompatibility(bundle, { fhir }) {
  const problems = [];
  if (!bundle || bundle.resourceType !== 'Bundle' || bundle.type !== 'searchset') return { ok: false, problems: ['notBundle'] };
  const { docs } = splitBundle(bundle);
  if (!docs.length) return { ok: true, problems: [] }; // nothing to judge, nothing to transfer either
  if (!docs.some(d => d.meta?.profile?.some(x => x.includes('IHE.MHD.Comprehensive.DocumentReference')))) problems.push('profile');
  if (!docs.every(d => extension(d, EXT.homeCommunityId)?.valueString?.startsWith('urn:oid:'))) problems.push('noHomeCommunityExtension');
  if (!docs.every(d => typeof attachmentOf(d).url === 'string' && attachmentOf(d).url.startsWith(`${fhir}/Binary/`))) problems.push('noBinaryUrl');
  if (!docs.every(d => typeof attachmentOf(d).hash === 'string' && attachmentOf(d).hash.length >= 27)) problems.push('noHash');
  if (!docs.every(d => decodeDocumentId(d.id).homeCommunityId?.startsWith('urn:oid:'))) problems.push('idFormat');
  return { ok: problems.length === 0, problems };
}
