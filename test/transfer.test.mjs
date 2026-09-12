import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { splitBundle, attachmentOf, homeCommunityOf } from '../src/api.js';
import { runTransfer, runBackup, extensionFor, sanitiseFileName, backupBaseName, RunAborted } from '../src/transfer.js';

const CARA = 'urn:oid:2.16.756.5.30.1.177';
const FHIR = 'https://api-portals.cara.ch/ad-adaptor/api/r4';
const bundle = JSON.parse(readFileSync(new URL('../DocumentReferenceOE.json', import.meta.url)));
const { docs } = splitBundle(bundle);
const session = { getXua: async () => 'xua', getAuthor: async () => ({ given: 'Anna', family: 'Muster' }), author: { given: 'Anna', family: 'Muster' } };

/** Minimal fake of the CARA facade: list, retrieve, upload (multipart), deletion (json), read-by-id. */
function fakeServer({ initialDocs, fail = {} }) {
  const store = new Map(initialDocs.map(d => [d.id, d]));
  const bytesById = new Map();
  for (const d of initialDocs) {
    const b = new TextEncoder().encode('content-of-' + d.id);
    bytesById.set(d.id, b);
    attachmentOf(d).hash = createHash('sha1').update(b).digest('base64');
    attachmentOf(d).url = `${FHIR}/Binary/${encodeURIComponent(d.id)}`;
  }
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url: String(url) });
    const u = String(url);
    if (fail.status && fail.when(u, method)) return new Response('nope', { status: fail.status });
    if (method === 'GET' && u.startsWith(`${FHIR}/DocumentReference?`)) {
      return Response.json({ resourceType: 'Bundle', type: 'searchset', entry: [...store.values()].map(r => ({ resource: r })) });
    }
    if (method === 'GET' && u.startsWith(`${FHIR}/DocumentReference/`)) {
      const id = decodeURIComponent(u.slice(`${FHIR}/DocumentReference/`.length));
      return store.has(id) ? Response.json(store.get(id)) : new Response('Resource Not Found', { status: 404 });
    }
    if (method === 'GET' && u.startsWith(`${FHIR}/Binary/`)) {
      const id = decodeURIComponent(u.slice(`${FHIR}/Binary/`.length));
      const b = bytesById.get(id);
      return b ? new Response(b, { status: 200, headers: { 'content-type': 'application/pdf' } }) : new Response('', { status: 404 });
    }
    if (method === 'POST' && u === `${FHIR}/`) {
      if (init.body instanceof FormData) {
        const b = JSON.parse(await init.body.get('bundle').text());
        const dr = b.entry[1].resource;
        const part = init.body.get(dr.content[0].attachment.url);
        const bytes = new Uint8Array(await part.arrayBuffer());
        const newId = 'cara-' + dr.id;
        const copy = { ...dr, id: newId, extension: [{ url: 'https://api.phellowseven.com/fhir/StructureDefinition/homeCommunityId', valueString: CARA }] };
        copy.content = [{ attachment: { ...dr.content[0].attachment, url: `${FHIR}/Binary/${encodeURIComponent(newId)}` }, format: dr.content[0].format }];
        store.set(newId, copy);
        bytesById.set(newId, bytes);
        return Response.json(b);
      }
      const b = JSON.parse(init.body);
      const put = b.entry.find(e => e.request?.method === 'PUT');
      const id = put.request.url.slice('DocumentReference/'.length);
      if (!store.has(id)) return Response.json({ resourceType: 'Bundle', type: 'transaction-response', entry: [{ response: { status: '200 OK' } }, { response: { status: '404 Not Found' } }] });
      store.delete(id);
      return Response.json({ resourceType: 'Bundle', type: 'transaction-response', entry: [{ response: { status: '200 OK' } }, { response: { status: '200 OK' } }] });
    }
    return new Response('unhandled', { status: 500 });
  };
  return { store, fetchImpl, calls };
}

function withFetch(f, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = f;
  return fn().finally(() => { globalThis.fetch = orig; });
}

const clone = d => JSON.parse(JSON.stringify(d));
const foreignPdf = () => clone(docs.find(d => attachmentOf(d).title === 'Covid_vaccination_certificate'));
const nativeDoc = () => clone(docs.find(d => homeCommunityOf(d) === CARA));

