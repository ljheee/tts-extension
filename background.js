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

chrome.runtime.onInstalled.addListener(() => {
  applyTtsIcon();
  chrome.contextMenus.create({
    id: 'tts-play-from-here',
    title: '从此处开始播放',
    contexts: ['selection']
  });
});
chrome.runtime.onStartup.addListener(applyTtsIcon);

// 右键"从此处开始播放":转发给页面,由 content script 取选区位置续播。
// selectionText 在点击瞬间捕获(此时选区一定存在),随消息带给页面做兜底定位——
// 预览插件可能在 ensureDoubaoTab 的延迟里重渲染页面,把活选区销毁
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'tts-play-from-here' || !tab?.id) return;
  const selectionText = info.selectionText || '';
  ensureDoubaoTab().then(() => {
    chrome.tabs.sendMessage(tab.id, { type: 'PLAY_FROM_SELECTION', selectionText });
  });
});

async function getDoubaoTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://www.doubao.com/*' }, (tabs) => {
      resolve(tabs.length > 0 ? tabs[0] : null);
    });
  });
}

// callerTabId → { tabId: doubaoTabId, sessionId }
// SW 会被 Chrome 休眠杀掉(30s 无消息),内存态会丢;持久化到 storage.session,
// SW 被消息唤醒后先恢复,保证长会话中 TTS_SEND_TEXT/FINISH 不静默丢失
const proxyMap = {};
const proxyMapReady = chrome.storage.session.get('proxyMap').then(({ proxyMap: saved }) => {
  if (saved) Object.assign(proxyMap, saved);
}).catch(() => {});

function persistProxyMap() {
  chrome.storage.session.set({ proxyMap }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const callerTabId = sender.tab?.id;

  if (msg.type === 'CHECK_LOGIN') {
    chrome.cookies.getAll({ domain: 'doubao.com' }, (cookies) => {
      sendResponse({ loggedIn: cookies.some(c => c.name === 'sessionid_ss') });
    });
    return true;
  }

  if (msg.type === 'TTS_OPEN') {
    // 用 ensureDoubaoTab 而非 getDoubaoTab:豆包页孤儿化(扩展重载未刷新)时
    // PING 失败会自动 reload,避免 PROXY_TTS_OPEN 发进死页面、会话永远等不到 open
    proxyMapReady.then(() => ensureDoubaoTab()).then(() => getDoubaoTab()).then((doubaoTab) => {
      if (!doubaoTab) {
        chrome.tabs.sendMessage(callerTabId, { type: 'TTS_EVENT', event: 'no_doubao_tab', sessionId: msg.sessionId });
        return;
      }
      proxyMap[callerTabId] = { tabId: doubaoTab.id, sessionId: msg.sessionId };
      persistProxyMap();
      chrome.tabs.sendMessage(doubaoTab.id, { type: 'PROXY_TTS_OPEN', callerTabId, sessionId: msg.sessionId, rate: msg.rate });
    });
    return false;
  }

  if (msg.type === 'TTS_SEND_TEXT') {
    proxyMapReady.then(() => {
      const entry = proxyMap[callerTabId];
      if (entry && entry.sessionId === msg.sessionId) {
        chrome.tabs.sendMessage(entry.tabId, {
          type: 'PROXY_TTS_SEND_TEXT',
          callerTabId,
          sessionId: msg.sessionId,
          text: msg.text
        });
      }
    });
    return false;
  }

  if (msg.type === 'TTS_FINISH') {
    proxyMapReady.then(() => {
      const entry = proxyMap[callerTabId];
      if (entry && entry.sessionId === msg.sessionId) {
        chrome.tabs.sendMessage(entry.tabId, { type: 'PROXY_TTS_FINISH', callerTabId, sessionId: msg.sessionId });
      }
    });
    return false;
  }

  if (msg.type === 'TTS_CLOSE') {
    proxyMapReady.then(() => {
      const entry = proxyMap[callerTabId];
      if (entry && entry.sessionId === msg.sessionId) {
        chrome.tabs.sendMessage(entry.tabId, { type: 'PROXY_TTS_CLOSE', callerTabId, sessionId: msg.sessionId });
        delete proxyMap[callerTabId];
        persistProxyMap();
      }
    });
    return false;
  }

  // 豆包 tab 回传事件给 caller(sessionId 透传,caller 侧做代际过滤)
  if (msg.type === 'PROXY_TTS_EVENT') {
    chrome.tabs.sendMessage(msg.callerTabId, {
      type: 'TTS_EVENT',
      event: msg.event,
      data: msg.data,
      code: msg.code,
      sessionId: msg.sessionId
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

// 朗读页被关闭时,主动断掉对应的代理 WS,避免孤儿会话挂死在豆包 tab;
// 豆包 tab 被关闭时,通知所有 caller 异常断开,避免静默卡死
chrome.tabs.onRemoved.addListener((tabId) => {
  proxyMapReady.then(() => {
    const entry = proxyMap[tabId];
    if (entry) {
      chrome.tabs.sendMessage(entry.tabId, { type: 'PROXY_TTS_CLOSE', callerTabId: tabId, sessionId: entry.sessionId });
      delete proxyMap[tabId];
    }
    for (const [callerId, e] of Object.entries(proxyMap)) {
      if (e.tabId === tabId) {
        chrome.tabs.sendMessage(Number(callerId), { type: 'TTS_EVENT', event: 'close', code: 1006, sessionId: e.sessionId });
        delete proxyMap[callerId];
      }
    }
    persistProxyMap();
  });
});

// 豆包 tab 刷新/跳转:旧代理随页面销毁但不会有 close 回传,
// 主动通知 caller 断连(触发自动续连),否则发送被静默丢弃、句子永久丢失
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  proxyMapReady.then(() => {
    let changed = false;
    for (const [callerId, e] of Object.entries(proxyMap)) {
      if (e.tabId === tabId) {
        chrome.tabs.sendMessage(Number(callerId), { type: 'TTS_EVENT', event: 'close', code: 1006, sessionId: e.sessionId });
        delete proxyMap[callerId];
        changed = true;
      }
    }
    if (changed) persistProxyMap();
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
