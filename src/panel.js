// cara-transfer — side panel UI.
import {
  DEFAULTS, ApiError, setFetch, tenantForIdp, fhirBase, decodeJwt, createSession, listDocuments, splitBundle,
  classify, caraHashSet, homeCommunityOf, attachmentOf, authorDisplayOf, checkCompatibility,
} from './api.js';
import { runTransfer, runBackup, backupBaseName, TRANSFER_STEPS, BACKUP_STEPS, STEPS } from './transfer.js';
import { t, setLanguage, mapLanguage, currentLanguage, applyDom, formatDate, formatDateTime, formatSize, formatDuration } from './i18n.js';
import { findPortalTab, readPortalState, writePortalTokens, portalFetch, PortalNotReady } from './portal.js';
import { readLog, appendLog, clearLog } from './log.js';
import { communityInfo } from './communities.js';

const $ = id => document.getElementById(id);

const state = {
  tabId: null,
  portal: null,
  langOverride: null,
  config: { homeCommunityId: DEFAULTS.homeCommunityId, homeCommunityName: DEFAULTS.homeCommunityName, apiBase: DEFAULTS.apiBase, fhir: fhirBase(DEFAULTS.apiBase), tenant: 'realm-pat-swissid' },
  session: null,
  author: null,
  docs: [],
  states: new Map(),
  selected: new Set(),
  showCara: false,
  run: null,
  logOpen: false,
  compat: { ok: true, problems: [] },
};

// Bump when the first-run text changes materially; users must accept again.
const INTRO_VERSION = 1;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === false || v == null) continue;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c != null) e.append(c);
  return e;
}
function show(id) {
  for (const v of ['introView', 'messageView', 'listView', 'progressView']) $(v).hidden = v !== id;
}
function community() { return state.config.homeCommunityName || 'CARA'; }
function showMessage(text) { $('messageText').textContent = text; show('messageView'); }

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  $('reloadBtn').addEventListener('click', () => boot());
  $('langSelect').addEventListener('change', async e => { state.langOverride = e.target.value; await applyLanguage(); });
  $('showCara').addEventListener('change', e => { state.showCara = e.target.checked; renderList(); });
  $('selectAllBtn').addEventListener('click', () => { for (const d of visibleDocs()) if (isSelectable(d)) state.selected.add(d.id); renderList(); });
  $('selectNoneBtn').addEventListener('click', () => { state.selected.clear(); renderList(); });
  $('transferBtn').addEventListener('click', () => startDestructive('transfer'));
  $('deleteBtn').addEventListener('click', () => startDestructive('delete'));
  $('backupBtn').addEventListener('click', () => startBackup());
  $('stopBtn').addEventListener('click', () => { if (state.run) { state.run.stopRequested = true; $('progressStatus').textContent = t('progress.stopping'); $('stopBtn').disabled = true; } });
  $('backBtn').addEventListener('click', () => { state.run = null; boot(); });
  $('downloadLogBtn').addEventListener('click', () => downloadRunLog());
  $('toggleLogBtn').addEventListener('click', () => { state.logOpen = !state.logOpen; renderLog(); });
  $('clearLogBtn').addEventListener('click', async () => {
    const n = (await readLog()).length;
    if (confirm(t('log.clearConfirm', { n }))) { await clearLog(); renderLog(); }
  });
  $('disclaimerAck').addEventListener('change', e => { $('disclaimerConfirm').disabled = !e.target.checked; });
  $('introAck').addEventListener('change', e => { $('introAccept').disabled = !e.target.checked; });
  $('introAccept').addEventListener('click', async () => { await chrome.storage.local.set({ introAccepted: INTRO_VERSION }); await boot(); });
  // All API traffic goes through the portal tab so that requests carry the portal's origin (see portal.js).
  setFetch(portalFetch(() => state.tabId));
  await boot();
}

