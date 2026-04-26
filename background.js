// background.js — TTS 消息路由,WS 由豆包 tab 代理(Cookie 自动携带)

// ── 工具栏图标:动态绘制 "TTS" ────────────────────
function makeTtsIcon(size) {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  const r = size * 0.22;
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#f39c12';
  ctx.font = `bold ${Math.round(size * 0.42)}px -apple-system, "Helvetica Neue", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('TTS', size / 2, size / 2 + size * 0.04);
  return ctx.getImageData(0, 0, size, size);
}

function applyTtsIcon() {
  try {
    chrome.action.setIcon({
      imageData: {
        16: makeTtsIcon(16),
        32: makeTtsIcon(32),
        48: makeTtsIcon(48),
        128: makeTtsIcon(128)
      }
    });
  } catch (e) {
    console.error('[TTS icon] setIcon failed', e);
  }
}

chrome.runtime.onInstalled.addListener(applyTtsIcon);
chrome.runtime.onStartup.addListener(applyTtsIcon);

async function getDoubaoTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://www.doubao.com/*' }, (tabs) => {
      resolve(tabs.length > 0 ? tabs[0] : null);
    });
  });
}

// callerTabId → doubaoTabId
const proxyMap = {};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const callerTabId = sender.tab?.id;

  if (msg.type === 'CHECK_LOGIN') {
    chrome.cookies.getAll({ domain: 'doubao.com' }, (cookies) => {
      sendResponse({ loggedIn: cookies.some(c => c.name === 'sessionid_ss') });
    });
    return true;
  }

  if (msg.type === 'TTS_OPEN') {
    getDoubaoTab().then((doubaoTab) => {
      if (!doubaoTab) {
        chrome.tabs.sendMessage(callerTabId, { type: 'TTS_EVENT', event: 'no_doubao_tab' });
        return;
      }
      proxyMap[callerTabId] = doubaoTab.id;
      chrome.tabs.sendMessage(doubaoTab.id, { type: 'PROXY_TTS_OPEN', callerTabId });
    });
    return false;
  }

  if (msg.type === 'TTS_SEND_TEXT') {
    const doubaoTabId = proxyMap[callerTabId];
    if (doubaoTabId) {
      chrome.tabs.sendMessage(doubaoTabId, {
        type: 'PROXY_TTS_SEND_TEXT',
        callerTabId,
        text: msg.text
      });
    }
    return false;
  }

  if (msg.type === 'TTS_FINISH') {
    const doubaoTabId = proxyMap[callerTabId];
    if (doubaoTabId) {
      chrome.tabs.sendMessage(doubaoTabId, { type: 'PROXY_TTS_FINISH', callerTabId });
    }
    return false;
  }

  if (msg.type === 'TTS_CLOSE') {
    const doubaoTabId = proxyMap[callerTabId];
    if (doubaoTabId) {
      chrome.tabs.sendMessage(doubaoTabId, { type: 'PROXY_TTS_CLOSE', callerTabId });
      delete proxyMap[callerTabId];
    }
    return false;
  }

  // 豆包 tab 回传事件给 caller
  if (msg.type === 'PROXY_TTS_EVENT') {
    chrome.tabs.sendMessage(msg.callerTabId, {
      type: 'TTS_EVENT',
      event: msg.event,
      data: msg.data,
      code: msg.code
    });
    return false;
  }

  if (msg.type === 'OPEN_DOUBAO') {
    chrome.tabs.create({ url: 'https://www.doubao.com' });
  }
});

chrome.action.onClicked.addListener((tab) => {
  ensureDoubaoTab().then(() => {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  });
});

async function ensureDoubaoTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://www.doubao.com/*' }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'PING' }, (res) => {
          if (chrome.runtime.lastError || !res) {
            waitForTabLoad(tabs[0].id, resolve);
            chrome.tabs.reload(tabs[0].id);
          } else {
            resolve();
          }
        });
      } else {
        chrome.tabs.create({ url: 'https://www.doubao.com', active: false }, (newTab) => {
          waitForTabLoad(newTab.id, resolve);
        });
      }
    });
  });
}

function waitForTabLoad(tabId, callback) {
  const listener = (id, info) => {
    if (id === tabId && info.status === 'complete') {
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(callback, 500);
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
}
