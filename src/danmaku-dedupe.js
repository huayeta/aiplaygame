// 弹幕双源合流去重（DOM 采集器 + WS protobuf 解码）。
// 目标：同一条弹幕只上报一次，且 WS 的结构化消息优先，WS 断流时 DOM 自动接管。
'use strict';

const seen = new Map();   // contentKey -> { exp, src, ids:Set }
let dropped = 0;
let wsActiveUntil = 0;
const WS_ACTIVE_MS = 8000;
const TTL_MS = 4000;
let sendFn = null;

function init(send) { sendFn = send; reset(); }
function reset() { seen.clear(); dropped = 0; wsActiveUntil = 0; }
function keyOf(msg) {
  const kind = String(msg.kind || (msg.type === 'event' ? 'event' : 'chat'));
  const user = String(msg.user || '').replace(/\s+/g, ' ').trim();
  const text = String(msg.text || msg.t || '').replace(/\s+/g, ' ').trim();
  return kind + '|' + user + '|' + text;
}
function markWsActive() { wsActiveUntil = Date.now() + WS_ACTIVE_MS; }
function droppedCount() { return dropped; }
function isWsActive() { return Date.now() < wsActiveUntil; }

function forward(msg, src) {
  if (!msg || !String(msg.t || '').trim()) return false;
  const now = Date.now();
  // WS 解码正常时以它为准，DOM 静默让位（避免双份）；断流超过 WS_ACTIVE_MS 后 DOM 自动接管
  if (src === 'dom' && now < wsActiveUntil) return false;

  const key = keyOf(msg);
  const id = String(msg.msgId || '');
  const rec = seen.get(key);
  if (rec && rec.exp > now) {
    if (src === 'ws' && rec.src === 'dom') {
      // 切换瞬间：DOM 已经把这一条发出去了，WS 这条丢弃（避免重复）。
      // 但把记录源改成 ws，让后续同源新 msgId 能正常放行；之后 DOM 让位，WS 独占。
      rec.src = 'ws';
      dropped++;
      return false;
    } else if (id && rec.src === src && !rec.ids.has(id)) {
      // 同源 + 新 msgId → 放行（同一人连发「666」是两条独立消息）
      rec.ids.add(id);
    } else {
      dropped++;
      return false;
    }
  } else {
    seen.set(key, { exp: now + TTL_MS, src, ids: new Set(id ? [id] : []) });
  }
  if (seen.size > 3000) {
    for (const [k, r] of seen) if (r.exp <= now) seen.delete(k);
  }
  if (sendFn) sendFn('dm:message', msg);
  return true;
}

module.exports = { init, reset, forward, keyOf, markWsActive, droppedCount, isWsActive };
