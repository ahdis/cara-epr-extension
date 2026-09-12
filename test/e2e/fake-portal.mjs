#!/usr/bin/env node
// Offline end-to-end test of the extension UI with Playwright (not part of `npm test`; needs playwright in ~/node_modules
// or node_modules). It loads the unpacked extension into Chromium, serves a fake portal page at https://patient.cara.ch
// and a fake API at https://api-portals.cara.ch (route interception), then drives the panel through
// list → transfer one document → delete-only one document → backup → language switch.
//
//   node test/e2e/fake-portal.mjs [--headed] [--screenshots <dir>]
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const shots = args.includes('--screenshots') ? args[args.indexOf('--screenshots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

function loadPlaywright() {
  for (const base of [root, homedir()]) {
    try { return createRequire(join(base, 'node_modules', '/'))('playwright'); } catch { /* next */ }
  }
  throw new Error('playwright not found (npm i -D playwright)');
}
const { chromium } = loadPlaywright();

// --- fake data ----------------------------------------------------------------------------------
const CARA = 'urn:oid:2.16.756.5.30.1.177';
const FHIR = 'https://api-portals.cara.ch/ad-adaptor/api/r4';
const bundle = JSON.parse(readFileSync(join(root, 'DocumentReferenceOE.json'), 'utf8'));
const store = new Map();
const bytesById = new Map();
for (const e of bundle.entry) {
  const r = e.resource;
  if (r.resourceType !== 'DocumentReference') continue;
  const b = Buffer.from('%PDF-1.4 fake content of ' + r.id);
  bytesById.set(r.id, b);
  r.content[0].attachment.hash = createHash('sha1').update(b).digest('base64');
  r.content[0].attachment.url = `${FHIR}/Binary/${r.id}`;
  store.set(r.id, r);
}
const lists = bundle.entry.map(e => e.resource).filter(r => r.resourceType === 'List');
const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`;
const now = () => Math.floor(Date.now() / 1000);
const idToken = jwt({ spid: '761337610000000001', given_name: 'Anna', family_name: 'Muster', iat: now(), exp: now() + 300 });
const requests = [];
let tokenRefreshes = 0, exchanges = 0, uploads = 0, deletions = 0;

function listBundle() {
  return { resourceType: 'Bundle', type: 'searchset', total: store.size + lists.length, entry: [...store.values(), ...lists].map(r => ({ resource: r })) };
}

async function fakeApi(route) {
  const req = route.request();
  const url = req.url();
  const method = req.method();
  requests.push({ method, url });
  if (url.includes('/openid-connect/token')) {
    const body = new URLSearchParams(req.postData() ?? '');
    if (body.get('grant_type') === 'refresh_token') {
      tokenRefreshes++;
      if (!body.get('refresh_token')?.startsWith('eyJ')) return route.fulfill({ status: 400, body: 'bad refresh token' });
      return route.fulfill({ json: { access_token: jwt({ spid: '761337610000000001', exp: now() + 300 }), refresh_token: jwt({ typ: 'refresh', iat: now(), exp: now() + 300, n: tokenRefreshes }), id_token: idToken, token_type: 'Bearer', expires_in: 300 } });
    }
    exchanges++;
    for (const k of ['purpose_of_use', 'role', 'resource_id', 'home_community_id']) if (!body.get(k)) return route.fulfill({ status: 400, body: `<html>missing ${k}</html>` });
    return route.fulfill({ json: { access_token: jwt({ SubjectRole: [{ code: 'PAT' }], exp: now() + 299 }), token_type: 'Bearer', expires_in: 299 } });
  }
  const auth = req.headers().authorization ?? '';
  if (!auth.startsWith('Bearer eyJ')) return route.fulfill({ status: 401, body: 'no token' });
  if (method === 'GET' && url.startsWith(`${FHIR}/DocumentReference?`)) return route.fulfill({ json: listBundle(), contentType: 'application/fhir+json' });
  if (method === 'GET' && url.startsWith(`${FHIR}/DocumentReference/`)) {
    const id = decodeURIComponent(url.slice(`${FHIR}/DocumentReference/`.length));
    return store.has(id) ? route.fulfill({ json: store.get(id) }) : route.fulfill({ status: 404, body: 'Resource Not Found' });
  }
  if (method === 'GET' && url.startsWith(`${FHIR}/Binary/`)) {
    const id = decodeURIComponent(url.slice(`${FHIR}/Binary/`.length));
    const b = bytesById.get(id);
    return b ? route.fulfill({ status: 200, body: b, contentType: 'application/pdf' }) : route.fulfill({ status: 404, body: '' });
  }
  if (method === 'POST' && url === `${FHIR}/`) {
    const ct = req.headers()['content-type'] ?? '';
    if (ct.startsWith('multipart/form-data')) {
      uploads++;
      const raw = req.postDataBuffer();
      const boundary = ct.split('boundary=')[1];
      const parts = parseMultipart(raw, boundary);
      const b = JSON.parse(parts.find(p => p.name === 'bundle').body.toString());
      const dr = b.entry[1].resource;
      const file = parts.find(p => p.name === dr.content[0].attachment.url);
      const newId = Buffer.from(`${dr.id.slice(9)}@${CARA}`).toString('base64');
      const copy = { ...dr, id: newId, extension: [{ url: 'https://api.phellowseven.com/fhir/StructureDefinition/homeCommunityId', valueString: CARA }] };
      copy.content = [{ attachment: { ...dr.content[0].attachment, url: `${FHIR}/Binary/${newId}` }, format: dr.content[0].format }];
      store.set(newId, copy);
      bytesById.set(newId, file.body);
      return route.fulfill({ json: b });
    }
    const b = JSON.parse(req.postData());
    const put = b.entry.find(e => e.request?.method === 'PUT');
    const id = put.request.url.slice('DocumentReference/'.length);
    deletions++;
    if (!store.has(id)) return route.fulfill({ json: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', diagnostics: 'not found' }] }, status: 404 });
    store.delete(id);
    return route.fulfill({ json: { resourceType: 'Bundle', type: 'transaction-response', entry: [{ response: { status: '200 OK' } }, { response: { status: '200 OK' } }] } });
  }
  return route.fulfill({ status: 500, body: 'unhandled ' + method + ' ' + url });
}

function parseMultipart(buf, boundary) {
  const parts = [];
  const delim = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(delim) + delim.length;
  for (;;) {
    if (buf.slice(pos, pos + 2).toString() === '--') break;
    pos += 2; // CRLF
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    const head = buf.slice(pos, headEnd).toString();
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const next = buf.indexOf(delim, headEnd);
    const body = buf.slice(headEnd + 4, next - 2);
    parts.push({ name, body });
    pos = next + delim.length;
  }
  return parts;
}

const portalHtml = `<!doctype html><html><head><meta charset="utf-8"><title>fake CARA portal</title></head>
<body><div id="app" data-content='${JSON.stringify({ VUE_APP_HOME_COMMUNITY_ID: '2.16.756.5.30.1.177', VUE_APP_HOME_COMMUNITY_NAME: 'CARA', VUE_APP_API_PHIDY: 'https://api-portals.cara.ch', VUE_APP_API_APHINITY: 'https://api-portals.cara.ch/ad-adaptor/api/' })}'>fake portal</div></body></html>`;

// --- run ----------------------------------------------------------------------------------------
const userDataDir = join(root, '.e2e-profile');
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: !headed,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const failures = [];
const check = (cond, msg) => { if (cond) console.log('  ✔', msg); else { console.log('  ✖', msg); failures.push(msg); } };
try {
  await context.route('https://patient.cara.ch/**', route => route.fulfill({ body: portalHtml, contentType: 'text/html' }));
  await context.route('https://api-portals.cara.ch/**', fakeApi);

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  console.log('extension id', extId);

  const portal = await context.newPage();
  await portal.goto('https://patient.cara.ch/documents/');
  await portal.evaluate(({ idToken, jwt }) => {
    localStorage.setItem('phellow:oauth2:refreshToken', jwt);
    localStorage.setItem('phellow:oauth2:idToken', idToken);
    localStorage.setItem('phellow:oauth2:accessToken', jwt);
    localStorage.setItem('phellow:state:selectedIdP', 'SwissID');
    localStorage.setItem('phellow:language', 'de-ch');
  }, { idToken, jwt: jwt({ typ: 'refresh', iat: now(), exp: now() + 300, n: 0 }) });

  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', e => errors.push(e.message));
  panel.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); }); // 404 on re-read after deletion is expected
  await panel.goto(`chrome-extension://${extId}/src/panel.html`);
  await panel.evaluate(() => chrome.storage.local.clear());
  await panel.reload();

  console.log('\n0. first-run notice');
  await panel.waitForSelector('#introView:not([hidden])', { timeout: 15000 });
  check((await panel.textContent('#introView')).includes('ahdis'), 'first-run notice names the provider');
  check(await panel.isDisabled('#introAccept'), 'continue disabled before acknowledgement');
  await panel.check('#introAck');
  await panel.click('#introAccept');

  console.log('\n1. list view in German');
  await panel.waitForSelector('#listView:not([hidden]) table', { timeout: 15000 });
  check(await panel.$eval('#compatBanner', b => b.hidden), 'compatibility check passes for the verified shape');
  check((await panel.textContent('#patientName')).includes('Anna Muster'), 'patient name from id_token');
  check((await panel.textContent('#communityName')).includes('CARA'), 'community name from config');
  check((await panel.textContent('#reloadBtn')) === 'Neu laden', 'German UI (portal language de-ch)');
  const rows = await panel.$$('#tableContainer tbody tr');
  check(rows.length === 19, `19 foreign rows shown (got ${rows.length})`);
  const groups = await panel.$$('#tableContainer .group');
  check(groups.length === 1, 'one foreign community group');
  const badges = await panel.$$eval('#tableContainer .badge', b => b.map(x => x.textContent));
  const count = v => badges.filter(x => x === v).length;
  check(count('übertragbar') === 8 && count('ersetzt') === 11 && count('nicht unterstützt') === 0, `badges: ${JSON.stringify(Object.fromEntries([...new Set(badges)].map(v => [v, count(v)])))}`);
  check((await panel.textContent('#selectedCount')).startsWith('8 '), 'transferable rows pre-selected');
  await panel.check('#showCara');
  check((await panel.$$('#tableContainer tbody tr')).length === 22, 'toggle shows CARA documents too');
  check((await panel.$$('#tableContainer .group')).length === 2, 'CARA group added');
  await panel.uncheck('#showCara');
  if (shots) await panel.screenshot({ path: join(shots, '1-list-de.png'), fullPage: true });
  const refreshedToken = await portal.evaluate(() => localStorage.getItem('phellow:oauth2:refreshToken'));
  check(refreshedToken.includes(b64url({ typ: 'refresh', iat: now(), exp: now() + 300, n: 1 }).slice(0, 10)) || tokenRefreshes >= 1, `token refreshed and written back (${tokenRefreshes} refresh, ${exchanges} exchange)`);

  console.log('\n2. transfer one document');
  await panel.click('#selectNoneBtn');
  const covidRow = panel.locator('#tableContainer tbody tr', { hasText: 'Covid_vaccination_certificate' });
  await covidRow.locator('input[type=checkbox]').check();
  check((await panel.textContent('#selectedCount')).startsWith('1 '), 'one selected');
  await panel.click('#transferBtn');
  await panel.waitForSelector('#disclaimerDialog[open]');
  check((await panel.textContent('#disclaimerText')).includes('sofort und unwiderruflich'), 'German disclaimer shown');
  check(await panel.isDisabled('#disclaimerConfirm'), 'confirm disabled before acknowledgement');
  check(await panel.isChecked('#safetyCopy') && (await panel.textContent('#safetyCopyLabel')).includes('cara-backup'), 'safety copy on by default');
  await panel.check('#disclaimerAck');
  check(!(await panel.isDisabled('#disclaimerConfirm')), 'confirm enabled after acknowledgement');
  if (shots) await panel.screenshot({ path: join(shots, '2-disclaimer.png') });
  await panel.click('#disclaimerConfirm');
  await panel.waitForSelector('#backBtn:not([hidden])', { timeout: 30000 });
  const stepTexts = await panel.$$eval('.prow-steps .step', s => s.map(x => x.className.replace('step ', '') + '|' + x.textContent));
  check(stepTexts.filter(s => s.startsWith('step-ok')).length === 6, `all six steps ok (incl. safety copy): ${stepTexts.join(', ')}`);
  check(uploads === 1 && deletions === 1, `one upload and one deletion request sent (${uploads}/${deletions})`);
  check(!(await panel.textContent('#progressSummary')).includes('fehlgeschlagen: 1') && (await panel.textContent('#progressSummary')).includes('1 erfolgreich'), 'summary reports success');
  if (shots) await panel.screenshot({ path: join(shots, '3-progress.png'), fullPage: true });
  await panel.click('#backBtn');
  await panel.waitForSelector('#listView:not([hidden]) table');
  check(!(await panel.textContent('#tableContainer')).includes('Covid_vaccination_certificate'), 'original gone from the foreign list after reload');
  await panel.check('#showCara');
  check((await panel.locator('#tableContainer tbody tr', { hasText: 'Covid_vaccination_certificate' }).count()) === 1, 'copy appears under CARA');
  await panel.uncheck('#showCara');

  console.log('\n3. copy exists → no re-upload');
  // simulate: the CARA copy exists but the foreign original is still there (interrupted run)
  const orig = bundle.entry.map(e => e.resource).find(r => r.resourceType === 'DocumentReference' && r.content[0].attachment.title === 'Covid_vaccination_certificate');
  store.set(orig.id, orig);
  await panel.click('#reloadBtn');
  await panel.waitForSelector('#listView:not([hidden]) table');
  const dupRow = panel.locator('#tableContainer tbody tr', { hasText: 'Covid_vaccination_certificate' });
  check((await dupRow.locator('.badge').textContent()) === 'Kopie vorhanden', 'badge "copy exists"');
  check(!(await dupRow.locator('input[type=checkbox]').isChecked()), 'copy-exists row not pre-selected');
  await panel.click('#selectNoneBtn');
  await dupRow.locator('input[type=checkbox]').check();
  check(await panel.isDisabled('#transferBtn'), 'transfer disabled for copy-exists selection');
  check(!(await panel.isDisabled('#deleteBtn')), 'delete-only allowed for copy-exists selection');

  console.log('\n4. delete-only one superseded version');
  await panel.click('#selectNoneBtn');
  const sup = panel.locator('#tableContainer tbody tr', { hasText: 'FluarixTextra' }).first();
  await sup.locator('input[type=checkbox]').check();
  check(await panel.isDisabled('#transferBtn'), 'transfer disabled for superseded');
  const before = store.size;
  await panel.click('#deleteBtn');
  await panel.waitForSelector('#disclaimerDialog[open]');
  check((await panel.textContent('#disclaimerText')).includes('nicht nach CARA kopiert'), 'delete-only disclaimer');
  await panel.check('#disclaimerAck');
  await panel.click('#disclaimerConfirm');
  await panel.waitForSelector('#backBtn:not([hidden])', { timeout: 30000 });
  check(store.size === before - 1 && uploads === 1, 'exactly one document deleted, no upload');
  const delSteps = await panel.$$eval('.prow-steps .step', s => s.map(x => x.className.replace('step ', '')));
  check(delSteps.filter(s => s === 'step-skipped').length === 2 && delSteps[4] === 'step-ok' && delSteps[5] === 'step-ok', `upload/verify skipped, safety copy + delete ok: ${delSteps.join(',')}`);
  await panel.click('#backBtn');
  await panel.waitForSelector('#listView:not([hidden]) table');

  console.log('\n5. backup two documents');
  await panel.click('#selectNoneBtn');
  await panel.locator('#tableContainer tbody tr', { hasText: '20221015_AustrittsberichtTriemli' }).locator('input[type=checkbox]').check();
  await panel.locator('#tableContainer tbody tr', { hasText: 'Vaccination - Fluarix Tetra' }).first().locator('input[type=checkbox]').check();
  const downloadNames = [];
  context.on('page', () => {});
  const dlPromise = new Promise(res => { let n = 0; const h = async d => { downloadNames.push(d.suggestedFilename()); await d.path().catch(() => {}); if (++n >= 4) { res(); } }; panel.on('download', h); portal.on('download', h); });
  await panel.click('#backupBtn');
  await panel.waitForSelector('#backupDialog[open]');
  check((await panel.textContent('#backupNote')).includes('cara-backup'), 'backup note names the folder');
  await panel.click('#backupDialog button[value=confirm]');
  await panel.waitForSelector('#backBtn:not([hidden])', { timeout: 30000 });
  await Promise.race([dlPromise, new Promise(r => setTimeout(r, 3000))]);
  const bSteps = await panel.$$eval('.prow', rows => rows.map(r => [...r.querySelectorAll('.step')].map(s => s.className.replace('step ', ''))));
  check(bSteps.length === 2 && bSteps.every(s => s.every(x => x === 'step-ok')), `backup steps ok: ${JSON.stringify(bSteps)}`);
  const metas = await panel.$$eval('.prow-meta', m => m.map(x => x.textContent));
  check(metas.some(m => m.includes('2022-10-15_20221015_AustrittsberichtTriemli.pdf')), `filename in progress row: ${metas.join(' | ')}`);
  console.log('   downloads seen by playwright:', downloadNames.join(', ') || '(none captured — chrome.downloads from extension pages are not surfaced as page downloads)');
  if (shots) await panel.screenshot({ path: join(shots, '4-backup.png'), fullPage: true });
  await panel.click('#backBtn');
  await panel.waitForSelector('#listView:not([hidden]) table');

  console.log('\n6. log and language switch');
  await panel.click('#toggleLogBtn');
  const logText = await panel.textContent('#logEntries');
  check(logText.includes('Covid_vaccination_certificate') && logText.includes('backup'), 'log lists transfer and backup entries');
  await portal.evaluate(() => localStorage.setItem('phellow:language', 'fr-ch'));
  await panel.click('#reloadBtn');
  await panel.waitForSelector('#listView:not([hidden]) table');
  check((await panel.textContent('#reloadBtn')) === 'Recharger', 'panel follows portal language (fr)');
  check((await panel.$$eval('#tableContainer .badge', b => b.map(x => x.textContent))).includes('transférable'), 'badges translated');
  await panel.selectOption('#langSelect', 'en');
  await panel.waitForFunction(() => document.getElementById('reloadBtn').textContent === 'Reload');
  check(true, 'manual override to English');
  if (shots) await panel.screenshot({ path: join(shots, '5-list-en.png'), fullPage: true });

  console.log('\n7. logged-out state');
  await portal.evaluate(() => localStorage.removeItem('phellow:oauth2:refreshToken'));
  await panel.click('#reloadBtn');
  await panel.waitForSelector('#messageView:not([hidden])');
  check((await panel.textContent('#messageText')).includes('Log in'), 'asks to log in when no refresh token');

  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  const tokenLeaks = requests.filter(r => /eyJ/.test(r.url));
  check(tokenLeaks.length === 0, 'no token in any URL');
} finally {
  await context.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
