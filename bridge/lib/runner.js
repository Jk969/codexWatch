'use strict';
// Runner:发起/恢复/排队/停止 Codex 任务。
// 通过 node 直接运行 codex.js,避免 shell 引号问题;停止用 taskkill 杀进程树。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { EventEmitter } = require('events');
const { log, logErr, uuid, truncate } = require('./util');
const { attachmentPrompt } = require('./attachments');
const { DesktopLink } = require('./desktop');

function startupError(text, code) {
  if (/already has an active writer|thread-store conflict/i.test(text)) return '该聊天由桌面 Codex 持有，当前未能连接桌面消息接口；文字已保留，请检查桌面服务';
  return 'Codex 未开始处理: ' + (text.trim() || ('进程退出 ' + code)).slice(-250);
}

const IS_WIN = process.platform === 'win32';

function findCodexJs() {
  if (process.env.CODEXWATCH_CODEX_JS) return process.env.CODEXWATCH_CODEX_JS;
  const cands = [];
  try {
    const out = execSync(IS_WIN ? 'where codex.cmd' : 'which codex', { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) {
      const p = line.trim();
      if (!p) continue;
      const dir = path.dirname(p);
      cands.push(path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
      // macOS/Linux 的 bin/codex 通常是指向 codex.js 的软链接
      try { const real = fs.realpathSync(p); if (/codex\.js$/.test(real)) cands.unshift(real); } catch {}
      cands.push(path.join(dir, '..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    }
  } catch {}
  cands.push(path.join('D:', 'soft', 'nvm4w', 'nodejs', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

class Runner extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.desktop = new DesktopLink();
    this.codexJs = findCodexJs();
    this.pending = new Map(); // ref -> spawn record
    this.spawnedByChat = new Map(); // chatId -> spawn record
    store.on('chat_appear', (chat) => this.tryBindNew(chat));
    store.on('chat_update', (s) => this.tryBindRunning(s));
    // 完成/出错后继续发送排队消息；被中断视为用户主动停止，取消排队并提示原文，避免消息永远卡在队列里。
    store.on('notify', (n) => {
      if (n.level === 'done' || n.level === 'error') this.drainPending(n.chatId);
      else if (n.level === 'warn') this.cancelPending(n.chatId, '任务已中断');
    });
    log('[runner] codex.js =', this.codexJs || '(未找到,降级 cmd)');
  }

  spawnCodex(args, opts) {
    const base = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !IS_WIN }; // stdin 必须忽略:codex exec 会尝试读 stdin；非 Windows 独立进程组便于整组停止
    if (this.codexJs) {
      return spawn(process.execPath, [this.codexJs, ...args], Object.assign(base, opts));
    }
    return spawn('cmd.exe', ['/d', '/s', '/c', 'codex', ...args.map(a => /[\s"^&|<>]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a)], Object.assign(base, opts));
  }

  // ---------- 新任务 ----------
  newTask({ cwd, prompt, model, effort, sandbox, resumeOf, attachments = [] }) {
    if (!prompt || !String(prompt).trim()) return { ok: false, error: '指令不能为空' };
    prompt = String(prompt).trim();
    prompt = attachmentPrompt(prompt, attachments);
    const ref = uuid();
    const args = ['exec'];
    if (resumeOf) args.push('resume', resumeOf, '--skip-git-repo-check');
    else {
      if (!cwd) return { ok: false, error: '请选择工作目录' };
      try { if (!fs.statSync(cwd).isDirectory()) throw 0; } catch { return { ok: false, error: '目录不存在: ' + cwd }; }
      args.push('--cd', cwd, '--skip-git-repo-check');
    }
    // resume 的参数集合与 exec 不同，不能把 --color 等 exec 专用参数放在 resume 后。
    if (!resumeOf) args.push('--color', 'never');
    args.push('--json');
    if (model) args.push('-m', model);
    if (effort) args.push('-c', 'model_reasoning_effort="' + effort + '"');
    if (sandbox && !resumeOf) args.push('-s', sandbox);
    for (const file of attachments.filter(f => f.image)) args.push('--image', file.path);
    const lastMsgFile = path.join(os.tmpdir(), 'cw-lastmsg-' + ref + '.txt');
    args.push('-o', lastMsgFile);
    // 以 "-" 开头的指令（如 "-h 是什么意思"）会被当成命令行参数，用 "--" 结束选项解析。
    if (prompt.startsWith('-')) args.push('--');
    args.push(prompt);

    let child;
    try { child = this.spawnCodex(args, { cwd: undefined, env: process.env }); }
    catch (e) { return { ok: false, error: '启动失败: ' + e.message }; }

    const rec = { ref, cwd: resumeOf ? null : cwd, prompt, resumeOf: resumeOf || null, child, startedAt: Date.now(), boundChatId: null, lastMsgFile, stderr: '' };
    rec.started = new Promise(resolve => { rec.confirmStart = resolve; });
    let output = '';
    child.stdout.on('data', data => {
      output += data.toString();
      let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        try { if (JSON.parse(line).type === 'turn.started') rec.confirmStart({ ok: true }); } catch {}
      }
    });
    child.on('error', e => { rec.stderr = e.message; rec.confirmStart({ ok: false, error: '启动失败: ' + e.message }); });
    this.pending.set(ref, rec);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { rec.stderr = (rec.stderr + d).slice(-2000); });
    child.on('exit', (code) => this.onChildExit(rec, code));
    log('[runner] spawn', ref.slice(0, 8), resumeOf ? ('resume ' + resumeOf.slice(0, 8)) : cwd, 'pid=' + child.pid);
    return { ok: true, ref, pid: child.pid };
  }

  onChildExit(rec, code) {
    rec.confirmStart({ ok: false, error: startupError(rec.stderr, code) });
    this.pending.delete(rec.ref);
    // -o 输出的最后一条消息只用于调试，进程退出后删除，避免临时目录堆积。
    fs.unlink(rec.lastMsgFile, () => {});
    // resume 很快结束时，轮询可能还没看到 running 状态就退出了：正常退出不算启动失败。
    if (!rec.boundChatId && rec.resumeOf && code === 0) {
      setTimeout(() => this.drainPending(rec.resumeOf), 1500).unref();
      return;
    }
    if (!rec.boundChatId) {
      // 没有产生会话文件 → 启动失败,直接通知
      if (code !== 0) {
        logErr('[runner] 任务启动失败', code, rec.stderr.slice(-300));
        this.emit('spawn_failed', { ref: rec.ref, cwd: rec.cwd, code, stderr: rec.stderr });
      } else {
        this.emit('spawn_failed', { ref: rec.ref, cwd: rec.cwd, code: 0, stderr: '会话已结束但未找到会话文件(--ephemeral?)' });
      }
      return;
    }
    this.spawnedByChat.delete(rec.boundChatId);
    const chat = this.store.get(rec.boundChatId);
    if (chat) {
      chat.spawn = null;
      // 进程退出但状态仍是 running(被强杀)→ 标记中断
      setTimeout(() => {
        const c2 = this.store.get(rec.boundChatId);
        if (c2 && c2.status === 'running') {
          c2.status = 'interrupted';
          this.store.pushItem(c2, { k: 'sys', ts: Date.now(), t: '进程已退出(状态:中断)' }, true);
          this.store.emit('chat_update', this.store.summary(c2));
        }
      }, 3000).unref();
    }
  }

  // ---------- 绑定新出现的会话 ----------
  tryBindNew(chat) {
    for (const rec of this.pending.values()) {
      if (rec.resumeOf || rec.boundChatId) continue;
      if (!rec.cwd || !chat.cwd) continue;
      const same = rec.cwd.toLowerCase() === String(chat.cwd).toLowerCase();
      const fresh = Date.now() - rec.startedAt < 120e3;
      if (same && fresh) {
        rec.boundChatId = chat.id;
        chat.spawn = { pid: rec.child.pid, ref: rec.ref, startedAt: rec.startedAt };
        this.spawnedByChat.set(chat.id, rec);
        log('[runner] 绑定新会话', chat.id.slice(0, 8), 'pid=' + rec.child.pid);
        this.emit('bound', chat.id);
        this.store.emit('chat_update', this.store.summary(chat));
        return;
      }
    }
  }

  // resume 型:目标聊天转为 running 时绑定
  tryBindRunning(summary) {
    if (summary.status !== 'running') return;
    for (const rec of this.pending.values()) {
      if (!rec.resumeOf || rec.boundChatId) continue;
      if (rec.resumeOf === summary.id && Date.now() - rec.startedAt < 180e3) {
        const chat = this.store.get(summary.id);
        if (!chat) continue;
        rec.boundChatId = chat.id;
        chat.spawn = { pid: rec.child.pid, ref: rec.ref, startedAt: rec.startedAt };
        this.spawnedByChat.set(chat.id, rec);
        log('[runner] 绑定resume会话', chat.id.slice(0, 8), 'pid=' + rec.child.pid);
        this.emit('bound', chat.id);
        return;
      }
    }
  }

  // ---------- 追加指令 ----------
  async sendMsg(chatId, text, opts) {
    if (!text || !String(text).trim()) return { ok: false, error: '内容为空' };
    text = String(text).trim();
    const o = opts || {};
    const chat = this.store.get(chatId);
    if (!chat) return { ok: false, error: '会话不存在' };
    if (this.desktop) {
      const result = await this.desktop.sendIfOwned(chatId, text, o);
      if (result) {
        log('[runner] desktop message', chatId.slice(0, 12), result.ok ? 'accepted' : 'unconfirmed');
        return result;
      }
    }
    if (chat.status === 'running') {
      // 运行中:先试 codex queue 注入;失败则本地排队,任务结束后自动 resume 发送
      const q = o.attachments?.length || o.model || o.effort ? { ok: false } : await this.queueMessage(chatId, text);
      if (q.ok) return q;
      chat.pendingMsgs = chat.pendingMsgs || [];
      chat.pendingMsgs.push({ text, opts: o });
      this.store.pushItem(chat, { k: 'sys', ts: Date.now(), t: '已加入队列,当前任务结束后自动发送(' + chat.pendingMsgs.length + ' 条)' }, true);
      this.store.emit('chat_update', this.store.summary(chat));
      return { ok: true, mode: 'local_queue' };
    }
    const r = this.newTask({ resumeOf: chatId, prompt: text, model: o.model, effort: o.effort, sandbox: o.sandbox, attachments: o.attachments });
    if (r.ok) {
      const rec = this.pending.get(r.ref);
      let timer;
      const started = await Promise.race([rec.started, new Promise(resolve => {
        timer = setTimeout(() => resolve({ ok: false, error: 'Codex 启动尚未确认，请检查电脑任务状态，避免重复发送' }), 25000);
      })]);
      clearTimeout(timer);
      if (!started.ok) return started;
      this.store.pushItem(chat, { k: 'sys', ts: Date.now(), t: o.model ? ('已发送(模型: ' + o.model + (o.effort ? ' / ' + o.effort : '') + ')') : '已发送指令,任务开始…' }, true);
      return { ok: true, mode: 'resume', ref: r.ref };
    }
    return r;
  }

  // 任务结束后自动发送本地排队的消息
  drainPending(chatId) {
    const chat = this.store.get(chatId);
    if (!chat || !chat.pendingMsgs || !chat.pendingMsgs.length) return;
    if (chat.status === 'running') return;
    const entry = chat.pendingMsgs.shift();
    const text = typeof entry === 'string' ? entry : entry.text;
    const opts = typeof entry === 'string' ? {} : entry.opts;
    const fail = (error) => {
      // 排队消息发送失败不能静默丢弃：写入聊天并通知手机，方便用户重发。
      const c = this.store.get(chatId);
      if (c) {
        this.store.pushItem(c, { k: 'err', ts: Date.now(), t: '排队消息发送失败：' + error + '\n原文：' + truncate(text, 200) }, true);
        this.store.emit('chat_update', this.store.summary(c));
      }
      this.emit('notify', { chatId, level: 'error', title: '排队消息未发送', body: truncate(String(error || ''), 80) });
    };
    setImmediate(() => this.sendMsg(chatId, text, opts).then(r => { if (r && r.ok === false) fail(r.error || '未知错误'); }).catch(e => fail(e.message)));
  }

  cancelPending(chatId, reason) {
    const chat = this.store.get(chatId);
    if (!chat || !chat.pendingMsgs || !chat.pendingMsgs.length) return;
    const texts = chat.pendingMsgs.map(e => typeof e === 'string' ? e : e.text);
    chat.pendingMsgs = [];
    this.store.pushItem(chat, { k: 'sys', ts: Date.now(), t: reason + '，已取消 ' + texts.length + ' 条排队消息：' + texts.map(t => truncate(t, 40)).join(' / ') }, true);
    this.store.emit('chat_update', this.store.summary(chat));
  }

  queueMessage(chatId, text) {
    return new Promise((resolve) => {
      let child;
      try { child = this.spawnCodex(['queue', '--thread', chatId, '--message', text], { env: process.env }); }
      catch (e) { return resolve({ ok: false, error: 'queue 启动失败: ' + e.message }); }
      let out = '', err = '', settled = false;
      const finish = (r) => { if (!settled) { settled = true; clearTimeout(t); resolve(r); } };
      const t = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, error: 'queue 超时' }); }, 20e3);
      child.stdout.on('data', d => { out = (out + d).slice(-4000); });
      child.stderr.on('data', d => { err = (err + d).slice(-4000); });
      // 没有 error 监听时，启动失败会抛出未捕获异常且 Promise 永不结束。
      child.on('error', e => finish({ ok: false, error: 'queue 启动失败: ' + e.message }));
      child.on('exit', (code) => {
        if (settled) return;
        clearTimeout(t);
        const chat = this.store.get(chatId);
        if (code === 0) {
          if (chat) this.store.pushItem(chat, { k: 'sys', ts: Date.now(), t: '已加入会话队列: ' + truncate(text, 40) }, true);
          finish({ ok: true, mode: 'queue' });
        } else {
          finish({ ok: false, error: '无法注入运行中的会话(exit ' + code + '): ' + truncate((err || out).slice(-200), 150) + '。可等任务结束后再发。' });
        }
      });
    });
  }

  // ---------- 停止 ----------
  stop(chatId) {
    const chat = this.store.get(chatId);
    if (!chat) return { ok: false, error: '会话不存在' };
    const rec = this.spawnedByChat.get(chatId);
    const pid = chat.spawn ? chat.spawn.pid : (rec ? rec.child.pid : null);
    if (!pid) return { ok: false, error: '该会话不是本守护进程发起的,无法远程停止(可在电脑上手动结束)' };
    try {
      if (IS_WIN) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
      else {
        // 子进程以独立进程组启动时可整组结束；否则退回只结束该进程。
        try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
      }
    } catch (e) { return { ok: false, error: '停止失败: ' + e.message }; }
    chat.status = 'stopped';
    chat.runningSince = null;
    this.store.pushItem(chat, { k: 'sys', ts: Date.now(), t: '已远程停止' }, true);
    this.cancelPending(chatId, '任务已远程停止');
    this.store.emit('chat_update', this.store.summary(chat));
    this.emit('notify', { chatId, level: 'warn', title: this.store.summary(chat).title, body: '任务已远程停止' });
    return { ok: true };
  }
}

module.exports = { Runner, startupError };
