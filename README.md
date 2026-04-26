# 豆包 TTS 浏览器扩展

一键朗读当前网页内容,基于豆包(火山引擎)WebSocket 流式 TTS。任意网站点工具栏图标 → 浮窗 → "朗读本页"。

---

## 1. 全局架构

```
用户网页 (content.js A 实例)         后台 (background.js)         豆包页 (content.js B 实例)        豆包服务端
  ┌──────────────┐                    ┌────────────┐               ┌────────────┐                ┌────────────┐
  │ 浮窗 UI      │                    │ 消息路由   │               │  WS 代理   │                │ TTS WS     │
  │ 文本提取     │ TTS_OPEN/SEND/...  │            │ PROXY_TTS_*   │            │ WSS+Cookie     │            │
  │ 解码 + 播放  ├───────────────────►│  proxyMap  ├──────────────►│ WebSocket  ├───────────────►│            │
  │              │                    │            │               │            │                │            │
  │              │◄────TTS_EVENT──────┤            │◄──PROXY_EVENT─┤            │◄── AAC binary──┤            │
  └──────────────┘                    └────────────┘               └────────────┘                └────────────┘
```

**为什么要绕路?**
豆包 TTS 的 WSS 鉴权依赖 doubao.com 域下的 cookie(`sessionid_ss` 等)。Service Worker 没法跨域附 cookie,直接连会 401。所以让真正的 WebSocket 在 doubao.com tab 的 content script 里建立——浏览器自动带上同源 cookie——其他 tab 通过 background SW 中转消息。

---

## 2. 文件清单

| 文件 | 作用 |
|---|---|
| `manifest.json` | MV3 配置:`<all_urls>` 注入 content.js,`host_permissions` 仅 doubao.com,声明 cookies 权限 |
| `background.js` | 消息路由(任意 tab ↔ 豆包 tab)、`ensureDoubaoTab()` 自动确保豆包页存在、`OffscreenCanvas` 动态绘制 "TTS" 工具栏图标 |
| `content.js` | 双角色:① 非豆包页注入浮窗 + 文本提取 + 音频解码播放;② 豆包页 WS 代理 |

`IS_DOUBAO = location.hostname.endsWith('doubao.com')` 决定当前实例走哪条分支。

---

## 3. 完整流程

### 3.1 触发

1. 用户点工具栏图标 → `chrome.action.onClicked`(background)
2. `ensureDoubaoTab()`:查询是否有 `doubao.com/*` tab;无则后台开一个并 `waitForTabLoad`,有但 PING 不通则 reload
3. 给当前 tab 发 `TOGGLE_PANEL` → content.js 注入 `#tts-ext-panel` 浮窗(若已存在则切显隐)

### 3.2 朗读

`startRead()`:
- `extractPageText()`:`document.body.innerText`,清理多余空白,**不截断**
- `segmentText()`:按 `。!?！？\n` 切句
- `new AudioContext()` 在 user gesture 内创建
- 发 `TTS_OPEN` 给 background

`flushSegments()` 在 `TTS_EVENT {event:'open'}` 后启动:
- 30ms 间隔逐段 `TTS_SEND_TEXT`,避免一次性批量阻塞 SW 路由
- 全发完后送 `TTS_FINISH`

### 3.3 WS 建立(background → 豆包 tab)

```
caller                   background                  doubao tab
  │  TTS_OPEN ──────────►│ proxyMap[caller]=doubao  │
  │                      │  PROXY_TTS_OPEN ────────►│ new WebSocket(TTS_URL)
  │                      │                          │ binaryType='arraybuffer'
  │                      │                          │ ws.onopen
  │                      │ ◄────── PROXY_TTS_EVENT ─┤    {event:'open'}
  │ ◄────── TTS_EVENT ───┤
```

`TTS_URL` 是固定 WSS,query 含 speaker / format=aac / aid / device_id / web_id / tea_uuid 等,从浏览器抓包硬编码。同一账号长期有效。

### 3.4 流式接收

服务端按句返回:

```
{event:'open_success', code:0}              ← string
{event:'sentence_start', sentence_start_result:{readable_text:"..."}}
[binary AAC frame] [binary AAC frame] ...   ← 多个二进制帧
{event:'sentence_end'}
... 下一句 ...
{event:'finish'}
ws.close(1000)
```

`豆包 tab → background → caller`:
- 文本消息 → `event:'message', data: <string>`
- 二进制 → `Array.from(new Uint8Array(buf))` → `event:'binary', data: number[]`(消息通道无法直接传 ArrayBuffer)

### 3.5 音频拼接(无缝)

