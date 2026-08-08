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
let sentenceCount = 0;
// 解码+调度串行链:保证句子严格按到达顺序上时间轴,消除乱序竞态
let scheduleChain = Promise.resolve();
// 背压:纯内存兜底门限(防个别 60s+ 超长句撑爆内存)。
// 注意:此门限不能压太低!发送停滞过久服务端会判会话空闲,主动 finish+close。
// 主力背压靠下面的段数窗口,保证文本持续涓流、连接不饿死
const SEND_AHEAD_SECONDS = 120;
// 背压(段数):已发送但未播完的段数上限;50 段 ≈ 数分钟音频 ≈ 20-30MB 解码缓冲,有界
const SEND_AHEAD_SEGMENTS = 50;
// 涓流心跳:每 10s 强制补发 1 段,防止超长句播放期间发送空窗饿死连接
const TRICKLE_INTERVAL_MS = 10000;
let trickleTimer = null;
let sendIndex = 0;
let sentencesPlayed = 0;
let finishSent = false;
let synthFinished = false; // 服务端 'finish' 事件:全部合成完毕(服务端可能不断开 WS)
// 续发点定位:服务端会对文本流自行分句(可能合并/拆分我们的段),
// 用句数对齐 sendIndex 必然漂移(偏少→重发旧文折返,偏多→跳句)。
// 改用"归一化(去空白)字符坐标":segPrefixChars 与 ackedChars/anchorPos 同单位。
// anchorPos 是在线单调游标——每句 sentence_end 就地在 normFull 推进,
// 天然免疫重复句;遇服务端文本展开(数字→中文等)匹配失败则置脏,重连走字符数兜底
let segPrefixChars = []; // segPrefixChars[i] = 前 i 段的归一化字符数
let ackedChars = 0;      // 已完整合成的归一化字符数(兜底估算用)
let normFull = '';       // 各段归一化文本的依序拼接(= 去空白全文)
let anchorPos = 0;       // normFull 中已确认合成到的位置(单调游标)
let anchorDirty = false;
let pendingSentenceText = '';
// 会话代际:stop→start/续播时递增,旧会话迟到的 close/binary 事件一律丢弃,
// 否则旧 close(1000) 会把新会话 wsClosed 置真,pump 永久停摆。
// all_frames 下同 tab 多 frame 共享 callerTabId 路由,sessionId 必须带 frame 唯一前缀,
// 否则两个 frame 各自的 sid=1 会互相串台
const FRAME_UID = Math.random().toString(36).slice(2) + Date.now().toString(36);
let sessionSeq = 0;
let sessionId = null;
// 服务端对单会话文本量/时长有限制,可能中途关 WS;自动续连从断点接着发。
// 收到新会话的 sentence/binary 说明续连成功,计数清零;连续失败才封顶
let reconnects = 0;
const MAX_RECONNECTS = 8;
// 续连后首个 open 必须立即补发文本(空会话会被服务端秒关),
// 此时播放缓冲通常 > 门限,需绕过缓冲门限强制发一批
let reconnectKick = 0;
let reconnectTimer = null;
// WS open 看门狗:TTS_OPEN 后长时间没收到 open 事件(代理页异常/消息丢失)时给出可见提示
let wsOpened = false;
let openWatchdog = null;
// 语速:speech_rate 取值 [-50,100],速度 = 1 + rate/100(服务端变速,不变调)
const SPEED_OPTIONS = [[0, '1.0x'], [20, '1.2x'], [50, '1.5x'], [75, '1.75x'], [100, '2.0x']];
let currentRate = 0;

function rateLabel() {
  return (SPEED_OPTIONS.find(([r]) => r === currentRate) || [])[1] || (currentRate / 100 + 1) + 'x';
}

// 读取持久化的语速选择
try {
  chrome.storage.local.get('ttsRate').then(({ ttsRate }) => {
    if (typeof ttsRate === 'number') { currentRate = ttsRate; renderSpeedChips(); }
  }).catch(() => {});
} catch (e) {}

