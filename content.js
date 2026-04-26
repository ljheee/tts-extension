// content.js — 双角色:非豆包页注入朗读浮窗;豆包页做 WS 代理

// ── 通用工具 ──────────────────────────────────────
const IS_DOUBAO = location.hostname.endsWith('doubao.com');

function setStatus(msg, color) {
  const el = document.getElementById('tts-ext-status');
  if (el) { el.textContent = msg; el.style.color = color || '#555'; }
}

// ── 非豆包页:朗读浮窗 ────────────────────────────
let currentChunks = [];
let audioCtx = null;
let nextStartTime = 0;
let activeSources = [];
let isReading = false;
let isPaused = false;
let wsClosed = false;
let segmentTotal = 0;
let segmentSent = 0;
let sentenceCount = 0;

function injectPanel() {
  if (document.getElementById('tts-ext-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'tts-ext-panel';
  panel.style.cssText = `
    position:fixed; bottom:24px; right:24px; z-index:2147483647;
    background:#1a1a1a; border:1px solid #333; border-radius:16px;
    padding:16px; width:280px; box-shadow:0 8px 32px rgba(0,0,0,0.6);
    font-family:-apple-system,sans-serif; color:#e0e0e0;
  `;
  panel.innerHTML = `
    <div id="tts-drag" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;cursor:move;user-select:none">
      <span style="font-size:12px;color:#666">⠿ 豆包 TTS</span>
      <span id="tts-close" style="cursor:pointer;color:#555;font-size:18px;line-height:1">×</span>
    </div>
    <button id="tts-btn" style="
      width:100%; height:52px; border-radius:12px; border:none;
      background:#2a2a2a; color:#aaa; font-size:14px; cursor:pointer;
      transition:all 0.15s; outline:none;
    ">▶ 朗读本页</button>
    <button id="tts-stop" style="
      display:none; width:100%; height:36px; margin-top:8px;
      border-radius:10px; border:1px solid #444; background:transparent;
      color:#888; font-size:12px; cursor:pointer; outline:none;
    ">■ 停止</button>
    <div id="tts-ext-status" style="margin-top:10px;font-size:11px;color:#555;text-align:center">就绪</div>
    <div id="tts-ext-progress" style="margin-top:6px;font-size:11px;color:#555;text-align:center"></div>
  `;
  document.body.appendChild(panel);
  document.getElementById('tts-btn').addEventListener('click', toggleRead);
  document.getElementById('tts-stop').addEventListener('click', stopRead);
  document.getElementById('tts-close').addEventListener('click', () => {
    stopRead();
    panel.remove();
  });
  initDrag();
}

function initDrag() {
  const panelEl = document.getElementById('tts-ext-panel');
  const handle = document.getElementById('tts-drag');
  let dragging = false, ox = 0, oy = 0;
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    const rect = panelEl.getBoundingClientRect();
    ox = e.clientX - rect.left; oy = e.clientY - rect.top;
    panelEl.style.left = rect.left + 'px';
    panelEl.style.top = rect.top + 'px';
    panelEl.style.right = 'auto';
    panelEl.style.bottom = 'auto';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panelEl.style.left = (e.clientX - ox) + 'px';
    panelEl.style.top = (e.clientY - oy) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

// ── 文本提取与分段 ────────────────────────────────
function extractPageText() {
  const raw = (document.body.innerText || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return raw.length > 5000 ? raw.slice(0, 5000) : raw;
}

function segmentText(text) {
  const segs = text.match(/[^。!?！？\n]+[。!?！？\n]?/g) || [text];
  return segs.map(s => s.trim()).filter(Boolean);
}

// ── 朗读流程 ─────────────────────────────────────
function toggleRead() {
  if (!isReading) startRead();
  else if (isPaused) resumeRead();
  else pauseRead();
}

function pauseRead() {
  if (!audioCtx || audioCtx.state === 'closed') return;
  audioCtx.suspend().then(() => {
    isPaused = true;
    setBtn('▶ 继续');
    setStatus('已暂停', '#f39c12');
  }).catch(() => {});
}

function resumeRead() {
  if (!audioCtx || audioCtx.state === 'closed') return;
  audioCtx.resume().then(() => {
    isPaused = false;
    setBtn('⏸ 暂停', '#2c3e50');
    setStatus('继续播放', '#27ae60');
  }).catch(() => {});
}

function setStopVisible(visible) {
  const btn = document.getElementById('tts-stop');
  if (btn) btn.style.display = visible ? 'block' : 'none';
}

function setBtn(label, color) {
  const btn = document.getElementById('tts-btn');
  if (btn) {
    btn.textContent = label;
    if (color) { btn.style.background = color; btn.style.color = '#fff'; }
    else { btn.style.background = '#2a2a2a'; btn.style.color = '#aaa'; }
  }
}

function startRead() {
  const text = extractPageText();
  if (!text) { setStatus('页面无文本', '#e74c3c'); return; }
  const segs = segmentText(text);
  if (!segs.length) { setStatus('分段失败', '#e74c3c'); return; }

  isReading = true;
  isPaused = false;
  wsClosed = false;
  currentChunks = [];
  activeSources = [];
  sentenceCount = 0;
  segmentTotal = segs.length;
  segmentSent = 0;

  // AudioContext 必须在 user gesture 内创建/恢复才能播
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  nextStartTime = audioCtx.currentTime;

  setBtn('⏸ 暂停', '#2c3e50');
  setStopVisible(true);
  setStatus(`连接中... (${segs.length} 段)`, '#f39c12');
  document.getElementById('tts-ext-progress').textContent = '';

  pendingSegments = segs;
  chrome.runtime.sendMessage({ type: 'TTS_OPEN' });
}

let pendingSegments = [];

function flushSegments() {
  // WS open 后,逐段发送,中间留 30ms 间隔便于服务端流式接收
  let i = 0;
  const tick = () => {
    if (!isReading) return;
    if (i >= pendingSegments.length) {
      chrome.runtime.sendMessage({ type: 'TTS_FINISH' });
      setStatus(`已发送 ${pendingSegments.length} 段,等待合成...`, '#3498db');
      return;
    }
    const seg = pendingSegments[i++];
    segmentSent = i;
    chrome.runtime.sendMessage({ type: 'TTS_SEND_TEXT', text: seg });
    document.getElementById('tts-ext-progress').textContent = `发送 ${i}/${segmentTotal}`;
    setTimeout(tick, 30);
  };
  tick();
}

function stopRead() {
  isReading = false;
  isPaused = false;
  pendingSegments = [];
  currentChunks = [];
  activeSources.forEach(s => { try { s.stop(); } catch (e) {} });
  activeSources = [];
  if (audioCtx) {
    try { audioCtx.close(); } catch (e) {}
    audioCtx = null;
  }
  nextStartTime = 0;
  chrome.runtime.sendMessage({ type: 'TTS_CLOSE' });
  setBtn('▶ 朗读本页');
  setStopVisible(false);
  setStatus('已停止', '#555');
  document.getElementById('tts-ext-progress').textContent = '';
}

// ── 音频调度播放(AudioContext 时间轴,无缝拼接)─────
async function flushCurrentSentence() {
  if (currentChunks.length === 0) return;
  const chunks = currentChunks;
  currentChunks = [];
  sentenceCount++;

  if (!audioCtx || audioCtx.state === 'closed') return;
  if (audioCtx.state === 'suspended' && !isPaused) {
    try { await audioCtx.resume(); } catch (e) {}
  }

  const blob = new Blob(chunks.map(a => new Uint8Array(a)), { type: 'audio/aac' });
  let buf;
  try {
    buf = await audioCtx.decodeAudioData(await blob.arrayBuffer());
  } catch (e) {
    console.error('[TTS decode error]', e);
    return;
  }

  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);

  // 关键:如果 nextStartTime 已经过去,从 currentTime 起播;否则接续上一段尾巴
  const startAt = Math.max(nextStartTime, audioCtx.currentTime + 0.02);
  src.start(startAt);
  nextStartTime = startAt + buf.duration;

  activeSources.push(src);
  src.onended = () => {
    const i = activeSources.indexOf(src);
    if (i >= 0) activeSources.splice(i, 1);
    if (activeSources.length === 0 && wsClosed) {
      isReading = false;
      isPaused = false;
      setBtn('▶ 朗读本页');
      setStopVisible(false);
      setStatus('播放完成', '#27ae60');
    }
  };

  document.getElementById('tts-ext-progress').textContent =
    `合成 ${sentenceCount} 句 · 排队 ${activeSources.length} · 缓冲 ${(nextStartTime - audioCtx.currentTime).toFixed(2)}s`;
}

// ── 接收 background 转发的 TTS 事件 ───────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'TTS_EVENT') return;

  if (msg.event === 'no_doubao_tab') {
    setStatus('请先打开豆包页面 →', '#e74c3c');
    const el = document.getElementById('tts-ext-status');
    if (el) { el.style.cursor = 'pointer'; el.onclick = () => chrome.runtime.sendMessage({ type: 'OPEN_DOUBAO' }); }
    isReading = false; isPaused = false; setBtn('▶ 朗读本页'); setStopVisible(false); return;
  }

  if (msg.event === 'open') {
    setStatus('已连接,开始送文本...', '#27ae60');
    flushSegments();
    return;
  }

  if (msg.event === 'message') {
    let payload;
    try { payload = JSON.parse(msg.data); } catch (e) { return; }
    console.log('[TTS server]', payload.event, payload.sentence_start_result?.readable_text || '');

    if (payload.event === 'open_success') {
      // 服务端 ack,不做特别处理
    } else if (payload.event === 'sentence_start') {
      const txt = payload.sentence_start_result?.readable_text || '';
      setStatus(`合成中: ${txt.slice(0, 40)}`, '#3498db');
    } else if (payload.event === 'sentence_end') {
      flushCurrentSentence();
    } else if (payload.event === 'finish') {
      flushCurrentSentence();
      setStatus('全部合成完成', '#27ae60');
      // 不主动 close,让队列自然播完
    } else if (payload.code && payload.code !== 0) {
      setStatus(`服务端错误 ${payload.code}: ${payload.message || ''}`, '#e74c3c');
    }
    return;
  }

  if (msg.event === 'binary') {
    currentChunks.push(msg.data);
    console.log('[TTS binary]', msg.data.length, 'bytes, sentence chunks:', currentChunks.length);
    return;
  }

  if (msg.event === 'error') {
    setStatus('WS 错误', '#e74c3c');
    isReading = false; isPaused = false; setBtn('▶ 朗读本页'); setStopVisible(false);
    return;
  }

  if (msg.event === 'close') {
    flushCurrentSentence();
    wsClosed = true;
    if (msg.code === 1000) {
      // 正常关闭:让 onended 在队列播完后收尾
      if (activeSources.length === 0 && !isPaused) {
        isReading = false;
        setBtn('▶ 朗读本页');
        setStopVisible(false);
        setStatus('播放完成', '#27ae60');
      } else {
        setStatus('播放队列中...', '#555');
      }
    } else {
      isReading = false;
      isPaused = false;
      setBtn('▶ 朗读本页');
      setStopVisible(false);
      setStatus(`异常断开 ${msg.code}`, '#e74c3c');
    }
    return;
  }
});

// ── 图标点击切换浮窗 ─────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') { sendResponse({ ok: true }); return true; }
  if (msg.type === 'TOGGLE_PANEL') {
    if (IS_DOUBAO) return; // 豆包页只做代理,不显示朗读 UI
    const panel = document.getElementById('tts-ext-panel');
    if (panel) {
      if (panel.style.display === 'none') panel.style.display = '';
      else { stopRead(); panel.style.display = 'none'; }
    } else {
      injectPanel();
    }
  }
});

