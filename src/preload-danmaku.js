// 弹幕源窗口的预加载脚本（隔离世界，document-start 自动执行）。
// 相比旧方案（main 进程 executeJavaScript 注入 + 600ms 轮询拉取）的改进：
//   1. 推模式：抓到就 ipcRenderer.send，不再 600ms 轮询，延迟从 ~600ms 降到 ~50ms
//   2. 随文档启动：SPA 跳转 / 断线重连 / 容器替换都会自动重建，不再只在 did-finish-load 注入一次
//   3. 只观察聊天容器，不观察整个 document.body（旧方案每次礼物特效都触发全量 querySelectorAll）
//   4. 去 CSS 哈希：优先用结构特征 [data-index]，类名只作兜底，不写死 webcast-chatroom___item
//   5. 带真实 msgId（容器代次 + data-index），下游可用它精确去重，不再靠 user|text + 5 秒 TTL 猜
//   6. 健康检查 + 容器自愈：容器被移除/长时间无新消息时自动重挂，并把状态报给界面
// 注意：contextIsolation 下 preload 在隔离世界，但 DOM 是共享的，MutationObserver/querySelectorAll 均可正常使用。
const { ipcRenderer } = require('electron');

(function () {
  'use strict';
  if (window.__dmCollectorStarted) return;
  window.__dmCollectorStarted = true;

  const BOOTSTRAP_MS = 400;      // 找容器的重试间隔
  const HEALTH_MS = 3000;        // 健康上报间隔
  const QUIET_RESCAN_MS = 20000; // 长时间无新消息时做一次兜底重扫
  const READ_DELAY_MS = 50;      // 节点插入后等一帧再取文本（React 常先建壳后填字）
  const DEDUP_TTL_MS = 10000;    // 无 data-index 时的文本兜底去重窗口

  let container = null;          // 当前聊天容器
  let observer = null;           // 挂在容器上的 MutationObserver
  let bootTimer = null;          // 找容器定时器
  let healthTimer = null;
  let gen = 0;                   // 容器代次：重挂后 +1，避免 msgId 跨挂载撞车
  let rowSeq = 0;                // 全局递增：保证每条 msgId 唯一（虚拟列表会复用 data-index）
  let lastMsgAt = 0;
  let msgCount = 0;
  let selfHealCount = 0;
  let mutCount = 0;      // 观察到的 DOM 变动次数：区分「页面没动」和「动了但没采到」
  let lastText = '';     // 最近一次处理的文本样本（诊断用）
  const seenText = new Map();    // 文本兜底去重 key -> expireAt
  const pending = new Set();     // 等待延时读取的 row

  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function send(msg) {
    try { ipcRenderer.send('dm:message', msg); } catch (e) {}
  }
  function health(extra) {
    const now = Date.now();
    try {
      ipcRenderer.send('dm:health', {
        container: !!(container && container.isConnected),
        msgs: msgCount,
        sinceLastMs: lastMsgAt ? (now - lastMsgAt) : 0,
        gen: gen,
        selfHeals: selfHealCount,
        mutations: mutCount,
        containerCls: container ? String(container.className || '').slice(0, 100) : '',
        containerEls: container ? (function () { try { return container.querySelectorAll('*').length; } catch (e) { return 0; } })() : 0,
        lastText: String(lastText).slice(0, 60),
        ...(extra || {})
      });
    } catch (e) {}
  }

  // ---- 找聊天容器：优先结构特征，类名只作兜底（CSS Modules 哈希会变） ----
  const CONTAINER_SELECTORS = [
    '[class*="webcast-chatroom"]',
    '[class*="chatroom"]',
    '[class*="chat-list"]',
    '[class*="message-list"]',
    '[class*="danmaku"]'
  ];
  // 明显的「非聊天区」：播放器控件、视频、工具栏、页头页脚，以及聊天关闭占位（chatroom_close）
  // 之前误挂到 douyin-player-controls-inner / chatroom_close 这类占位元素，抓到的是提示文案不是弹幕。
  const BAD_CLS = /player|controls|video|toolbar|-header|-footer|sidebar|nav-|banner|tooltip|chatroom[-_]?close/i;
  function isBad(el) {
    const c = String((el && el.className) || '');
    return BAD_CLS.test(c);
  }
  function idxCount(el) {
    try { return el.querySelectorAll('[data-index]').length; } catch (e) { return 0; }
  }
  function score(el) {
    if (isBad(el)) return -1;                       // 播放器/控件/关闭占位 直接排除
    const c = String(el.className || '').toLowerCase();
    const n = idxCount(el);
    let s = 0;
    if (/chatroom/.test(c)) s += (n > 0 ? 1000 : 50); // 有消息行才高度可信；否则可能只是占位
    else if (/chat|comment|message|danmaku/.test(c)) s += 300;
    s += Math.min(n, 80) * 10;                       // 消息行越多越可信
    if (n) s += Math.min(20, el.children ? el.children.length : 0);
    return s;
  }
  function lca(a, b) {
    const anc = new Set();
    let p = a;
    while (p) { anc.add(p); p = p.parentElement; }
    p = b;
    while (p && !anc.has(p)) p = p.parentElement;
    return p;
  }
  function findContainer() {
    // 1) 类名候选（明确 chatroom 的会拿到高分）
    let best = null, bestScore = 0;
    for (const sel of CONTAINER_SELECTORS) {
      let list;
      try { list = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of list) {
        const s = score(el);
        if (s > bestScore) { bestScore = s; best = el; }
      }
    }
    if (bestScore >= 300) return best;   // 有 chat/chatroom 类名或足够多消息行，可信

    // 2) 结构兜底：取若干 [data-index] 行的最近公共祖先。
    //    必须排除播放器/控件区，且至少要像「列表」（>=3 条）。
    try {
      const rows = Array.prototype.slice.call(document.querySelectorAll('[data-index]'), 0, 20)
        .filter(el => !isBad(el));
      if (rows.length >= 3) {
        let c = lca(rows[0], rows[1]);
        for (let i = 2; i < rows.length && c; i++) c = lca(c, rows[i]);
        if (c && c !== document.body && c !== document.documentElement && c.isConnected &&
            !isBad(c) && idxCount(c) >= 3) {
          return c;
        }
      }
    } catch (e) {}

    // 3) 低分候选也排除「坏容器」后才用，否则宁可返回 null（报未找到容器，好过抓一堆播放器提示）
    if (best && !isBad(best) && bestScore >= 100) return best;
    return null;
  }

  // ---- 从容器里挑出“消息行” ----
  function rowsOf(node) {
    const out = [];
    const add = (el) => { if (el && el.nodeType === 1 && !out.includes(el) && !isBad(el)) out.push(el); };
    if (!node || node.nodeType !== 1) return out;
    // 结构优先：data-index 就是消息行的稳定序号
    if (node.hasAttribute && node.hasAttribute('data-index')) add(node);
    try { node.querySelectorAll('[data-index]').forEach(add); } catch (e) {}
    // 类名兜底（不写死哈希后缀）
    if (node.matches && node.matches('[class*="bottom_message"],[class*="chatroom___item"],[class*="chatroom___list"]')) add(node);
    try {
      node.querySelectorAll('[class*="bottom_message"],[class*="chatroom___item"]').forEach(add);
    } catch (e) {}
    return out;
  }
  function isEvent(el) {
    try {
      if (/bottom_message/.test(String(el.className || ''))) return true;
      return !!(el.querySelector && el.querySelector('[class*="bottom_message"]'));
    } catch (e) { return false; }
  }

  // 去重 key：不能假设 data-index 单调递增！
  // 抖音聊天区是虚拟列表，data-index 常是「可视行位置」(固定 0~N 循环复用)。
  // 若按 idx<=lastIdx 就丢，容器一挂载就会把之后所有新消息全吞掉。
  // 改用「索引 + 文本」组合：同一行内容变了 = 新消息；同一行同一内容 = 重复。
  function rowKey(el, text) {
    let idx = NaN;
    try {
      const a = el.getAttribute && el.getAttribute('data-index');
      if (a != null) idx = parseInt(a, 10);
    } catch (e) {}
    return { idx, key: (isNaN(idx) ? 't' : ('i' + idx)) + '|' + text };
  }
  function emitRow(el) {
    const text = clean(el.innerText);
    if (!text || text.length > 300) return; // 旧方案 120 字会丢长弹幕，放宽到 300
    lastText = text;
    const { idx, key } = rowKey(el, text);
    const now = Date.now();
    const exp = seenText.get(key);
    if (exp && exp > now) return;           // 同一行同一内容已发过
    seenText.set(key, now + DEDUP_TTL_MS);
    if (seenText.size > 500) {
      for (const [k, e] of seenText) if (e <= now) seenText.delete(k);
    }
    const msgId = 'g' + gen + (isNaN(idx) ? 't' : 'i' + idx) + 's' + (++rowSeq);

    // 尽量把「用户名：内容」拆开传下去，下游就不必再靠正则猜
    let user = '', content = text;
    const m = text.match(/^([^:：]{1,24})[:：]\s*(.+)$/);
    if (m) { user = m[1]; content = m[2]; }

    lastMsgAt = Date.now();
    msgCount++;
    send({
      t: text,                               // 兼容旧格式：整行文本
      type: isEvent(el) ? 'event' : 'chat',  // 兼容旧格式
      msgId: msgId,                          // 新增：真实去重键
      user: user,                            // 新增：可选结构化字段
      text: content,                         // 新增：可选结构化字段
      src: 'dom'                             // 来源标记：供跨源去重区分 WS / DOM
    });
  }

  function scheduleRow(el) {
    if (pending.has(el)) return;
    pending.add(el);
    setTimeout(() => {
      pending.delete(el);
      try { if (container && (el === container || container.contains(el))) emitRow(el); } catch (e) {}
    }, READ_DELAY_MS);
  }

  // ---- 挂载 / 卸载观察器 ----
  function attach(el) {
    detachObserver();
    container = el;
    gen++;
    // 把挂载瞬间已渲染的历史行登记为「已发过」，避免重挂时把整屏历史重复推送。
    // 登记的是组合 key（不是最大序号），因此不影响之后新消息。
    try {
      el.querySelectorAll('[data-index]').forEach((r) => {
        const t = clean(r.innerText);
        if (t) {
          const { key } = rowKey(r, t);
          seenText.set(key, Date.now() + DEDUP_TTL_MS);
        }
      });
    } catch (e) {}
    observer = new MutationObserver((muts) => {
      mutCount += muts.length;
      for (const mu of muts) {
        if (mu.type === 'childList') {
          for (const n of mu.addedNodes) {
            const rows = rowsOf(n);
            if (rows.length) rows.forEach(scheduleRow);
            else if (n && n.nodeType === 1) scheduleRow(n); // 未知布局：兜底按新增节点本身处理
          }
        } else if (mu.type === 'characterData' && mu.target && mu.target.parentElement) {
          // 文本后填：找到最近的 [data-index] 行重读（emitRow 的序号去重会挡住重复）
          let p = mu.target.parentElement, row = null;
          while (p && p !== container) {
            if (p.hasAttribute && p.hasAttribute('data-index')) { row = p; break; }
            p = p.parentElement;
          }
          if (row) scheduleRow(row);
        }
      }
    });
    try { observer.observe(el, { childList: true, subtree: true, characterData: true }); } catch (e) {}
    health({ note: 'attached' });
  }
  function detachObserver() {
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
    pending.clear();
  }
  function stopBootstrap() { if (bootTimer) { clearInterval(bootTimer); bootTimer = null; } }

  function bootstrap() {
    stopBootstrap();
    detachObserver();
    container = null;
    let tries = 0;
    bootTimer = setInterval(() => {
      tries++;
      const el = findContainer();
      if (el && el.isConnected) {
        stopBootstrap();
        attach(el);
      } else if (tries === 50) {
        health({ note: 'container-not-found' });
      }
    }, BOOTSTRAP_MS);
  }

  // ---- 健康检查：容器丢了就重挂；长时间静默做一次兜底重扫 ----
  function startHealth() {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(() => {
      const now = Date.now();
      if (!container || !container.isConnected) {
        selfHealCount++;
        health({ note: 're-attach' });
        bootstrap();
        return;
      }
      if (lastMsgAt && now - lastMsgAt > QUIET_RESCAN_MS) {
        // 虚拟列表回收 / observer 漏帧的兜底：重扫当前容器里的行，由 emitRow 用组合 key 判重
        try {
          const rows = Array.prototype.slice.call(container.querySelectorAll('[data-index]'), -30);
          rows.forEach(scheduleRow);
        } catch (e) {}
      }
      health();
    }, HEALTH_MS);
  }

  // 页面卸载/跳转时让状态可观测（新文档会重新执行本 preload，自动重建）
  window.addEventListener('beforeunload', () => { detachObserver(); stopBootstrap(); });

  bootstrap();
  startHealth();
})();
