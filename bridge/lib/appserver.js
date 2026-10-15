'use strict';
// AppServerLink:桥接 codex app-server(独立实例,stdio JSON-RPC)。
// 提供:交互式会话(thread/start + turn/start)、实时 item 通知、命令授权、
// 运行中提问(request_user_input)、打断、每轮切换模型/思考程度。
// 与文件监听(ChatStore)并存:交互式会话在此管理,文件型会话仍走 watcher。

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { log, logErr, uuid, truncate, relTime } = require('./util');
const { basename: baseBasename } = require('./store');
const { attachmentPrompt } = require('./attachments');
const fs = require('fs');
const path = require('path');
const { codexHome } = require('./util');

// v2 ThreadItem → UI item 翻译(宽容处理未知类型)
function threadItemToUi(item) {
  if (!item || !item.type) return null;
  switch (item.type) {
    case 'agentMessage':
      if (!item.text) return null;
      return { k: 'agent', ts: null, t: String(item.text).slice(0, 6000), iid: item.id };
    case 'reasoning':
      if (!item.text && !item.reasoning) return null;
      return { k: 'reason', ts: null, t: String(item.text || item.reasoning || '').slice(0, 1200), iid: item.id };
    case 'userMessage': {
      let text = '';
      if (item.text) text = String(item.text);
      else if (Array.isArray(item.content)) text = item.content.map(c => (c && c.text) || '').join('');
      if (!text.trim()) return null;
      return { k: 'user', ts: null, t: text.slice(0, 4000), iid: item.id };
    }
    case 'commandExecution': {
      const ce = item;
      const args = [ce.command || ''].join(' ').slice(0, 800);
      const out = ce.aggregatedOutput ? String(ce.aggregatedOutput).slice(0, 1200) : '';
      return { k: 'tool', ts: null, callId: ce.id, name: 'shell', args, out, iid: item.id };
    }
    case 'mcpToolCall': {
      return { k: 'tool', ts: null, callId: item.id, name: item.tool || 'mcp', args: String(JSON.stringify(item.arguments || '')).slice(0, 800), out: item.output ? String(item.output).slice(0, 1200) : '', iid: item.id };
    }
    case 'webSearch':
      return { k: 'tool', ts: null, callId: item.id, name: 'web_search', args: String(item.query || ''), out: '', iid: item.id };
    case 'fileChange': {
      const n = (item.changes || []).length;
      return { k: 'tool', ts: null, callId: item.id, name: 'patch', args: n + ' 处文件修改', out: (item.rationale || '').slice(0, 300), iid: item.id };
    }
    case 'plan':
      return null; // 计划步骤暂不展示为消息
    case 'todoList':
      return null;
    default:
      return null;
  }
}

const APPROVAL_DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'];
const LEGACY_DECISION = { accept: 'approved', acceptForSession: 'approved_for_session', decline: 'denied', cancel: 'abort' };

class AppServerLink extends EventEmitter {
  constructor(codexJsPath, opts) {
    super();
    this.codexJs = codexJsPath;
    this.opts = opts || {};
    this.child = null;
    this.available = false;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();   // id -> {resolve, reject, timer}
    this.chats = new Map();     // threadId -> chat 对象
    this.openRequests = new Map(); // JSON-RPC 服务端请求 id -> {method, params, chatId, itemId}
    this.retry = 0;
    this.start();
    // 账号文件变更只比较元数据，不读取或记录凭据；有运行中任务时延后重启。
    this.authStamp = this.accountStamp();
    this.authTimer = setInterval(() => this.refreshAccount(), 3000);
    this.authTimer.unref();
  }

  accountStamp() {
    try { const s = fs.statSync(path.join(codexHome(), 'auth.json')); return s.mtimeMs + ':' + s.size; }
    catch { return 'missing'; }
  }
  refreshAccount() {
    const stamp = this.accountStamp();
    if (stamp === this.authStamp || [...this.chats.values()].some(c => ['running','waiting_approval','waiting_input'].includes(c.status))) return;
    this.authStamp = stamp;
    if (this.child && !this.child.killed) {
      log('[as] 登录状态变更，重载模型服务');
      this.available = false;
      this.child.kill();
    }
  }