function renderSpeedChips() {
  const box = document.getElementById('tts-speeds');
  if (!box) return;
  box.innerHTML = '';
  SPEED_OPTIONS.forEach(([rate, label]) => {
    const b = document.createElement('span');
    b.textContent = label;
    b.style.cssText = 'flex:1;text-align:center;font-size:11px;padding:3px 0;border-radius:6px;cursor:pointer;user-select:none;'
      + (rate === currentRate ? 'background:#f39c12;color:#1a1a1a;font-weight:bold;' : 'background:#2a2a2a;color:#888;');
    b.onclick = () => setSpeed(rate);
    box.appendChild(b);
  });
}

function setSpeed(rate) {
  if (rate === currentRate) return;
  currentRate = rate;
  try { chrome.storage.local.set({ ttsRate: rate }); } catch (e) {}
  renderSpeedChips();
  if (isReading) {
    // 语速是建连参数,播放中切换 = 立即重开会话(不消耗重试配额),从当前句无缝接力
    scheduleReconnect({ delay: 0, consumeRetry: false, status: `已切换 ${rateLabel()},切换中...` });
  } else {
    setStatus(`语速 ${rateLabel()}`, '#555');
  }
}

function armOpenWatchdog() {
  clearTimeout(openWatchdog);
  const sid = sessionId;
  openWatchdog = setTimeout(() => {
    if (isReading && sessionId === sid && !wsOpened) {
      // 代理页孤儿化/消息丢失时不死等,按断连自动续连自愈
      setStatus('连接超时,自动续连...', '#f39c12');
      scheduleReconnect();
    }
  }, 12000);
}

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
    <div id="tts-speeds" style="display:flex;gap:4px;margin-top:8px"></div>
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
  renderSpeedChips();
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
function cleanText(s) {
  return (s || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractPageText() {
  return cleanText(document.body.innerText);
}

// 穿透 open shadow root 找选区:markdown 预览等插件常用 shadow DOM 渲染正文,
// window.getSelection() 穿不透 shadow 边界,需沿 activeElement 链下钻
function deepGetSelection() {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount) return sel;
  let el = document.activeElement;
  while (el && el.shadowRoot) {
    const s = el.shadowRoot.getSelection && el.shadowRoot.getSelection();
    if (s && !s.isCollapsed && s.rangeCount) return s;
    el = el.shadowRoot.activeElement;
  }
  return null;
}

// 忽略一切空白字符,在 haystack 中定位 needle,返回原文起始下标(找不到返回 -1)。
// selectionText 与 innerText 的空白/换行常有差异,按"去空白串 + 下标映射"对齐
function indexOfNormalized(haystack, needle) {
  const map = []; // 去空白串下标 -> 原文下标
  let stripped = '';
  for (let i = 0; i < haystack.length; i++) {
    if (!/\s/.test(haystack[i])) { map.push(i); stripped += haystack[i]; }
  }
  const k = stripped.indexOf((needle || '').replace(/\s+/g, ''));
  return k < 0 ? -1 : map[k];
}

// 断点续播:取选区起点到页面末尾的全部文本。
// 主路径:活选区 Range 精确定位(不做字符串匹配);
// 兜底:选区被预览插件重渲染销毁时,用右键点击瞬间捕获的 selectionText 在全文归一化匹配。
// 注意不能直接用 Range.toString():body 尾部常带内联 script/style,会被读出来,
// 故 cloneContents + 剔除脚本样式 + 离屏 innerText。
function extractFromSelection(fallbackText) {
  const sel = deepGetSelection();
  if (sel) {
    const r = sel.getRangeAt(0);
    if (r.startContainer.isConnected) {
      const rest = document.createRange();
      const rootNode = r.startContainer.getRootNode();
      // 选区在 shadow tree 里时,Range 两端必须同属一个 node tree,读到 shadow 根末尾
      rest.selectNodeContents(rootNode instanceof ShadowRoot ? rootNode : document.body);
      rest.setStart(r.startContainer, r.startOffset);
      const frag = rest.cloneContents();
      frag.querySelectorAll('script,style,noscript,template').forEach(n => n.remove());
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;';
      host.appendChild(frag);
      document.body.appendChild(host);
      const text = cleanText(host.innerText);
      host.remove();
      if (text) return text;
    }
  }
  if (fallbackText) {
    const full = extractPageText();
    const pos = indexOfNormalized(full, fallbackText);
    if (pos >= 0) {
      console.log('[TTS] 活选区不可用,用 selectionText 兜底定位,起点下标:', pos);
      return full.slice(pos);
    }
  }
  return null;
}

function segmentText(text) {
  // 分号/冒号也切开:长段落单段播放可超 60s,既触发服务端空闲/限量判定又撑大解码缓冲
  const segs = text.match(/[^。!?！？;；:\n]+[。!?！？;；:\n]?/g) || [text];
  return segs.map(s => s.trim()).filter(Boolean);
}

// ── 朗读流程 ─────────────────────────────────────
// 右键菜单启动不算页面手势,AudioContext 可能被 autoplay 策略挂起;补一次真实点击即恢复
if (!IS_DOUBAO) {
  document.addEventListener('click', () => {
    if (audioCtx && audioCtx.state === 'suspended' && isReading && !isPaused) {
      audioCtx.resume().catch(() => {});
    }
  });
}

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
    maybeFinish(); // 暂停期间队列可能已播完且服务端已 finish,恢复时补收尾
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

function startRead(text) {
  if (!text) text = extractPageText();
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
  sendIndex = 0;
  sentencesPlayed = 0;
  finishSent = false;
  synthFinished = false;
  ackedChars = 0;
  pendingSentenceText = '';
  anchorPos = 0;
  anchorDirty = false;
  segPrefixChars = [0];
  normFull = '';
  segs.forEach(s => {
    const n = s.replace(/\s+/g, '');
    segPrefixChars.push(segPrefixChars[segPrefixChars.length - 1] + n.length);
    normFull += n;
  });
  scheduleChain = Promise.resolve();
  reconnects = 0;
  sessionSeq += 1;
  sessionId = FRAME_UID + ':' + sessionSeq;

  // AudioContext 必须在 user gesture 内创建/恢复才能播
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  nextStartTime = audioCtx.currentTime;

  setBtn('⏸ 暂停', '#2c3e50');
  setStopVisible(true);
  setStatus(`连接中... (${segs.length} 段)`, '#f39c12');
  document.getElementById('tts-ext-progress').textContent = '';

  pendingSegments = segs;
  wsOpened = false;
  reconnectKick = 0;
  armOpenWatchdog();
  clearInterval(trickleTimer);
  trickleTimer = setInterval(() => pumpSegments(1), TRICKLE_INTERVAL_MS);
  chrome.runtime.sendMessage({ type: 'TTS_OPEN', sessionId, rate: currentRate });
}

let pendingSegments = [];

function bufferedAhead() {
  if (!audioCtx || audioCtx.state === 'closed') return 0;
  return Math.max(0, nextStartTime - audioCtx.currentTime);
}

// 背压发送:缓冲超 SEND_AHEAD_SECONDS 或未播段数超 SEND_AHEAD_SEGMENTS 即暂停;
// 由 open / 每句调度完成 / 每段播放结束(onended) / 10s 涓流心跳驱动。
// forceCount:续连后的首个 open 需绕过缓冲门限强制补发的段数(空会话会被服务端秒关)。
// 必须等 wsOpened:WS 未就绪时发送会被代理层静默丢弃,但 sendIndex 已前移,句子永久丢失
function pumpSegments(forceCount = 0) {
  if (!isReading || wsClosed || !wsOpened) return;
  while (sendIndex < pendingSegments.length
         && sendIndex - sentencesPlayed < SEND_AHEAD_SEGMENTS
         && (forceCount > 0 || bufferedAhead() <= SEND_AHEAD_SECONDS)) {
    const seg = pendingSegments[sendIndex++];
    chrome.runtime.sendMessage({ type: 'TTS_SEND_TEXT', text: seg, sessionId });
    if (forceCount > 0) forceCount--;
  }
  document.getElementById('tts-ext-progress').textContent = `发送 ${sendIndex}/${segmentTotal} · ${rateLabel()}`;
  if (sendIndex >= pendingSegments.length && !finishSent) {
    finishSent = true;
    chrome.runtime.sendMessage({ type: 'TTS_FINISH', sessionId });
    setStatus(`已发送 ${pendingSegments.length} 段,等待合成...`, '#3498db');
  }
}

function stopRead() {
  isReading = false;
  isPaused = false;
  clearTimeout(reconnectTimer);
  clearTimeout(openWatchdog);
  clearInterval(trickleTimer);
  reconnectKick = 0;
  pendingSegments = [];
  sendIndex = 0;
  sentencesPlayed = 0;
  finishSent = false;
  synthFinished = false;
  scheduleChain = Promise.resolve();
  reconnects = 0;
  currentChunks = [];
  activeSources.forEach(s => { try { s.stop(); } catch (e) {} });
  activeSources = [];
  if (audioCtx) {
    try { audioCtx.close(); } catch (e) {}
    audioCtx = null;
  }
  nextStartTime = 0;
  chrome.runtime.sendMessage({ type: 'TTS_CLOSE', sessionId });
  setBtn('▶ 朗读本页');
  setStopVisible(false);
  setStatus('已停止', '#555');
  document.getElementById('tts-ext-progress').textContent = '';
}

// ── 音频调度播放(AudioContext 时间轴,无缝拼接)─────
// 关键:decodeAudioData 耗时不定,若并发 decode 则先完成者先占 nextStartTime,
// 造成乱序(C 先于 B)。用 scheduleChain 串行化,保证严格按句子到达顺序上时间轴。
function maybeFinish() {
  // isReading=false 说明是异常断开/手动停止,保留原状态文案,不覆盖为"播放完成"
  if (!isReading || isPaused) return;
  // 文本没发完绝不可能是完成态:服务端可能对单会话限量,中途发 finish+close
  if (!finishSent) return;
  if (!wsClosed && !synthFinished) return;
  if (activeSources.length > 0) return;
  isReading = false;
  isPaused = false;
  clearInterval(trickleTimer);
  setBtn('▶ 朗读本页');
  setStopVisible(false);
  setStatus('播放完成', '#27ae60');
}

function flushCurrentSentence() {
  if (currentChunks.length === 0) return;
  const chunks = currentChunks;
  currentChunks = [];
  sentenceCount++;
  scheduleChain = scheduleChain.then(() => scheduleChunks(chunks)).catch(() => {});
}

// 文本没发完连接就断了(或服务端提前 finish):服务端单会话限量/空闲判定,
// 自动续连从断点接着发(缓冲队列跨会话连续)。旧 WS 由新 PROXY_TTS_OPEN 顺带关闭。
// opts.consumeRetry=false:语速切换等主动换会话,不占重试配额;opts.delay 覆盖退避
function scheduleReconnect(opts) {
  const o = opts || {};
  const consumeRetry = o.consumeRetry !== false;
  if (consumeRetry) {
    if (reconnects >= MAX_RECONNECTS) {
      isReading = false;
      isPaused = false;
      clearInterval(trickleTimer);
      setBtn('▶ 朗读本页');
      setStopVisible(false);
      setStatus(`服务端连续限量断开,续连失败 (${sendIndex}/${segmentTotal})`, '#e74c3c');
      return;
    }
    reconnects++;
  }
  wsClosed = false;
  wsOpened = false; // 旧会话已放弃:退避期间禁止任何发送(trickle 会每 10s 尝试)
  finishSent = false;
  synthFinished = false;
  // 半成品句丢弃(不入账不播放):否则新会话首句 binary 会与旧半截拼接,
  // 轻则 decode 失败跳句,重则夹带残音;续发后整句重发
  currentChunks = [];
  pendingSentenceText = '';
  // 续发点定位:优先锚定游标(单调推进,免疫重复句与归一化漂移);
  // 游标脏(服务端展开文本)时回退字符数映射并保守 -1 段(宁重复勿跳句)
  let resumeIdx = -1;
  if (!anchorDirty) {
    resumeIdx = 0;
    // 游标落在段中间(服务端拆句)→ 指向该段头,重读至多半句,不跳句
    while (resumeIdx < pendingSegments.length && segPrefixChars[resumeIdx + 1] <= anchorPos) resumeIdx++;
  } else {
    resumeIdx = 0;
    while (resumeIdx < pendingSegments.length && segPrefixChars[resumeIdx + 1] <= ackedChars) resumeIdx++;
    resumeIdx = Math.max(0, resumeIdx - 1);
  }
  sendIndex = Math.min(sendIndex, resumeIdx);
  // 重发段的 sentence_start 会再次计入,基数与游标都重置为续发点精确值
  ackedChars = segPrefixChars[sendIndex];
  anchorPos = segPrefixChars[sendIndex];
  sessionSeq += 1;
  sessionId = FRAME_UID + ':' + sessionSeq;
  // 退避:避免触发服务端频率限制,也给播放缓冲留出消耗时间
  const delay = o.delay != null ? o.delay : Math.min(800 * reconnects, 5000);
  reconnectKick = 10; // 续连后首个 open 强制补发 10 段,绕过缓冲门限
  setStatus(o.status || `服务端限量断开,${(delay / 1000).toFixed(1)}s 后续连 (${reconnects}) 从 ${sendIndex}/${segmentTotal} 继续...`, '#f39c12');
  const sid = sessionId;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!isReading || sessionId !== sid) return;
    wsOpened = false;
    armOpenWatchdog();
    chrome.runtime.sendMessage({ type: 'TTS_OPEN', sessionId, rate: currentRate });
  }, delay);
}

