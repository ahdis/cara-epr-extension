#!/usr/bin/env node
// Integration script: runs the extension's transfer algorithm (src/transfer.js + src/api.js) against the live API.
//
//   EPR_REFRESH_TOKEN='<phellow:oauth2:refreshToken from DevTools>' node scripts/transfer-one.mjs --dry-run [--title <substring>] [--mode transfer|delete|backup]
//
// Default: --dry-run is REQUIRED unless you pass --really (a real run copies one document and deletes the original!).
// --hc <urn:oid:...>   restrict to one source community (default: everything that is not CARA)
// --status current|superseded|any   (default current for transfer, superseded for delete)
// --allow-fhir-json    treat application/fhir+json as transferable (UNVERIFIED upload path)
// --out <dir>          for --mode backup: target directory (default ./backup-<date>)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULTS, fhirBase, createSession, listDocuments, splitBundle, classify, caraHashSet, attachmentOf, homeCommunityOf, decodeJwt,
} from '../src/api.js';
import { runTransfer, runBackup, backupBaseName } from '../src/transfer.js';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const has = k => args.includes(k);
const mode = arg('--mode', 'transfer');
const dryRun = !has('--really');
if (!dryRun && !has('--dry-run') && mode !== 'backup') console.error('*** REAL RUN: one document will be copied and/or its original deleted ***');
if (!dryRun && has('--dry-run')) { console.error('--dry-run and --really are mutually exclusive'); process.exit(2); }

let refreshToken = process.env.EPR_REFRESH_TOKEN;
if (!refreshToken) { console.error('EPR_REFRESH_TOKEN missing'); process.exit(2); }
const tenant = arg('--tenant', 'realm-pat-swissid');
const homeCommunityId = DEFAULTS.homeCommunityId;
const fhir = fhirBase();

const session = createSession({
  tenant,
  homeCommunityId,
  readTokens: async () => ({ refreshToken }),
  writeTokens: async t => { refreshToken = t.refreshToken; console.error('(refresh token rotated; new one kept in memory only)'); },
});

const xua = await session.getXua();
const c = decodeJwt(xua);
console.error(`XUA token ok, role ${c?.SubjectRole?.[0]?.code ?? '?'}, exp ${c?.exp ? new Date(c.exp * 1e3).toISOString() : '?'}; author ${session.author.given} ${session.author.family}`);

const { docs } = splitBundle(await listDocuments({ fhir, xua }));
const caraHashes = caraHashSet(docs, homeCommunityId);
const allowFhirJson = has('--allow-fhir-json');
const wantHc = arg('--hc', null);
const wantStatus = arg('--status', mode === 'delete' ? 'superseded' : 'current');
const title = arg('--title', null);

const rows = docs.map(d => ({ d, state: classify(d, { caraHashes, homeCommunityId, allowFhirJson }) }));
console.error('\nAll documents:');
for (const { d, state } of rows) {
  const a = attachmentOf(d);
  console.error(`  ${(a.creation ?? '').slice(0, 10)}  ${d.status.padEnd(10)}  ${String(homeCommunityOf(d)).padEnd(34)}  ${a.contentType.padEnd(22)}  ${state.padEnd(12)}  ${a.title}`);
}

let cands = rows.filter(({ d }) => homeCommunityOf(d) !== homeCommunityId);
if (wantHc) cands = cands.filter(({ d }) => homeCommunityOf(d) === wantHc);
if (wantStatus !== 'any') cands = cands.filter(({ d }) => d.status === wantStatus);
if (title) cands = cands.filter(({ d }) => (attachmentOf(d).title ?? '').includes(title));
if (mode === 'transfer') cands = cands.filter(({ state }) => state === 'transferable');
if (mode === 'delete') cands = cands.filter(({ state }) => state !== 'unsupported' || true);

console.error(`\nCandidates (${mode}${wantHc ? ', hc ' + wantHc : ''}, status ${wantStatus}${title ? ', title ~ "' + title + '"' : ''}): ${cands.length}`);
for (const { d, state } of cands) console.error(`  - ${attachmentOf(d).title}  [${state}, ${attachmentOf(d).size} B, ${d.status}, ${(attachmentOf(d).creation ?? '').slice(0, 10)}]`);
if (mode !== 'backup' && cands.length !== 1 && !has('--first')) {
  console.error('\nRefusing: need exactly one candidate (narrow with --title/--hc/--status, or pass --first).');
  process.exit(cands.length ? 2 : 1);
}
const documents = mode === 'backup' ? cands.map(x => x.d) : [cands[0].d];

const onEvent = ev => {
  if (ev.type === 'doc-start') console.error(`\n▶ ${attachmentOf(ev.doc).title}`);
  else if (ev.type === 'step' && ev.status !== 'running') console.error(`   ${ev.step.padEnd(15)} ${ev.status}${ev.detail && typeof ev.detail === 'string' ? ' (' + ev.detail + ')' : ''}${ev.error ? ' — ' + ev.error : ''}`);
  else if (ev.type === 'run-done') console.error(`\nSummary: ${JSON.stringify(ev.summary)}`);
};
const appendLog = async e => { if (e.phase === 'done') console.error(`   log: ${JSON.stringify({ ...e, steps: undefined })}`); };

if (mode === 'backup') {
  const out = arg('--out', `backup-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(out, { recursive: true });
  const r = await runBackup({ session, documents, onEvent, appendLog, fileName: ({ doc }) => backupBaseName(doc), save: async ({ bytes, filename }) => { writeFileSync(join(out, filename), bytes); return filename; } });
  console.log(JSON.stringify(r.results, null, 2));
} else {
  const r = await runTransfer({
    session, fhir, homeCommunityId, documents, mode, dryRun, onEvent, appendLog,
    onDryRun: (kind, bundle) => { console.log(`\n=== ${kind} (would send) ===`); console.log(JSON.stringify(bundle, null, 2)); },
  });
  if (!dryRun) console.log(JSON.stringify(r.results, null, 2));
}
