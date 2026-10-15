'use strict';
// rollout-*.jsonl 行解析:把 Codex 的 rollout 事件翻译为 UI 友好的 item / 状态变化。
// 设计原则:对未知字段与未知事件类型一律宽容跳过,保证跨版本稳健。

const XML_BLOCK = /<(environment_context|user_instructions|ENVIRONMENT_CONTEXT|USER_INSTRUCTIONS|INSTRUCTIONS|turn_aborted|user_shell_command)[\s\S]*?<\/\1>/g;
// Codex 自动注入的上下文消息（AGENTS.md、环境信息等）以 user 角色写入 rollout，不是用户真正发的指令。
const INJECTED_PREFIX = /^\s*(?:# AGENTS\.md instructions for |<environment_context>|<user_instructions>|<INSTRUCTIONS>)/;

function safeJson(s) { try { return JSON.parse(s); } catch { return undefined; } }

function parseLine(line) {
  if (!line) return null;
  const j = safeJson(line);
  if (!j || typeof j !== 'object') return null;
  return j;
}

// 会话身份:session_id 是线程(对话)主键,resume/子文件共享它;id 是单文件 id。
function classifyMeta(p) {
  if (!p) return null;
  const sub = p.source && p.source.subagent;
  const internal = !!sub
    || /guardian|subagent|review/i.test(String(p.thread_source || ''))
    || /guardian|review/i.test(String(p.originator || ''));
  return {
    chatKey: p.session_id || p.id || null,
    fileId: p.id || null,
    subagent: internal,
    subagentKind: sub ? (sub.other || sub.kind || 'subagent') : (internal ? (p.thread_source || 'internal') : null),
    cwd: p.cwd || '',
    originator: p.originator || 'unknown',
    model: p.model || (p.model_info && p.model_info.id) || '',
    ts: p.timestamp ? Date.parse(p.timestamp) : null,
    cliVersion: p.cli_version || '',
  };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const c of content) {
    if (!c) continue;
    if (typeof c === 'string') { out += c; continue; }
    // reasoning.summary 用 summary_text，reasoning.content 用 reasoning_text
    if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text' || c.type === 'summary_text' || c.type === 'reasoning_text') out += (out && (c.type === 'summary_text') ? '\n\n' : '') + (c.text || '');
    else if (c.type === 'input_image') out += '[图片]';
  }
  return out;
}

