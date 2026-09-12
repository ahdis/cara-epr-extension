// cara-transfer — panel-side bridge to the portal tab (localStorage, config and all HTTP requests).
// Everything goes through the content script; there is deliberately no scripting fallback
// (fewer permissions). A portal tab without the content script must be reloaded by the user.

export async function findPortalTab() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'cara:findPortalTab' });
    if (r?.tabId != null) return r;
  } catch { /* service worker unavailable */ }
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: 'https://patient.cara.ch/*' });
    if (active) return { tabId: active.id, url: active.url };
    const all = await chrome.tabs.query({ url: 'https://patient.cara.ch/*' });
    if (all.length) return { tabId: all[0].id, url: all[0].url };
  } catch { /* ignore */ }
  return { tabId: null };
}

async function viaContentScript(tabId, msg) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, msg);
    if (r !== undefined) return r;
  } catch { /* no receiver in that tab */ }
  return undefined;
}

export class PortalNotReady extends Error {
  constructor() { super('portal tab does not answer (content script not loaded)'); this.name = 'PortalNotReady'; }
}

// The portal tab must run the content script (injected on page load). A tab that was open before the
// extension was installed or updated answers nothing → PortalNotReady → the panel asks for a page reload.
export async function readPortalState(tabId) {
  const r = await viaContentScript(tabId, { type: 'cara:getState' });
  if (!r) throw new PortalNotReady();
  return r;
}

export async function writePortalTokens(tabId, tokens) {
  const r = await viaContentScript(tabId, { type: 'cara:setTokens', tokens });
  if (!r) throw new PortalNotReady();
  return r;
}

// ---------------------------------------------------------------------------
// fetch through the portal tab (page origin). The FHIR facade rejects POSTs from
// the extension origin with 403 "Invalid CORS request".
// ---------------------------------------------------------------------------
const b64ToBytes = b64 => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const bytesToB64 = bytes => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };

async function serialiseBody(body) {
  if (body == null) return null;
  if (typeof body === 'string') return { kind: 'text', text: body };
  if (body instanceof URLSearchParams) return { kind: 'text', text: body.toString() };
  if (body instanceof FormData) {
    const parts = [];
    for (const [name, value] of body) {
      if (value instanceof Blob) parts.push({ name, type: value.type, base64: bytesToB64(new Uint8Array(await value.arrayBuffer())) });
      else parts.push({ name, type: 'text/plain', text: String(value) });
    }
    return { kind: 'form', parts };
  }
  if (body instanceof Blob) return { kind: 'text', text: await body.text() };
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { kind: 'text', text: new TextDecoder().decode(body) };
  throw new Error('unsupported body type');
}

/** Returns a fetch-compatible function that executes requests inside the portal tab. */
export function portalFetch(getTabId) {
  return async (url, init = {}) => {
    const tabId = getTabId();
    if (tabId == null) throw new TypeError('no portal tab');
    const request = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: await serialiseBody(init.body) };
    const res = await viaContentScript(tabId, { type: 'cara:fetch', request });
    if (!res) throw new PortalNotReady();
    if (res.error) throw new TypeError(res.error);
    return new Response(b64ToBytes(res.base64), { status: res.status, headers: res.headers });
  };
}
