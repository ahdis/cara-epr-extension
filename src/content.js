// cara-transfer — content script on https://patient.cara.ch/*.
// Only reads and writes the portal's own localStorage keys and reads its runtime config.
// It never logs token values and never sends anything to the network.
(() => {
  const KEYS = {
    accessToken: 'phellow:oauth2:accessToken',
    refreshToken: 'phellow:oauth2:refreshToken',
    idToken: 'phellow:oauth2:idToken',
    tokenType: 'phellow:oauth2:accessToken:type',
    expiresAt: 'phellow:oauth2:accessToken:expiresAt',
    selectedIdP: 'phellow:state:selectedIdP',
    language: 'phellow:language',
    role: 'phellow:state:role',
  };

  function readConfig() {
    try {
      const el = document.querySelector('[data-content]');
      if (el) {
        const parsed = JSON.parse(el.getAttribute('data-content'));
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch { /* ignore */ }
    return null;
  }

  // The user-facing community name ("CARA") lives in VUE_APP_I18N_OVERRIDE[<lang>].community.name; VUE_APP_HOME_COMMUNITY_NAME is the internal name ("emedo").
  function communityDisplayName(cfg) {
    try {
      const o = JSON.parse(cfg.VUE_APP_I18N_OVERRIDE ?? '{}');
      for (const k of Object.keys(o)) { const n = o[k]?.community?.name; if (n) return String(n); }
    } catch { /* ignore */ }
    return null;
  }

  function getState() {
    const ls = k => { try { return localStorage.getItem(k); } catch { return null; } };
    const cfg = readConfig() ?? {};
    const pickCfg = (...names) => { for (const n of names) if (cfg[n] != null && cfg[n] !== '') return String(cfg[n]); return null; };
    return {
      refreshToken: ls(KEYS.refreshToken),
      idToken: ls(KEYS.idToken),
      accessToken: ls(KEYS.accessToken),
      expiresAt: ls(KEYS.expiresAt),
      selectedIdP: ls(KEYS.selectedIdP),
      language: ls(KEYS.language) ?? document.documentElement.lang ?? null,
      role: ls(KEYS.role),
      navigatorLanguage: navigator.language,
      config: {
        homeCommunityId: pickCfg('VUE_APP_HOME_COMMUNITY_ID'),
        homeCommunityName: communityDisplayName(cfg) ?? pickCfg('VUE_APP_HOME_COMMUNITY_NAME'),
        tenant: pickCfg('VUE_APP_OAUTH2_' + String(ls(KEYS.selectedIdP) ?? '').toUpperCase() + '_TENANT'),
        apiPhidy: pickCfg('VUE_APP_API_PHIDY'),
        apiAphinity: pickCfg('VUE_APP_API_APHINITY'),
        clientId: pickCfg('VUE_APP_OAUTH_CLIENT_ID', 'VUE_APP_CLIENT_ID'),
        documentMaxSize: pickCfg('VUE_APP_DOCUMENT_MAX_SIZE'),
        configFound: Object.keys(cfg).length > 0,
      },
      url: location.href,
    };
  }

  function setTokens(t) {
    try {
      if (t.accessToken) localStorage.setItem(KEYS.accessToken, t.accessToken);
      if (t.refreshToken) localStorage.setItem(KEYS.refreshToken, t.refreshToken);
      if (t.idToken) localStorage.setItem(KEYS.idToken, t.idToken);
      if (t.expiresAt) localStorage.setItem(KEYS.expiresAt, t.expiresAt);
      if (t.tokenType) localStorage.setItem(KEYS.tokenType, t.tokenType);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // --- fetch relay: performs the request with the page's origin (https://patient.cara.ch) -------------
  const b64ToBytes = b64 => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  const bytesToB64 = bytes => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };

  async function relayFetch(req) {
    let body;
    if (req.body?.kind === 'text') body = req.body.text;
    else if (req.body?.kind === 'form') {
      body = new FormData();
      for (const part of req.body.parts) body.append(part.name, new Blob([part.base64 != null ? b64ToBytes(part.base64) : part.text], { type: part.type }));
    }
    const r = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers ?? {}, body, credentials: 'omit' });
    const headers = {};
    for (const [k, v] of r.headers) headers[k] = v;
    return { status: r.status, headers, base64: bytesToB64(new Uint8Array(await r.arrayBuffer())) };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'cara:getState') { sendResponse(getState()); return false; }
    if (msg?.type === 'cara:setTokens') { sendResponse(setTokens(msg.tokens ?? {})); return false; }
    if (msg?.type === 'cara:fetch') {
      relayFetch(msg.request).then(sendResponse, e => sendResponse({ error: e.message }));
      return true; // async
    }
    return false;
  });
})();
