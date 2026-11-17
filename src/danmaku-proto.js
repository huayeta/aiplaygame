// 抖音直播间 WebSocket 推送帧解码（零依赖）。
//
// 只实现 protobuf 的 wire-format 读取，不需要 .proto 编译器、不需要 npm 包。
// 字段编号来自 DouyinLiveWebFetcher/protobuf/douyin.proto（GitHub API 取回原文核对）：
//   PushFrame  { payloadEncoding = 6 (string), payload = 8 (bytes) }
//   Response   { messagesList  = 1 (repeated Message) }
//   Message    { method = 1 (string), payload = 2 (bytes), msgId = 3 (int64) }
//   ChatMessage   { user = 2, content = 3 }
//   GiftMessage   { repeatCount = 5, user = 7, gift = 15 -> GiftStruct.name = 16 }
//   MemberMessage { user = 2 }        进场
//   LikeMessage   { count = 2, user = 5 }
//   SocialMessage { user = 2 }        关注/分享
//   User          { nickName = 3, idStr = 1028 }
//   Common        { msgId = 2 }
//
// 设计原则：解码失败一律返回空数组 / null，绝不抛异常影响主线程；
// 主进程据此可安全回退到 DOM 采集器。
'use strict';
const zlib = require('zlib');

// ---------- protobuf wire format ----------
function readVarint(buf, p) {
  let v = 0n, shift = 0n;
  while (p < buf.length) {
    const b = buf[p++];
    v |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { v, p };
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
  throw new Error('truncated varint');
}

// 返回 Map<fieldNo, [{wire, v}]>；v 为 BigInt(varint) 或 Buffer(length-delimited)
function parseFields(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const out = new Map();
  let p = 0;
  while (p < buf.length) {
    let tag;
    try { const r = readVarint(buf, p); tag = r.v; p = r.p; } catch (e) { break; }
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field <= 0) break;
    let v;
    try {
      if (wire === 0) { const r = readVarint(buf, p); v = r.v; p = r.p; }
      else if (wire === 1) { if (p + 8 > buf.length) break; v = buf.subarray(p, p + 8); p += 8; }
      else if (wire === 2) {
        const r = readVarint(buf, p); p = r.p;
        const n = Number(r.v);
        if (n < 0 || p + n > buf.length) break;
        v = buf.subarray(p, p + n); p += n;
      }
      else if (wire === 5) { if (p + 4 > buf.length) break; v = buf.subarray(p, p + 4); p += 4; }
      else break; // wire 3/4 group：proto3 不使用
    } catch (e) { break; }
    if (!out.has(field)) out.set(field, []);
    out.get(field).push({ wire, v });
  }
  return out;
}

const f1 = (m, n) => (m.get(n) || [])[0];
function asStr(x) {
  if (x == null) return '';
  const v = (x && x.v !== undefined) ? x.v : x;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  try { return Buffer.from(v).toString('utf8'); } catch (e) { return ''; }
}
function asNum(x) {
  if (x == null) return 0;
  const v = (x && x.v !== undefined) ? x.v : x;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function asBuf(x) {
  if (x == null) return Buffer.alloc(0);
  const v = (x && x.v !== undefined) ? x.v : x;
  try { return Buffer.isBuffer(v) ? v : Buffer.from(v); } catch (e) { return Buffer.alloc(0); }
}

// ---------- 结构读取 ----------
function readUser(buf) {
  const f = parseFields(buf);
  let nick = asStr(f1(f, 3)).trim();
  if (!nick) nick = asStr(f1(f, 1028)).trim(); // idStr 兜底
  return nick;
}
function userAt(f, n) {
  const u = f1(f, n);
  return (u && u.wire === 2) ? readUser(u.v) : '';
}
function readCommonId(buf) {
  const f = parseFields(buf);
  const id = f1(f, 2); // Common.msgId
  return id ? asStr(id) : '';
}

// 从 Response 字节里抽出 messagesList
function extractMessages(respBuf) {
  const out = [];
  let resp;
  try { resp = parseFields(respBuf); } catch (e) { return out; }
  for (const item of (resp.get(1) || [])) {
    if (item.wire !== 2) continue;              // messagesList 必须是 length-delimited
    let mf;
    try { mf = parseFields(item.v); } catch (e) { continue; }
    const method = asStr(f1(mf, 1));
    if (!method || !/^[A-Za-z]+$/.test(method)) continue;
    const body = asBuf(f1(mf, 2));
    if (body.length) { try { parseFields(body); } catch (e) { continue; } }
    out.push({ method, body, msgId: asStr(f1(mf, 3)) });
  }
  return out;
}

const isGzip = b => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

// 一条 WS 二进制帧 → Message[]。
// 抖音各时期/各端封装不同，穷举 4 条路径，返回第一个成功的：
//   ① 帧=PushFrame{6:payloadEncoding, 8:payload}，payload 可能 gzip
//   ② 整帧是 gzip → 解压后是 PushFrame
//   ③ 整帧是 gzip → 解压后直接是 Response
//   ④ 帧直接就是 Response
function decodePushFrame(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!buf.length) return [];
  const tryResp = (b) => { try { return extractMessages(b); } catch (e) { return []; } };
  const tryPush = (b) => {
    let top;
    try { top = parseFields(b); } catch (e) { return []; }
    const enc = asStr(f1(top, 6));
    let payload = asBuf(f1(top, 8));
    if (!payload.length) return [];
    if (/gzip/i.test(enc) || isGzip(payload)) {
      // 标了 gzip 但数据其实没压的情况也存在，解压失败就退回原始字节
      try { payload = zlib.gunzipSync(payload); } catch (e) { /* keep raw */ }
    }
    return tryResp(payload);
  };

  let msgs = tryPush(buf);                       // ①
  if (msgs.length) return msgs;
  if (isGzip(buf)) {
    let un = null;
    try { un = zlib.gunzipSync(buf); } catch (e) {}
    if (un) {
      msgs = tryPush(un); if (msgs.length) return msgs;   // ②
      msgs = tryResp(un);  if (msgs.length) return msgs;  // ③
    }
  }
  return tryResp(buf);                           // ④
}