async function applyLanguage() {
  const portalLang = state.portal?.language ?? state.portal?.navigatorLanguage ?? navigator.language;
  const lang = state.langOverride ?? mapLanguage(portalLang);
  await setLanguage(lang);
  $('langSelect').value = currentLanguage();
  applyDom();
  $('showCaraLabel').textContent = t('list.showCara', { community: community() });
  $('legendText').textContent = t('list.legend', { community: community() });
  $('transferBtn').textContent = t('action.transfer', { community: community() });
  $('communityName').textContent = `${t('header.community')}: ${community()}`;
  if (state.author) $('patientName').textContent = `${t('header.patient')}: ${state.author.given} ${state.author.family}`.trim();
  if (!$('listView').hidden) renderList();
  if (!$('progressView').hidden && state.run) renderProgress();
  renderLog();
}

async function boot() {
  showMessage(t('list.loading'));
  state.selected.clear();
  state.docs = [];
  state.states.clear();
  const { introAccepted } = await chrome.storage.local.get('introAccepted');
  if (introAccepted !== INTRO_VERSION) {
    await applyLanguage();
    $('introAck').checked = false;
    $('introAccept').disabled = true;
    show('introView');
    return;
  }
  const tab = await findPortalTab();
  state.tabId = tab.tabId;
  if (state.tabId == null) {
    state.portal = null;
    await applyLanguage();
    showMessage(t('login.noTab'));
    return;
  }
  try {
    state.portal = await readPortalState(state.tabId);
  } catch (e) {
    state.portal = null;
    await applyLanguage();
    showMessage(e instanceof PortalNotReady ? t('login.reloadPortal') : t('login.tokenError', { error: e.message }));
    return;
  }
  await applyLanguage();
  const p = state.portal ?? {};
  if (!p.refreshToken) { showMessage(t('login.required')); return; }
  if (p.role && p.role !== 'PAT') { showMessage(t('login.roleRefused', { role: p.role })); return; }

  const cfg = p.config ?? {};
  const apiBase = (cfg.apiPhidy ?? DEFAULTS.apiBase).replace(/\/+$/, '');
  const hcRaw = cfg.homeCommunityId ?? DEFAULTS.homeCommunityId;
  state.config = {
    homeCommunityId: hcRaw.startsWith('urn:oid:') ? hcRaw : 'urn:oid:' + hcRaw,
    homeCommunityName: cfg.homeCommunityName ?? DEFAULTS.homeCommunityName,
    apiBase,
    fhir: cfg.apiAphinity ? cfg.apiAphinity.replace(/\/+$/, '') + '/r4' : fhirBase(apiBase),
    tenant: cfg.tenant ?? tenantForIdp(p.selectedIdP),
  };
  const idClaims = decodeJwt(p.idToken) ?? {};
  state.author = { given: idClaims.given_name ?? '', family: idClaims.family_name ?? '' };
  $('patientName').textContent = `${t('header.patient')}: ${state.author.given} ${state.author.family}`.trim();
  $('communityName').textContent = `${t('header.community')}: ${community()}`;

  state.session = createSession({
    tenant: state.config.tenant,
    apiBase: state.config.apiBase,
    homeCommunityId: state.config.homeCommunityId,
    readTokens: async () => {
      const s = await readPortalState(state.tabId);
      return { refreshToken: s?.refreshToken, idToken: s?.idToken };
    },
    writeTokens: async tokens => { await writePortalTokens(state.tabId, tokens); },
  });
  await loadList();
}

async function loadList() {
  showMessage(t('list.loading'));
  try {
    const xua = await state.session.getXua();
    const a = state.session.author;
    if (a) { state.author = a; $('patientName').textContent = `${t('header.patient')}: ${a.given} ${a.family}`.trim(); }
    const bundle = await listDocuments({ fhir: state.config.fhir, xua });
    state.docs = splitBundle(bundle).docs;
    state.compat = checkCompatibility(bundle, { fhir: state.config.fhir });
    $('compatBanner').hidden = state.compat.ok;
    if (!state.compat.ok) $('compatBanner').textContent = t('compat.banner', { problems: state.compat.problems.join(', ') });
    reclassify();
    // default selection: transferable documents
    state.selected.clear();
    for (const d of state.docs) if (state.states.get(d.id) === 'transferable') state.selected.add(d.id);
    show('listView');
    renderList();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) showMessage(t('error.unauthorized'));
    else showMessage(t('error.list', { error: e.message }));
  }
}

