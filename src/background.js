// cara-transfer — service worker: opens the side panel on toolbar click (popup window as fallback).
const PORTAL = 'https://patient.cara.ch/';

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.action.onClicked.addListener(async tab => {
  // With openPanelOnActionClick the side panel opens by itself; this listener only serves the fallback.
  if (chrome.sidePanel?.open) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    } catch { /* fall through to popup window */ }
  }
  await chrome.windows.create({ url: chrome.runtime.getURL('src/panel.html'), type: 'popup', width: 520, height: 820 });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'cara:findPortalTab') {
    (async () => {
      try {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: PORTAL + '*' });
        if (active) return sendResponse({ tabId: active.id, url: active.url });
        const all = await chrome.tabs.query({ url: PORTAL + '*' });
        if (all.length) return sendResponse({ tabId: all[0].id, url: all[0].url });
        sendResponse({ tabId: null });
      } catch (e) {
        sendResponse({ tabId: null, error: e.message });
      }
    })();
    return true;
  }
  return false;
});