async function scheduleChunks(chunks) {
  // 捕获当前会话的 ctx:停止→重开后,旧链上的 in-flight decode 不得排进新会话
  const ctx = audioCtx;
  if (!ctx || ctx.state === 'closed') return;
  if (ctx.state === 'suspended' && !isPaused) {
    try { await ctx.resume(); } catch (e) {}
  }

  const blob = new Blob(chunks.map(a => new Uint8Array(a)), { type: 'audio/aac' });
  let buf;
  try {
    buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch (e) {
    console.error('[TTS decode error]', e);
    // 该句永不播放,必须计入"已消耗",否则未播段数门限把发送卡死;
    // 但仅当仍属当前会话:stop→start 跨 await 时旧会话的失败不得虚增新会话计数
    if (ctx === audioCtx && isReading) {
      sentencesPlayed++;
      pumpSegments();
    }
    return;
  }
  // await 之后会话可能已切换/停止
  if (ctx !== audioCtx || ctx.state === 'closed' || !isReading) return;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);

  // 关键:如果 nextStartTime 已经过去,从 currentTime 起播;否则接续上一段尾巴
  const startAt = Math.max(nextStartTime, ctx.currentTime + 0.02);
  src.start(startAt);
  nextStartTime = startAt + buf.duration;

  activeSources.push(src);
  src.onended = () => {
    const i = activeSources.indexOf(src);
    if (i >= 0) activeSources.splice(i, 1);
    sentencesPlayed++;
    pumpSegments(); // 播放消耗了缓冲,继续送文本
    maybeFinish();
  };

  document.getElementById('tts-ext-progress').textContent =
    `合成 ${sentenceCount} 句 · 排队 ${activeSources.length} · 缓冲 ${bufferedAhead().toFixed(2)}s · ${rateLabel()}`;

  pumpSegments(); // 缓冲未满则继续送文本(首次合成前触发全量发送的起点)
}