function reclassify() {
  const caraHashes = caraHashSet(state.docs, state.config.homeCommunityId);
  state.states.clear();
  for (const d of state.docs) state.states.set(d.id, classify(d, { caraHashes, homeCommunityId: state.config.homeCommunityId }));
  for (const id of [...state.selected]) if (!state.states.has(id)) state.selected.delete(id);
}

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------
function visibleDocs() {
  return state.docs.filter(d => state.showCara || state.states.get(d.id) !== 'native');
}
function isSelectable() { return true; } // backup is possible for every row
function eligible(doc, mode) {
  const s = state.states.get(doc.id);
  if (mode === 'transfer') return s === 'transferable';
  if (mode === 'delete') return s === 'transferable' || s === 'superseded' || s === 'copyExists';
  return true;
}

function renderList() {
  const docs = visibleDocs();
  const counts = { transferable: 0, copyExists: 0, superseded: 0, unsupported: 0, native: 0 };
  for (const d of state.docs) counts[state.states.get(d.id)]++;
  $('summaryLine').textContent = t('list.summary', { ...counts, community: community() });

  const container = $('tableContainer');
  container.replaceChildren();
  $('listEmpty').hidden = docs.length > 0;
  if (!docs.length) $('listEmpty').textContent = state.docs.length ? t('list.empty', { community: community() }) : t('list.emptyAll');

  const groups = new Map();
  for (const d of docs) {
    const hc = homeCommunityOf(d) ?? '?';
    if (!groups.has(hc)) groups.set(hc, []);
    groups.get(hc).push(d);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === state.config.homeCommunityId) - (b === state.config.homeCommunityId) || a.localeCompare(b));
  for (const [hc, list] of ordered) {
    list.sort((a, b) => (attachmentOf(b).creation ?? '').localeCompare(attachmentOf(a).creation ?? ''));
    const info = communityInfo(hc);
    const title = hc === state.config.homeCommunityId ? t('list.communityCara', { community: community() }) : (info.name ? t('list.communityNamed', { name: info.name, oid: info.oid }) : t('list.community', { oid: info.oid }));
    const group = el('div', { class: 'group' }, [el('div', { class: 'group-title', title: info.description ?? '', text: `${title} · ${t('list.count', { n: list.length })}` })]);
    const thead = el('thead', {}, el('tr', {}, [
      el('th'),
      el('th', { text: t('col.title') }),
      el('th', { class: 'nowrap', text: t('col.creation') }),
      el('th', { text: t('col.status') }),
      el('th', { class: 'nowrap', text: t('col.size') }),
      el('th', { text: t('col.state') }),
    ]));
    const tbody = el('tbody');
    for (const d of list) tbody.append(renderRow(d));
    group.append(el('table', {}, [thead, tbody]));
    container.append(group);
  }
  updateSelectionUi();
}

function renderRow(d) {
  const att = attachmentOf(d);
  const s = state.states.get(d.id);
  const cb = el('input', { type: 'checkbox' });
  cb.checked = state.selected.has(d.id);
  cb.addEventListener('change', () => { if (cb.checked) state.selected.add(d.id); else state.selected.delete(d.id); updateSelectionUi(); });
  const typeDisplay = d.type?.coding?.[0]?.display ?? d.type?.coding?.[0]?.code ?? '';
  const ct = (att.contentType ?? '').replace('application/', '');
  const author = authorDisplayOf(d);
  const badgeText = s === 'native' ? t('state.native', { community: community() }) : t('state.' + s);
  return el('tr', { class: s === 'unsupported' ? 'disabled-row' : '' }, [
    el('td', {}, cb),
    el('td', { class: 'title' }, [
      document.createTextNode(att.title ?? ''),
      el('span', { class: 'sub', text: [typeDisplay, ct, author].filter(Boolean).join(' · ') }),
    ]),
    el('td', { class: 'nowrap', text: formatDate(att.creation) }),
    el('td', { text: t('status.' + (d.status ?? 'current')) }),
    el('td', { class: 'nowrap', text: formatSize(att.size) }),
    el('td', {}, el('span', { class: `badge badge-${s}`, title: t('stateHelp.' + s, { community: community(), contentType: att.contentType ?? '' }), text: badgeText })),
  ]);
}