// 诊断用：分析一帧结构（不抛异常）
function analyzeFrame(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const info = { len: buf.length, hex: buf.subarray(0, 24).toString('hex'), gzip: isGzip(buf) };
  try { info.msgCount = decodePushFrame(buf).length; } catch (e) { info.msgCount = -1; }
  try { info.topFields = Array.from(parseFields(buf).keys()); } catch (e) { info.topFields = 'parse-fail'; }
  // PushFrame 字段里若没有 8（payload），说明可能不是 PushFrame，而是控制帧/心跳
  try {
    const top = parseFields(buf);
    info.hasPayloadField = !!f1(top, 8);
    info.payloadEncoding = asStr(f1(top, 6));
  } catch (e) {}
  if (isGzip(buf)) {
    try {
      const un = zlib.gunzipSync(buf);
      info.gunzipLen = un.length;
      info.gunzipHex = un.subarray(0, 24).toString('hex');
      try { info.gunzipFields = Array.from(parseFields(un).keys()); } catch (e) { info.gunzipFields = 'parse-fail'; }
    } catch (e) { info.gunzipErr = String((e && e.message) || e); }
  }
  try {
    const top = parseFields(buf);
    const enc = asStr(f1(top, 6));
    const pl = asBuf(f1(top, 8));
    if (pl.length) {
      info.pushEnc = enc;
      info.pushPayloadLen = pl.length;
      info.pushPayloadGzip = isGzip(pl);
      let inner = pl;
      if (info.pushPayloadGzip) {
        try {
          const un2 = zlib.gunzipSync(pl);
          inner = un2;
          info.pushUnzipLen = un2.length;
          info.pushUnzipHex = un2.subarray(0, 24).toString('hex');
        } catch (e) { info.pushUnzipErr = String((e && e.message) || e); }
      }
      // Response 层字段号：1=messagesList, 2=cursor, 8=heartbeatDuration, 9=needAck
      try {
        const rf = parseFields(inner);
        info.respFields = Array.from(rf.keys());
        info.respMsgCount = (rf.get(1) || []).length;
        info.needAck = !!f1(rf, 9);
        info.heartbeatDuration = f1(rf, 8) ? asNum(f1(rf, 8)) : 0;
      } catch (e) { info.respFields = 'parse-fail'; }
    }
  } catch (e) {}
  // 归类建议：给未解帧一个直观标签
  if (info.msgCount > 0) info.label = 'messages';
  else if (info.respFields && info.respMsgCount === 0) info.label = 'control/heartbeat(无消息)';
  else info.label = 'unknown';
  return info;
}

// Message[] → 统一弹幕事件（兼容现有 dm:message 的 {t,type} 格式，并附带结构化字段）
function decodeMessage(m) {
  try {
    const method = String((m && m.method) || '');
    const f = parseFields(asBuf(m && m.body));
    const common = f1(f, 1);
    const commonId = (common && common.wire === 2) ? readCommonId(common.v) : '';
    const msgId = (m && m.msgId) || commonId || ('x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));

    let kind = '', user = '', text = '', t = '', giftName = '', giftCount = 0;

    if (/ChatMessage$/i.test(method)) {
      kind = 'chat';
      user = userAt(f, 2);
      text = asStr(f1(f, 3)).trim();
      t = (user ? user + '：' : '') + text;
    } else if (/GiftMessage$/i.test(method)) {
      kind = 'gift';
      user = userAt(f, 7);
      giftCount = asNum(f1(f, 5)) || 1;       // repeatCount
      const gf = parseFields(asBuf(f1(f, 15)));
      giftName = asStr(f1(gf, 16)).trim() || asStr(f1(gf, 2)).trim() || '礼物';
      text = '送出' + giftName + (giftCount > 1 ? ' x' + giftCount : '');
      t = (user ? user + '：' : '') + text;
    } else if (/LikeMessage$/i.test(method)) {
      kind = 'like';
      user = userAt(f, 5);
      const cnt = asNum(f1(f, 2));
      text = '点赞' + (cnt > 1 ? ' x' + cnt : '');
      t = (user ? user + '：' : '') + text;
    } else if (/MemberMessage$/i.test(method)) {
      kind = 'enter';
      user = userAt(f, 2);
      text = '来了';
      t = user ? (user + ' 来了') : '有人来了';
    } else if (/SocialMessage$/i.test(method)) {
      kind = 'follow';
      user = userAt(f, 2);
      text = '关注了主播';
      t = (user ? user + '：' : '') + text;
    } else {
      return null; // ControlMessage / RoomUserSeqMessage 等暂不需要
    }

    if (!t.trim()) return null;
    const out = {
      t: t,
      type: kind === 'chat' ? 'chat' : 'event', // 兼容旧：非 chat 一律按事件样式
      kind: kind,                               // 新增：精确类型，下游无需再靠正则猜
      msgId: 'ws' + msgId,
      user: user,
      text: text,
      src: 'ws'
    };
    if (kind === 'gift') out.gift = { name: giftName, count: giftCount };
    return out;
  } catch (e) { return null; }
}

module.exports = { decodePushFrame, decodeMessage, analyzeFrame, extractMessages, parseFields, readVarint, asStr, asNum, asBuf, f1 };