  // ---------- 进程与协议 ----------
  start() {
    if (!this.codexJs) { log('[as] 无 codex.js,跳过 app-server'); return; }
    log('[as] 启动 codex app-server(独立实例)');
    let child;
    try {
      child = spawn(process.execPath, [this.codexJs, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { logErr('[as] 启动失败', e.message); return; }
    this.child = child;
    // 进程异常退出后写 stdin 会触发 EPIPE；不加监听会变成未捕获异常。
    child.stdin.on('error', () => {});
    child.on('error', (e) => logErr('[as] 进程错误', e.message));
    child.stdout.setEncoding('utf8');
    this.buf = '';
    child.stdout.on('data', d => { if (this.child === child) this.onStdout(d); });
    let errTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-500); });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.available = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('电脑模型服务正在重连，请稍后重试')); }
      this.pending.clear();
      this.recoverChatsAfterExit();
      this.emit('down');
      const wait = Math.min(5000 * ++this.retry, 60000);
      logErr('[as] 进程退出 code=' + code, errTail.slice(-120).replace(/\n/g, ' '));
      setTimeout(() => this.start(), wait);
    });
    this.handshake();
  }

  // app-server 重启后旧进程里的线程、轮次和待答请求全部失效：
  // 结束卡住的"运行中"状态、作废授权/提问卡片，并在下一条消息前 thread/resume 重新载入线程。
  recoverChatsAfterExit() {
    for (const [key, rec] of this.openRequests) {
      const chat = this.chats.get(rec.chatId);
      const item = chat && chat.items.find(x => x.iid === rec.itemId);
      if (item && item.decision == null && item.answers == null) { item.decision = 'expired'; this.emit('item_refresh', chat.id, item); }
      this.openRequests.delete(key);
    }
    for (const chat of this.chats.values()) {
      chat.needsResume = true;
      chat.starting = false;
      if (chat.compacting) chat.compacting = false;
      if (chat.turnId || ['running', 'waiting_approval', 'waiting_input'].includes(chat.status)) {
        chat.turnId = null;
        chat.runningSince = null;
        chat.status = 'interrupted';
        chat.lastMsg = '交互服务已重启，本轮已中断';
        this.sys(chat, '电脑交互服务已重启，本轮任务已中断；再发一条消息即可在原会话继续');
        this.emit('notify', { chatId: chat.id, level: 'warn', title: this.summary(chat).title, body: '交互服务已重启，本轮任务已中断' });
        this.emit('chat_update', this.summary(chat));
      }
    }
  }

  onStdout(d) {
    if (process.env.CW_AS_DEBUG) log('[as] RAW', JSON.stringify(String(d).slice(0, 160)));
    this.buf += d;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    if (msg.id != null && msg.method) {
      // 服务端请求(approval / user input / ...)
      this.onServerRequest(msg);
    } else if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'rpc error'));
        else p.resolve(msg.result);
      }
    } else if (msg.method) {
      this.onNotification(msg);
    }
  }

  send(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) return reject(new Error('app-server 未运行'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' 超时')); }, timeoutMs || 20000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
      } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  // JSON-RPC id 可以是数字或字符串：按原始值回复，不能一律 Number()。
  respond(reqId, result) {
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, result }) + '\n'); } catch {}
  }
  respondErr(reqId, message) {
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, error: { code: -32000, message } }) + '\n'); } catch {}
  }

  async handshake() {
    const child = this.child;
    try {
      const r = await this.send('initialize', { clientInfo: { name: 'CodexWatch', title: 'CodexWatch Bridge', version: '1.0.0' } }, 15000);
      if (this.child !== child || !child || child.killed) return false;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
      this.available = true;
      this.retry = 0;
      log('[as] 握手成功 codexHome=' + r.codexHome);
      this.emit('up');
      return true;
    } catch (e) {
      logErr('[as] 握手失败', e.message);
      return false;
    }
  }

  // ---------- 会话管理 ----------
  async listModels() {
    this.refreshAccount();
    if (!this.available) throw new Error('电脑登录状态正在更新，请稍后重新打开模型列表');
    const models = [];
    let cursor = null;
    do {
      const page = await this.send('model/list', { limit: 100, includeHidden: false, cursor }, 8000);
      models.push(...(page.data || []));
      cursor = page.nextCursor;
    } while (cursor && models.length < 500);
    return models;
  }

  async readLimits() {
    this.refreshAccount();
    if (!this.available) throw new Error('电脑登录状态正在更新，请稍后重试');
    const revision = this.accountStamp();
    const result = await this.send('account/rateLimits/read', {}, 10000);
    if (revision !== this.accountStamp()) throw new Error('电脑账号已变化，请刷新用量');
    return { ...result, accountRevision:revision };
  }
  async consumeReset(frame) {
    if (!frame.idempotencyKey || !/^[a-zA-Z0-9-]{16,80}$/.test(frame.idempotencyKey)) throw new Error('重置请求编号无效');
    this.refreshAccount();
    if (!this.available) throw new Error('电脑登录状态正在更新，请稍后重试');
    if (frame.accountRevision !== this.accountStamp()) throw new Error('电脑登录状态已变化，请刷新后重新确认');
    const params = { idempotencyKey:frame.idempotencyKey };
    if (frame.creditId) params.creditId = frame.creditId;
    return this.send('account/rateLimitResetCredit/consume', params, 15000);
  }
  newChat(threadId, meta) {
    return {
      id: threadId, src: 'as', title: meta.title || '', cwd: meta.cwd || '', project: meta.project || '',
      origin: 'appserver', model: meta.model || '', effort: meta.effort || '',
      status: 'idle', createdAt: Date.now(), lastTs: Date.now(), lastMsg: '', turns: 0,
      tokens: null, runningSince: null, turnId: null, items: [], seenIds: new Set(),
      approvalPolicy: meta.approvalPolicy || '', sandbox: meta.sandbox || '',
    };
  }

  summary(chat) {
    const title = chat.title || truncate(chat.firstUser || '', 24) || '交互任务';
    return {
      id: chat.id, src: 'as', title, cwd: chat.cwd, project: chat.project || baseBasename(chat.cwd),
      origin: chat.origin, model: chat.model, effort: chat.effort, status: chat.status,
      createdAt: chat.createdAt, lastTs: chat.lastTs, lastTsLabel: relTime(chat.lastTs),
      lastMsg: truncate(chat.lastMsg, 60), turns: chat.turns, tokens: chat.tokens,
      runningSince: chat.runningSince, durable: true, interactive: true, compacting:!!chat.compacting,
      approvalPolicy:chat.approvalPolicy,sandbox:chat.sandbox,
    };
  }

  pushItem(chat, it) {
    if (it.iid) {
      if (chat.seenIds.has(it.iid)) return;
      chat.seenIds.add(it.iid);
    }
    chat.items.push(it);
    if (chat.items.length > 2500) chat.items.splice(0, chat.items.length - 2500);
    this.emit('item', chat.id, it);
    if (it.k === 'agent') chat.lastMsg = it.t;
    else if (it.k === 'user') { chat.lastMsg = it.t; if (!chat.firstUser) chat.firstUser = it.t; }
    else if (it.k === 'tool') chat.lastMsg = '[' + it.name + '] ' + String(it.args || '').slice(0, 40);
    chat.lastTs = Date.now();
  }

  sys(chat, text, extra) {
    this.pushItem(chat, Object.assign({ k: 'sys', ts: Date.now(), t: text }, extra || {}));
  }

  async compactContext(threadId){
    const chat=this.chats.get(threadId);
    if(!this.available||!chat)throw Error('交互聊天服务暂不可用');
    if(chat.compacting||['running','waiting_input','waiting_approval'].includes(chat.status))throw Error('请等待当前任务或压缩完成后再操作');
    chat.compacting=true;
    try{await this.send('thread/compact/start',{threadId});this.emit('chat_update',this.summary(chat));}
    catch(e){chat.compacting=false;this.emit('chat_update',this.summary(chat));throw e;}
  }

  async startThread({ cwd, prompt, model, effort, sandbox, approvalPolicy }) {
    const startParams = {};
    if (cwd) startParams.cwd = cwd;
    if (model) startParams.model = model;
    if (sandbox && sandbox !== 'default') startParams.sandbox = sandbox;
    if (approvalPolicy) startParams.approvalPolicy = approvalPolicy;
    const t = await this.send('thread/start', startParams, 20000);
    const threadId = (t && t.thread && t.thread.id) || (t && (t.threadId || t.id)) || (typeof t === 'string' ? t : null);
    if (!threadId) throw new Error('thread/start 返回异常: ' + JSON.stringify(t).slice(0, 120));
    const chat = this.newChat(threadId, { cwd, model: t.model || model, effort: t.reasoningEffort || effort, approvalPolicy:t.approvalPolicy||approvalPolicy, sandbox:t.sandbox||sandbox });
    chat.project = require('./store').basename(cwd);
    this.chats.set(threadId, chat);
    this.emit('chat_new', chat);
    // 首条消息
    await this.sendTurn(threadId, prompt, { model, effort });
    return chat;
  }

  async sendTurn(threadId, text, opts) {
    const o = opts || {};
    if(o.approvalPolicy&&!['on-request','never'].includes(o.approvalPolicy))throw Error('不支持的审批模式');
    const attachments = o.attachments || [];
    const chat = this.chats.get(threadId);
    if (chat && (chat.turnId || chat.starting)) {
      chat.pendingTurns = chat.pendingTurns || [];
      chat.pendingTurns.push({ text, opts: o });
      this.sys(chat, '已加入队列，当前任务结束后自动发送');
      return { queued: true };
    }
    if (chat && chat.needsResume) {
      if (!this.available) throw new Error('电脑交互服务正在重启，请稍后重试');
      chat.starting = true;
      try { await this.send('thread/resume', { threadId }, 20000); chat.needsResume = false; }
      catch (e) { throw new Error('交互会话恢复失败：' + e.message); }
      finally { chat.starting = false; }
    }
    const params = {
      threadId,
      input: [{ type: 'text', text: attachmentPrompt(text, attachments) }, ...attachments.filter(f => f.image).map(f => ({ type: 'localImage', path: f.path }))],
    };
    if (o.model) params.model = o.model;
    if (o.effort) params.effort = o.effort;
    if (o.approvalPolicy) params.approvalPolicy = o.approvalPolicy;
    if (chat) chat.starting = true;
    try {
      const r = await this.send('turn/start', params, 15000);
      if (chat) {
        if (r.turn && r.turn.id) chat.turnId = r.turn.id;
        if (o.model) chat.model = o.model;
        if (o.effort) chat.effort = o.effort;
        if(o.approvalPolicy)chat.approvalPolicy=o.approvalPolicy;
        this.emit('chat_update', this.summary(chat));
      }
      return r;
    } finally { if (chat) chat.starting = false; }
  }

  async interrupt(threadId) {
    const chat = this.chats.get(threadId);
    if (!chat || !chat.turnId) return false;
    try { await this.send('turn/interrupt', { threadId, turnId: chat.turnId }, 8000); return true; }
    catch { return false; }
  }

  // ---------- 通知 ----------
  onNotification(msg) {
    const m = msg.method, p = msg.params || {};
    const threadId = p.threadId || (p.thread && p.thread.id) || (p.turn && p.turn.threadId) || null;
    if (m === 'thread/started') {
      const tid = (p.thread && p.thread.id) || p.threadId;
      if (tid && !this.chats.has(tid)) {
        // 不是我们发起的(理论上不会发生,独立实例)
        const chat = this.newChat(tid, { cwd: p.thread && p.thread.cwd });
        this.chats.set(tid, chat);
        this.emit('chat_new', chat);
      }
      return;
    }
    const chat = threadId ? this.chats.get(threadId) : null;
    if (!chat) {
      if (/^(turn|item)\//.test(m)) log('[as] 未匹配通知丢弃:', m, 'tid=' + String(threadId).slice(0, 8), 'chats=' + this.chats.size);
      return;
    }
    switch (m) {
      case 'turn/started': {
        chat.turnId = p.turnId || (p.turn && p.turn.id);
        chat.status = 'running';
        chat.runningSince = Date.now();
        chat.turns++;
        chat.lastMsg = '正在执行…';
        this.sys(chat, '任务开始');
        this.emit('chat_update', this.summary(chat));
        break;
      }
      case 'item/started': {
        if(p.item?.type==='contextCompaction'){chat.compacting=true;this.sys(chat,'正在压缩上下文…');this.emit('chat_update',this.summary(chat));break;}
        const it = threadItemToUi(p.item);
        if (it) this.pushItem(chat, it);
        break;
      }
      case 'item/completed': {
        if(p.item?.type==='contextCompaction'){chat.compacting=false;this.sys(chat,'上下文压缩完成',{done:true});this.emit('chat_update',this.summary(chat));break;}
        const it = threadItemToUi(p.item);
        if (it) {
          // 更新已有(iid 命中去重后重写尾部)
          const exist = chat.items.find(x => x.iid === it.iid);
          if (exist) Object.assign(exist, it);
          else this.pushItem(chat, it);
          this.emit('item_refresh', chat.id, exist || it);
        }
        break;
      }
      case 'item/agentMessage/delta': {
        // 流式:追加到同一 itemId 的 agent 气泡（中间可能插入思考/工具条目，只回看最近几条）
        const last = this.recentItem(chat, p.itemId, 'agent');
        if (last) {
          last.t += String(p.delta || '');
          if (last.t.length > 6000) last.t = last.t.slice(0, 6000);
          chat.lastMsg = last.t;
          this.emit('item_refresh', chat.id, last);
        } else {
          const it = { k: 'agent', ts: Date.now(), t: String(p.delta || ''), iid: p.itemId };
          this.pushItem(chat, it);
        }
        chat.lastTs = Date.now();
        break;
      }
      case 'item/reasoning/summaryTextDelta': {
        const last = this.recentItem(chat, p.itemId, 'reason');
        if (last) {
          last.t += String(p.delta || '');
          this.emit('item_refresh', chat.id, last);
        } else if (p.delta) {
          this.pushItem(chat, { k: 'reason', ts: Date.now(), t: String(p.delta), iid: p.itemId });
        }
        break;
      }
      case 'item/commandExecution/outputDelta': {
        const target = chat.items.find(x => x.iid === p.itemId);
        if (target) { target.out = (target.out || '') + String(p.delta || ''); if (target.out.length > 1200) target.out = target.out.slice(-1200); this.emit('item_refresh', chat.id, target); }
        break;
      }
      case 'turn/completed': {
        if(chat.compacting){chat.compacting=false;this.sys(chat,'压缩流程已结束，未收到压缩完成确认');}
        // v2 协议把结果放在 turn.status（completed / interrupted / failed），旧版用 reason。
        const turnStatus = String((p.turn && p.turn.status) || p.status || '');
        const reason = String(p.reason || '');
        const turnId = (p.turn && p.turn.id) || p.turnId || chat.turnId || '';
        chat.turnId = null;
        chat.runningSince = null;
        this.expireRequests(chat.id);
        if (/interrupt/i.test(turnStatus) || /interrupt/i.test(reason)) {
          chat.status = 'stopped';
          this.sys(chat, '已中断');
          this.emit('notify', { chatId: chat.id, level: 'warn', itemId: turnId + ':stop', title: this.summary(chat).title, body: '任务已中断' });
        } else if (/fail/i.test(turnStatus)) {
          const message = String((p.turn && p.turn.error && p.turn.error.message) || '任务执行失败');
          chat.status = 'error';
          chat.lastMsg = '出错: ' + message;
          this.pushItem(chat, { k: 'err', ts: Date.now(), t: message.slice(0, 800) });
          this.emit('notify', { chatId: chat.id, level: 'error', itemId: turnId + ':err', title: this.summary(chat).title, body: '任务出错: ' + message.slice(0, 80) });
        } else {
          chat.status = 'idle';
          const usage = p.usage || {};
          if (usage.inputTokens != null) chat.tokens = { in: usage.inputTokens, out: usage.outputTokens, total: (usage.inputTokens || 0) + (usage.outputTokens || 0) };
          this.sys(chat, '任务完成', { done: true });
          this.emit('notify', { chatId: chat.id, level: 'done', itemId: turnId || null, title: this.summary(chat).title, body: this.summary(chat).lastMsg || '任务已完成' });
        }
        this.emit('chat_update', this.summary(chat));
        this.emit('turn_done', chat.id);
        const pending = (chat.pendingTurns || []).shift();
        if (pending) setImmediate(() => this.sendTurn(chat.id, pending.text, pending.opts).catch(e => this.sys(chat, '排队消息发送失败：' + e.message)));
        break;
      }
      case 'thread/name/updated': {
        if (p.name) { chat.title = p.name; this.emit('chat_update', this.summary(chat)); }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const u = p.usage || p.tokenUsage || {};
        const total = u.total || u, last = u.last || {};
        chat.tokens = { in:total.inputTokens ?? null, out:total.outputTokens ?? null, total:total.totalTokens ?? null, ctx:u.modelContextWindow ?? null, lastTotal:last.totalTokens ?? null };
        this.emit('chat_update', this.summary(chat));
        break;
      }
      case 'error': {
        // v2: { error: { message }, willRetry }；willRetry=true 是可自动恢复的临时错误（如限流重试），不能把任务标成失败。
        const message = String((p.error && p.error.message) || p.message || '未知错误');
        if (p.willRetry) { this.sys(chat, '临时错误，Codex 正在自动重试：' + message.slice(0, 200)); break; }
        chat.compacting=false;
        chat.status = 'error';
        chat.runningSince = null;
        this.pushItem(chat, { k: 'err', ts: Date.now(), t: message.slice(0, 800) });
        this.emit('notify', { chatId: chat.id, level: 'error', title: this.summary(chat).title, body: '任务出错: ' + message.slice(0, 80) });
        this.emit('chat_update', this.summary(chat));
        break;
      }
      default:
        break;
    }
  }

  // ---------- 服务端请求(授权/提问) ----------
  onServerRequest(msg) {
    const m = msg.method, p = msg.params || {};
    const threadId = p.threadId || (p.thread && p.thread.id) || null;
    const chat = threadId ? this.chats.get(threadId) : null;
    if (m === 'item/commandExecution/requestApproval' || m === 'execCommandApproval' || m === 'applyPatchApproval' || m === 'item/fileChange/requestApproval' || m === 'item/permissions/requestApproval') {
      const command = p.command || (p.item && p.item.command) || '';
      const item = {
        k: 'approval', ts: Date.now(), iid: 'appr-' + (p.itemId || msg.id), reqId: String(msg.id),
        title: m === 'item/fileChange/requestApproval' ? '文件修改授权' : '命令授权',
        command: String(command).slice(0, 1200), cwd: p.cwd || (chat && chat.cwd) || '',
      };
      this.openRequests.set(String(msg.id), { method: m, params: p, chatId: threadId, itemId: item.iid, kind: 'approval', rawId: msg.id });
      if (chat) {
        this.pushItem(chat, item);
        chat.status = 'waiting_approval';
        this.emit('chat_update', this.summary(chat));
        this.emit('notify', {
          chatId: chat.id, level: 'ask', itemId: item.iid, title: '需要你的授权',
          body: String(command).slice(0, 80) || 'Codex 请求执行操作',
        });
      }
      return; // 挂起等待手机回复
    }
    if (m === 'item/tool/requestUserInput' || m === 'tool/requestUserInput') {
      const questions = (p.questions || []).map(q => ({
        id: q.id, header: q.header || '', question: q.question || '',
        options: (q.options || []).map(o => ({ label: o.label, description: o.description || '' })),
        isOther: !!q.isOther, isSecret: !!q.isSecret,
      }));
      const item = {
        k: 'askuser', ts: Date.now(), iid: 'ask-' + (p.itemId || msg.id), reqId: String(msg.id),
        blocking: !!p.isBlocking, questions,
      };
      this.openRequests.set(String(msg.id), { method: m, params: p, chatId: threadId, itemId: item.iid, kind: 'askuser', rawId: msg.id });
      if (chat) {
        this.pushItem(chat, item);
        chat.status = 'waiting_input';
        this.emit('chat_update', this.summary(chat));
        this.emit('notify', {
          chatId: chat.id, level: 'ask', itemId: item.iid, title: 'Codex 在等你回答',
          body: (questions[0] && questions[0].question || '').slice(0, 80) || '点击进入回答',
        });
      }
      return;
    }
    // 其余服务端请求一律礼貌拒绝,避免会话卡死
    log('[as] 拒绝未知服务端请求', m);
    this.respondErr(msg.id, 'unsupported by CodexWatch');
  }

  // 手机端回答
  answerApproval(key, decision) {
    const rec = this.openRequests.get(key);
    if (!rec) return { ok: false, error: '该请求已失效(可能已处理或超时)' };
    if (rec.kind && rec.kind !== 'approval') return { ok: false, error: '该请求不是授权请求' };
    if (!APPROVAL_DECISIONS.includes(decision)) return { ok: false, error: '不支持的授权决定' };
    this.openRequests.delete(key);
    const chat = this.chats.get(rec.chatId);
    if (chat) {
      const item = chat.items.find(x => x.iid === rec.itemId && (x.k === 'approval' || x.k === 'askuser'));
      if (item) { item.decision = decision; this.emit('item_refresh', chat.id, item); }
      if (chat.status === 'waiting_approval' || chat.status === 'waiting_input') { chat.status = 'running'; this.emit('chat_update', this.summary(chat)); }
    }
    // 旧版 execCommandApproval/applyPatchApproval 使用 approved/denied/abort 取值。
    const legacy = rec.method === 'execCommandApproval' || rec.method === 'applyPatchApproval';
    this.respond(rec.rawId != null ? rec.rawId : key, { decision: legacy ? LEGACY_DECISION[decision] : decision });
    return { ok: true };
  }

  answerUserInput(key, answers) {
    const rec = this.openRequests.get(key);
    if (!rec) return { ok: false, error: '该提问已失效' };
    if (rec.kind && rec.kind !== 'askuser') return { ok: false, error: '该请求不是提问' };
    const questions = rec.params.questions || [];
    if (!Array.isArray(answers) || answers.length!==questions.length || answers.some(a=>typeof a!=='string'||!a.trim())) return {ok:false,error:'请回答全部问题'};
    this.openRequests.delete(key);
    const chat = this.chats.get(rec.chatId);
    if (chat) {
      const item = chat.items.find(x => x.iid === rec.itemId && x.k === 'askuser');
      if (item) {
        item.answers = answers;
        const txt = answers.map(a => String(a).slice(0, 200)).join(' / ');
        this.pushItem(chat, { k: 'user', ts: Date.now(), t: txt });
        this.emit('item_refresh', chat.id, item);
      }
      if (chat.status === 'waiting_input') { chat.status = 'running'; this.emit('chat_update', this.summary(chat)); }
    }
    this.respond(rec.rawId != null ? rec.rawId : key, { answers: Object.fromEntries(questions.map((q,i)=>[q.id,{answers:[answers[i]]}])) });
    return { ok: true };
  }

  recentItem(chat, iid, kind) {
    if (!iid) return null;
    for (let i = chat.items.length - 1; i >= 0 && i >= chat.items.length - 30; i--) {
      const x = chat.items[i];
      if (x.iid === iid && x.k === kind) return x;
    }
    return null;
  }

  // 轮次结束后仍挂着的授权/提问已无意义，标记失效，避免手机上还能点。
  expireRequests(chatId) {
    for (const [key, rec] of this.openRequests) {
      if (rec.chatId !== chatId) continue;
      this.openRequests.delete(key);
      const chat = this.chats.get(chatId);
      const item = chat && chat.items.find(x => x.iid === rec.itemId);
      if (item && item.decision == null && item.answers == null) { item.decision = 'expired'; this.emit('item_refresh', chatId, item); }
    }
  }

  itemsView(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    return { chatId, detailed: true, trimmedHead: 0, items: chat.items, summary: this.summary(chat) };
  }

  summaries() {
    return [...this.chats.values()].map(c => this.summary(c));
  }
}

module.exports = { AppServerLink };