function updateSelectionUi() {
  const n = state.selected.size;
  $('selectedCount').textContent = t('action.selectedCount', { n });
  const sel = [...state.selected].map(id => state.docs.find(d => d.id === id)).filter(Boolean);
  $('transferBtn').disabled = !state.compat.ok || !sel.some(d => eligible(d, 'transfer'));
  $('deleteBtn').disabled = !state.compat.ok || !sel.some(d => eligible(d, 'delete'));
  $('backupBtn').disabled = n === 0;
}

function selectedDocs(mode) {
  const all = [...state.selected].map(id => state.docs.find(d => d.id === id)).filter(Boolean);
  const ok = all.filter(d => eligible(d, mode));
  return { ok, skipped: all.length - ok.length };
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
function openDialog(dialog) {
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

async function startDestructive(mode) {
  const { ok, skipped } = selectedDocs(mode);
  const note = $('actionNote');
  note.hidden = true;
  if (!ok.length) { note.textContent = t('action.nothingSelected'); note.hidden = false; return; }
  if (skipped) { note.textContent = t('action.notEligible', { n: skipped }); note.hidden = false; }
  const dlg = $('disclaimerDialog');
  $('disclaimerText').textContent = t(mode === 'transfer' ? 'disclaimer.transfer' : 'disclaimer.delete', { community: community() });
  $('safetyCopy').checked = true;
  $('safetyCopyLabel').textContent = t('disclaimer.safetyCopy', { folder: t('backup.folder'), date: new Date().toISOString().slice(0, 10) });
  $('disclaimerCount').textContent = t('disclaimer.documents', { n: ok.length });
  $('disclaimerAck').checked = false;
  $('disclaimerConfirm').disabled = true;
  $('disclaimerConfirm').textContent = t(mode === 'transfer' ? 'disclaimer.confirmTransfer' : 'disclaimer.confirmDelete');
  dlg.returnValue = 'cancel';
  const confirmed = await openDialog(dlg);
  if (!confirmed || !$('disclaimerAck').checked) return;
  await executeRun({ mode, documents: ok, safetyCopy: $('safetyCopy').checked, date: new Date().toISOString().slice(0, 10) });
}

async function startBackup() {
  const { ok } = selectedDocs('backup');
  if (!ok.length) { $('actionNote').textContent = t('action.nothingSelected'); $('actionNote').hidden = false; return; }
  const dlg = $('backupDialog');
  const date = new Date().toISOString().slice(0, 10);
  $('backupNote').textContent = t('backup.note', { folder: t('backup.folder'), date });
  $('backupCount').textContent = t('disclaimer.documents', { n: ok.length });
  dlg.returnValue = 'cancel';
  const confirmed = await openDialog(dlg);
  if (!confirmed) return;
  await executeRun({ mode: 'backup', documents: ok, includeMetadata: $('backupMeta').checked, date });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------
async function executeRun({ mode, documents, includeMetadata = true, date, safetyCopy = false }) {
  const run = {
    id: new Date().toISOString(),
    mode,
    startedAt: Date.now(),
    stopRequested: false,
    rows: documents.map(d => ({ doc: d, steps: {}, error: null, entry: null, startedAt: null, ms: null })),
    summary: null,
    results: [],
    fatal: null,
    steps: mode === 'backup' ? BACKUP_STEPS : TRANSFER_STEPS,
  };
  state.run = run;
  show('progressView');
  $('stopBtn').disabled = false;
  $('stopBtn').hidden = false;
  $('backBtn').hidden = true;
  $('downloadLogBtn').hidden = true;
  $('progressSummary').hidden = true;
  $('progressStatus').textContent = t('progress.running');
  renderProgress();
  const timer = setInterval(renderProgressStatus, 1000);

  const onEvent = ev => {
    if (ev.type === 'doc-start') { run.rows[ev.index].startedAt = Date.now(); }
    else if (ev.type === 'step') { run.rows[ev.index].steps[ev.step] = { status: ev.status, detail: ev.detail, error: ev.error }; }
    else if (ev.type === 'doc-done') { const r = run.rows[ev.index]; r.entry = ev.entry; r.error = ev.entry.error; r.ms = ev.entry.ms; }
    else if (ev.type === 'run-done') { run.summary = ev.summary; run.results = ev.results; }
    renderProgress();
  };
  const common = { session: state.session, documents, onEvent, shouldStop: () => run.stopRequested, appendLog, runId: run.id };
  try {
    if (mode === 'backup') {
      const folder = `${t('backup.folder')}/${date}`;
      await runBackup({ ...common, includeMetadata, fileName: ({ doc }) => backupBaseName(doc), save: o => saveViaDownloads({ ...o, folder }) });
    } else {
      const folder = `${t('backup.folder')}/${date}`;
      await runTransfer({ ...common, mode, fhir: state.config.fhir, homeCommunityId: state.config.homeCommunityId, save: safetyCopy ? o => saveViaDownloads({ ...o, folder }) : null });
    }
  } catch (e) {
    run.fatal = e.cause?.status === 401 ? t('error.unauthorized') : (e.cause?.status >= 500 ? t('error.server', { status: e.cause.status }) : e.message);
  } finally {
    clearInterval(timer);
    run.finishedAt = Date.now();
    $('stopBtn').hidden = true;
    $('backBtn').hidden = false;
    $('downloadLogBtn').hidden = false;
    renderProgress();
    renderLog();
  }
}

function renderProgressStatus() {
  const run = state.run;
  if (!run) return;
  const elapsed = (run.finishedAt ?? Date.now()) - run.startedAt;
  const s = run.summary;
  const parts = [];
  if (run.finishedAt) parts.push(t('progress.done'));
  else parts.push(run.stopRequested ? t('progress.stopping') : t('progress.running'));
  parts.push(t('progress.elapsed', { t: formatDuration(elapsed) }));
  $('progressStatus').textContent = parts.join(' · ');
  if (s) {
    const lines = [t('progress.summary', { ok: s.ok, failed: s.failed, processed: s.processed, total: s.total })];
    if (s.stopped) lines.push(t('progress.stopped'));
    if (run.fatal) lines.push(t('progress.fatal', { error: run.fatal }));
    $('progressSummary').textContent = lines.join(' ');
    $('progressSummary').hidden = false;
  }
}

function renderProgress() {
  const run = state.run;
  if (!run) return;
  renderProgressStatus();
  const rows = $('progressRows');
  rows.replaceChildren();
  for (const r of run.rows) {
    const att = attachmentOf(r.doc);
    const steps = el('div', { class: 'prow-steps' });
    for (const name of run.steps) {
      const st = r.steps[name];
      const status = st?.status ?? 'pending';
      const label = name === STEPS.verifyCara ? t('step.verifyCara', { community: community() }) : t('step.' + name);
      let detail = '';
      if (st?.detail && typeof st.detail === 'string' && ['copyExists', 'deleteOnly', 'dryRun', 'gone', 'deletionRequested', 'mismatch'].includes(st.detail)) detail = t('stepDetail.' + st.detail);
      steps.append(el('span', { class: `step step-${status}`, title: st?.error ?? '' , text: `${label}: ${detail || t('stepStatus.' + status)}` }));
    }
    const meta = [];
    if (r.ms != null) meta.push(formatDuration(r.ms));
    if (r.entry?.filename) meta.push(r.entry.filename);
    if (r.entry?.newMasterIdentifier && !r.error) meta.push(r.entry.newMasterIdentifier);
    if (r.entry?.copyAuthor != null) meta.push(`${t(r.entry.authorKept ? 'stepDetail.authorKept' : 'stepDetail.authorPatient')}: ${r.entry.copyAuthor}`);
    rows.append(el('div', { class: 'prow' }, [
      el('div', { class: 'prow-title', text: att.title ?? r.doc.id }),
      steps,
      r.error ? el('div', { class: 'prow-error', text: t('error.generic', { error: r.error }) }) : null,
      meta.length ? el('div', { class: 'prow-meta', text: meta.join(' · ') }) : null,
    ]));
  }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
function download({ blob, filename, saveAs = false }) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' }, downloadId => {
      if (chrome.runtime.lastError || downloadId == null) {
        URL.revokeObjectURL(url);
        return reject(new Error(chrome.runtime.lastError?.message ?? 'download failed'));
      }
      let settled = false;
      const finish = (state, error) => {
        if (settled) return;
        settled = true;
        chrome.downloads.onChanged.removeListener(listener);
        URL.revokeObjectURL(url);
        if (state === 'complete') chrome.downloads.search({ id: downloadId }, items => resolve(items?.[0]?.filename ?? filename));
        else reject(new Error(error ?? 'download interrupted'));
      };
      const listener = delta => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') finish(delta.state.current, delta.error?.current);
      };
      chrome.downloads.onChanged.addListener(listener);
      // Small files can complete before the listener is attached; check the current state once.
      chrome.downloads.search({ id: downloadId }, items => {
        const it = items?.[0];
        if (it && (it.state === 'complete' || it.state === 'interrupted')) finish(it.state, it.error);
      });
    });
  });
}