// ── 接收 background 转发的 TTS 事件 ───────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'TTS_EVENT') return;
  // 代际过滤:旧会话迟到的 close/binary/message 全部丢弃
  if (msg.sessionId !== sessionId) return;

  if (msg.event === 'no_doubao_tab') {
    setStatus('请先打开豆包页面 →', '#e74c3c');
    const el = document.getElementById('tts-ext-status');
    if (el) { el.style.cursor = 'pointer'; el.onclick = () => chrome.runtime.sendMessage({ type: 'OPEN_DOUBAO' }); }
    isReading = false; isPaused = false; setBtn('▶ 朗读本页'); setStopVisible(false); return;
  }

  if (msg.event === 'open') {
    wsOpened = true;
    clearTimeout(openWatchdog);
    setStatus('已连接,开始送文本...', '#27ae60');
    const kick = reconnectKick;
    reconnectKick = 0;
    pumpSegments(kick);
    return;
  }

  if (msg.event === 'message') {
    let payload;
    try { payload = JSON.parse(msg.data); } catch (e) { return; }
    console.log('[TTS server]', payload.event, payload.sentence_start_result?.readable_text || '');

    if (payload.event === 'open_success') {
      // 服务端 ack,不做特别处理
    } else if (payload.event === 'sentence_start') {
      reconnects = 0; // 新会话正常出活,续连计数清零
      const txt = payload.sentence_start_result?.readable_text || '';
      pendingSentenceText = txt; // sentence_end 时入账并推进锚定游标
      setStatus(`合成中: ${txt.slice(0, 40)}`, '#3498db');
    } else if (payload.event === 'sentence_end') {
      const norm = pendingSentenceText.replace(/\s+/g, '');
      pendingSentenceText = '';
      ackedChars += norm.length;
      // 在线推进锚定游标:正常时应紧邻当前位置(k === anchorPos);
      // 匹配失败=服务端展开/改写了文本(数字→中文等),游标失效转兜底
      if (!anchorDirty && norm) {
        const k = normFull.indexOf(norm, anchorPos);
        if (k >= 0 && k - anchorPos <= 50) anchorPos = k + norm.length;
        else anchorDirty = true;
      }
      flushCurrentSentence();
    } else if (payload.event === 'finish') {
      // 文本没发完服务端就 finish:等同提前断连,直接续连(半成品清理由 scheduleReconnect 统一处理)
      if (sendIndex < pendingSegments.length) {
        console.log('[TTS] 服务端提前 finish,按断连续连处理, sent:', sendIndex, '/', segmentTotal);
        scheduleReconnect();
        return;
      }
      flushCurrentSentence();
      synthFinished = true;
      setStatus('全部合成完成', '#27ae60');
      // 调度链排空后若已无排队音频,立即收尾(服务端可能不关 WS)
      scheduleChain.then(maybeFinish);
    } else if (payload.code && payload.code !== 0) {
      setStatus(`服务端错误 ${payload.code}: ${payload.message || ''}`, '#e74c3c');
    }
    return;
  }

  if (msg.event === 'binary') {
    reconnects = 0; // 新会话正常出流,续连计数清零
    currentChunks.push(msg.data);
    console.log('[TTS binary]', msg.data.length, 'bytes, sentence chunks:', currentChunks.length);
    return;
  }

  if (msg.event === 'error') {
    setStatus('WS 错误', '#e74c3c');
    // 丢弃半成品句:随后的 close 走非 premature 分支会 flush,不能把半截排上时间轴
    currentChunks = [];
    pendingSentenceText = '';
    isReading = false; isPaused = false; setBtn('▶ 朗读本页'); setStopVisible(false);
    return;
  }

  if (msg.event === 'close') {
    console.log('[TTS close] code:', msg.code, 'sent:', sendIndex, '/', segmentTotal, 'played sentences:', sentenceCount);
    wsClosed = true;
    wsOpened = false;

    // 文本没发完连接就断了:自动续连(半成品清理由 scheduleReconnect 统一处理)
    if (isReading && sendIndex < pendingSegments.length) {
      scheduleReconnect();
      return;
    }

    flushCurrentSentence();

    if (msg.code === 1000) {
      // 正常关闭:等调度链排空后再判断,否则 in-flight 的 decode 会被误判为"已播完"
      scheduleChain.then(() => {
        if (activeSources.length === 0 && !isPaused) {
          maybeFinish();
        } else {
          setStatus('播放队列中...', '#555');
        }
      });
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
  if (IS_DOUBAO) return; // 豆包页只做代理,不显示朗读 UI
  if (msg.type === 'TOGGLE_PANEL') {
    if (window !== top) return; // 浮窗只放顶层 frame
    const panel = document.getElementById('tts-ext-panel');
    if (panel) {
      if (panel.style.display === 'none') panel.style.display = '';
      else { stopRead(); panel.style.display = 'none'; }
    } else {
      injectPanel();
    }
  }
  if (msg.type === 'PLAY_FROM_SELECTION') {
    // 消息广播到所有 frame:先取选区,只有选区所在 frame 继续,其余静默忽略
    // (markdown 预览等插件常把正文渲染在 iframe/shadow DOM 里,顶层 frame 拿不到选区)
    const text = extractFromSelection(msg.selectionText);
    console.log('[TTS] PLAY_FROM_SELECTION frame:', location.href,
      '| top:', window === top, '| selectionText:', (msg.selectionText || '').length,
      '| text:', text ? text.length + ' chars' : 'none');
    if (!text) return;
    let panel = document.getElementById('tts-ext-panel');
    if (!panel) injectPanel();
    else if (panel.style.display === 'none') panel.style.display = '';
    if (isReading) stopRead();
    startRead(text);
    if (audioCtx && audioCtx.state === 'suspended') {
      setStatus('已就绪,点击页面任意处开始发声', '#f39c12');
    }
  }
});

