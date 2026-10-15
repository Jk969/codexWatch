'use strict';
// Hub:业务中枢。所有客户端(本机浏览器 / 云端中继背后的手机)的帧都到这里处理,
// 并把广播发到所有已连接客户端。数据源:文件监听(ChatStore)+ app-server 交互会话。

const { log } = require('./util');
const { spawnSync } = require('child_process');
const { Attachments } = require('./attachments');
const { browseDirectories,browseWorkspace,resolveReferences,previewWorkspaceFile,readWorkspaceChunk } = require('./directories');

class Hub {
  constructor(store, runner, as) {
    this.store = store;
    this.runner = runner;
    this.as = as || null;
    this.attachments = new Attachments();
    this.sinks = new Set(); // {send(frame), label}
    this.shutdown = null;   // {chatId, delayMs, phase: waiting|countdown, deadline}
    this.bind();
  }

  bind() {
    const store = this.store;
    store.on('chat_update', (s) => { this.broadcast({ t: 'chat_update', chat: s }); this.checkShutdownDone(s && s.id, s && s.status); });
    store.on('item', (chatId, item) => this.broadcast({ t: 'item', chatId, item }));
    store.on('item_refresh', (chatId, item) => this.broadcast({t:'item_refresh',chatId,item}));
    store.on('notify', (n) => this.broadcast({ t: 'notify', d: Object.assign({ nid: n.chatId + ':' + (n.turnId || Date.now()), ts: Date.now() }, n) }));
    this.runner.on('notify', (n) => this.broadcast({ t: 'notify', d: Object.assign({ nid: n.chatId + ':' + Date.now(), ts: Date.now() }, n) }));
    this.runner.on('spawn_failed', (f) => {
      this.broadcast({
        t: 'notify',
        d: { level: 'error', title: '任务启动失败', body: String(f.stderr || ('exit ' + f.code)).slice(-160).trim(), chatId: null, nid: 'spawn:' + f.ref, ts: Date.now() },
      });
    });
    if (this.as) {
      const as = this.as;
      as.on('up', () => this.broadcast({ t: 'models_changed' }));
      as.on('down', () => this.broadcast({ t: 'models_changed' }));
      as.on('chat_new', (chat) => this.broadcast({ t: 'chat_update', chat: as.summary(chat) }));
      as.on('chat_update', (s) => { this.broadcast({ t: 'chat_update', chat: s }); this.checkShutdownDone(s && s.id, s && s.status); });
      as.on('item', (chatId, item) => this.broadcast({ t: 'item', chatId, item }));
      as.on('item_refresh', (chatId, item) => this.broadcast({ t: 'item_refresh', chatId, item }));
      as.on('notify', (n) => this.broadcast({ t: 'notify', d: Object.assign({ nid: n.chatId + ':' + (n.itemId || Date.now()), ts: Date.now(), ask: n.level === 'ask' }, n) }));
    }
  }

  addSink(send, label) {
    const sink = { send, label };
    this.sinks.add(sink);
    log('[hub] sink+', label, 'total', this.sinks.size);
    return sink;
  }
  removeSink(sink) {
    this.sinks.delete(sink);
    log('[hub] sink-', sink && sink.label, 'total', this.sinks.size);
  }
  broadcast(frame) {
    for (const s of this.sinks) {
      try { s.send(frame); } catch {}
    }
  }

  stateFrame() {
    const chats = this.store.summaries().concat(this.as ? this.as.summaries() : []);
    chats.sort((a, b) => {
      const w = (c) => (c.status === 'running' ? 0 : (c.status === 'waiting_approval' || c.status === 'waiting_input') ? 1 : 2);
      const d = w(a) - w(b);
      return d !== 0 ? d : (b.lastTs || 0) - (a.lastTs || 0);
    });
    return {
      t: 'state', chats, dirs: this.store.recentDirs(), stats: this.store.stats(),
      interactive: !!(this.as && this.as.available), serverTime: Date.now(),
      shutdown: this.shutdownFrame(),
    };
  }

  findChat(chatId) {
    if (this.as) {
      const c = this.as.chats.get(chatId);
      if (c) return { src: 'as', chat: c };
    }
    const c = this.store.get(chatId);
    return c ? { src: 'fs', chat: c } : null;
  }

  // 工作区根目录:正式会话取会话 cwd;草稿(未发起)场景客户端传 cwd,须是电脑已知项目目录
  workspaceRoot(frame) {
    if (frame.chatId) {
      const found = this.findChat(frame.chatId);
      if (found && found.chat.cwd) return found.chat.cwd;
    }
    if (typeof frame.cwd === 'string' && this.store.recentDirs().some(d => d.cwd === frame.cwd)) return frame.cwd;
    throw Error('这个文件夹还没有任务记录,发起任务后即可浏览');
  }