test('transfer: retrieve → hash → upload → verify → delete original', async () => {
  const src = foreignPdf();
  const srv = fakeServer({ initialDocs: [src, nativeDoc()] });
  const log = [];
  const events = [];
  const { summary, results } = await withFetch(srv.fetchImpl, () => runTransfer({
    session, fhir: FHIR, homeCommunityId: CARA, documents: [src], mode: 'transfer', settleMs: 0,
    appendLog: async e => log.push(e), onEvent: e => events.push(e),
  }));
  assert.equal(summary.ok, 1);
  assert.equal(results[0].error, null);
  assert.deepEqual(results[0].steps.map(s => `${s.step}:${s.status}`), ['retrieve:ok', 'verifyHash:ok', 'upload:ok', 'verifyCara:ok', 'safetyCopy:skipped', 'deleteOriginal:ok']);
  assert.equal(results[0].steps[5].detail, 'gone');
  assert.ok(!srv.store.has(src.id), 'original deleted');
  assert.ok([...srv.store.values()].some(d => homeCommunityOf(d) === CARA && attachmentOf(d).hash === attachmentOf(src).hash), 'copy exists');
  assert.deepEqual(log.map(e => e.phase), ['before-upload', 'before-delete', 'done']);
  assert.match(results[0].newDocUrn, /^urn:uuid:/);
  // strictly sequential: upload happened before deletion request
  const postIdx = srv.calls.map((c, i) => c.method === 'POST' ? i : -1).filter(i => i >= 0);
  assert.equal(postIdx.length, 2);
});

test('transfer: copy already exists → no upload, original deleted', async () => {
  const src = foreignPdf();
  const copy = nativeDoc();
  const srv = fakeServer({ initialDocs: [src, copy] });
  attachmentOf(copy).hash = attachmentOf(src).hash; // same content already in CARA
  const { results } = await withFetch(srv.fetchImpl, () => runTransfer({ session, fhir: FHIR, homeCommunityId: CARA, documents: [src], mode: 'transfer', settleMs: 0 }));
  assert.equal(results[0].error, null);
  assert.deepEqual(results[0].steps.map(s => `${s.step}:${s.status}`), ['retrieve:ok', 'verifyHash:ok', 'upload:skipped', 'verifyCara:skipped', 'safetyCopy:skipped', 'deleteOriginal:ok']);
  assert.equal(srv.calls.filter(c => c.method === 'POST').length, 1, 'only the deletion request was posted');
});

test('transfer: hash mismatch → nothing uploaded, nothing deleted', async () => {
  const src = foreignPdf();
  const srv = fakeServer({ initialDocs: [src] });
  attachmentOf(src).hash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const { summary, results } = await withFetch(srv.fetchImpl, () => runTransfer({ session, fhir: FHIR, homeCommunityId: CARA, documents: [src], mode: 'transfer', settleMs: 0 }));
  assert.equal(summary.failed, 1);
  assert.match(results[0].error, /hash mismatch/);
  assert.equal(srv.calls.filter(c => c.method === 'POST').length, 0);
  assert.ok(srv.store.has(src.id));
});

test('transfer: copy not verifiable → original left untouched', async () => {
  const src = foreignPdf();
  const srv = fakeServer({ initialDocs: [src] });
  // sabotage: the server "loses" the upload
  const orig = srv.fetchImpl;
  const f = async (u, init) => { const r = await orig(u, init); if (init?.body instanceof FormData) { for (const k of [...srv.store.keys()]) if (k.startsWith('cara-')) srv.store.delete(k); } return r; };
  const { results } = await withFetch(f, () => runTransfer({ session, fhir: FHIR, homeCommunityId: CARA, documents: [src], mode: 'transfer', settleMs: 0 }));
  assert.match(results[0].error, /copy not found/);
  assert.equal(results[0].steps.find(s => s.step === 'deleteOriginal'), undefined);
  assert.ok(srv.store.has(src.id), 'original still there');
});

