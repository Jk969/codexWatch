'use strict';
// 复用已运行桌面的本机 App Tools 管道，避免另开 writer 恢复桌面持有的线程。
const net = require('net');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { attachmentPrompt } = require('./attachments');

function pipePaths() {
  const paths = [process.env.CODEX_APP_TOOLS_PIPE_PATH].filter(Boolean);
  if (process.platform === 'win32') {
    try { for (const name of fs.readdirSync('\\\\.\\pipe\\')) {
      if (name.startsWith('codex-browser-use-')) paths.push('\\\\.\\pipe\\' + name);
    } } catch {}
  }
  return [...new Set(paths)];
}

function request(pipe, method, params, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe); let buffer = Buffer.alloc(0);
    const done = (error, result) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => done(new Error('桌面服务响应超时')), timeout);
    socket.on('error', error => done(error));
    socket.on('end', () => done(new Error('桌面服务连接断开')));
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method,params}));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32LE();
      if (size > 8 * 1024 * 1024) return done(new Error('桌面响应过大'));
      if (buffer.length < size + 4) return;
      try {
        const reply = JSON.parse(buffer.subarray(4, size + 4).toString());
        if (reply.error) done(new Error(reply.error.message)); else done(null, reply.result);
      } catch (error) { done(error); }
    });
  });
}

function resultData(result) {
  const text = (result.contentItems || []).filter(c => c.type === 'inputText').map(c => c.text).join('\n');
  if (!result.success) throw new Error(text || '桌面未接受消息');
  try { return JSON.parse(text); } catch { return { text }; }
}

class DesktopLink {
  constructor(options = {}) {
    this.paths = options.paths || pipePaths;
    this.request = options.request || request;
  }
  async call(pipe, tool, threadId, args) {
    return resultData(await this.request(pipe, 'tools/call', {
      namespace:'codex_app',tool,threadId,callerSource:'codex',
      callId:'codexwatch-' + randomUUID(),turnId:'codexwatch-' + randomUUID(),arguments:args,
    }));
  }
  async readStatus(chatId) {
    for (const pipe of this.paths()) {
      try {
        const snapshot = await this.call(pipe, 'read_thread', chatId, {
          threadId:chatId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:0,
        });
        if (snapshot.thread?.id !== chatId || snapshot.thread.kind !== 'codex' || snapshot.thread.hostId !== 'local') continue;
        const turn = snapshot.turns?.[0];
        // notLoaded 只表示桌面未加载聊天；是否执行须看最新轮次，不能据此判定完成。
        const statuses = {inProgress:'running',in_progress:'running',running:'running',completed:'idle',interrupted:'interrupted',failed:'error'};
        if (turn && statuses[turn.status]) return {status:statuses[turn.status],turnId:turn.id};
      } catch { /* 桌面暂不可用时保留日志状态，下次再核对。 */ }
    }
    return null;
  }
  async sendIfOwned(chatId, text, opts = {}) {
    for (const pipe of this.paths()) {
      let snapshot;
      try { snapshot = await this.call(pipe, 'read_thread', chatId, {threadId:chatId,turnLimit:1,maxOutputCharsPerItem:0}); }
      catch { continue; }
      if (!snapshot.thread || snapshot.thread.id !== chatId || snapshot.thread.kind !== 'codex' || snapshot.thread.hostId !== 'local') continue;
      // 一旦发送交给桌面，无论响应超时还是失败都不回退 CLI，避免重复投递。
      // 桌面将此接口显示为跨任务转发；标明手机输入的来源，避免被当作旧任务的补充材料。
      const prompt = text.startsWith('<send_user_message_question_reply>') ? text :
        '【CodexWatch 手机端：当前用户请求】\n用户正在手机上向这个聊天发送新的请求。请承接下面的请求；若与此前任务不冲突，请继续完成它，不要只重复回答此前的问题。\n\n' + text;
      const args = { threadId:chatId, hostId:'local', prompt:attachmentPrompt(prompt, opts.attachments) };
      if (opts.model) args.model = opts.model;
      if (opts.effort) args.thinking = opts.effort;
      try {
        await this.call(pipe, 'send_message_to_thread', chatId, args);
        return {ok:true,mode:'desktop'};
      } catch {
        return {ok:false,error:'桌面未确认接收，请检查电脑聊天；文字已保留，确认后再重试'};
      }
    }
    return null;
  }
}

module.exports = { pipePaths, request, DesktopLink, resultData };
