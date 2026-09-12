// cara-transfer — local transfer log in chrome.storage.local (key "transferLog").
// Entries contain document titles and identifiers, never tokens or document content.
const KEY = 'transferLog';
const MAX = 2000;

export async function readLog() {
  const r = await chrome.storage.local.get(KEY);
  return Array.isArray(r[KEY]) ? r[KEY] : [];
}

/** Append or replace (same runId + sourceId → the later phase replaces the earlier one). */
export async function appendLog(entry) {
  const log = await readLog();
  const clean = JSON.parse(JSON.stringify(entry));
  const idx = entry.runId ? log.findIndex(e => e.runId === entry.runId && e.sourceId === entry.sourceId) : -1;
  if (idx >= 0) log[idx] = clean; else log.push(clean);
  while (log.length > MAX) log.shift();
  await chrome.storage.local.set({ [KEY]: log });
}

export async function clearLog() {
  await chrome.storage.local.remove(KEY);
}
