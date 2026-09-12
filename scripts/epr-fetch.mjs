#!/usr/bin/env node
// Proof-of-concept: read your CARA EPR document list from the command line while logged in.
//
// 1. Log in at https://patient.cara.ch/documents/
// 2. DevTools → Application → Local Storage → https://patient.cara.ch → copy `phellow:oauth2:refreshToken`
//    (valid ~5 min; it is rotated on every refresh, this script prints the new one).
// 3. EPR_REFRESH_TOKEN='<token>' node scripts/epr-fetch.mjs [--cookie '<phidy:session value>']
//
// Verified 2026-09-12: works without any cookie. --cookie is kept only as a fallback
// (DevTools → Application → Cookies → https://api-portals.cara.ch → phidy:session).
// Add --json to dump the full Bundle.

const TOKEN_URL = 'https://api-portals.cara.ch/tenant/realm-pat-swissid/openid-connect/token';
const FHIR = 'https://api-portals.cara.ch/ad-adaptor/api/r4';
const CLIENT_ID = 'emedo-pr-web';
const HOME_COMMUNITY = 'urn:oid:2.16.756.5.30.1.177';

const args = process.argv.slice(2);
const cookie = args.includes('--cookie') ? args[args.indexOf('--cookie') + 1] : null;
const refreshToken = process.env.EPR_REFRESH_TOKEN;
if (!refreshToken) { console.error('EPR_REFRESH_TOKEN missing'); process.exit(2); }

const claims = t => JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
const headers = { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie: `phidy:session=${cookie}` } : {}) };

async function post(params) {
  const r = await fetch(TOKEN_URL, { method: 'POST', headers, body: new URLSearchParams(params) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

// 1. refresh IdP token
const idp = await post({ grant_type: 'refresh_token', client_id: CLIENT_ID, redirect_uri: 'https://patient.cara.ch/login', refresh_token: refreshToken });
const c1 = claims(idp.access_token);
console.error(`IdP token ok, exp ${new Date(c1.exp * 1e3).toISOString()}; NEW refresh token (rotated):\n${idp.refresh_token}\n`);

// 2. token exchange → XUA token
// The portal (role PAT) adds purpose_of_use, role and resource_id = own EPR-SPID (taken from the id_token `spid` claim).
const spid = claims(idp.id_token ?? idp.access_token).spid;
const xua = await post({ client_id: CLIENT_ID, grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: idp.access_token, subject_token_type: 'urn:ietf:params:oauth:token-type:access_token', home_community_id: HOME_COMMUNITY, purpose_of_use: 'NORM', role: 'PAT', resource_id: spid });
const c2 = claims(xua.access_token);
console.error(`XUA token ok, role ${c2.SubjectRole?.[0]?.code}, exp ${new Date(c2.exp * 1e3).toISOString()}`);

// 3. ITI-67
const r = await fetch(`${FHIR}/DocumentReference?status=current,superseded&_revinclude=List:item`, { headers: { authorization: `${xua.token_type} ${xua.access_token}`, accept: 'application/fhir+json' } });
console.error(`DocumentReference → ${r.status}`);
const bundle = await r.json();
if (args.includes('--json')) { console.log(JSON.stringify(bundle, null, 2)); }
else for (const e of bundle.entry ?? []) {
  const d = e.resource; if (d.resourceType !== 'DocumentReference') continue;
  const hc = d.extension?.find(x => x.url.endsWith('/homeCommunityId'))?.valueString;
  console.log(`${d.content[0].attachment.creation?.slice(0, 10)}  ${d.status.padEnd(10)}  ${hc?.padEnd(36)}  ${d.content[0].attachment.title}`);
}