function cleanUserText(t) {
  return String(t || '').replace(XML_BLOCK, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function userInput(text, id, ts, source) {
  const reply = text.match(/<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/);
  if (reply) { const answers = safeJson(reply[1]); if (Array.isArray(answers)) return { questionAnswers:answers }; }
  if (!source && INJECTED_PREFIX.test(text)) return null;
  const cleaned = cleanUserText(text);
  if (!cleaned) return null;
  return { item: { id: id || null, k: 'user', ts, t: cleaned.slice(0, 4000), ...(source ? {source} : {}) } };
}

// 桌面跨任务投递写成 FunctionCallOutput；只识别该接口的结构，普通工具输出不能冒充用户消息。
function delegationInput(p, ts) {
  if (p.name !== 'send_message_to_thread' || p.namespace !== 'codex_app' || typeof p.output !== 'string') return null;
  const match = p.output.match(/^<codex_delegation>\s*<source_thread_id>[^<]+<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/);
  if (!match) return null;
  let text = match[1];
  const mobile = text.startsWith('【CodexWatch 手机端：当前用户请求】\n');
  if (mobile) text = text.replace(/^【CodexWatch 手机端：当前用户请求】\n[^\n]*\n\n/, '');
  return userInput(text, p.id, ts, mobile ? 'mobile_forward' : 'thread_forward');
}

// 把一条 rollout 记录翻译为:{item} / {status} / {tokens} / {turnCtx} / null
function translate(rec) {
  if (!rec || !rec.type) return null;
  const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
  const p = rec.payload || {};

  if (rec.type === 'response_item') {
    const t = p.type;
    if (t === 'message') {
      const role = p.role;
      const text = contentText(p.content).trim();
      if (role === 'user') {
        return userInput(text, p.id, ts);
      }
      if (role === 'assistant') {
        if (!text) return null;
        return { item: { id: p.id || null, k: 'agent', ts, t: text.slice(0, 6000) } };
      }
      return null;
    }
    if (t === 'reasoning') {
      let text = '';
      if (Array.isArray(p.summary)) text = contentText(p.summary);
      else if (Array.isArray(p.content)) text = contentText(p.content);
      if (!text) return null;
      return { item: { id: p.id || null, k: 'reason', ts, t: text.slice(0, 1500) } };
    }
    if (t === 'custom_tool_call') {
      return { item: { id: p.id || p.call_id || null, k: 'tool', ts, callId: p.call_id || p.id || null, name: p.name || 'tool', args: String(p.input || '').slice(0, 800) } };
    }
    if (t === 'custom_tool_call_output') {
      return { itemOut: { callId: p.call_id || null, out: String(p.output || '').slice(0, 1200) } };
    }
    if (t === 'function_call') {
      if (/^(?:functions\.)?request_user_input(?:_async)?$/.test(p.name || '')) {
        const args = safeJson(p.arguments) || {};
        const async = /_async$/.test(p.name);
        const questions = (args.questions || []).map((q,i)=>({
          id:q.id||String(i),header:q.header||'',question:q.question||q.title||'',
          questionItemId:JSON.stringify([p.name,p.call_id,i]),
          options:(q.options||[]).map(o=>typeof o==='string'?{label:o,description:''}:o),
        }));
        if (questions.length) return {item:{id:p.id||p.call_id,iid:'ask-'+p.call_id,k:'askuser',ts,reqId:'desktop:'+p.call_id,desktop:true,async,questions}};
      }
      return { item: { id: p.id || p.call_id || null, k: 'tool', ts, callId: p.call_id || p.id || null, name: p.name || 'tool', args: String(p.arguments || '').slice(0, 800) } };
    }
    if (t === 'function_call_output') {
      const input = delegationInput(p, ts);
      if (input) return input;
      return { itemOut: { callId: p.call_id || null, out: String(p.output || '').slice(0, 1200) } };
    }
    if (t === 'local_shell_call') {
      const act = p.action || {};
      const cmd = Array.isArray(act.command) ? act.command.join(' ') : String(act.command || '');
      return { item: { id: p.id || null, k: 'tool', ts, callId: p.id || null, name: 'shell', args: cmd.slice(0, 800) } };
    }
    if (t === 'web_search_call') {
      return { item: { id: p.id || null, k: 'tool', ts, callId: p.id || null, name: 'web_search', args: '' } };
    }
    return null;
  }

  if (rec.type === 'event_msg') {
    const t = p.type;
    if (t === 'item_completed' && p.item && p.item.type === 'FunctionCallOutput') return delegationInput(p.item, ts);
    if (t === 'task_started') {
      return { status: 'running', turnId: p.turn_id || null, ts };
    }
    if (t === 'task_complete') {
      return {
        status: 'idle',
        turnDone: {
          turnId: p.turn_id || null,
          lastAgentMessage: typeof p.last_agent_message === 'string' ? p.last_agent_message : '',
          durationMs: p.duration_ms || null,
          ts,
        },
      };
    }
    if (t === 'turn_aborted') {
      return { status: 'stopped', reason: p.reason || '', ts };
    }
    if (t === 'error') {
      return { status: 'error', message: contentText(p.message) || String(p.message || '未知错误'), ts };
    }
    if (t === 'token_count') {
      const info = p.info || {};
      const tot = info.total_token_usage || {};
      const last = info.last_token_usage || {};
      return { tokens: { in: tot.input_tokens || 0, out: tot.output_tokens || 0, total: tot.total_tokens || 0, ctx: info.model_context_window || null, lastTotal: last.total_tokens ?? null } };
    }
    return null;
  }

  if (rec.type === 'turn_context') {
    return { turnCtx: { cwd: p.cwd || '', model: p.model || '', effort: p.effort || p.reasoning_effort || '', sandbox: p.sandbox_policy || p.sandbox || '', approval: p.approval_policy || '', ts } };
  }
  return null;
}

module.exports = { parseLine, classifyMeta, translate, cleanUserText };