```js
let nextStartTime = 0;
// sentence_end 触发
const blob = new Blob(chunks.map(a => new Uint8Array(a)), { type:'audio/aac' });
const buf = await audioCtx.decodeAudioData(await blob.arrayBuffer());
const src = audioCtx.createBufferSource();
src.buffer = buf;
src.connect(audioCtx.destination);
const startAt = Math.max(nextStartTime, audioCtx.currentTime + 0.02);
src.start(startAt);
nextStartTime = startAt + buf.duration;
```

每句解码出一个 `AudioBuffer`,在 AudioContext 共享时间轴上接续。`Math.max` 兼顾两种情况:① 第一句到来时 `nextStartTime` 已过期,从 `currentTime+20ms` 起播;② 后续句续在上一句尾。

### 3.6 暂停 / 继续

| 操作 | 实现 |
|---|---|
| ⏸ 暂停 | `audioCtx.suspend()` 冻结时间轴,排队的 BufferSource 原地等 |
| ▶ 继续 | `audioCtx.resume()` 解冻,从冻结点起播 |
| ■ 停止 | 关 WS,关 audioCtx,释放所有 source 和 buffer |

WS 接收与 audioCtx 状态独立,暂停时若服务端还在推 binary 仍正常入队;`flushCurrentSentence()` 内特意写 `if (audioCtx.state === 'suspended' && !isPaused)` 才 resume,避免误唤醒。

### 3.7 收尾

`wsClosed = true` 由 close 事件设置。每个 `BufferSource.onended` 检查 `activeSources.length === 0 && wsClosed`,满足则:
- `isReading = false`
- 按钮回到 "▶ 朗读本页"
- 状态 = "播放完成"

---

## 4. 状态机

```
            startRead
   idle ─────────────► reading
    ▲                    │
    │                    │ pause                ┌──── resume ────┐
    │ ┌─ stop / 队列空+wsClosed ────► reading ──┤                │
    │ │                                paused ◄──┘                │
    │ └────── stop ◄──────────────── reading ◄────────────────────┘
    │                                paused
    └────────── stop ───────────────────┘
```

变量:`isReading`(总开关)、`isPaused`(用户主动暂停)、`wsClosed`(服务端是否已 close)。

---

## 5. 协议示例

**发送**:

```json
{"event":"text","text":"今天天气真好。"}
{"event":"finish"}
```

**接收(JSON)**:

```json
{"event":"open_success","code":0}
{"event":"sentence_start","sentence_start_result":{"readable_text":"今天天气真好。"}}
{"event":"sentence_end"}
{"event":"finish"}
```

**接收(binary)**:AAC ADTS 帧,长度不等;同一句的多帧需拼接成完整 AAC blob 才能 `decodeAudioData`。

---

## 6. 内存与性能

- AAC 比特流压缩比高,WS 收的 binary 几十 KB/秒。
- `decodeAudioData` 解出的 PCM = 采样率 × 通道 × 4 字节(Float32),1 秒约 350 KB。
- 5 分钟音频约 100 MB,DevTools → Memory → Heap snapshot 看 `AudioBuffer` 占用。
- 全在进程内存,**不落盘**,不进 Chrome disk cache。
- `stopRead()` 关 audioCtx 释放;tab 关闭整批回收。

---

## 7. 限制

| 项 | 上限 | 备注 |
|---|---|---|
| 单条 `event:text` payload | 2000 UTF-8 字符(流式) | 中文约 600 字。当前按句切,远不会触限 |
| 单 WS 会话总量 | 文档未公开 | 几万字以上极长文未实测,可能命中服务端超时 |
| 内存 | 取决于音频时长 | 见上 |
| 设备指纹 | 同账号长期有效 | 失效时从豆包 web 抓包替换 |

---

## 8. 调试

| 现象 | 排查 |
|---|---|
| 点图标无浮窗 | `chrome://extensions` → service worker 链接 → DevTools 看 background 错误 |
| 状态栏 "请先打开豆包页面" | `ensureDoubaoTab` 应该自动开一个,等它加载完;手动开一个 doubao.com 也行 |
| WS 异常断开 non-1000 | 大概率设备指纹失效 / 账号未登录,刷新豆包页重新登录 |
| 没有声音 | 检查 `audioCtx.state`;Chrome 要求 AudioContext 在 user gesture 内创建 |
| 控制台不再刷 binary | 服务端已合成完毕,这是正常的 |

---

## 9. 改进方向

- 设备指纹自动从豆包 tab 抓取(目前硬编码)
- 极长文 → 分批多 WS 会话
- 浮窗拖动位置持久化
- 多语种 / 多音色切换 UI
- 选中区域朗读(替代整页)