  // ---------------- 任务完成后关机 ----------------
  shutdownFrame() {
    if (!this.shutdown) return null;
    return { chatId: this.shutdown.chatId, phase: this.shutdown.phase, delayMs: this.shutdown.delayMs, deadline: this.shutdown.deadline || null, ts: Date.now() };
  }
  scheduleOsShutdown(secs) {
    try {
      if (process.platform === 'win32') {
        const r = spawnSync('shutdown', ['/s', '/t', String(secs), '/c', `CodexWatch:任务完成,${Math.max(1, Math.round(secs / 60))}分钟后关机(手机App可取消)`], { windowsHide: true });
        return r.status === 0 ? { ok: true } : { ok: false, error: '系统拒绝关机指令(' + (r.status || 'exit') + ')' };
      }
      if (process.platform === 'linux') {
        const r = spawnSync('shutdown', ['-h', '+' + Math.max(1, Math.round(secs / 60))]);
        return r.status === 0 ? { ok: true } : { ok: false, error: '系统拒绝关机指令(需要 root?)' };
      }
      return { ok: false, error: '此系统暂不支持远程关机' };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  abortOsShutdown() {
    try {
      if (process.platform === 'win32') spawnSync('shutdown', ['/a'], { windowsHide: true });
      else if (process.platform === 'linux') spawnSync('shutdown', ['-c']);
    } catch {}
  }
  armShutdown(chatId, delayMs) {
    if (this.shutdown && this.shutdown.phase === 'countdown') this.abortOsShutdown(); // 换目标/重复设置
    this.shutdown = { chatId, delayMs: Math.max(60e3, Math.min(3600e3, delayMs || 300e3)), phase: 'waiting', deadline: null };
    const found = this.findChat(chatId);
    const st = found && found.chat && found.chat.status;
    if (st !== 'running' && st !== 'waiting_approval' && st !== 'waiting_input') this.beginShutdownCountdown(); // 任务未在运行:直接倒计时
    else { log('[shutdown] 已设置:任务结束后', Math.round(this.shutdown.delayMs / 60000), '分钟关机, chat', String(chatId).slice(0, 8)); this.broadcast({ t: 'shutdown_update', shutdown: this.shutdownFrame() }); }
  }
  checkShutdownDone(chatId, status) {
    const s = this.shutdown;
    if (!s || s.phase !== 'waiting' || !chatId || chatId !== s.chatId) return;
    if (status === 'running' || status === 'waiting_approval' || status === 'waiting_input') return;
    this.beginShutdownCountdown();
  }
  beginShutdownCountdown() {
    const s = this.shutdown;
    if (!s) return;
    const secs = Math.max(15, Math.round(s.delayMs / 1000));
    const r = this.scheduleOsShutdown(secs);
    if (!r.ok) {
      log('[shutdown] 调度失败:', r.error);
      this.shutdown = null;
      this.broadcast({ t: 'shutdown_update', shutdown: null, error: r.error });
      return;
    }
    s.phase = 'countdown';
    s.deadline = Date.now() + secs * 1000;
    log('[shutdown] 倒计时', secs + 's, chat', String(s.chatId).slice(0, 8));
    this.broadcast({ t: 'shutdown_update', shutdown: this.shutdownFrame() });
  }
  cancelShutdown(reason) {
    const s = this.shutdown;
    this.shutdown = null;
    if (s && s.phase === 'countdown') this.abortOsShutdown();
    log('[shutdown] 已取消', reason || '');
    this.broadcast({ t: 'shutdown_update', shutdown: null, reason: reason || '' });
  }

  async handleFrame(frame, sink) {
    if (!frame || typeof frame !== 'object') return;
    try {
      switch (frame.t) {
        case 'compact_context': {
          const found=this.findChat(frame.chatId);
          if(!found)throw Error('会话不存在');
          if(found.src!=='as')throw Error('此聊天由桌面持有，当前桌面接口未开放压缩操作，请在电脑端操作');
          await this.as.compactContext(frame.chatId);
          sink.send({t:'compact_result',ref:frame.ref,ok:true});break;
        }
        case 'get_usage':
        case 'consume_reset': {
          if (!this.as) throw new Error('电脑额度服务不可用');
          if (frame.t === 'consume_reset') {
            const result = await this.as.consumeReset(frame);
            sink.send({t:'reset_result',ref:frame.ref,ok:true,...result});
          } else {
            sink.send({t:'usage_result',ref:frame.ref,ok:true,usage:await this.as.readLimits()});
          }
          break;
        }
        case 'get_models': {
          try {
            if (!this.as || !this.as.available) throw new Error('电脑模型服务暂不可用，请稍后重试');
            sink.send({ t: 'models', ref: frame.ref, ok: true, models: await this.as.listModels() });
          } catch (e) { sink.send({ t: 'models', ref: frame.ref, ok: false, error: e.message }); }
          break;
        }
        case 'upload_begin':
        case 'upload_chunk':
        case 'upload_finish': {
          try {
            if (frame.t === 'upload_begin' && !this.findChat(frame.chatId)) throw new Error('会话不存在');
            const method = { upload_begin: 'begin', upload_chunk: 'chunk', upload_finish: 'finish' }[frame.t];
            sink.send({ t: 'upload_result', ref: frame.ref, ok: true, ...this.attachments[method](frame) });
          } catch (e) { sink.send({ t: 'upload_result', ref: frame.ref, ok: false, error: e.message }); }
          break;
        }
        case 'hello':
        case 'get_state':
          sink.send(this.stateFrame());
          break;
        case 'open_chat': {
          if (this.as) {
            const view = this.as.itemsView(frame.chatId);
            if (view) return sink.send(Object.assign({ t: 'chat' }, view));
          }
          const chat = this.store.ensureDetail(frame.chatId);
          if (!chat) return sink.send({ t: 'err', ref: 'open_chat', error: '会话不存在' });
          sink.send(Object.assign({ t: 'chat' }, this.store.itemsView(chat), { summary: this.store.summary(chat) }));
          break;
        }
        case 'get_dirs':
          sink.send({ t: 'dirs', dirs: this.store.recentDirs() });
          break;
        case 'browse_dirs':
          sink.send({t:'directory_result',ref:frame.ref,ok:true,...await browseDirectories(frame.path)});
          break;
        case 'browse_workspace': {
          const root=this.workspaceRoot(frame);
          sink.send({t:'workspace_result',ref:frame.ref,ok:true,...await browseWorkspace(root,frame.path)});break;
        }
        case 'file_preview': {
          const root=this.workspaceRoot(frame);
          sink.send({t:'file_preview_result',ref:frame.ref,ok:true,...await previewWorkspaceFile(root,frame.path)});break;
        }
        case 'file_read': {
          const root=this.workspaceRoot(frame);
          sink.send({t:'file_read_result',ref:frame.ref,ok:true,...await readWorkspaceChunk(root,frame.path,frame.offset)});break;
        }
        case 'get_stats':
          sink.send({ t: 'stats', stats: this.store.stats() });
          break;
        case 'new_task': {
          if(frame.approvalPolicy&&!['on-request','never'].includes(frame.approvalPolicy))throw Error('不支持的审批模式');
          // 优先交互式(app-server):支持审批/提问/打断/切模型
          if (this.as && this.as.available && frame.interactive !== false) {
            try {
              const chat = await this.as.startThread({
                cwd: frame.cwd, prompt: frame.prompt, model: frame.model,
                effort: frame.effort, sandbox: frame.sandbox, approvalPolicy: frame.approvalPolicy || 'on-request',
              });
              sink.send({ t: 'task_submitted', ref: frame.ref || null, ok: true, chatId: chat.id, interactive: true });
              break;
            } catch (e) {
              if(frame.approvalPolicy){sink.send({t:'task_submitted',ref:frame.ref||null,ok:false,error:e.message});break;}
              log('[hub] 交互式启动失败,回退 exec:', e.message);
            }
          }
          if(frame.approvalPolicy)throw Error('交互服务不可用，审批模式未应用；请等待服务恢复后重试');
          const r = this.runner.newTask({ cwd: frame.cwd, prompt: frame.prompt, model: frame.model, effort: frame.effort, sandbox: frame.sandbox });
          sink.send({ t: 'task_submitted', ref: frame.ref || null, ok: r.ok, error: r.error || null, spawnRef: r.ref || null });
          break;
        }
        case 'send_msg': {
          log('[hub] send_msg', 'ref=' + frame.ref, 'chat=' + String(frame.chatId).slice(0, 12), 'attachments=' + (frame.attachments || []).length);
          const found = this.findChat(frame.chatId);
          if (!found) return sink.send({ t: 'send_result', ref: frame.ref, chatId: frame.chatId, ok: false, error: '会话不存在' });
          const attachments = this.attachments.resolve(frame.attachments || [], frame.chatId);
          const referenced=await resolveReferences(found.chat.cwd,frame.references||[]);
          if(attachments.length+referenced.length>5)throw Error('每条消息最多 5 个附件和引用文件');
          attachments.push(...referenced);
          if (found.src === 'as') {
            try {
              const result = await this.as.sendTurn(frame.chatId, frame.text, { model: frame.model, effort: frame.effort, approvalPolicy: frame.approvalPolicy, attachments });
              sink.send({ t: 'send_result', ref: frame.ref || null, chatId: frame.chatId, ok: true, mode: result && result.queued ? 'queued' : 'turn' });
            } catch (e) {
              sink.send({ t: 'send_result', ref: frame.ref || null, chatId: frame.chatId, ok: false, error: e.message });
            }
            break;
          }
          if(frame.approvalPolicy)throw Error('桌面转发接口不支持修改审批模式，请在电脑端切换');
          const r = await this.runner.sendMsg(frame.chatId, frame.text, { model: frame.model, effort: frame.effort, sandbox: frame.sandbox, attachments });
          sink.send({ t: 'send_result', ref: frame.ref || null, chatId: frame.chatId, ok: r.ok, error: r.error || null, mode: r.mode || null });
          break;
        }
        case 'stop_task': {
          const found = this.findChat(frame.chatId);
          if (found && found.src === 'as') {
            const ok = await this.as.interrupt(frame.chatId);
            return sink.send({ t: 'stop_result', ref: frame.ref || null, chatId: frame.chatId, ok, error: ok ? null : '无法中断(会话可能已结束)' });
          }
          const r = this.runner.stop(frame.chatId);
          sink.send({ t: 'stop_result', ref: frame.ref || null, chatId: frame.chatId, ok: r.ok, error: r.error || null });
          break;
        }
        case 'answer_approval': {
          if (!this.as) return sink.send({ t: 'err', ref: frame.ref, error: '交互服务不可用' });
          const r = this.as.answerApproval(String(frame.reqId), frame.decision || 'accept');
          sink.send({ t: 'answer_result', ref: frame.ref || null, ok: r.ok, error: r.error || null });
          break;
        }
        case 'answer_user_input': {
          if (String(frame.reqId).startsWith('desktop:')) {
            const chat = this.store.get(frame.chatId);
            const item = chat?.items?.find(x=>x.k==='askuser'&&x.reqId===frame.reqId);
            if (!item || item.answers) throw new Error('该提问已回答或失效，请刷新聊天');
            if (!item.async) throw new Error('此提问需在电脑端完成，当前桌面接口未开放该类回复');
            if (!Array.isArray(frame.answers) || frame.answers.length!==item.questions.length || frame.answers.some(x=>typeof x!=='string'||!x.trim()||x.length>4000)) throw new Error('请回答全部问题');
            const replies=item.questions.map((q,i)=>({questionItemId:q.questionItemId,question:q.question,answer:frame.answers[i]}));
            const text='<send_user_message_question_reply>\n'+JSON.stringify(replies)+'\n</send_user_message_question_reply>';
            const result=await this.runner.desktop.sendIfOwned(chat.id,text);
            if (!result?.ok) throw new Error(result?.error||'电脑问答服务未连接');
            item.answers=frame.answers;
            item.submitted=true;
            this.broadcast({t:'item_refresh',chatId:chat.id,item});
            this.broadcast({t:'chat_update',chat:this.store.summary(chat)});
            sink.send({t:'answer_result',ref:frame.ref,ok:true});
            break;
          }
          if (!this.as) return sink.send({ t: 'err', ref: frame.ref, error: '交互服务不可用' });
          const r = this.as.answerUserInput(String(frame.reqId), frame.answers || []);
          sink.send({ t: 'answer_result', ref: frame.ref || null, ok: r.ok, error: r.error || null });
          break;
        }
        case 'shutdown_arm': {
          const found=this.findChat(frame.chatId);
          if(!found)throw Error('会话不存在');
          if(found.chat.draft)throw Error('草稿还没有任务,发起任务后才能设置');
          this.armShutdown(frame.chatId, Number(frame.delayMs));
          sink.send({t:'shutdown_result',ref:frame.ref,ok:true,shutdown:this.shutdownFrame()});
          break;
        }
        case 'shutdown_cancel': {
          this.cancelShutdown('用户在手机上取消');
          sink.send({t:'shutdown_result',ref:frame.ref,ok:true,shutdown:null});
          break;
        }
        case 'ping':
          sink.send({ t: 'pong', ts: Date.now() });
          break;
        default:
          break;
      }
    } catch (e) {
      log('[hub] frame error', frame.t, e.message);
      try { sink.send({ t: 'err', ref: frame.ref, error: e.message }); } catch {}
    }
  }
}

module.exports = { Hub };