// ── 豆包页:WS 代理 ───────────────────────────────
// speech_rate 为建连参数(取值 [-50,100],速度=1+rate/100),由 caller 在 OPEN 时携带
const TTS_URL = 'wss://ws-samantha.doubao.com/samantha/audio/tts'
  + '?speaker=zh_female_taozi_conversation_v4_wvae_bigtts'
  + '&format=aac&pitch=0'
  + '&version_code=20800&language=zh&device_platform=web'
  + '&aid=497858&real_aid=497858&pkg_type=release_version'
  + '&device_id=7616216604401780224&pc_version=3.15.1'
  + '&web_id=7627108056602248710&tea_uuid=7627108056602248710'
  + '&region=&sys_region=&samantha_web=1&use-olympus-account=1';

function ttsUrl(rate) {
  const r = Math.max(-50, Math.min(100, Math.round(rate || 0)));
  return TTS_URL + '&speech_rate=' + r;
}

const proxySessions = {}; // callerTabId -> { ws, sessionId }

function arrayBufferToArray(buf) {
  return Array.from(new Uint8Array(buf));
}

// all_frames 下代理监听只挂顶层 frame,否则消息广播会让每个 iframe 各建一条 WS
if (IS_DOUBAO && window === top) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PROXY_TTS_OPEN') {
      const { callerTabId, sessionId } = msg;
      const old = proxySessions[callerTabId];
      if (old) {
        try { old.ws.close(); } catch (e) {}
        delete proxySessions[callerTabId];
      }
      const ws = new WebSocket(ttsUrl(msg.rate));
      ws.binaryType = 'arraybuffer';
      proxySessions[callerTabId] = { ws, sessionId };
      const emit = (event, extra = {}) =>
        chrome.runtime.sendMessage({ type: 'PROXY_TTS_EVENT', callerTabId, sessionId, event, ...extra });

      ws.onopen = () => emit('open');
      ws.onclose = (e) => {
        console.log('[TTS proxy] ws closed, code:', e.code, 'reason:', e.reason, 'wasClean:', e.wasClean);
        emit('close', { code: e.code });
        // 旧 ws 的 onclose 可能晚于新会话建立,只删自己,不误删新会话
        if (proxySessions[callerTabId]?.ws === ws) delete proxySessions[callerTabId];
      };
      ws.onerror = () => emit('error');
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          emit('message', { data: e.data });
        } else {
          // ArrayBuffer 二进制 AAC 帧
          emit('binary', { data: arrayBufferToArray(e.data) });
        }
      };
    }

    if (msg.type === 'PROXY_TTS_SEND_TEXT') {
      const s = proxySessions[msg.callerTabId];
      if (s && s.sessionId === msg.sessionId && s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(JSON.stringify({ event: 'text', text: msg.text }));
      }
    }

    if (msg.type === 'PROXY_TTS_FINISH') {
      const s = proxySessions[msg.callerTabId];
      if (s && s.sessionId === msg.sessionId && s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(JSON.stringify({ event: 'finish' }));
      }
    }

    if (msg.type === 'PROXY_TTS_CLOSE') {
      const s = proxySessions[msg.callerTabId];
      if (s && s.sessionId === msg.sessionId) {
        if (s.ws.readyState === WebSocket.OPEN) s.ws.close(1000);
        delete proxySessions[msg.callerTabId];
      }
    }
  });
}
