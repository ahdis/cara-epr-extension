// cara-transfer — run engine (environment-agnostic; used by the panel and by scripts/transfer-one.mjs).
// Executes the per-document algorithm of spec §4.4 sequentially, never in parallel.
import {
  ApiError, attachmentOf, homeCommunityOf, uniqueIdOf, sha1Base64, bytesEqual, authorDisplayOf,
  listDocuments, retrieveDocument, uploadDocument, requestDeletion, getDocumentReferenceStatus,
  buildProvideBundle, buildDeletionBundle, findCopy, splitBundle,
} from './api.js';

export const STEPS = Object.freeze({
  retrieve: 'retrieve',
  verifyHash: 'verifyHash',
  upload: 'upload',
  verifyCara: 'verifyCara',
  safetyCopy: 'safetyCopy',
  deleteOriginal: 'deleteOriginal',
  save: 'save',
});

export const TRANSFER_STEPS = [STEPS.retrieve, STEPS.verifyHash, STEPS.upload, STEPS.verifyCara, STEPS.safetyCopy, STEPS.deleteOriginal];
export const BACKUP_STEPS = [STEPS.retrieve, STEPS.verifyHash, STEPS.save];

export class RunAborted extends Error {
  constructor(message, cause) { super(message); this.name = 'RunAborted'; this.cause = cause; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeStepper(entry, index, onEvent) {
  const step = async (name, fn) => {
    const t0 = Date.now();
    onEvent({ type: 'step', index, step: name, status: 'running' });
    try {
      const detail = await fn();
      entry.steps.push({ step: name, status: 'ok', ms: Date.now() - t0, ...(detail ? { detail: typeof detail === 'string' ? detail : undefined } : {}) });
      onEvent({ type: 'step', index, step: name, status: 'ok', detail });
      return detail;
    } catch (e) {
      entry.steps.push({ step: name, status: 'failed', ms: Date.now() - t0, error: e.message, httpStatus: e.status ?? null });
      onEvent({ type: 'step', index, step: name, status: 'failed', error: e.message });
      throw e;
    }
  };
  const skip = (name, detail) => {
    entry.steps.push({ step: name, status: 'skipped', ms: 0, detail });
    onEvent({ type: 'step', index, step: name, status: 'skipped', detail });
  };
  return { step, skip };
}

function baseEntry(doc, mode, runId, dryRun) {
  const att = attachmentOf(doc);
  return {
    when: new Date().toISOString(),
    runId,
    mode,
    dryRun,
    sourceId: doc.id,
    sourceUniqueId: uniqueIdOf(doc),
    homeCommunityId: homeCommunityOf(doc),
    title: att.title ?? '',
    hash: att.hash ?? null,
    newDocUrn: null,
    newMasterIdentifier: null,
    steps: [],
    error: null,
  };
}

/**
 * Transfer / delete-only run.
 * @param {object} o
 * @param {object} o.session        createSession() result
 * @param {string} o.fhir           FHIR base URL
 * @param {string} o.homeCommunityId
 * @param {object[]} o.documents    selected DocumentReference resources from the list fetched in this run
 * @param {'transfer'|'delete'} o.mode
 * @param {boolean} [o.dryRun]      build everything, send nothing destructive
 * @param {boolean} [o.compareBytes] after upload, retrieve the copy and byte-compare (default true)
 * @param {(ev:object)=>void} [o.onEvent]   progress events {type:'doc-start'|'step'|'doc-done'|'run-done', ...}
 * @param {()=>boolean} [o.shouldStop]      polled between documents ("stop after current")
 * @param {(entry:object)=>Promise<void>} [o.appendLog]  persist one log entry (called before and after destructive calls)
 * @param {(kind:string, bundle:object)=>void} [o.onDryRun]
 * @param {(o:{bytes:Uint8Array, filename:string, contentType:string}) => Promise<string>} [o.save]
 *        safety-copy writer (chrome.downloads in the panel). When given, every document is written to disk
 *        (document + metadata JSON) BEFORE its deletion request; a failed write prevents the deletion.
 */
export async function runTransfer(o) {
  const {
    session, fhir, homeCommunityId, documents, mode, dryRun = false, compareBytes = true, keepAuthor = true, save = null,
    onEvent = () => {}, shouldStop = () => false, appendLog = async () => {}, settleMs = 2000, runId = new Date().toISOString(),
  } = o;
  if (mode !== 'transfer' && mode !== 'delete') throw new Error('unknown mode ' + mode);
  const results = [];
  let stopped = false;
  let fatal = null;

  for (let i = 0; i < documents.length; i++) {
    if (shouldStop()) { stopped = true; break; }
    const doc = documents[i];
    const att = attachmentOf(doc);
    const entry = baseEntry(doc, mode, runId, dryRun);
    const startedAt = Date.now();
    const { step, skip } = makeStepper(entry, i, onEvent);
    onEvent({ type: 'doc-start', index: i, doc, entry });

    try {
      await session.getXua();

      if (mode === 'transfer') {
        // 1 retrieve
        const { bytes } = await step(STEPS.retrieve, async () => retrieveDocument({ url: att.url, xua: await session.getXua() }));
        // 2 hash
        const hash = await step(STEPS.verifyHash, async () => {
          const h = await sha1Base64(bytes);
          if (h !== att.hash) throw new ApiError(`hash mismatch (metadata ${att.hash}, retrieved ${h}), not uploading`, { step: 'verifyHash' });
          return h;
        });

        // 3 does a CARA copy already exist? (fresh list, not the one the panel rendered from)
        const fresh = splitBundle(await listDocuments({ fhir, xua: await session.getXua() })).docs;
        let copy = findCopy(fresh, { hash, homeCommunityId });
        if (copy) {
          skip(STEPS.upload, 'copyExists');
          skip(STEPS.verifyCara, 'copyExists');
          entry.newDocUrn = copy.identifier?.find(x => x.value?.startsWith('urn:uuid:'))?.value ?? null;
          entry.newMasterIdentifier = copy.masterIdentifier?.value ?? null;
        } else {
          // 4 + 5 upload and verify
          const author = await session.getAuthor();
          const built = buildProvideBundle({ source: doc, size: bytes.length, hash, author, keepAuthor });
          entry.newDocUrn = built.docUrn;
          entry.newMasterIdentifier = built.masterIdentifier;
          entry.authorKept = built.authorKept;
          await appendLog({ ...entry, phase: 'before-upload' });
          if (dryRun) {
            o.onDryRun?.('ProvideBundle', built.bundle);
            skip(STEPS.upload, 'dryRun');
            skip(STEPS.verifyCara, 'dryRun');
          } else {
            await step(STEPS.upload, async () => {
              await uploadDocument({ fhir, xua: await session.getXua(), bundle: built.bundle, docPart: built.docPart, bytes, contentType: att.contentType });
              return built.docUrn;
            });
            copy = await step(STEPS.verifyCara, async () => {
              let found = null;
              for (let attempt = 0; attempt < 3 && !found; attempt++) {
                await sleep(settleMs);
                const after = splitBundle(await listDocuments({ fhir, xua: await session.getXua() })).docs;
                found = findCopy(after, { hash, homeCommunityId, docUrn: built.docUrn });
              }
              if (!found) throw new ApiError('copy not found in CARA after upload; original left untouched', { step: 'verifyCara' });
              if (compareBytes) {
                const r = await retrieveDocument({ url: attachmentOf(found).url, xua: await session.getXua() });
                if (!bytesEqual(r.bytes, bytes)) throw new ApiError('copy in CARA differs from the source bytes; original left untouched', { step: 'verifyCara' });
              }
              entry.newMasterIdentifier = found.masterIdentifier?.value ?? entry.newMasterIdentifier;
              entry.copyAuthor = authorDisplayOf(found);
              entry.sourceAuthor = authorDisplayOf(doc);
              return found;
            });
          }
        }
        // 5b local safety copy, 6 delete the original — only when the copy is verified (or already existed)
        if (dryRun) {
          skip(STEPS.safetyCopy, 'dryRun');
          o.onDryRun?.('DeletionBundle', buildDeletionBundle({ sourceId: doc.id }).bundle);
          skip(STEPS.deleteOriginal, 'dryRun');
        } else if (copy) {
          await safetyCopy({ doc, bytes, save, step, skip, entry });
          await deleteOriginal({ doc, step, session, fhir, appendLog, entry, settleMs });
        }
      } else {
        // delete-only: retrieve for the safety copy (when enabled), then the deletion request
        let bytes = null;
        if (save && !dryRun) {
          ({ bytes } = await step(STEPS.retrieve, async () => retrieveDocument({ url: att.url, xua: await session.getXua() })));
          await step(STEPS.verifyHash, async () => {
            const h = await sha1Base64(bytes);
            if (h !== att.hash) throw new ApiError(`hash mismatch (metadata ${att.hash}, retrieved ${h}), not deleting`, { step: 'verifyHash' });
            return h;
          });
        } else {
          skip(STEPS.retrieve, 'deleteOnly');
          skip(STEPS.verifyHash, 'deleteOnly');
        }
        skip(STEPS.upload, 'deleteOnly');
        skip(STEPS.verifyCara, 'deleteOnly');
        if (dryRun) {
          skip(STEPS.safetyCopy, 'dryRun');
          o.onDryRun?.('DeletionBundle', buildDeletionBundle({ sourceId: doc.id }).bundle);
          skip(STEPS.deleteOriginal, 'dryRun');
        } else {
          await safetyCopy({ doc, bytes, save, step, skip, entry });
          await deleteOriginal({ doc, step, session, fhir, appendLog, entry, settleMs });
        }
      }
    } catch (e) {
      entry.error = e.message;
      if (e instanceof ApiError && e.fatal) fatal = e;
    }
    entry.ms = Date.now() - startedAt;
    await appendLog({ ...entry, phase: 'done' });
    results.push(entry);
    onEvent({ type: 'doc-done', index: i, entry });
    if (fatal) break;
  }

  const summary = {
    total: documents.length,
    processed: results.length,
    ok: results.filter(r => !r.error).length,
    failed: results.filter(r => r.error).length,
    stopped,
    fatal: fatal ? fatal.message : null,
  };
  onEvent({ type: 'run-done', summary, results });
  if (fatal) throw new RunAborted(fatal.message, fatal);
  return { summary, results };
}

async function safetyCopy({ doc, bytes, save, step, skip, entry }) {
  if (!save) { skip(STEPS.safetyCopy, 'disabled'); return; }
  await step(STEPS.safetyCopy, async () => {
    const att = attachmentOf(doc);
    const base = backupBaseName(doc);
    const name = await save({ bytes, filename: `${base}.${extensionFor(att.contentType)}`, contentType: att.contentType || 'application/octet-stream' });
    await save({ bytes: new TextEncoder().encode(JSON.stringify(doc, null, 2)), filename: `${base}.metadata.json`, contentType: 'application/json' });
    entry.filename = name;
    return name;
  });
}

async function deleteOriginal({ doc, step, session, fhir, appendLog, entry, settleMs }) {
  await step(STEPS.deleteOriginal, async () => {
    const { bundle } = buildDeletionBundle({ sourceId: doc.id });
    await appendLog({ ...entry, phase: 'before-delete' });
    await requestDeletion({ fhir, xua: await session.getXua(), bundle });
    await sleep(settleMs);
    const status = await getDocumentReferenceStatus({ fhir, xua: await session.getXua(), id: doc.id });
    if (status === 404) return 'gone';
    if (status === 200) return 'deletionRequested';
    return `status ${status}`;
  });
}

/**
 * Backup run: retrieve → verify hash → save (spec §4.6). `save` is injected (chrome.downloads in the panel, fs in Node).
 * @param {object} o
 * @param {(o:{bytes:Uint8Array, filename:string, contentType:string}) => Promise<string>} o.save  returns final local filename
 * @param {(o:{doc:object, ext:string}) => string} o.fileName   base name without extension
 */
export async function runBackup(o) {
  const {
    session, documents, save, fileName, includeMetadata = true,
    onEvent = () => {}, shouldStop = () => false, appendLog = async () => {}, runId = new Date().toISOString(),
  } = o;
  const results = [];
  let stopped = false;
  let fatal = null;
  for (let i = 0; i < documents.length; i++) {
    if (shouldStop()) { stopped = true; break; }
    const doc = documents[i];
    const att = attachmentOf(doc);
    const entry = { ...baseEntry(doc, 'backup', runId, false), filename: null, hashMismatch: false };
    const startedAt = Date.now();
    const { step } = makeStepper(entry, i, onEvent);
    onEvent({ type: 'doc-start', index: i, doc, entry });
    try {
      const { bytes } = await step(STEPS.retrieve, async () => retrieveDocument({ url: att.url, xua: await session.getXua() }));
      await step(STEPS.verifyHash, async () => {
        const h = await sha1Base64(bytes);
        if (h !== att.hash) { entry.hashMismatch = true; return 'mismatch'; }
        return 'ok';
      });
      await step(STEPS.save, async () => {
        const ext = extensionFor(att.contentType);
        const base = fileName({ doc, ext });
        const name = await save({ bytes, filename: `${base}.${ext}`, contentType: att.contentType || 'application/octet-stream' });
        entry.filename = name;
        if (includeMetadata) {
          const meta = new TextEncoder().encode(JSON.stringify(doc, null, 2));
          await save({ bytes: meta, filename: `${base}.metadata.json`, contentType: 'application/json' });
        }
        return name;
      });
    } catch (e) {
      entry.error = e.message;
      if (e instanceof ApiError && e.fatal) fatal = e;
    }
    entry.ms = Date.now() - startedAt;
    await appendLog({ ...entry, phase: 'done' });
    results.push(entry);
    onEvent({ type: 'doc-done', index: i, entry });
    if (fatal) break;
  }
  const summary = { total: documents.length, processed: results.length, ok: results.filter(r => !r.error).length, failed: results.filter(r => r.error).length, stopped, fatal: fatal ? fatal.message : null };
  onEvent({ type: 'run-done', summary, results });
  if (fatal) throw new RunAborted(fatal.message, fatal);
  return { summary, results };
}

export function extensionFor(contentType) {
  const ct = String(contentType ?? '').toLowerCase().split(';')[0].trim();
  if (ct === 'application/pdf') return 'pdf';
  if (ct === 'application/fhir+json' || ct === 'application/json') return 'json';
  if (ct === 'application/fhir+xml' || ct === 'text/xml' || ct === 'application/xml') return 'xml';
  const sub = ct.split('/')[1] ?? 'bin';
  return sub.replace(/\+.*$/, '').replace(/[^a-z0-9]/g, '') || 'bin';
}

export function sanitiseFileName(s, max = 100) {
  const cleaned = String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[ -]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim();
  return (cleaned || 'document').slice(0, max);
}

export function backupBaseName(doc) {
  const att = attachmentOf(doc);
  const date = (att.creation ?? '').slice(0, 10) || 'undated';
  const ext = extensionFor(att.contentType);
  // titles sometimes already end with the file extension ("report.pdf"); avoid "report.pdf.pdf"
  const title = String(att.title ?? '').replace(new RegExp(`\\.${ext}$`, 'i'), '');
  return `${date}_${sanitiseFileName(title || uniqueIdOf(doc) || doc.id)}`;
}