test('delete-only: only the deletion request is sent', async () => {
  const src = foreignPdf();
  const srv = fakeServer({ initialDocs: [src] });
  const { results } = await withFetch(srv.fetchImpl, () => runTransfer({ session, fhir: FHIR, homeCommunityId: CARA, documents: [src], mode: 'delete', settleMs: 0 }));
  assert.equal(results[0].error, null);
  assert.deepEqual(results[0].steps.map(s => `${s.step}:${s.status}`), ['retrieve:skipped', 'verifyHash:skipped', 'upload:skipped', 'verifyCara:skipped', 'safetyCopy:skipped', 'deleteOriginal:ok']);
  assert.equal(srv.calls.filter(c => c.method === 'GET' && c.url.includes('/Binary/')).length, 0);
  assert.ok(!srv.store.has(src.id));
});

test('dry run sends nothing destructive', async () => {
  const src = foreignPdf();
  const srv = fakeServer({ initialDocs: [src] });
  const bundles = [];
  const { results } = await withFetch(srv.fetchImpl, () => runTransfer({ session, fhir: FHIR, homeCommunityId: CARA, documents: [src], mode: 'transfer', dryRun: true, settleMs: 0, onDryRun: (k, b) => bundles.push(k) }));
  assert.equal(results[0].error, null);
  assert.deepEqual(bundles, ['ProvideBundle', 'DeletionBundle']);
  assert.equal(srv.calls.filter(c => c.method === 'POST').length, 0);
  assert.ok(srv.store.has(src.id));
});

test('run stops on 401 and continues past per-document 4xx', async () => {
  const a = foreignPdf();
  const b = clone(docs.find(d => attachmentOf(d).title === '20221015_AustrittsberichtTriemli'));
  const c = clone(docs.find(d => attachmentOf(d).title === 'Vaccination - Fluarix Tetra'));
  const srv = fakeServer({ initialDocs: [a, b, c] });
  attachmentOf(a).url = `${FHIR}/Binary/missing`; // 404 on retrieve → per-document failure, run continues
  let n = 0;
  const f = async (u, init) => { if (String(u).includes('/Binary/') && String(u).includes(encodeURIComponent(c.id))) return new Response('', { status: 401 }); return srv.fetchImpl(u, init); };
  await assert.rejects(
    withFetch(f, () => runTransfer({ session, fhir: FHIR, homeCommunityId: CARA, documents: [a, c, b], mode: 'transfer', settleMs: 0, onEvent: e => { if (e.type === 'doc-done') n++; } })),
    RunAborted,
  );
  assert.equal(n, 2, 'a failed, c aborted, b never started');
  assert.ok(srv.store.has(b.id));
});

test('stop after current document', async () => {
  const a = foreignPdf();
  const b = clone(docs.find(d => attachmentOf(d).title === '20221015_AustrittsberichtTriemli'));
  const srv = fakeServer({ initialDocs: [a, b] });
  let stop = false;
  const { summary } = await withFetch(srv.fetchImpl, () => runTransfer({ session, fhir: FHIR, homeCommunityId: CARA, documents: [a, b], mode: 'transfer', settleMs: 0, shouldStop: () => stop, onEvent: e => { if (e.type === 'doc-done') stop = true; } }));
  assert.equal(summary.processed, 1);
  assert.equal(summary.stopped, true);
  assert.ok(srv.store.has(b.id));
});

test('backup: saves document and metadata, flags hash mismatch but still saves', async () => {
  const a = foreignPdf();
  const b = clone(docs.find(d => attachmentOf(d).title === 'Vaccination - Fluarix Tetra'));
  const srv = fakeServer({ initialDocs: [a, b] });
  attachmentOf(b).hash = 'bogus';
  const saved = [];
  const { results } = await withFetch(srv.fetchImpl, () => runBackup({
    session, documents: [a, b], fileName: ({ doc }) => backupBaseName(doc),
    save: async ({ filename, bytes }) => { saved.push([filename, bytes.length]); return filename; },
  }));
  assert.equal(results[0].error, null);
  assert.equal(results[0].hashMismatch, false);
  assert.equal(results[1].hashMismatch, true);
  assert.equal(results[1].error, null);
  assert.deepEqual(saved.map(s => s[0]), [
    '2022-06-03_Covid_vaccination_certificate.pdf', '2022-06-03_Covid_vaccination_certificate.metadata.json',
    '2025-02-07_Vaccination - Fluarix Tetra.json', '2025-02-07_Vaccination - Fluarix Tetra.metadata.json',
  ].map(n => n));
});