// ── 豆包页:WS 代理 ───────────────────────────────
const TTS_URL = 'wss://ws-samantha.doubao.com/samantha/audio/tts'
  + '?speaker=zh_female_taozi_conversation_v4_wvae_bigtts'
  + '&format=aac&speech_rate=0&pitch=0'
  + '&version_code=20800&language=zh&device_platform=web'
  + '&aid=497858&real_aid=497858&pkg_type=release_version'
  + '&device_id=7616216604401780224&pc_version=3.15.1'
  + '&web_id=7627108056602248710&tea_uuid=7627108056602248710'
  + '&region=&sys_region=&samantha_web=1&use-olympus-account=1';

const proxySessions = {}; // callerTabId -> WebSocket

function arrayBufferToArray(buf) {
  return Array.from(new Uint8Array(buf));
}

if (IS_DOUBAO) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PROXY_TTS_OPEN') {
      const { callerTabId } = msg;
      if (proxySessions[callerTabId]) {
        try { proxySessions[callerTabId].close(); } catch (e) {}
        delete proxySessions[callerTabId];
      }
      const ws = new WebSocket(TTS_URL);
      ws.binaryType = 'arraybuffer';
      proxySessions[callerTabId] = ws;

      ws.onopen = () => chrome.runtime.sendMessage({ type: 'PROXY_TTS_EVENT', callerTabId, event: 'open' });
      ws.onclose = (e) => {
        chrome.runtime.sendMessage({ type: 'PROXY_TTS_EVENT', callerTabId, event: 'close', code: e.code });
        delete proxySessions[callerTabId];
      };
      ws.onerror = () => chrome.runtime.sendMessage({ type: 'PROXY_TTS_EVENT', callerTabId, event: 'error' });
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          chrome.runtime.sendMessage({ type: 'PROXY_TTS_EVENT', callerTabId, event: 'message', data: e.data });
        } else {
          // ArrayBuffer 二进制 AAC 帧
          chrome.runtime.sendMessage({
            type: 'PROXY_TTS_EVENT',
            callerTabId,
            event: 'binary',
            data: arrayBufferToArray(e.data)
          });
        }
      };
    }

    if (msg.type === 'PROXY_TTS_SEND_TEXT') {
      const ws = proxySessions[msg.callerTabId];
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'text', text: msg.text }));
      }
    }

    if (msg.type === 'PROXY_TTS_FINISH') {
      const ws = proxySessions[msg.callerTabId];
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'finish' }));
      }
    }

    if (msg.type === 'PROXY_TTS_CLOSE') {
      const ws = proxySessions[msg.callerTabId];
      if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000);
      delete proxySessions[msg.callerTabId];
    }
  });
}