async function saveViaDownloads({ bytes, filename, contentType, folder }) {
  const blob = new Blob([bytes], { type: contentType });
  const resolved = await download({ blob, filename: `${folder}/${filename}` });
  const base = resolved.split(/[\\/]/).pop();
  // Chrome reports the final on-disk name (uniquified on conflict); keep it when it still looks like ours
  return base.startsWith(filename.slice(0, 10)) ? base : filename;
}

async function downloadRunLog() {
  const run = state.run;
  if (!run) return;
  const payload = { runId: run.id, mode: run.mode, startedAt: new Date(run.startedAt).toISOString(), finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null, summary: run.summary, fatal: run.fatal, results: run.results };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  try {
    await download({ blob, filename: `cara-transfer-log_${run.id.replace(/[:.]/g, '-')}.json`, saveAs: true });
  } catch (e) {
    $('progressSummary').textContent += ' ' + t('error.download', { error: e.message });
  }
}

// ---------------------------------------------------------------------------
// Log view
// ---------------------------------------------------------------------------
async function renderLog() {
  const log = await readLog();
  $('logCount').textContent = t('log.entries', { n: log.length });
  $('toggleLogBtn').textContent = state.logOpen ? t('log.hide') : t('log.show');
  $('clearLogBtn').disabled = log.length === 0;
  const box = $('logEntries');
  box.hidden = !state.logOpen;
  if (!state.logOpen) return;
  box.replaceChildren();
  if (!log.length) { box.append(el('div', { class: 'muted', text: t('log.empty') })); return; }
  for (const e of [...log].reverse().slice(0, 200)) {
    const steps = (e.steps ?? []).map(s => `${s.step}:${s.status}`).join(' ');
    box.append(el('div', { class: 'log-entry' }, [
      el('div', { text: `${formatDateTime(e.when)} · ${e.mode}${e.dryRun ? ' (dry run)' : ''} · ${e.title}` }),
      el('div', { class: 'muted', text: [steps, e.newMasterIdentifier, e.filename].filter(Boolean).join(' · ') }),
      e.error ? el('div', { class: 'err', text: e.error }) : null,
    ]));
  }
}

init().catch(e => showMessage(t('error.generic', { error: e.message })));