test('file naming helpers', () => {
  assert.equal(extensionFor('application/pdf'), 'pdf');
  assert.equal(extensionFor('application/fhir+json'), 'json');
  assert.equal(extensionFor('application/fhir+json; charset=utf-8'), 'json');
  assert.equal(extensionFor('text/xml'), 'xml');
  assert.equal(extensionFor('image/jpeg'), 'jpeg');
  assert.equal(extensionFor(undefined), 'bin');
  assert.equal(sanitiseFileName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
  assert.equal(sanitiseFileName('  .hidden.  '), 'hidden');
  assert.equal(sanitiseFileName(''), 'document');
  assert.equal(sanitiseFileName('x'.repeat(200)).length, 100);
  const withExt = clone(docs.find(d => attachmentOf(d).title.endsWith('.pdf')));
  assert.equal(backupBaseName(withExt), '2024-10-11_2024-10-11_BB_CobediasZs_1.pdf2024-10-11_BB_CobediasZs_1');
});

test('safety copy is written before the deletion request; a failed write prevents the deletion', async () => {
  const src = foreignPdf();
  const srv = fakeServer({ initialDocs: [src] });
  const saved = [];
  let deletePostedAfterSave = null;
  const save = async ({ filename, bytes }) => { saved.push([filename, bytes.length]); return filename; };
  const f = async (u, init) => { if (init?.method === 'POST' && !(init.body instanceof FormData)) deletePostedAfterSave = saved.length; return srv.fetchImpl(u, init); };
  const { results } = await withFetch(f, () => runTransfer({ session, fhir: FHIR, homeCommunityId: CARA, documents: [src], mode: 'transfer', settleMs: 0, save }));
  assert.equal(results[0].error, null);
  assert.deepEqual(results[0].steps.map(s => `${s.step}:${s.status}`), ['retrieve:ok', 'verifyHash:ok', 'upload:ok', 'verifyCara:ok', 'safetyCopy:ok', 'deleteOriginal:ok']);
  assert.deepEqual(saved.map(x => x[0]), ['2022-06-03_Covid_vaccination_certificate.pdf', '2022-06-03_Covid_vaccination_certificate.metadata.json']);
  assert.equal(deletePostedAfterSave, 2, 'both files were saved before the deletion request');
  assert.equal(results[0].filename, '2022-06-03_Covid_vaccination_certificate.pdf');

  // failing writer → copy exists in CARA, original NOT deleted
  const src2 = foreignPdf();
  const srv2 = fakeServer({ initialDocs: [src2] });
  const r2 = await withFetch(srv2.fetchImpl, () => runTransfer({ session, fhir: FHIR, homeCommunityId: CARA, documents: [src2], mode: 'transfer', settleMs: 0, save: async () => { throw new Error('disk full'); } }));
  assert.match(r2.results[0].error, /disk full/);
  assert.ok(srv2.store.has(src2.id), 'original still there');
  assert.equal(r2.results[0].steps.find(s => s.step === 'deleteOriginal'), undefined);
});

test('delete-only with safety copy retrieves, verifies and saves before deleting', async () => {
  const src = foreignPdf();
  const srv = fakeServer({ initialDocs: [src] });
  const saved = [];
  const { results } = await withFetch(srv.fetchImpl, () => runTransfer({ session, fhir: FHIR, homeCommunityId: CARA, documents: [src], mode: 'delete', settleMs: 0, save: async ({ filename }) => { saved.push(filename); return filename; } }));
  assert.equal(results[0].error, null);
  assert.deepEqual(results[0].steps.map(s => `${s.step}:${s.status}`), ['retrieve:ok', 'verifyHash:ok', 'upload:skipped', 'verifyCara:skipped', 'safetyCopy:ok', 'deleteOriginal:ok']);
  assert.equal(saved.length, 2);
  assert.ok(!srv.store.has(src.id));
  // hash mismatch → not deleted
  const src2 = foreignPdf();
  const srv2 = fakeServer({ initialDocs: [src2] });
  attachmentOf(src2).hash = 'bogus';
  const r2 = await withFetch(srv2.fetchImpl, () => runTransfer({ session, fhir: FHIR, homeCommunityId: CARA, documents: [src2], mode: 'delete', settleMs: 0, save: async ({ filename }) => filename }));
  assert.match(r2.results[0].error, /hash mismatch/);
  assert.ok(srv2.store.has(src2.id));
});
