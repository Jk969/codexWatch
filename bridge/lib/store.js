'use strict';
// ChatStore:把 ~/.codex/sessions 下的 rollout 文件聚合为"聊天(任务)"。
// 启动时轻量扫描建摘要;客户端打开聊天时才全量解析;之后增量 tail。

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { parseLine, classifyMeta, translate, cleanUserText } = require('./rollout');
const { log, logErr, truncate, relTime } = require('./util');

const MAX_ITEMS = 2500;          // 单聊天保留的 item 上限(更早的折叠)
const QUICK_HEAD = 96 * 1024;    // 启动扫描读取文件头
const QUICK_TAIL = 64 * 1024;    // 启动扫描读取文件尾

function basename(p) {
  if (!p) return '';
  p = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

class ChatStore extends EventEmitter {
  constructor(sessionsRoot, opts) {
    super();
    this.root = sessionsRoot;
    this.opts = Object.assign({ retainDays: 14, maxChats: 200 }, opts || {});
    this.chats = new Map();       // chatKey -> chat
    this.fileChat = new Map();    // absFile -> chatKey
    this.filePos = new Map();     // absFile -> byte offset already parsed
    this.threadNames = new Map(); // id -> name (来自 session_index.jsonl)
    this.indexFile = path.join(path.dirname(sessionsRoot), 'session_index.jsonl');
  }

  // ---------- 启动轻量扫描 ----------
  loadThreadNames() {
    try {
      const lines = fs.readFileSync(this.indexFile, 'utf8').split('\n');
      for (const l of lines) {
        try { const j = JSON.parse(l); if (j && j.id && j.thread_name) this.threadNames.set(j.id, j.thread_name); } catch {}
      }
      log('[store] thread names:', this.threadNames.size);
    } catch { /* 无索引文件时忽略 */ }
  }

  listFiles() {
    const out = [];
    const cutoff = Date.now() - this.opts.retainDays * 864e5;
    const walk = (d) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl')) {
          try { const st = fs.statSync(p); if (st.mtimeMs >= cutoff) out.push({ p, size: st.size, mtime: st.mtimeMs }); } catch {}
        }
      }
    };
    walk(this.root);
    return out;
  }

  quickScan() {
    this.loadThreadNames();
    const files = this.listFiles().sort((a, b) => a.mtime - b.mtime);
    let skippedSub = 0;
    for (const f of files) {
      try {
        const info = this.quickReadFile(f.p);
        if (!info) continue;
        if (info.meta.subagent) { skippedSub++; this.fileChat.set(f.p, null); this.filePos.set(f.p, f.size); continue; }
        this.mergeFile(f.p, info, f.size, f.mtime);
      } catch (e) { logErr('quickScan', f.p, e.message); }
    }
    log(`[store] quick scan: ${this.chats.size} chats / ${files.length} files (子代理隐藏 ${skippedSub})`);
  }

  quickReadFile(file) {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(Math.min(QUICK_HEAD, fs.fstatSync(fd).size));
      fs.readSync(fd, head, 0, head.length, 0);
      const headLines = head.toString('utf8').split('\n');
      const first = parseLine(headLines[0]);
      if (!first || first.type !== 'session_meta') return null;
      const meta = classifyMeta(first.payload);
      if (!meta.chatKey) return null;

      // 找首条用户消息作为标题兜底;同时识别内部审查线程(guardian 等)
      let firstUser = '';
      for (let i = 1; i < headLines.length && !firstUser; i++) {
        const rec = parseLine(headLines[i]);
        if (!rec || rec.type !== 'response_item' || !rec.payload || rec.payload.type !== 'message' || rec.payload.role !== 'user') continue;
        const t = cleanUserText(require('./rollout').translate(rec)?.item?.t || '');
        if (t && t.length > 1) firstUser = t;
      }
      if (/^The following is the Codex agent history/i.test(firstUser)) return { meta: Object.assign({}, meta, { subagent: true }) };

      // 读尾部推状态
      const size = fs.fstatSync(fd).size;
      const tailLen = Math.min(QUICK_TAIL, size);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, size - tailLen);
      let tailLines = tail.toString('utf8').split('\n');
      if (tailLen < size && tailLines.length) tailLines = tailLines.slice(1); // 丢弃半行
      let status = 'idle', lastMsg = '', lastTs = meta.ts, tokens = null, lastError = '', lastDurMs = null, model = '', effort = '', approvalPolicy = '', sandbox = null;
      // 尾部可能全是工具输出；先取头部状态，避免漏掉任务开始后默认成空闲。
      for (const l of [...headLines, ...tailLines]) {
        const rec = parseLine(l);
        if (!rec) continue;
        const tr = translate(rec);
        if (!tr) continue;
        if (rec.timestamp) lastTs = Math.max(Date.parse(rec.timestamp) || 0, lastTs || 0);
        if (tr.status) status = tr.status;
        if (tr.status === 'error' && tr.message) lastError = tr.message;
        if (tr.status === 'idle' && tr.turnDone) {
          lastMsg = tr.turnDone.lastAgentMessage || '';
          lastDurMs = tr.turnDone.durationMs;
        }
        if (tr.tokens) tokens = tr.tokens;
        if (tr.turnCtx) {
          if(tr.turnCtx.approval)approvalPolicy=tr.turnCtx.approval;
          if(tr.turnCtx.sandbox)sandbox=tr.turnCtx.sandbox;
          if(tr.turnCtx.model)model=tr.turnCtx.model;
          if(tr.turnCtx.effort)effort=tr.turnCtx.effort;
        }
      }
      // 长时间无日志不证明任务已停止；由桌面轮次状态核对，避免误判长工具调用。
      return { meta, firstUser, status, lastMsg: lastMsg || firstUser, lastTs: lastTs || st.mtimeMs, tokens, lastError, lastDurMs, model, effort, approvalPolicy, sandbox };
    } finally { fs.closeSync(fd); }
  }

  mergeFile(file, info, size, mtime) {
    if (this.suppress && this.suppress.has(info.meta.chatKey)) {
      // app-server 交互会话由 AppServerLink 管理,文件层跳过避免重复
      this.fileChat.set(file, null);
      this.filePos.set(file, size);
      return;
    }
    let chat = this.chats.get(info.meta.chatKey);
    if (!chat) {
      chat = this.newChat(info.meta.chatKey, info.meta);
      this.chats.set(chat.id, chat);
      this.emit('new_chat', chat);
    }
    // 文件级信息
    if (!chat.files.find(f => f.path === file)) chat.files.push({ path: file, size });
    chat.files.sort((a, b) => a.path < b.path ? -1 : 1);
    if (!chat.cwd && info.meta.cwd) chat.cwd = info.meta.cwd;
    if (!chat.model && info.meta.model) chat.model = info.meta.model;
    if (!chat.origin) chat.origin = info.meta.originator;
    if (!chat.createdAt || (info.meta.ts && info.meta.ts < chat.createdAt)) chat.createdAt = info.meta.ts;
    // 取最新文件的状态
    if (info.lastTs >= (chat.lastTs || 0)) {
      if(info.approvalPolicy)chat.approvalPolicy=info.approvalPolicy;
      if(info.sandbox)chat.sandbox=info.sandbox;
      if (info.model) chat.model = info.model;
      if (info.effort) chat.effort = info.effort;
      chat.lastTs = info.lastTs;
      chat.status = info.status;
      chat.lastMsg = info.lastMsg;
      chat.lastDurMs = info.lastDurMs;
      if (info.tokens) chat.tokens = info.tokens;
      if (info.status === 'error' && info.lastError) chat.lastError = info.lastError;
    }
    if (info.firstUser && !chat.firstUser) chat.firstUser = info.firstUser;
    if (!chat.title) {
      const named = this.threadNames.get(chat.id) || (info.meta.fileId && this.threadNames.get(info.meta.fileId));
      if (named) { chat.title = named; chat.titleFrom = 'index'; }
    }
    this.fileChat.set(file, chat.id);
    this.filePos.set(file, size); // 摘要模式:先不增量解析,等打开或活动时再 tail
    chat._stale = true; // 摘要需重算
  }

  newChat(id, meta) {
    return {
      id, title: '', titleFrom: '', cwd: meta.cwd || '', project: basename(meta.cwd),
      origin: meta.originator, model: meta.model || '', cliVersion: meta.cliVersion || '',
      createdAt: meta.ts, lastTs: meta.ts, lastMsg: '', lastDurMs: null,
      status: 'idle', turns: 0, tokens: null, runningSince: null, lastError: '',
      files: [], items: null, seenIds: new Set(), trimmedHead: 0, detailed: false,
      firstUser: '', spawn: null, live: false,
    };
  }

  summary(chat) {
    const title = chat.title || truncate(chat.firstUser, 24) || '未命名任务';
    return {
      id: chat.id, title, titleFrom: chat.titleFrom, cwd: chat.cwd, project: chat.project || basename(chat.cwd),
      origin: chat.origin, model: chat.model, effort: chat.effort || '', status: chat.status,
      approvalPolicy:chat.approvalPolicy||'',sandbox:chat.sandbox||'',
      createdAt: chat.createdAt, lastTs: chat.lastTs, lastTsLabel: relTime(chat.lastTs),
      lastMsg: truncate(chat.lastMsg, 60), turns: chat.turns,
      tokens: chat.tokens, runningSince: chat.runningSince,
      pendingQuestions: (chat.items||[]).filter(x=>x.k==='askuser'&&!x.answers).length,
      durable: !!(chat.spawn), // 是否本守护进程发起(可远程停止)
      fileCount: chat.files.length,
    };
  }

  summaries() {
    const arr = [...this.chats.values()].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    return arr.slice(0, this.opts.maxChats).map(c => this.summary(c));
  }

  get(chatId) { return this.chats.get(chatId); }

  async reconcileStatuses(desktop) {
    if (this._reconciling) return;
    this._reconciling = true;
    try {
      for (const chat of this.chats.values()) {
        if (chat.status !== 'running' || chat.spawn) continue;
        this.ensureDetail(chat.id);
        if (chat.status !== 'running') continue;
        const version = chat._recordVersion || 0;
        const actual = await desktop.readStatus(chat.id);
        // 请求期间有新日志或新轮次时丢弃旧响应，避免把刚恢复的任务标成中断。
        if (!actual || version !== (chat._recordVersion || 0) || chat.status !== 'running' || chat.spawn) continue;
        if (actual.turnId !== chat.turnId) continue;
        if (actual.status === 'running') continue;
        chat.status = actual.status;
        chat.runningSince = null;
        if (actual.status === 'interrupted') chat.lastMsg = '任务已中断';
        if (actual.status === 'error') chat.lastMsg = '任务执行失败';
        if (actual.status === 'idle') chat.lastMsg = '任务已完成';
        chat._verifiedStatus = {status:chat.status,lastTs:chat.lastTs,turnId:chat.turnId,lastMsg:chat.lastMsg};
        // 状态补偿只更新快照，不重放完成通知或触发历史消息发送。
        this.emit('chat_update', this.summary(chat));
      }
    } finally { this._reconciling = false; }
  }

  // ---------- 增量 tail ----------
  poll() {
    const files = this.listFiles();
    for (const f of files) {
      const known = this.fileChat.get(f.p);
      if (known === null) continue; // 子代理,忽略
      const pos = this.filePos.get(f.p) || 0;
      if (f.size > pos) this.tailFile(f.p, known);
      else if (f.size < pos) this.filePos.set(f.p, 0); // 文件被截断,重读
    }
  }

  tailFile(file, knownChatId) {
    let pos = this.filePos.get(file) || 0;
    let chat = null;
    if (knownChatId) chat = this.chats.get(knownChatId);
    if (!chat) {
      // 新文件:先读头部识别
      const info = this.quickReadFile(file);
      if (!info) { this.fileChat.set(file, null); this.filePos.set(file, fs.statSync(file).size); return; }
      if (info.meta.subagent) { this.fileChat.set(file, null); this.filePos.set(file, fs.statSync(file).size); return; }
      this.mergeFile(file, info, 0, Date.now());
      chat = this.chats.get(info.meta.chatKey);
      pos = 0;
      this.filePos.set(file, 0);
      this.emit('chat_update', this.summary(chat));
      if (!chat._appearEmitted) { chat._appearEmitted = true; this.emit('chat_appear', chat); } // 供 runner 绑定
    }
    // 从 pos 读到末尾
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= pos) { fs.closeSync(fd); return; }
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      // 只消费完整行的原始字节；空尾行不能多算一个字节，中文半行留待下次读取。
      const consumed = buf.lastIndexOf(10) + 1;
      const usable = buf.subarray(0, consumed).toString('utf8').split('\n');
      for (const l of usable) {
        if (!l.trim()) continue;
        const rec = parseLine(l);
        if (rec) this.applyRecord(chat, rec, file);
      }
      this.filePos.set(file, pos + consumed);
      chat.lastFileTs = Date.now();
      if (chat._stale || true) this.emit('chat_update', this.summary(chat));
    } catch (e) {
      logErr('tailFile', file, e.message);
    } finally { try { fs.closeSync(fd); } catch {} }
  }

  // 应用一条记录到聊天(增量或全量)
  applyRecord(chat, rec, file) {
    chat._recordVersion = (chat._recordVersion || 0) + 1;
    const isMeta = rec.type === 'session_meta';
    if (isMeta) {
      const meta = classifyMeta(rec.payload);
      if (!chat.createdAt && meta.ts) chat.createdAt = meta.ts;
      if (!chat.cwd && meta.cwd) { chat.cwd = meta.cwd; chat.project = basename(meta.cwd); }
      if (!chat.model && meta.model) chat.model = meta.model;
      if (meta.fileId && !chat._fileIds) chat._fileIds = new Set();
      if (meta.fileId) chat._fileIds.add(meta.fileId);
      if (!chat.title) {
        const named = this.threadNames.get(chat.id) || (meta.fileId && this.threadNames.get(meta.fileId));
        if (named) { chat.title = named; chat.titleFrom = 'index'; }
      }
      chat.lastTs = Math.max(chat.lastTs || 0, meta.ts || 0);
      return;
    }
    const tr = translate(rec);
    if (!tr) return;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : Date.now();
    if (ts) chat.lastTs = Math.max(chat.lastTs || 0, ts);

    if (tr.item) {
      const it = tr.item;
      if (it.id && chat.seenIds.has(it.id)) return;
      if (it.id) chat.seenIds.add(it.id);
      if (it.k === 'user' && !chat.title) chat.firstUser = it.t.slice(0, 200);
      this.pushItem(chat, it, true);
      if (it.k === 'askuser') {
        if (!chat._replaying) this.emit('notify',{chatId:chat.id,level:'ask',title:'Codex 在等你回答',body:(it.questions[0]?.question||'打开聊天回答').slice(0,100),itemId:it.iid});
      }
      return;
    }
    if (tr.questionAnswers) {
      for (const it of chat.items || []) {
        if (it.k !== 'askuser') continue;
        it.answersById = it.answersById || {};
        for (const a of tr.questionAnswers) if (it.questions.some(q=>q.questionItemId===a.questionItemId)) it.answersById[a.questionItemId] = a.answer;
        if (it.questions.every(q=>Object.hasOwn(it.answersById,q.questionItemId))) { it.answers = it.questions.map(q=>it.answersById[q.questionItemId]);it.submitted=false; }
        if (!chat._replaying) this.emit('item_refresh',chat.id,it);
      }
      if (!chat._replaying) this.emit('chat_update',this.summary(chat));
      return;
    }
    if (tr.itemOut) {
      const items = chat.items;
      if (items) {
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].k === 'tool' && items[i].callId === tr.itemOut.callId) { items[i].out = tr.itemOut.out; break; }
        }
      }
      return;
    }
    if (tr.status === 'running') {
      chat.status = 'running';
      chat.turnId = tr.turnId;
      chat.runningSince = ts;
      chat.turns++;
      chat.lastMsg = '正在执行…';
      this.pushItem(chat, { k: 'sys', ts, t: '任务开始' }, true);
      return;
    }
    if (tr.status === 'idle' && tr.turnDone) {
      const done = tr.turnDone;
      chat.status = 'idle';
      chat.runningSince = null;
      chat.lastDurMs = done.durationMs;
      // 避免与 response_item 的 assistant 消息重复:若尾部已有相同开头文本则不再补
      let dup = false;
      if (chat.items && done.lastAgentMessage) {
        for (let i = chat.items.length - 1; i >= 0 && i >= chat.items.length - 4; i--) {
          const x = chat.items[i];
          if (x.k === 'agent' && done.lastAgentMessage.slice(0, 40) && x.t.startsWith(done.lastAgentMessage.slice(0, Math.min(40, x.t.length)))) { dup = true; break; }
        }
      }
      if (done.lastAgentMessage && !dup) this.pushItem(chat, { k: 'agent', ts, t: done.lastAgentMessage.slice(0, 6000) }, true);
      if (!done.lastAgentMessage && !dup) chat.lastMsg = '任务完成';
      else if (done.lastAgentMessage) chat.lastMsg = done.lastAgentMessage;
      const sec = done.durationMs != null ? Math.round(done.durationMs / 1000) + 's' : '';
      this.pushItem(chat, { k: 'sys', ts, t: '任务完成' + (sec ? ' · 用时 ' + sec : ''), done: true }, true);
      if (!chat._replaying) this.emit('notify', { chatId: chat.id, level: 'done', title: this.summary(chat).title, body: truncate(done.lastAgentMessage || '任务已完成', 90) });
      return;
    }
    if (tr.status === 'stopped') {
      chat.status = 'stopped';
      chat.runningSince = null;
      this.pushItem(chat, { k: 'sys', ts, t: '已中断' + (tr.reason ? '(' + tr.reason + ')' : '') }, true);
      if (!chat._replaying) this.emit('notify', { chatId: chat.id, level: 'warn', title: this.summary(chat).title, body: '任务被中断' });
      return;
    }
    if (tr.status === 'error') {
      chat.status = 'error';
      chat.runningSince = null;
      chat.lastError = tr.message;
      chat.lastMsg = '出错: ' + tr.message;
      this.pushItem(chat, { k: 'err', ts, t: tr.message.slice(0, 1500) }, true);
      if (!chat._replaying) this.emit('notify', { chatId: chat.id, level: 'error', title: this.summary(chat).title, body: truncate('任务出错: ' + tr.message, 90) });
      return;
    }
    if (tr.tokens) {
      chat.tokens = tr.tokens;
      return;
    }
    if (tr.turnCtx) {
      if(tr.turnCtx.approval)chat.approvalPolicy=tr.turnCtx.approval;
      if(tr.turnCtx.sandbox)chat.sandbox=tr.turnCtx.sandbox;
      if (tr.turnCtx.model) chat.model = tr.turnCtx.model;
      if (tr.turnCtx.effort) chat.effort = tr.turnCtx.effort;
      if (tr.turnCtx.cwd && !chat.cwd) { chat.cwd = tr.turnCtx.cwd; chat.project = basename(tr.turnCtx.cwd); }
      return;
    }
  }

  pushItem(chat, it, emit) {
    if (chat.items) {
      chat.items.push(it);
      if (chat.items.length > MAX_ITEMS) {
        const drop = chat.items.length - MAX_ITEMS;
        chat.items.splice(0, drop);
        chat.trimmedHead += drop;
      }
      if (emit && !chat._replaying) this.emit('item', chat.id, it);
    }
    // 摘要(未打开详情时也要更新预览)
    if (!emit) return;
    if (it.k === 'agent') chat.lastMsg = it.t;
    else if (it.k === 'user') chat.lastMsg = it.t;
    else if (it.k === 'tool') chat.lastMsg = '[' + (it.name || '工具') + '] ' + truncate(it.args || '', 40);
    else if (it.k === 'reason') chat.lastMsg = '[思考] ' + truncate(it.t, 40);
  }

  // ---------- 详情加载 ----------
  ensureDetail(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    if (chat.detailed) return chat;
    chat.items = [];
    chat.seenIds = new Set();
    chat.trimmedHead = 0;
    chat.turns = 0;
    // 历史解析只构建快照，不能广播新消息或触发历史完成事件的待发送队列。
    chat._replaying = true;
    try { for (const f of chat.files) {
      let bytes;
      try { bytes = fs.readFileSync(f.path); } catch { continue; }
      const consumed = bytes.lastIndexOf(10) + 1;
      const text = bytes.subarray(0, consumed).toString('utf8');
      for (const l of text.split('\n')) {
        if (!l.trim()) continue;
        const rec = parseLine(l);
        if (rec) this.applyRecord(chat, rec, f.path);
      }
      this.filePos.set(f.path, consumed);
    } } finally { chat._replaying = false; }
    chat.detailed = true;
    const verified = chat._verifiedStatus;
    if (verified && verified.lastTs === chat.lastTs && verified.turnId === chat.turnId) {
      chat.status = verified.status;
      chat.runningSince = null;
      chat.lastMsg = verified.lastMsg;
    }
    return chat;
  }

  itemsView(chat) {
    return {
      chatId: chat.id, detailed: true, trimmedHead: chat.trimmedHead,
      items: chat.items || [],
    };
  }

  // 常用目录(新建任务用)
  recentDirs() {
    const m = new Map();
    for (const c of this.chats.values()) {
      if (!c.cwd) continue;
      const cur = m.get(c.cwd) || { cwd: c.cwd, project: basename(c.cwd), lastTs: 0 };
      if ((c.lastTs || 0) > cur.lastTs) cur.lastTs = c.lastTs;
      m.set(c.cwd, cur);
    }
    return [...m.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, 12);
  }

  // 发现页统计
  stats() {
    const chats = [...this.chats.values()];
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    let doneToday = 0, running = 0, errors = 0, tokens = { in: 0, out: 0, total: 0 };
    const projects = new Map();
    for (const c of chats) {
      if (c.status === 'running') running++;
      if (c.tokens) { tokens.in += c.tokens.in; tokens.out += c.tokens.out; tokens.total += c.tokens.total; }
      if (c.cwd) {
        const p = projects.get(c.cwd) || { cwd: c.cwd, project: basename(c.cwd), chats: 0, running: 0 };
        p.chats++; if (c.status === 'running') p.running++;
        projects.set(c.cwd, p);
      }
    }
    return {
      totalChats: chats.length, running, tokens,
      projects: [...projects.values()].sort((a, b) => b.chats - a.chats).slice(0, 10),
      deviceTime: Date.now(),
    };
  }
}

module.exports = { ChatStore, basename };
