'use strict';
/* CodexWatch Web UI —— 与桥(本机)/中继(浏览器)/安卓壳(CWApp)三种传输共用的单页应用 */

/* ================= 工具 ================= */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const PALETTE = [['#07C160','#0ABF56'],['#10AEFF','#0C8FEF'],['#FA9D3B','#F08A24'],['#6C5CE7','#5B4BD1'],['#E8535B','#D64550'],['#00B894','#00A381'],['#2E8BFF','#1F79E8'],['#F76E6E','#E85B5B']];
function hashCode(s){ let h=0; s=String(s||''); for(let i=0;i<s.length;i++){h=((h<<5)-h+s.charCodeAt(i))|0;} return Math.abs(h); }
function paletteOf(key){ return PALETTE[hashCode(key)%PALETTE.length]; }
function avatarHtml(key, letter, cls){ const c=paletteOf(key); const ch=(letter||String(key||'?').trim().charAt(0)||'?').toUpperCase();
  return `<div class="${cls||'avatar'}"><div class="img" style="background:linear-gradient(135deg,${c[0]},${c[1]})">${esc(ch)}</div></div>`; }
const CODEX_AVATAR = `<div class="img" style="background:linear-gradient(135deg,#2b2b31,#101014)">
  <svg viewBox="0 0 24 24" style="width:24px;height:24px"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" fill="#fff"/></svg></div>`;
function relTime(ts){ if(!ts) return ''; const now=Date.now(), d=new Date(ts), diff=now-ts;
  if(diff<60e3) return '刚刚';
  const n=new Date(now);
  if(d.toDateString()===n.toDateString()){const h=d.getHours(),m=String(d.getMinutes()).padStart(2,'0');return (h<6?'凌晨 ':'')+h+':'+m;}
  const y=new Date(now-864e5); if(d.toDateString()===y.toDateString()) return '昨天';
  if(d.getFullYear()===n.getFullYear()) return (d.getMonth()+1)+'月'+d.getDate()+'日';
  return d.getFullYear()+'/'+(d.getMonth()+1)+'/'+d.getDate();
}
function dayLabel(ts){ const d=new Date(ts), n=new Date();
  if(d.toDateString()===n.toDateString()) return '今天 '+pad(d.getHours())+':'+pad(d.getMinutes());
  const y=new Date(Date.now()-864e5); if(d.toDateString()===y.toDateString()) return '昨天 '+pad(d.getHours())+':'+pad(d.getMinutes());
  return (d.getMonth()+1)+'月'+d.getDate()+'日 '+pad(d.getHours())+':'+pad(d.getMinutes());
}
const pad=n=>String(n).padStart(2,'0');
function fmtTokens(t){ if(!t||!t.total) return '0'; const v=t.total; if(v>=1e9) return (v/1e9).toFixed(1)+'B'; if(v>=1e6) return (v/1e6).toFixed(1)+'M'; if(v>=1e3) return (v/1e3).toFixed(1)+'K'; return String(v); }
function mdStrip(s){ return String(s||'').replace(/\*\*([^*]+)\*\*/g,'$1').replace(/`([^`]*)`/g,'$1').replace(/^#+\s*/gm,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*_#>]/g,''); }
function mdToHtml(s){
  return window.CWMarkdown ? CWMarkdown.render(s) : esc(s);
}
async function copyMarkdownCode(button){
  const value=button.closest('.md-code-block').querySelector('pre code').textContent;
  try{
    if(IS_APK && typeof CWApp.copyText==='function'){
      if(!CWApp.copyText(value))throw new Error('复制失败');
    }else if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(value);
    else{
      const field=document.createElement('textarea');field.value=value;field.style.cssText='position:fixed;opacity:0';
      document.body.append(field);field.select();
      try{if(!document.execCommand('copy'))throw new Error('复制失败');}finally{field.remove();}
    }
    toast('代码已复制');
  }catch{toast('复制失败，请长按代码选择复制');}
}
function toast(msg, ms){ const t=$('toast'); t.innerHTML=msg; t.classList.remove('hidden'); clearTimeout(t._tm); t._tm=setTimeout(()=>t.classList.add('hidden'), ms||2600); }

/* ================= 持久化 ================= */
const LS = {
  get(k,d){ try{ const v=localStorage.getItem('cw:'+k); return v==null?d:JSON.parse(v);}catch{return d;} },
  set(k,v){ try{ localStorage.setItem('cw:'+k, JSON.stringify(v)); }catch{} }
};

/* ================= 环境与模式 ================= */
const IS_APK = !!window.CWApp;
const IS_LOCAL = window.__CW_LOCAL__ === 1 || location.port === '3599';
const DEFAULT_SERVER = 'https://pcphone.jingxixi.top';
let serverBase = LS.get('server', DEFAULT_SERVER);           // REST 基址
let wsToken = LS.get('token', null);                          // 用户 token

/* ================= 全局状态 ================= */
const S = {
  conn: 'init',            // init/connecting/connected/offline
  user: null,
  devices: [],             // {id,name,online,...}
  devicesReady:false, deviceError:null,
  chats: new Map(),        // key = dev+"/"+chatId -> chat summary
  items: new Map(),        // key -> [items]
  loaded: new Set(),       // 已拉取详情的 key
  unread: new Map(),       // key -> count
  muted: new Map(),        // key -> true
  archived: new Map(),     // key -> 归档时间戳
  shutdown: null,          // {chatId, phase: waiting|countdown, delayMs, deadline} 任务完成后关机
  clockSkew: 0,            // 电脑时钟 - 手机时钟(ms)
  opened: null,            // key
  tab: 'chats',
  search: '',
  relayStatus: null,       // 本机模式:桥→云中继状态
  pendingPair: null,
};
S.muted = new Map(Object.entries(LS.get('muted', {}) || {}));
S.archived = new Map(Object.entries(LS.get('archived', {}) || {}).map(([k, v]) => [k, Number(v) || Date.now()]));

function persistMuted(){ LS.set('muted', Object.fromEntries(S.muted)); }
function persistArchived(){ LS.set('archived', Object.fromEntries(S.archived)); }
function chatKey(dev, id){ return dev + '/' + id; }
function totalUnread(){ let n=0; for(const v of S.unread.values()) n+=v; return n; }

/* ================= 传输层 ================= */
const Conn = {
  ws: null, manualClose: false, retry: 0, timer: null,
  raw(obj){ 
    if (IS_APK) { try{ CWApp.send(JSON.stringify(obj)); }catch(e){} return; }
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  },
  // 业务帧:本地模式直接发;远程模式包一层 dev_frame
  send(frame, deviceId){
    if (IS_LOCAL) { this.raw(frame); return; }
    const dev = deviceId || (frame.chatId ? frame.chatId.split('|')[0] : null) || activeDeviceId();
    if (!dev) { toast('没有在线设备'); return; }
    this.raw({ t: 'dev_frame', deviceId: dev, d: frame });
  },
  connect(){
    if (IS_APK) {
      try{ CWApp.setConfig(JSON.stringify({endpoint: wsUrl(), token: wsToken})); CWApp.requestConnect(); }catch(e){}
      return;
    }
    if (IS_LOCAL) { this.openWs(location.origin.replace(/^http/, 'ws') + '/ws'); return; }
    if (!wsToken) { showLogin(); return; }
    this.openWs(wsUrl());
  },
  openWs(url){
    clearTimeout(this.timer);
    setConn('connecting');
    let ws;
    try { ws = new WebSocket(url); } catch(e){ return this.scheduleRetry(); }
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; setConn('connected'); if (IS_LOCAL) this.raw({ t: 'hello' }); };
    ws.onmessage = (ev) => { let m; try{ m = JSON.parse(ev.data); }catch{ return; } onNetMessage(m); };
    ws.onclose = () => { if (this.ws === ws && !this.manualClose) this.scheduleRetry(); };
    ws.onerror = () => {};
  },
  scheduleRetry(){
    setConn('offline');
    const wait = Math.min(2000 * Math.pow(1.8, this.retry++), 45000);
    this.timer = setTimeout(() => this.connect(), wait);
  }
};
function wsUrl(){
  // 浏览器远程模式与 APK 共用中继 /ws
  if (IS_APK) return serverBase.replace(/^http/,'ws') + '/ws';
  if (IS_LOCAL) return location.origin.replace(/^http/,'ws') + '/ws';
  return location.origin.replace(/^http/,'ws') + '/ws?token=' + encodeURIComponent(wsToken);
}
function activeDeviceId(){
  const on = S.devices.filter(d=>d.online);
  if (on.length) return on[0].id;
  return S.devices.length ? S.devices[0].id : null;
}

/* ================= REST ================= */
async function api(path, body, method){
  const opt = { method: method || (body ? 'POST' : 'GET'), headers: {} };
  if (wsToken) opt.headers['Authorization'] = 'Bearer ' + wsToken;
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(serverBase + path, opt);
  const j = await r.json().catch(()=>({}));
  if (r.status === 401 && path !== '/api/login') { wsToken = null; LS.set('token', null); showLogin(); throw new Error(j.error || '请重新登录'); }
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

/* ================= 网络消息分发 ================= */
function onNetMessage(m){
  // 本地模式:桥直接发业务帧(无 dev_frame 包装)
  if (IS_LOCAL) { handleFrame(m, 'local'); updateConnDot(); return; }
  switch (m.t) {
    case 'authed':
      S.user = m.user || S.user;
      break;
    case 'devices':
      S.devicesReady=true;S.deviceError=null;
      S.devices = m.devices || [];
      if (!IS_LOCAL) {
        for (const d of S.devices) if (d.online) Conn.send({ t: 'hello' }, d.id);
      }
      if(S.tab==='devices')renderDevices();else if(S.tab==='me')renderMe();else if(S.tab==='chats')renderChatList();
      break;
    case 'dev_frame':
      if (m.d) handleFrame(m.d, m.deviceId);
      break;
    case 'pair_code':
      S.pendingPair = m;
      showPairPanel();
      break;
    case 'notify': onNotify(m.d, m.queued); break;
    case 'pong': break;
  }
  updateConnDot();
}

let deviceLoad=null;
function syncDevices(){
  if(IS_LOCAL||!wsToken)return;
  if(S.conn==='connected')Conn.raw({t:'get_devices'});
  if(deviceLoad)return deviceLoad;
  const token=wsToken;
  deviceLoad=api('/api/devices').then(r=>{if(wsToken===token)onNetMessage({t:'devices',devices:r.devices});})
    .catch(e=>{if(wsToken===token&&!S.devicesReady){S.deviceError=e.message;if(S.tab==='devices')renderDevices();else if(S.tab==='chats')renderChatList();}})
    .finally(()=>{deviceLoad=null;});
  return deviceLoad;
}

function handleFrame(d, dev){
  if (d.ref && frameRequests.has(d.ref)) {
    const pending = frameRequests.get(d.ref);
    if (pending.dev === dev) {
      clearTimeout(pending.timer); frameRequests.delete(d.ref);
      if (d.ok === false || d.t === 'err') pending.reject(new Error(d.error || '操作失败'));
      else pending.resolve(d);
    }
  }
  switch (d.t) {
    case 'models_changed':
      modelCatalogs.delete(IS_LOCAL ? 'local' : dev);
      break;
    case 'state': {
      const keep = new Set((d.chats||[]).map(c => chatKey(dev, c.id)));
      for (const k of [...S.chats.keys()]) if (k.startsWith(dev + '/') && !keep.has(k)) { S.chats.delete(k); S.items.delete(k); S.loaded.delete(k); }
      for (const c of d.chats || []) S.chats.set(chatKey(dev, c.id), Object.assign({ _dev: dev }, c));
      // 运行中/待处理的任务不允许被归档藏着:有活动自动恢复
      for (const c of d.chats || []) if ((c.status==='running'||c.status==='waiting_approval'||c.status==='waiting_input') && S.archived.delete(chatKey(dev, c.id))) persistArchived();
      S.interactive = d.interactive;
      if (Number.isFinite(d.serverTime)) S.clockSkew = d.serverTime - Date.now();
      S.shutdown = d.shutdown && d.shutdown.chatId ? d.shutdown : null;
      renderChatList(); renderDiscoverMaybe(d.stats); if (S.tab === 'projects') renderProjects();
      break;
    }
    case 'chat': {
      const k = chatKey(dev, d.chatId);
      const same = S.loaded.has(k) && JSON.stringify(S.items.get(k)) === JSON.stringify(d.items || []);
      S.items.set(k, d.items || []);
      S.loaded.add(k);
      if (d.summary) S.chats.set(k, Object.assign({ _dev: dev }, d.summary));
      if (S.opened === k && !same) renderChatView(true);
      break;
    }
    case 'item': {
      const k = chatKey(dev, d.chatId);
      if (S.archived.delete(k)) persistArchived();   // 已归档任务有新动态:自动恢复到列表
      const items = S.items.get(k);
      const identity = d.item.iid || d.item.id;
      if (identity && items && items.some(x => (x.iid || x.id) === identity)) break;
      if (S.items.has(k)) S.items.get(k).push(d.item);
      if (S.opened !== k) {
        if (!chatIsMuted(k)) S.unread.set(k, (S.unread.get(k)||0)+1);
        renderChatList(); updateTabBadge();
      } else { appendChatItem(d.item); }
      break;
    }
    case 'item_refresh': {
      // 更新已有 item(授权结果/流式输出/工具输出)
      const k = chatKey(dev, d.chatId);
      const items = S.items.get(k);
      if (items) {
        const idx = items.findIndex(x => x === d.item || (d.item.iid && x.iid === d.item.iid));
        if (idx >= 0) items[idx] = d.item;
      }
      if (S.opened === k) refreshChatItem(d.item);
      break;
    }
    case 'chat_update': {
      if (d.chat) {
        const ck = chatKey(dev, d.chat.id);
        if ((d.chat.status==='running'||d.chat.status==='waiting_approval'||d.chat.status==='waiting_input') && S.archived.delete(ck)) persistArchived();
        S.chats.set(ck, Object.assign({ _dev: dev }, d.chat));
      }
      renderChatList(); if (S.tab === 'projects') renderProjects();
      if (S.opened && S.opened.startsWith(dev+'/')) updateChatHeader();
      break;
    }
    case 'send_result':
      if (!d.ok) toast(esc(d.error || '发送失败'));
      else if (d.mode === 'local_queue' || d.mode === 'queued') toast('已加入队列,稍后自动执行');
      break;
    case 'answer_result':
      if (!d.ok) toast(esc(d.error || '操作失败'), 3200);
      break;
    case 'task_submitted':
      if (!d.ok) toast(esc(d.error || '任务发起失败'));
      else { closeOverlay('newtask'); if(!d.ref || !d.ref.startsWith('req-'))toast('任务已发起'); }
      break;
    case 'stop_result':
      toast(d.ok ? '已发送停止指令' : esc(d.error || '停止失败'), 3200);
      break;
    case 'err':
      if (d.error) toast(esc(d.error), 3200);
      break;
    case 'shutdown_update': {
      S.clockSkew = (d.shutdown && d.shutdown.ts || Date.now()) - Date.now();
      S.shutdown = d.shutdown && d.shutdown.chatId ? d.shutdown : null;
      renderShutdownBar();
      if (d.error) toast('⏻ 关机设置失败: ' + esc(d.error), 4000);
      if (S.shutdown && S.shutdown.chatId) {
        const k = chatKey(currentDevOfChat(S.shutdown.chatId), S.shutdown.chatId);
        if (S.opened === k && S.shutdown.phase === 'countdown') toast('⏻ 任务已完成,即将按计划关机', 4000);
      }
      break;
    }
    case 'relay_status':
      S.relayStatus = d;
      updateConnDot();
      break;
  }
}

function onNotify(d, queued){
  if (!d) return;
  const k = d.chatId ? chatKey(currentDevOfChat(d.chatId), d.chatId) : null;
  if (k && S.chats.has(k)) {
    const c = S.chats.get(k);
    if (c.lastTs < (d.ts||Date.now())) { /* 摘要可能还没更新 */ }
  }
  if (k && (S.muted.get(k) || S.archived.has(k))) return;
  if (k && S.opened !== k) {
    S.unread.set(k, (S.unread.get(k)||0)+1);
    renderChatList(); updateTabBadge();
  }
  // 页面标题提醒(浏览器);APK 内原生服务已发系统通知
  document.title = (totalUnread() ? '('+totalUnread()+') ' : '') + 'CodexWatch';
  if (d.level === 'error' && !queued) toast('⚠ ' + esc(d.title) + '<br>' + esc(d.body||''));
  if (d.level === 'ask' && !queued) toast('❓ ' + esc(d.title) + '<br>' + esc(d.body||''),5000);
}

function currentDevOfChat(chatId){
  for (const k of S.chats.keys()) if (k.endsWith('/'+chatId)) return k.split('/')[0];
  return activeDeviceId() || 'local';
}

/* ================= 连接状态 ================= */
function setConn(st){ S.conn = st; updateConnDot(); }
function updateConnDot(){
  const dot = $('conn-dot');
  if (IS_LOCAL) {
    const rs = S.relayStatus;
    if (S.conn === 'connected') { dot.className = 'conn-dot ' + (rs && rs.status === 'connected' ? 'ok' : (rs && rs.status ? 'warn' : '')); }
    else dot.className = 'conn-dot';
  } else {
    dot.className = 'conn-dot ' + (S.conn === 'connected' ? 'ok' : '');
  }
  const devOnline = S.devices.some(d=>d.online);
  if (S.tab==='chats' && S.conn==='connected' && !IS_LOCAL && !devOnline && S.devices.length===0) {
    renderChatList();
  }
}

/* ================= 视图:任务列表 ================= */
function chatIsMuted(k){ return !!S.muted.get(k); }
function statusW(c) { return c.status === 'running' ? 0 : (c.status === 'waiting_approval' || c.status === 'waiting_input') ? 1 : 2; }
const STATUS_TEXT = { running: '运行中', waiting_approval: '等授权', waiting_input: '等你回答', error: '出错', stopped: '已中断', interrupted: '已断开' };
function renderChatList(){
  const box = $('chat-list');
  let chats = [...S.chats.values()].filter(c=>!c.draft && !S.archived.has(chatKey(c._dev, c.id)));
  if (S.search) { const q = S.search.toLowerCase(); chats = chats.filter(c => (c.title||'').toLowerCase().includes(q) || (c.lastMsg||'').toLowerCase().includes(q) || (c.project||'').toLowerCase().includes(q)); }
  chats.sort((a,b)=>{ const d = statusW(a) - statusW(b); return d !== 0 ? d : (b.lastTs||0)-(a.lastTs||0); });
  if (!IS_LOCAL && S.devices.length === 0) {
    box.innerHTML = S.devicesReady ? `<div class="empty"><div class="big">🖥️</div>还没有绑定电脑<br>去「设备」页添加你的电脑吧</div>` : `<div class="empty">${esc(S.deviceError?'设备列表读取失败：'+S.deviceError:'正在读取已绑定的电脑…')}<br>连接恢复后会自动重试</div>`;
    return;
  }
  const archivedCount = S.search ? 0 : [...S.chats.values()].filter(c=>!c.draft && S.archived.has(chatKey(c._dev, c.id))).length;
  const archHtml = archivedCount ? `<div class="cells" style="margin-top:14px"><div class="cell" id="archived-entry"><div class="c-avatar" style="background:#EFEFEF;display:flex;align-items:center;justify-content:center;font-size:19px">🗂️</div><div class="c-main"><div class="c-name" style="font-size:16px">已归档</div><div class="c-sub">${archivedCount} 个任务 · 有新活动会自动回到列表</div></div><div class="chev">›</div></div></div>` : '';
  if (!chats.length) { box.innerHTML = `<div class="empty"><div class="big">🤖</div>暂无任务<br>到「项目」页点击「新建任务」发起第一个任务</div>` + archHtml; const ae=$('archived-entry'); if (ae) ae.onclick = openArchivedPanel; return; }
  let html = '';
  for (const c of chats) {
    const k = chatKey(c._dev, c.id);
    const un = S.unread.get(k) || 0;
    const running = c.status === 'running';
    const waiting = c.status === 'waiting_approval' || c.status === 'waiting_input';
    const preview = running ? `<span class="running-text">正在执行…</span>` : waiting ? `<span style="color:#FA5151;font-weight:600">${STATUS_TEXT[c.status]} · ${esc(mdStrip(c.lastMsg||'')).slice(0,30)}</span>` : esc(mdStrip(c.lastMsg || ''));
    const statusTag = running ? `<span class="tag running">运行中</span>` : waiting ? `<span class="tag ${c.status === 'waiting_approval' ? 'waiting' : 'waiting_input'}">${STATUS_TEXT[c.status]}</span>` : c.status==='error' ? `<span class="tag error">出错</span>` : (c.status==='stopped'||c.status==='interrupted') ? `<span class="tag stopped">${STATUS_TEXT[c.status]}</span>` : '';
    const multiDev = S.devices.length > 1 && c._dev !== 'local';
    const devName = multiDev ? `<span class="device-chip">${esc((S.devices.find(d=>d.id===c._dev)||{}).name || '')}</span>` : '';
    const st = running ? 'running' : (c.status === 'error' || waiting) ? 'error' : '';
    html += `<div class="chat-item" data-k="${esc(k)}">
      <div class="swipe-actions"><div class="swipe-btn nt" data-act="newtask">新建任务</div><div class="swipe-btn ar" data-act="archive">归档</div></div>
      <div class="chat-item-in"${statusW(c) < 2 ? ' style="background:#F0FBF4"' : ''}>
        <div class="avatar"><div class="img" style="background:linear-gradient(135deg,${paletteOf(c.project||c.id).join(',')})">${esc((c.project||'?').charAt(0).toUpperCase())}</div>
          <i class="st ${st}"></i></div>
        <div class="chat-main">
          <div class="chat-row1"><div class="chat-name">${esc(c.title || '未命名任务')}</div>${devName}<div class="chat-time">${relTime(c.lastTs)}</div></div>
          <div class="chat-row2">${statusTag}<div class="chat-preview">${preview}</div>${un?`<div class="badge">${un>99?'99+':un}</div>`:''}</div>
        </div>
      </div>
    </div>`;
  }
  box.innerHTML = html + archHtml;
  const ae = $('archived-entry'); if (ae) ae.onclick = openArchivedPanel;
  restoreSwipeOpen(box);
}

/* ================= 左滑操作(任务列表) ================= */
const Swipe = {
  openEl: null,          // 当前展开操作按钮的 .chat-item
  track: null,           // 进行中的拖拽
  suppressClick: false,  // 拖拽后吞掉紧随的 click
  width(el){ return el.querySelector('.swipe-actions').offsetWidth; },
  set(el, x, animate){
    const inner = el.querySelector('.chat-item-in'); if (!inner) return;
    inner.style.transition = animate ? '' : 'none';
    inner.style.transform = x ? 'translateX(' + Math.round(x) + 'px)' : '';
  },
  open(el, animate = true){ this.openEl = el; this.set(el, -this.width(el), animate); },
  close(){ const el = this.openEl; if (!el) return; this.openEl = null; this.set(el, 0, true); },
  restore(box){
    if (!this.openEl || this.openEl.isConnected) return;
    const k = this.openEl.dataset.k; this.openEl = null;
    if (!S.chats.has(k)) return;
    for (const el of box.querySelectorAll('.chat-item')) if (el.dataset.k === k) { this.open(el, false); break; }
  },
  runAction(el, act){
    const c = S.chats.get(el.dataset.k);
    this.close();
    if (!c) return;
    if (act === 'archive') archiveChat(el.dataset.k, c);
    else if (act === 'newtask') startNewTaskFor(c);
  }
};
function restoreSwipeOpen(box){ Swipe.restore(box); }
function bindChatSwipe(){
  const list = $('chat-list');
  list.addEventListener('pointerdown', (e)=>{
    Swipe.suppressClick = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const item = e.target.closest('.chat-item'); if (!item || e.target.closest('.swipe-btn')) return;
    Swipe.track = {
      item, inner: item.querySelector('.chat-item-in'), pid: e.pointerId,
      x: e.clientX, y: e.clientY, base: item === Swipe.openEl ? -Swipe.width(item) : 0,
      mode: 'idle', lastX: e.clientX, lastT: Date.now(), v: 0
    };
  });
  list.addEventListener('pointermove', (e)=>{
    const t = Swipe.track; if (!t || t.pid !== e.pointerId) return;
    if (t.mode === 'x' && !t.inner.isConnected) { Swipe.track = null; return; }
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    if (t.mode === 'idle') {
      if (Math.abs(dx) < 9 && Math.abs(dy) < 9) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.2) {
        t.mode = 'x'; t.w = Swipe.width(t.item);
        Swipe.suppressClick = true;
        if (Swipe.openEl && Swipe.openEl !== t.item) Swipe.close();
        t.inner.classList.add('dragging');
        try { list.setPointerCapture(e.pointerId); } catch (err) {}
      } else { Swipe.track = null; return; }
    }
    if (t.mode !== 'x') return;
    t.v = (e.clientX - t.lastX) / Math.max(1, Date.now() - t.lastT);
    t.lastX = e.clientX; t.lastT = Date.now();
    let x = t.base + dx;
    if (x > 0) x *= .35;                                   // 往右橡皮筋
    const min = -t.w - 36;
    if (x < min) x = min + (x - min) * .35;                // 往左橡皮筋
    t.inner.style.transform = 'translateX(' + Math.round(x) + 'px)';
  });
  const end = (e, cancelled)=>{
    const t = Swipe.track; if (!t || t.pid !== e.pointerId) return;
    Swipe.track = null;
    if (t.mode !== 'x') return;
    t.inner.classList.remove('dragging');
    if (cancelled) { Swipe.set(t.item, t.item === Swipe.openEl ? -Swipe.width(t.item) : 0, true); return; }
    const cur = t.base + (e.clientX - t.x);
    const v = (Date.now() - t.lastT > 90) ? 0 : t.v;       // 停顿后不按速度判定
    const open = v <= -0.5 ? true : v >= 0.5 ? false : cur <= -t.w * 0.5;
    if (open) Swipe.open(t.item);
    else if (t.item === Swipe.openEl) Swipe.close();
    else Swipe.set(t.item, 0, true);
  };
  list.addEventListener('pointerup', (e)=>end(e, false));
  list.addEventListener('pointercancel', (e)=>end(e, true));
}
function archiveChat(k, c){
  if (c.status === 'running' || c.status === 'waiting_approval' || c.status === 'waiting_input') { toast('任务进行中，结束后才能归档'); return; }
  S.archived.set(k, Date.now()); persistArchived();
  S.unread.delete(k); updateTabBadge();
  toast('已归档 · 任务列表底部可查看和恢复');
  setTimeout(()=>{ renderChatList(); if (S.tab === 'projects') renderProjects(); }, 200);
}
function unarchiveChat(k){
  S.archived.delete(k); persistArchived();
  renderChatList(); if (S.tab === 'projects') renderProjects();
}
function startNewTaskFor(c){
  if (!c.cwd) { toast('该任务没有工作目录，无法直接新建'); return; }
  if (!IS_LOCAL) {
    const dev = S.devices.find(d => d.id === c._dev);
    if (!dev || !dev.online) { toast('这台电脑当前离线，无法发起新任务'); return; }
  }
  NT.dev = IS_LOCAL ? 'local' : c._dev;
  NT.cwd = c.cwd; NT.prompt = ''; NT.model = ''; NT.effort = ''; NT.sandbox = '';
  openNewTaskDraft();
}
function openArchivedPanel(){
  const chats = [...S.chats.values()].filter(c => !c.draft && S.archived.has(chatKey(c._dev, c.id)));
  chats.sort((a,b)=>(b.lastTs||0)-(a.lastTs||0));
  let html = chats.length ? `<div class="group-h">共 ${chats.length} 个任务 · 左滑「恢复」回到任务列表</div><div class="cells">` : `<div class="empty"><div class="big">🗂️</div>还没有已归档的任务<br>在任务列表左滑任务即可归档</div>`;
  for (const c of chats) {
    const k = chatKey(c._dev, c.id);
    html += `<div class="cell" data-k="${esc(k)}">
      <div class="c-avatar" style="background:linear-gradient(135deg,${paletteOf(c.project||c.id).join(',')});color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px">${esc((c.project||c.title||'?').charAt(0).toUpperCase())}</div>
      <div class="c-main"><div class="c-name" style="font-size:15px">${esc(c.title||'未命名任务')}</div>
      <div class="c-sub">${esc(mdStrip(c.lastMsg||'')).slice(0,32)}</div></div>
      <button class="unarchive-btn" data-un="${esc(k)}">恢复</button></div>`;
  }
  if (chats.length) html += `</div>`;
  openSubpanel('已归档', html);
  const body = $('subpanel-body');
  body.querySelectorAll('.unarchive-btn').forEach(b => b.onclick = (e)=>{ e.stopPropagation(); unarchiveChat(b.dataset.un); openArchivedPanel(); });
  body.querySelectorAll('.cell[data-k]').forEach(el => el.onclick = ()=>{ closeOverlay('subpanel'); openChat(el.dataset.k); });
}

/* ================= 视图:聊天窗口 ================= */
function openChat(k){
  const c = S.chats.get(k);
  if (!c) return;
  S.opened = k;
  navStack = navStack.filter(id => id !== 'chat'); navStack.push('chat');
  $('chat-input').value = draftFor(k).text;
  renderComposer();
  S.unread.delete(k);
  updateTabBadge();
  renderChatList();
  $('chat').classList.remove('hidden');
  requestAnimationFrame(()=>$('chat').classList.add('show'));
  $('chat-title').textContent = c.title || '未命名任务';
  updateChatHeader();
  const body = $('chat-body');
  body.innerHTML = '';
  if (!S.loaded.has(k)) { body.innerHTML = `<div class="time-pill"><span class="spin" style="border-color:rgba(0,0,0,.15);border-top-color:#999"></span> 加载中…</div>`; }
  if(c.draft) body.innerHTML=`<div class="empty">${esc(c.cwd)}<br>调整模型、思考强度和审批模式后发送第一条指令<br>发送前不会创建或执行任务</div>`;
  else {Conn.send({ t: 'open_chat', chatId: c.id }, c._dev);renderChatView();}
  loadModels(c._dev).then(updateChatHeader).catch(()=>{});
}
function closeChat(){
  if (S.opened) draftFor(S.opened).text = $('chat-input').value;
  window.getSelection()?.removeAllRanges();selectionRefreshPending=false;
  S.opened = null;
  navStack = navStack.filter(id => id !== 'chat');
  $('chat').classList.remove('show');
  setTimeout(()=>{if(!$('chat').classList.contains('show'))$('chat').classList.add('hidden');}, 250);
}
function updateChatHeader(){
  if (!S.opened) return;
  const c = S.chats.get(S.opened); if (!c) return;
  $('chat-title').textContent = c.title || '未命名任务';
  const st = c.draft ? '草稿 · 尚未发起' : c.status==='running' ? '● 运行中' : c.status==='waiting_approval' ? '⏳ 等待你的授权' : c.status==='waiting_input' ? '❓ 等待你的回答' : c.status==='error' ? '出错' : c.status==='stopped' ? '已中断' : c.status==='interrupted' ? '已断开' : '已完成';
  const tune = chatTune(S.opened);
  const selected = selectedModel(c, tune);
  const effort = tune.effort || c.effort || (selected && selected.defaultReasoningEffort) || '';
  const tuneStr = modelName(tune.model || c.model || (selected && selected.model)) + ' · 思考：' + effortName(effort);
  $('chat-sub').textContent = st + (tuneStr ? ' · ' + tuneStr : '');
  const pendingPolicy=c.interactive&&tune.approvalPolicy!==c.approvalPolicy?tune.approvalPolicy:'';
  $('chat-permission').textContent=(pendingPolicy?'下条：':'审批：')+approvalName(pendingPolicy||c.approvalPolicy);
  const tuneBtn = $('chat-tune');
  if (tuneBtn) tuneBtn.classList.toggle('active', !!(tune.model || tune.effort));
  $('chat-model-label').textContent = modelName(tune.model || c.model || (selected && selected.model));
  $('chat-effort').textContent = '思考：' + effortName(effort);
  const usage = c.tokens || {};
  const known = Number.isFinite(usage.lastTotal) && Number.isFinite(usage.ctx) && usage.ctx > 0;
  $('chat-context').textContent = known ? '上下文已用 ' + Math.round(usage.lastTotal / usage.ctx * 100) + '%' : '上下文：暂无数据';
  $('chat-context').onclick = () => openSubpanel('上下文占用', `<div class="usage-card"><b>${known ? Math.round(usage.lastTotal/usage.ctx*100)+'% 已使用' : '暂无上下文数据'}</b><p>${known ? usage.lastTotal.toLocaleString()+' / '+usage.ctx.toLocaleString()+' Tokens' : '电脑尚未返回当前上下文占用。'}</p><p class="usage-note">按最近一次 Token 用量更新展示，上下文压缩后数值会变化。累计 Tokens 不作为当前上下文占用。</p></div>`);
  const wb = $('wait-banner');
  if (c.status === 'waiting_approval') { wb.textContent = '⏸ Codex 正在等待你的授权 — 请在下方处理'; wb.classList.remove('hidden'); }
  else if (c.status === 'waiting_input') { wb.textContent = '❓ Codex 有问题想问你 — 请在下方回答'; wb.classList.remove('hidden'); }
  else if (c.pendingQuestions) { wb.textContent='❓ 有 '+c.pendingQuestions+' 个提问待回答，请查看聊天中的提问卡';wb.classList.remove('hidden'); }
  else wb.classList.add('hidden');
}
// 刷新聊天中单个已渲染 item
let selectionRefreshPending=false;
function chatSelectionActive(){
  const selection=window.getSelection(),body=$('chat-body');
  return !!(selection&&!selection.isCollapsed&&body&&body.contains(selection.anchorNode)&&body.contains(selection.focusNode));
}
document.addEventListener('selectionchange',()=>{
  if(selectionRefreshPending&&!chatSelectionActive()){selectionRefreshPending=false;renderChatView(true);}
});
function refreshChatItem(item){
  const body = $('chat-body');
  if (!item.iid) return;
  const el = body.querySelector(`[data-iid="${CSS.escape(item.iid)}"]`);
  if (el) {if(chatSelectionActive()){selectionRefreshPending=true;return;}el.outerHTML = itemHtml(item, S.chats.get(S.opened));}
}
// 每聊天的模型/思考设置
function chatTune(k){ return LS.get('tune:'+k, {}); }
function setChatTune(k, obj){ LS.set('tune:'+k, obj); updateChatHeader(); }
function approvalName(policy){return policy==='on-request'?'按需审批':policy==='never'?'无需审批':policy?'自定义':'沿用电脑配置';}
function openPermissionPanel(){
  if(!S.opened)return;const key=S.opened,c=S.chats.get(key),tune=chatTune(key);
  $('sheet-mask').classList.remove('hidden');
  if(!c.interactive){$('sheet').innerHTML=`<div class="picker-heading">审批模式</div><div class="picker-note">电脑最近报告：${esc(approvalName(c.approvalPolicy))}。此聊天由桌面管理，当前转发接口不支持修改审批模式，请在电脑端切换。手机新建的交互聊天可在这里切换。</div>`;return;}
  const value=tune.approvalPolicy||'';
  const options=[{id:'',title:'沿用当前模式',note:'不覆盖电脑配置'},{id:'on-request',title:'按需审批',note:'Codex 在需要时请求批准'},{id:'never',title:'无需审批',note:'不弹出审批；仍受当前沙箱限制'}];
  $('sheet').innerHTML=`<div class="picker-heading">审批模式</div><div class="picker-note">当前：${esc(approvalName(c.approvalPolicy))}。选择后随下一条消息提交，不改变正在运行的任务或沙箱权限。</div><div class="model-list">${options.map(o=>`<button class="model-option${value===o.id?' selected':''}" data-approval="${o.id}"><span>${o.title}<small>${o.note}</small></span><b>${value===o.id?'✓':''}</b></button>`).join('')}</div>`;
  $('sheet').querySelectorAll('[data-approval]').forEach(button=>button.onclick=()=>{setChatTune(key,{...tune,approvalPolicy:button.dataset.approval});hideSheet();});
}
function approvalHtml(it){
  const decided = it.decision != null;
  const decisionText = { accept: '已允许', acceptForSession: '已允许(本会话不再询问)', decline: '已拒绝', cancel: '已拒绝并停止' }[it.decision] || String(it.decision||'');
  const btns = decided ? '' : `
    <div class="ap-actions">
      <button class="ap-btn primary" data-req="${esc(it.reqId)}" data-dec="accept">允许</button>
      <button class="ap-btn neutral" data-req="${esc(it.reqId)}" data-dec="acceptForSession">本会话均允许</button>
      <button class="ap-btn danger" data-req="${esc(it.reqId)}" data-dec="decline">拒绝</button>
      <button class="ap-btn danger" data-req="${esc(it.reqId)}" data-dec="cancel">拒绝并停止</button>
    </div>`;
  const doneLine = decided ? `<div class="ap-done"><span class="${/accept/.test(it.decision)?'ok':'no'}">${decisionText}</span></div>` : '';
  return `<div class="msg ai" data-iid="${esc(it.iid||'')}"><div class="m-avatar"></div><div class="bubble-wrap"><div class="approval-card">
    <div class="ap-head"><span class="ic"><svg viewBox="0 0 24 24"><path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 8v5M12 16v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span><span class="nm">${esc(it.title||'命令授权')}</span></div>
    <div class="ap-body"><div class="ap-cmd">${esc(it.command||'')}</div>${it.cwd?`<div class="ap-cwd">📁 ${esc(it.cwd)}</div>`:''}${btns}${doneLine}</div>
  </div></div></div>`;
}
function askHtml(it){
  const answered = it.answers != null;
  const desktopOnly = it.desktop && !it.async;
  const multi = (it.questions||[]).length > 1;
  const qs = (it.questions||[]).map((q,qi)=>`
    <div class="ask-q">
      ${q.header?`<div class="qh">${esc(q.header)}</div>`:''}
      <div class="qt">${esc(q.question)}</div>
      ${!answered&&!desktopOnly&&(q.options||[]).length?`<div class="ask-opts">${q.options.map(o=>`<button class="ask-opt" data-req="${esc(it.reqId)}" data-qi="${qi}" data-label="${esc(o.label)}">${esc(o.label)}${o.description?`<span class="od">${esc(o.description)}</span>`:''}</button>`).join('')}</div>`:''}
      ${multi&&!answered&&!desktopOnly?'<input class="ask-custom" placeholder="或输入自己的回答">':''}
    </div>`).join('');
  const answerLine = answered ? `<div class="ap-done"><span class="ok">${it.submitted?'已提交回答':'已回答'}:${esc((it.answers||[]).join(' / ').slice(0,200))}</span></div>` : desktopOnly ? '<div class="ap-done">请在电脑端回答此同步提问。</div>' : `
    <div class="ask-free">${multi?'':`<input placeholder="输入回答,或直接点选项…" data-req="${esc(it.reqId)}">`}${multi?`<button data-sendmulti="1" data-req="${esc(it.reqId)}">提交全部回答</button>`:`<button data-send="1" data-req="${esc(it.reqId)}">发送</button>`}</div>`;
  return `<div class="msg ai" data-iid="${esc(it.iid||'')}"><div class="m-avatar"></div><div class="bubble-wrap"><div class="ask-card">
    <div class="ask-head"><span class="ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.8.3-.9 1-.9 1.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1" fill="currentColor"/></svg></span><span class="nm">Codex 提问${it.blocking?' · 需要回答':''}</span></div>
    <div class="ask-body">${qs}${answerLine}</div>
  </div></div></div>`;
}
async function submitQuestion(reqId, answers, card){
  const chat=S.chats.get(S.opened);if(!chat||card.dataset.busy)return;
  card.dataset.busy='1';card.querySelectorAll('button,input').forEach(x=>x.disabled=true);
  try{await requestFrame({t:'answer_user_input',chatId:chat.id,reqId,answers},chat._dev);toast('回答已提交到电脑');}
  catch(e){toast(esc(e.message),4000);}
  finally{delete card.dataset.busy;card.querySelectorAll('button,input').forEach(x=>x.disabled=false);}
}
function itemHtml(it, c){
  const av = CODEX_AVATAR;
  const uav = `<div class="img" style="background:linear-gradient(135deg,#07C160,#0ABF56)">${esc(((S.user&&S.user.name)||'我').charAt(0))}</div>`;
  switch (it.k) {
    case 'user':
      return `<div class="msg user"><div class="m-avatar">${uav}</div><div class="bubble-wrap">${it.source?`<div class="message-source">${it.source==='mobile_forward'?'手机消息 · 经桌面转发':'其他聊天转发'}</div>`:''}<div class="bubble">${esc(it.t)}</div></div></div>`;
    case 'agent':
      return `<div class="msg ai" data-iid="${esc(it.iid||'')}"><div class="m-avatar">${av}</div><div class="bubble-wrap"><div class="bubble bubble-md">${mdToHtml(it.t)}</div></div></div>`;
    case 'reason':
      return `<div class="msg ai"><div class="m-avatar"></div><div class="bubble-wrap"><div class="reason"><span class="rl">思考</span>${esc((it.t||'').slice(0,300))}</div></div></div>`;
    case 'err':
      return `<div class="sysline err"><span>⚠ ${esc(it.t)}</span></div>`;
    case 'sys':
      return `<div class="sysline${it.done?' ok':''}"><span>${esc(it.t)}</span></div>`;
    case 'approval':
      return approvalHtml(it);
    case 'askuser':
      return askHtml(it);
    case 'tool': {
      const args = esc(it.args || '');
      const out = it.out ? `<div class="tool-out">${esc(it.out)}</div>` : '';
      return `<div class="msg ai" data-iid="${esc(it.iid||'')}"><div class="m-avatar"></div><div class="bubble-wrap"><div class="tool-card" data-x="0">
        <div class="tool-head"><span class="ic"><svg viewBox="0 0 24 24"><path d="M14.7 6.3a5 5 0 0 0-6.6 6.6L3 18l3 3 5.1-5.1a5 5 0 0 0 6.6-6.6l-3.2 3.2-2.5-.5-.5-2.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></span><span class="nm">${esc(it.name||'tool')}</span></div>
        <div class="tool-body"><div class="tool-args">${args}</div>${out}</div>
      </div></div></div>`;
    }
    default: return '';
  }
}
function renderChatView(preserveScroll = false){
  if (!S.opened) return;
  if(chatSelectionActive()){selectionRefreshPending=true;return;}
  const items = S.items.get(S.opened) || [];
  const c = S.chats.get(S.opened);
  const body = $('chat-body');
  const sc = $('chat-scroll');
  const oldTop = sc.scrollTop;
  const follow = !preserveScroll || sc.scrollHeight - oldTop - sc.clientHeight < 80;
  let html = '';
  if (c && c.cwd) html += `<div class="time-pill">📁 ${esc(c.cwd)}</div>`;
  if (items.length === 0 && S.loaded.has(S.opened)) {
    html += `<div class="time-pill">会话没有可显示的消息</div>`;
  }
  let lastTs = 0;
  for (const it of items) {
    if (it.ts && it.ts - lastTs > 5 * 60e3) html += `<div class="time-pill">${dayLabel(it.ts)}</div>`;
    if (it.ts) lastTs = it.ts;
    html += itemHtml(it, c);
  }
  if (c && c.status === 'running') html += `<div class="msg ai"><div class="m-avatar">${CODEX_AVATAR}</div><div class="bubble-wrap"><div class="bubble" style="padding:0"><div class="typing"><i></i><i></i><i></i></div></div></div></div>`;
  body.innerHTML = html;
  sc.scrollTop = follow ? sc.scrollHeight : oldTop;
}
function appendChatItem(it){
  const body = $('chat-body');
  const sc = $('chat-scroll');
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 300;
  const running = body.querySelector('.typing');
  const c = S.chats.get(S.opened);
  if (running && c && c.status !== 'running') running.closest('.msg').remove();
  else if (running) running.closest('.msg').remove();
  body.insertAdjacentHTML('beforeend', `<div class="time-pill">${dayLabel(it.ts||Date.now())}</div>` + itemHtml(it, c));
  if (!chatSelectionActive()&&(nearBottom || it.k === 'user')) sc.scrollTop = sc.scrollHeight;
  if (c && c.status === 'running') body.insertAdjacentHTML('beforeend', `<div class="msg ai"><div class="m-avatar">${CODEX_AVATAR}</div><div class="bubble-wrap"><div class="bubble" style="padding:0"><div class="typing"><i></i><i></i><i></i></div></div></div></div>`);
}

/* ================= 视图:发起任务 ================= */
let NT = { cwd: '', dev: '', prompt: '', model: '', sandbox: '', effort: '', approvalPolicy: 'on-request' };
function openNewTask(){
  const devs = S.devices.filter(d=>d.online);
  if (!IS_LOCAL && !devs.length) {syncDevices();toast(!S.devicesReady?'正在读取电脑设备，请稍后重试':S.devices.length?'已绑定电脑暂时离线，请检查电脑守护程序':'还没有绑定电脑，请到「设备」页配对');return;}
  const dev=IS_LOCAL?'local':(devs.find(d=>d.id===NT.dev)?.id||activeDeviceId());
  if(NT.dev && NT.dev!==dev) NT.cwd='';
  NT.dev=dev;
  renderNewTask();
  showOverlay('newtask');
}
function collectDirs(dev){
  const m = new Map();
  for (const c of S.chats.values()) if (!c.draft && c.cwd && (!dev || IS_LOCAL || c._dev===dev)) { const cur=m.get(c.cwd)||{cwd:c.cwd,project:c.project||c.cwd,lastTs:0}; if((c.lastTs||0)>cur.lastTs)cur.lastTs=c.lastTs; m.set(c.cwd,cur); }
  return [...m.values()].sort((a,b)=>b.lastTs-a.lastTs);
}
function renderNewTask(){
  const dirs = collectDirs(NT.dev);
  const devs = S.devices.filter(d=>d.online);
  let devSel = '';
  if (!IS_LOCAL && devs.length > 1) {
    devSel = `<div class="form-label">目标设备</div><div class="form-section">` +
      devs.map(d=>`<div class="dir-option${d.id===NT.dev?' sel':''}" data-dev="${esc(d.id)}"><div class="radio"></div><div class="dp"><div class="p1">${esc(d.name)}</div></div></div>`).join('') + `</div>`;
  }
  let dirOpts = dirs.map(d=>`<div class="dir-option${d.cwd===NT.cwd?' sel':''}" data-cwd="${esc(d.cwd)}"><div class="radio"></div><div class="dp"><div class="p1">${esc(d.project||d.cwd)}</div><div class="p2">${esc(d.cwd)}</div></div></div>`).join('');
  $('newtask-body').innerHTML = `
    ${devSel}
    <div class="form-label">工作目录</div>
    <div class="form-section">${dirOpts}
      <div class="cell" id="nt-choose-folder"><div class="c-main"><div class="c-name">选择电脑文件夹</div><div class="c-sub" style="overflow-wrap:anywhere">${esc(NT.cwd||'点击浏览目标电脑上的磁盘和文件夹')}</div></div><div class="chev">›</div></div>
    </div>
    <div class="picker-note">选好目录后进入聊天草稿，可调整任务参数；发送第一条指令才会发起任务。</div>`;
  $('newtask-body').querySelectorAll('.dir-option[data-cwd]').forEach(el=>{
    el.onclick = () => { NT.cwd = el.dataset.cwd;openNewTaskDraft(); };
  });
  $('newtask-body').querySelectorAll('.dir-option[data-dev]').forEach(el=>{
    el.onclick = () => {NT.dev=el.dataset.dev;NT.cwd='';NT.model='';NT.effort='';renderNewTask();};
  });
  $('nt-choose-folder').onclick=()=>openFolderPicker();
}
let folderSequence=0;
async function openFolderPicker(path=''){
  const seq=++folderSequence,dev=NT.dev;
  openSubpanel('选择电脑文件夹','<div class="empty">正在读取电脑文件夹…</div>');
  try{
    const result=await requestFrame({t:'browse_dirs',path},dev);
    if(seq!==folderSequence||dev!==NT.dev||!navStack.includes('subpanel'))return;
    $('subpanel-body').innerHTML=`<div class="usage-card" style="overflow-wrap:anywhere"><b>${esc(result.path||'电脑磁盘')}</b><p class="usage-note">${esc(S.devices.find(d=>d.id===dev)?.name||'这台电脑')} · 任务在所选文件夹中执行</p></div>
      <div class="cells">${result.path?'<div class="cell" id="folder-up"><div class="c-main">↑ 上一级</div></div><div class="cell" id="folder-roots"><div class="c-main">电脑磁盘</div></div>':''}
      ${result.entries.map((entry,i)=>`<div class="cell" data-folder="${i}"><div class="c-main"><div class="c-name">📁 ${esc(entry.name)}</div></div><div class="chev">›</div></div>`).join('')}</div>
      ${result.entries.length?'':'<div class="empty">此文件夹没有子文件夹</div>'}
      ${result.truncated?'<div class="usage-note">仅显示前 1000 个文件夹</div>':''}
      ${result.path?'<button class="btn-primary" id="folder-use">使用此文件夹</button>':''}`;
    if($('folder-up'))$('folder-up').onclick=()=>openFolderPicker(result.parent||'');
    if($('folder-roots'))$('folder-roots').onclick=()=>openFolderPicker();
    $('subpanel-body').querySelectorAll('[data-folder]').forEach(el=>el.onclick=()=>openFolderPicker(result.entries[+el.dataset.folder].path));
    if($('folder-use'))$('folder-use').onclick=()=>{NT.cwd=result.path;closeOverlay('subpanel');openNewTaskDraft();};
  }catch(e){if(seq===folderSequence && navStack.includes('subpanel')){
    $('subpanel-body').innerHTML=`<div class="empty">${esc(e.message)}</div><button class="btn-primary" id="folder-retry">返回电脑磁盘</button>`;
    $('folder-retry').onclick=()=>openFolderPicker();
  }}
}
function openNewTaskDraft(){
  const key='draft:'+NT.dev+':'+NT.cwd;
  if(!S.chats.has(key)){
    S.chats.set(key,{id:key,_dev:NT.dev,cwd:NT.cwd,title:'新任务 · '+basenameOf(NT.cwd),draft:true,interactive:true,status:'draft',approvalPolicy:NT.approvalPolicy,sandbox:NT.sandbox});
    draftFor(key).text=NT.prompt;
    LS.set('tune:'+key,{model:NT.model,effort:NT.effort,approvalPolicy:NT.approvalPolicy});
  }
  closeOverlay('newtask');closeOverlay('subpanel');openChat(key);
}

/* ================= 视图:设备 ================= */
function renderDevices(){
  const box = $('device-list');
  if (IS_LOCAL) {
    const rs = S.relayStatus;
    const st = rs ? (rs.status==='connected' ? '<span class="on-dot on"></span>&nbsp;已连接云端' : rs.status==='disconnected' ? '<span class="on-dot"></span>&nbsp;云端连接断开,重连中' : '…') : '未配置';
    box.innerHTML = `
      <div class="group-h">本机模式(浏览器直连守护进程)</div>
      <div class="cells">
        <div class="cell">${avatarHtml('pc','电')}<div class="c-main"><div class="c-name">这台电脑</div><div class="c-sub">${st}</div></div></div>
        <div class="cell" id="cell-cloud"><div class="c-main"><div class="c-name" style="color:#576B95">云中继连接说明</div><div class="c-sub">${esc((rs&&rs.url)||'未配置 --relay 参数')}</div></div><div class="chev">›</div></div>
      </div>
      <div class="group-h">远程(手机 App)接入</div>
      <div class="cells"><div class="cell" id="cell-pairguide"><div class="c-main"><div class="c-name" style="color:#576B95">如何用手机连接这台电脑</div><div class="c-sub">查看配对步骤</div></div><div class="chev">›</div></div></div>`;
    const g = $('cell-pairguide'); if (g) g.onclick = ()=>openSubpanel('手机接入指引', pairGuideHtml());
    const cc = $('cell-cloud'); if (cc) cc.onclick = ()=>toast('在 bridge 启动时加 --relay wss://pcphone.jingxixi.top/ws-device 并用 --pair 配对码绑定');
    return;
  }
  let html = `<div class="group-h">我的电脑设备</div><div class="cells">`;
  if (!S.devices.length) html += `<div class="cell"><div class="c-main"><div class="c-name" style="color:#999">${S.devicesReady?'还没有设备':'正在读取已绑定设备'}</div><div class="c-sub">${esc(S.devicesReady?'点击下方「添加设备」开始配对':S.deviceError||'连接恢复后自动重试，无需重新配对')}</div></div></div>`;
  for (const d of S.devices) {
    html += `<div class="cell">
      ${avatarHtml(d.id,'电')}
      <div class="c-main"><div class="c-name">${esc(d.name)} ${d.online?'<span class="on-dot on" style="margin-left:2px"></span>':''}</div>
      <div class="c-sub">${d.online?'在线 · 任务实时同步':'离线'}</div></div>
      <div class="c-val">${d.online?'':'·'}</div></div>`;
  }
  html += `</div><div class="group-h">添加</div><div class="cells">
    <div class="cell" id="cell-add">${avatarHtml('add','＋')}<div class="c-main"><div class="c-name">添加设备(配对)</div><div class="c-sub">在电脑守护进程输入 6 位配对码</div></div><div class="chev">›</div></div></div>`;
  box.innerHTML = html;
  const add = $('cell-add'); if (add) add.onclick = requestPairCode;
}
function requestPairCode(){
  if (IS_LOCAL) { openSubpanel('手机接入指引', pairGuideHtml()); return; }
  // 优先走 REST(不依赖实时通道),失败再走 WS
  toast('<span class="spin"></span>生成配对码…');
  api('/api/pair-code', {}).then(r => {
    S.pendingPair = { code: r.code, expiresAt: r.expiresAt };
    showPairPanel();
  }).catch(() => {
    Conn.raw({ t: 'create_pair' });
  });
}
function showPairPanel(){
  const p = S.pendingPair;
  if (!p || p.expiresAt <= Date.now()) { openSubpanel('添加设备', `<div class="empty">配对码已过期,请重新生成</div>`); return; }
  const left = Math.max(0, Math.round((p.expiresAt - Date.now())/1000));
  openSubpanel('添加设备', `
    <div style="text-align:center;padding:26px 20px 10px">
      <div style="font-size:15px;color:#333">在电脑上运行以下命令完成绑定</div>
      <div class="digits" style="font-size:46px;letter-spacing:10px;font-weight:700;color:#07C160;font-family:Menlo,monospace;margin:16px 0 6px">${esc(p.code)}</div>
      <div style="font-size:12px;color:#B2B2B2">${left} 秒内有效</div>
    </div>
    <div class="pair-steps" style="margin-top:6px">
      cd D:\\dev\\gpt\\codexWatch\\bridge<br>
      <code>node index.js --pair ${esc(p.code)}</code><br>
      <span style="color:#B2B2B2">(已配置过 --relay 的电脑,直接运行上面这条即可)</span>
    </div>
    <button class="btn-primary" id="pair-refresh">刷新配对码</button>`);
  const btn = $('pair-refresh'); if (btn) btn.onclick = requestPairCode;
}
function renderPairPanel(){
  const p = S.pendingPair;
  const left = Math.max(0, Math.round((p.expiresAt - Date.now())/1000));
  return `<div class="cells" style="margin-top:12px">
    <div class="cell" style="flex-direction:column;align-items:center;padding:18px">
      <div style="font-size:14px;color:#333">配对码</div>
      <div class="digits" style="font-size:40px;letter-spacing:10px;font-weight:700;color:#07C160;font-family:Menlo,monospace;margin:10px 0 4px">${esc(p.code)}</div>
      <div style="font-size:12px;color:#B2B2B2">${left}s 内有效 · 刷新后旧码失效</div>
      <button class="btn-primary" id="pair-refresh" style="margin:14px 15px 0">刷新配对码</button>
    </div></div>`;
}
function pairGuideHtml(){
  return `<div class="pair-steps">
    <b>第一步</b> · 电脑安装 Node.js 后,在项目目录运行守护进程:<br>
    <code>cd bridge && node index.js</code><br><br>
    <b>第二步</b> · 手机 App「设备」页 →「添加设备」获得 6 位配对码<br><br>
    <b>第三步</b> · 电脑上带配对码启动(自动换取设备凭证并保存):<br>
    <code>node index.js --relay wss://pcphone.jingxixi.top/ws-device --pair 123456</code><br><br>
    之后直接 <code>node index.js</code> 即可自动重连。
  </div>`;
}

/* ================= 视图:动态 ================= */
let lastStats = null;
function renderDiscoverMaybe(stats){ if (stats) { lastStats = stats; if (S.tab==='discover') renderDiscover(); } }
function renderDiscover(){
  const st = lastStats;
  const box = $('discover');
  if (!st) { box.innerHTML = `<div class="empty"><div class="big">📊</div>暂无数据</div>`; return; }
  const runningHtml = st.running ? `<div class="stat-cell"><div class="v" style="color:#07C160">${st.running}</div><div class="k">运行中</div></div>` : '';
  box.innerHTML = `
    <div class="stat-hero">
      <div class="n">${st.totalChats||0}</div><div class="l">近 14 天任务会话</div>
      <div class="stat-row">${runningHtml}
        <div class="stat-cell"><div class="v">${fmtTokens(st.tokens)}</div><div class="k">累计 Tokens</div></div>
        <div class="stat-cell"><div class="v">${(st.projects||[]).length}</div><div class="k">涉及项目</div></div>
      </div>
    </div>
    <div class="group-h">项目概览</div>
    <div class="cells">${(st.projects||[]).map(p=>`<div class="cell">${avatarHtml(p.cwd, (p.project||'?').charAt(0))}
      <div class="c-main"><div class="c-name">${esc(p.project||p.cwd)} ${p.running?`<span class="tag-mini">运行中 ${p.running}</span>`:''}</div><div class="c-sub">${esc(p.cwd)}</div></div>
      <div class="c-val">${p.chats} 个任务</div></div>`).join('') || '<div class="cell"><div class="c-sub">无</div></div>'}</div>`;
}

/* ================= 视图:我 ================= */
function renderMe(){
  const box = $('me');
  const name = (S.user && S.user.name) || (IS_LOCAL ? '本机用户' : '未登录');
  const role = (S.user && S.user.role === 'admin') ? '管理员' : (IS_LOCAL ? '本地模式' : '成员');
  const devCount = IS_LOCAL ? 1 : S.devices.length;
  box.innerHTML = `
    <div class="cells" style="margin-top:10px">
      <div class="cell" style="padding:16px 15px">${avatarHtml(name, name.charAt(0))}
        <div class="c-main"><div class="c-name" style="font-size:19px;font-weight:600">${esc(name)}</div><div class="c-sub">${esc(role)} · ${devCount} 台设备</div></div></div>
    </div>
    <div class="group-h">协作</div>
    <div class="cells">
      <div class="cell" id="me-invite"><div class="c-avatar" style="background:#07C160;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px">✚</div>
        <div class="c-main"><div class="c-name">邀请用户</div><div class="c-sub">生成邀请码给同伴注册</div></div>${(S.user&&S.user.role==='admin')?'<span class="tag-mini">管理员</span>':'<span class="tag-mini gray">仅管理员</span>'}<div class="chev">›</div></div>
      <div class="cell" id="me-notify"><div class="c-avatar" style="background:#10AEFF;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px">🔔</div>
        <div class="c-main"><div class="c-name">通知设置</div><div class="c-sub">全局开关与静音管理</div></div><div class="chev">›</div></div>
    </div>
    <div class="group-h">连接</div>
    <div class="cells">
      <div class="cell" id="me-usage"><div class="c-main"><div class="c-name">Codex 用量与重置卡</div><div class="c-sub">5 小时额度 · 周额度 · 重置时间</div></div><div class="chev">›</div></div>
      <div class="cell" id="me-conn"><div class="c-main"><div class="c-name">服务器</div><div class="c-sub">${esc(serverBase)} · ${S.conn==='connected'?'已连接':'未连接'}</div></div><div class="chev">›</div></div>
      <div class="cell" id="me-pass"><div class="c-main"><div class="c-name">修改密码</div><div class="c-sub">定期更换更安全</div></div><div class="chev">›</div></div>
      <div class="cell" id="me-logout"><div class="c-main"><div class="c-name" style="color:#FA5151">${IS_LOCAL?'重新扫描会话':'退出登录'}</div></div></div>
    </div>
    <div class="group-h">关于</div>
    <div class="cells"><div class="cell"><div class="c-main"><div class="c-name">CodexWatch v${esc(IS_APK ? CWApp.getVersion() : '1.0')}</div><div class="c-sub">微信式 Codex 任务指挥台 · 今夜为你而造</div></div></div></div>`;
  $('me-invite').onclick = ()=>openInvite();
  $('me-notify').onclick = ()=>openNotifySettings();
  $('me-conn').onclick = ()=>openConnInfo();
  $('me-usage').onclick = ()=>openUsage();
  $('me-pass').onclick = ()=>openChangePassword();
  $('me-logout').onclick = ()=>{
    if (IS_LOCAL) { Conn.send({t:'hello'}); toast('已刷新'); renderChatList(); return; }
    wsToken = null; LS.set('token', null);
    if (IS_APK) { try{ CWApp.setConfig(JSON.stringify({endpoint: wsUrl(), token: ''})); CWApp.disconnect(); }catch(e){} }
    location.reload();
  };
}
let usageDevice = null, usageData = null, usageBusy = false;
function usageDate(seconds){ return Number.isFinite(seconds) ? new Date(seconds*1000).toLocaleString('zh-CN') : '暂未提供'; }
function usageWindow(title, win){
  const known = win && Number.isFinite(win.usedPercent);
  const used = known ? Math.max(0,Math.min(100,win.usedPercent)) : null;
  return `<div class="usage-card"><b>${esc(title)}</b><div class="usage-value">${known ? '剩余 '+Math.round(100-used)+'%' : '暂无数据'}</div>${known ? `<progress max="100" value="${100-used}"></progress>` : ''}<div class="usage-note">${known ? '已用 '+Math.round(used)+'% · ' : ''}重置时间：${usageDate(win?.resetsAt)}</div></div>`;
}
function renderUsage(){
  if (!usageData) return;
  const data = usageData;
  const groups = data.rateLimitsByLimitId ? Object.entries(data.rateLimitsByLimitId) : [['codex',data.rateLimits]];
  const cards = data.rateLimitResetCredits;
  const count = cards && Number.isFinite(cards.availableCount) ? cards.availableCount : null;
  $('subpanel-body').innerHTML = `<div class="usage-note" style="padding:15px">电脑当前登录的 Codex 账号 · ${esc((S.devices.find(d=>d.id===usageDevice)||{}).name||'本机')}<br>更新于 ${new Date().toLocaleTimeString('zh-CN')}</div>` +
    groups.map(([id,bucket])=>{const windows=[bucket?.primary,bucket?.secondary].filter(Boolean);return `<div class="group-h">${esc(bucket?.limitName||id)}</div>`+ (windows.length ? windows.map(w=>usageWindow(w.windowDurationMins===300?'5 小时额度':w.windowDurationMins===10080?'周额度':Number.isFinite(w.windowDurationMins)?w.windowDurationMins+' 分钟额度':'额度',w)).join('') : usageWindow('5 小时额度',null)+usageWindow('周额度',null));}).join('')+
    `<div class="usage-card"><b>Codex 重置卡</b><div class="usage-value">${count===null?'暂未提供':count+' 张可用'}</div>${(cards?.credits||[]).map(c=>`<p>额度重置卡 · ${esc(c.status==='available'?'可用':c.status)}<br><span class="usage-note">到期：${c.expiresAt===null?'无到期时间':usageDate(c.expiresAt)}</span></p>`).join('')}<p class="usage-note">使用一张卡可重置账号符合条件的 Codex 额度，实际结果以服务返回为准。</p><button class="usage-button" id="use-reset"${usageBusy||!count?' disabled':''}>${usageBusy?'正在确认…':'使用一张重置卡'}</button></div><button class="usage-button" id="usage-refresh"${usageBusy?' disabled':''}>刷新用量</button>`;
  $('usage-refresh').onclick=()=>loadUsage(usageDevice);
  $('use-reset').onclick=()=>confirmReset();
}
async function openUsage(){
  usageDevice=IS_LOCAL?'local':activeDeviceId();usageData=null;
  openSubpanel('Codex 用量与重置卡','<div class="usage-card">正在读取电脑账号用量…</div>');
  await loadUsage(usageDevice);
}
async function loadUsage(dev){
  try {const result=await requestFrame({t:'get_usage'},dev);if(usageDevice!==dev)return;usageData=result.usage;renderUsage();}
  catch(e){$('subpanel-body').innerHTML=`<div class="usage-card">${esc(e.message)}<p>确认目标电脑在线后重试。</p><button class="usage-button" id="usage-retry">重试</button></div>`;$('usage-retry').onclick=()=>loadUsage(dev);}
}
function confirmReset(){
  $('sheet-mask').classList.remove('hidden');
  $('sheet').innerHTML='<div class="picker-heading">使用一张 Codex 重置卡？</div><p class="picker-note">这会消耗电脑当前账号的一张卡，重置符合条件的额度。</p><button class="usage-button" id="reset-confirm">确认使用</button><button class="usage-button" id="reset-cancel">取消</button>';
  $('reset-cancel').onclick=hideSheet;
  $('reset-confirm').onclick=async()=>{
    hideSheet();if(usageBusy)return;usageBusy=true;renderUsage();
    const key='reset-attempt:'+usageDevice+':'+usageData.accountRevision;
    const attempt=LS.get(key,null)||(crypto.randomUUID ? crypto.randomUUID() : 'reset-'+Date.now()+'-'+Math.random().toString(36).slice(2));LS.set(key,attempt);
    try {const r=await requestFrame({t:'consume_reset',idempotencyKey:attempt,accountRevision:usageData.accountRevision},usageDevice);
      LS.set(key,null);toast(({reset:'已使用重置卡',alreadyRedeemed:'该次重置已完成',nothingToReset:'当前没有可重置的额度',noCredit:'当前没有可用重置卡'})[r.outcome]||'服务返回未知结果，请刷新用量');
    }catch(e){toast(esc(e.message)+'；重试将复用同一请求编号',5000);}
    finally{usageBusy=false;await loadUsage(usageDevice);}
  };
}
function openInvite(){
  openSubpanel('邀请用户', `<div style="padding:20px 15px;color:#999;font-size:14px">加载中…</div>`);
  if (!(S.user && S.user.role === 'admin')) { $('subpanel-body').innerHTML = `<div class="empty">仅管理员可生成邀请码</div>`; return; }
  api('/api/invites').then(r=>{
    const list = (r.invites||[]).map(i=>`<div class="cell"><div class="c-main"><div class="c-name" style="font-family:Menlo,monospace;color:#07C160">${esc(i.code)}</div>
      <div class="c-sub">${i.used ? '已被 ' + esc(i.usedBy||'?') + ' 使用' : '未使用'} · ${relTime(i.createdAt)}</div></div>
      ${i.used?'':'<span class="tag-mini">可用</span>'}</div>`).join('');
    $('subpanel-body').innerHTML = `<div class="cells">${list || '<div class="cell"><div class="c-sub">暂无邀请码</div></div>'}</div>
      <button class="btn-primary" id="inv-gen">生成新邀请码</button>`;
    $('inv-gen').onclick = ()=>api('/api/invites', {}).then(()=>openInvite()).catch(e=>toast(esc(e.message)));
  }).catch(e=>{ $('subpanel-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
}
function openNotifySettings(){
  const mutedList = [...S.muted.keys()].filter(k=>S.muted.get(k));
  const html = `<div class="group-h">免打扰的任务(${mutedList.length})</div><div class="cells">${
    mutedList.map(k=>{const c=S.chats.get(k);return `<div class="cell"><div class="c-main"><div class="c-name">${esc(c?c.title:k)}</div></div>
      <div class="c-val" style="color:#576B95" data-unmute="${esc(k)}">取消免打扰</div></div>`;}).join('') || '<div class="cell"><div class="c-sub">无,所有任务完成都会通知</div></div>'}</div>
    <div class="group-h">说明</div><div class="cells"><div class="cell"><div class="c-main"><div class="c-sub" style="white-space:normal;line-height:1.8">任务完成/出错时,手机会收到系统通知(需允许通知权限并保持 App 后台运行)。在任务聊天右上角「…」里可对单个任务设置免打扰。</div></div></div></div>`;
  openSubpanel('通知设置', html);
  $('subpanel-body').querySelectorAll('[data-unmute]').forEach(el=>{
    el.onclick = ()=>{ S.muted.delete(el.dataset.unmute); persistMuted(); openNotifySettings(); };
  });
}
function openChangePassword(){
  const html = `<div class="form-section" style="margin-top:10px">
    <div class="form-cell"><div class="fl">原密码</div><input id="cp-old" type="password"></div>
    <div class="form-cell"><div class="fl">新密码</div><input id="cp-new" type="password" placeholder="至少6位"></div>
    <div class="form-cell"><div class="fl">确认新密码</div><input id="cp-new2" type="password"></div>
  </div><button class="btn-primary" id="cp-submit">保 存</button>`;
  openSubpanel('修改密码', html);
  $('cp-submit').onclick = async ()=>{
    const o = $('cp-old').value, n = $('cp-new').value, n2 = $('cp-new2').value;
    if (n !== n2) return toast('两次输入的新密码不一致');
    if (n.length < 6) return toast('新密码至少 6 位');
    try {
      await api('/api/change-password', { oldPassword: o, newPassword: n });
      toast('密码已修改'); closeOverlay('subpanel');
    } catch(e) { toast(esc(e.message)); }
  };
}

function openConnInfo(){
  const chan = IS_APK ? '原生长连接' : '浏览器 WebSocket';
  const chanState = S.conn === 'connected' ? '<span style="color:#07C160">已连接</span>' : '<span style="color:#FA5151">未连接</span>';
  const errLine = S.sockError ? `<div class="cell"><div class="c-main"><div class="c-name">通道错误</div><div class="c-sub" style="color:#FA5151">${esc(S.sockError)}</div></div></div>` : '';
  const html = `<div class="cells">
    <div class="cell" id="ci-server"><div class="c-main"><div class="c-name">服务器地址</div><div class="c-sub">${esc(serverBase)}</div></div><div class="c-val" style="color:#576B95">修改</div></div>
    <div class="cell"><div class="c-main"><div class="c-name">实时通道(${chan})</div><div class="c-sub">${chanState}</div></div></div>
    ${errLine}
    <div class="cell" id="ci-reconn"><div class="c-main"><div class="c-name" style="color:#576B95">立即重连</div></div></div>
    <div class="cell" id="ci-health"><div class="c-main"><div class="c-name" style="color:#576B95">测试服务器连通性</div></div></div>
  </div>`;
  openSubpanel('连接信息', html);
  $('ci-reconn').onclick = ()=>{ if (IS_APK) { try{ CWApp.requestConnect(); }catch(e){} } else Conn.connect(); toast('重连中…'); };
  $('ci-health').onclick = async ()=>{
    try { await api('/api/health'); toast('服务器可达 ✓<br>若实时通道仍失败,请检查 App 通知/后台权限后点立即重连', 4000); }
    catch(e) { toast('服务器不可达: ' + esc(e.message), 4000); }
  };
  $('ci-server').onclick = ()=>{
    const v = prompt('服务器地址', serverBase);
    if (v && /^https?:\/\//.test(v)) { serverBase = v.replace(/\/$/,''); LS.set('server', serverBase); toast('已保存,重连中…'); setTimeout(()=>location.reload(), 800); }
  };
}

const modelCatalogs = new Map();
const modelLoads = new Map();
const frameRequests = new Map();
const drafts = new Map();
let navStack = [];
function requestFrame(frame, dev){
  if(IS_APK && !CWApp.isConnected())setConn('offline');
  if (S.conn !== 'connected') return Promise.reject(new Error('实时通道未连接，请先重连'));
  if(!IS_LOCAL && !S.devices.some(d=>d.id===dev && d.online))return Promise.reject(new Error('目标电脑已离线，请先确认电脑桥接在线'));
  const ref = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  return new Promise((resolve, reject)=>{
    const timer = setTimeout(()=>{ frameRequests.delete(ref); reject(new Error('电脑响应超时，请检查设备连接后重试')); }, 30000);
    frameRequests.set(ref, { resolve, reject, timer, dev: IS_LOCAL ? 'local' : dev });
    Conn.send(Object.assign({}, frame, { ref }), dev);
  });
}
async function loadModels(dev){
  const key = IS_LOCAL ? 'local' : dev;
  if (modelCatalogs.has(key)) return modelCatalogs.get(key);
  if (modelLoads.has(key)) return modelLoads.get(key);
  const loading = requestFrame({ t:'get_models' }, dev).then(r=>{
    const models = (r.models || []).filter(m=>!m.hidden);
    modelCatalogs.set(key, models); return models;
  }).finally(()=>modelLoads.delete(key));
  modelLoads.set(key, loading); return loading;
}
function catalogFor(c){ return modelCatalogs.get(IS_LOCAL ? 'local' : c._dev) || []; }
function modelName(id){ return id ? String(id).replace(/^gpt-/i,'').replace(/-/g,' ').replace(/\b(sol|astra|luna|terra)\b/gi,s=>s[0].toUpperCase()+s.slice(1)) : '默认模型'; }
function effortName(e){ return ({none:'关闭',minimal:'最低',low:'低',medium:'中等',high:'高',xhigh:'很高',max:'最高',ultra:'极高'})[e] || '默认'; }
function selectedModel(c,tune){ const models=catalogFor(c); return models.find(m=>m.model===(tune.model||c.model)) || models.find(m=>m.isDefault); }
function modelOptions(models, value){ return '<option value="">默认（沿用当前配置）</option>' + models.map(m=>`<option value="${esc(m.model)}"${m.model===value?' selected':''}>${esc(modelName(m.model))}${m.isDefault?' · 推荐':''}</option>`).join(''); }
async function openTunePanel(){
  const key=S.opened; if(!key) return;
  const c=S.chats.get(key); const tune=chatTune(key);
  $('sheet-mask').classList.remove('hidden');
  $('sheet').innerHTML='<div class="sheet-title">正在读取电脑可用模型…</div>';
  try {
    const models=await loadModels(c._dev);
    if(S.opened!==key || $('sheet-mask').classList.contains('hidden')) return;
    const rows=[{model:'',label:'默认',isDefault:false},...models];
    $('sheet').innerHTML=`<div class="picker-heading">选择模型</div><div class="picker-note">切换后从下一条消息生效</div><div class="model-list">${rows.map(m=>`<button class="model-option${(tune.model||'')===m.model?' selected':''}" data-model="${esc(m.model)}"><span>${esc(m.label||modelName(m.model))}${m.isDefault?'<small>推荐模型</small>':m.model?'':'<small>沿用当前会话配置</small>'}</span><b>${(tune.model||'')===m.model?'✓':''}</b></button>`).join('')}</div>`;
    $('sheet').querySelectorAll('[data-model]').forEach(el=>el.onclick=()=>{
      const model=el.dataset.model; const m=models.find(x=>x.model===model);
      const allowed=(m?.supportedReasoningEfforts||[]).map(x=>x.reasoningEffort);
      setChatTune(key,Object.assign({},tune,{model,effort:allowed.includes(tune.effort)?tune.effort:(m?.defaultReasoningEffort||'')})); hideSheet();
    });
  } catch(e) { if(S.opened===key&&!$('sheet-mask').classList.contains('hidden')) $('sheet').innerHTML=`<div class="picker-heading">选择模型</div><div class="picker-note">${esc(e.message)}</div><button class="picker-retry">重新获取</button>`; $('sheet').querySelector('.picker-retry')?.addEventListener('click',openTunePanel); }
}
async function openEffortPanel(){
  const key=S.opened; if(!key) return;
  const c=S.chats.get(key); const tune=chatTune(key);
  try { await loadModels(c._dev); } catch(e) { return toast(esc(e.message)); }
  if(S.opened!==key) return;
  const m=selectedModel(c,tune); const opts=(m?.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort);
  const chosen=tune.effort||c.effort||m?.defaultReasoningEffort;
  let index=opts.indexOf(chosen); if(index<0) index=Math.max(0,opts.indexOf(m?.defaultReasoningEffort));
  $('sheet-mask').classList.remove('hidden');
  $('sheet').innerHTML=`<div class="picker-heading">思考强度 <button id="effort-reset" class="picker-reset">恢复默认</button></div><div class="effort-current" id="effort-current">${effortName(opts[index])}</div><div class="picker-note">${esc(modelName(m?.model||c.model))} · 从下一条消息生效</div>${opts.length?`<input class="effort-slider" id="effort-slider" type="range" min="0" max="${opts.length-1}" step="1" value="${index}"${opts.length===1?' disabled':''}><div class="effort-labels">${opts.map((e,i)=>`<button data-effort="${esc(e)}">${effortName(e)}</button>`).join('')}</div>`:'<div class="picker-note">此模型未提供可调档位</div>'}`;
  const save=e=>{ setChatTune(key,Object.assign({},tune,{effort:e})); $('effort-current').textContent=effortName(e); };
  $('effort-reset').onclick=()=>{ setChatTune(key,Object.assign({},tune,{effort:m?.defaultReasoningEffort||''})); hideSheet(); };
  $('effort-slider')?.addEventListener('input',ev=>save(opts[+ev.target.value]));
  $('sheet').querySelectorAll('[data-effort]').forEach(el=>el.onclick=()=>{save(el.dataset.effort); hideSheet();});
}
function draftFor(k){ if(!drafts.has(k)) drafts.set(k,{text:'',files:[],busy:false}); return drafts.get(k); }
function openSlashPanel(){
  if(!S.opened||draftFor(S.opened).busy)return;
  const chat=S.chats.get(S.opened);
  if(chat.draft)return toast('发送第一条指令后可使用快捷指令');
  const enabled=chat.interactive&&!chat.compacting&&!['running','waiting_input','waiting_approval'].includes(chat.status);
  const note=!chat.interactive?'此聊天由桌面持有，当前桌面接口未开放压缩操作':chat.compacting?'上下文正在压缩，请等待完成':!enabled?'请等待当前任务完成后再压缩':'调用 Codex 原生压缩，保留关键上下文后继续这个聊天';
  $('sheet-mask').classList.remove('hidden');
  $('sheet').innerHTML=`<div class="picker-heading">上下文管理</div><button class="model-option" data-command="compact"${enabled?'':' disabled'}><span>/compact · 压缩上下文<small>${esc(note)}</small></span></button>${!chat.interactive?'<div class="picker-note">我们不会另开进程恢复桌面聊天来压缩，避免会话写入冲突。当前需要在电脑端操作。</div>':''}`;
  $('sheet').querySelector('[data-command]').onclick=async()=>{
    if($('chat-input').value.trim()==='/'){$('chat-input').value='';draftFor(S.opened).text='';renderComposer();}
    const button=$('sheet').querySelector('[data-command]');button.disabled=true;
    try{await requestFrame({t:'compact_context',chatId:chat.id},chat._dev);hideSheet();toast('压缩请求已提交，完成后会显示在聊天中');}
    catch(e){toast(esc(e.message),4000);button.disabled=false;}
  };
}
let workspaceSequence=0;
async function openWorkspacePicker(path){
  const key=S.opened;if(!key||draftFor(key).busy)return;
  const chat=S.chats.get(key),sequence=++workspaceSequence;
  if(chat.draft)return toast('发起任务后可引用电脑文件');
  $('sheet-mask').classList.remove('hidden');$('sheet').innerHTML='<div class="picker-heading">引用电脑文件</div><div class="picker-note">正在读取当前工作目录…</div>';
  try{
    const result=await requestFrame({t:'browse_workspace',chatId:chat.id,path},chat._dev);
    if(S.opened!==key||sequence!==workspaceSequence||$('sheet-mask').classList.contains('hidden'))return;
    $('sheet').innerHTML=`<div class="picker-heading">引用电脑文件</div><div class="picker-note" style="overflow-wrap:anywhere">${esc(result.path)}<br>选择后随下一条消息提交文件路径，电脑上的 Codex 读取内容。</div><input class="workspace-filter" id="workspace-filter" placeholder="筛选当前目录的文件名">${result.parent?'<button class="model-option" id="workspace-parent">↑ 上一级</button>':''}<div class="model-list" id="workspace-list">${result.entries.map((e,i)=>`<button class="model-option" data-workspace="${i}"><span>${e.directory?'📁':'@'} ${esc(e.name)}</span></button>`).join('')||'<div class="picker-note">当前目录为空</div>'}</div>${result.truncated?'<div class="picker-note">仅展示前 1000 项，请进入子目录筛选。</div>':''}`;
    if($('workspace-parent'))$('workspace-parent').onclick=()=>openWorkspacePicker(result.parent);
    $('workspace-filter').oninput=()=>{$('workspace-list').querySelectorAll('[data-workspace]').forEach(el=>el.hidden=!result.entries[+el.dataset.workspace].name.toLowerCase().includes($('workspace-filter').value.toLowerCase()));};
    $('workspace-list').querySelectorAll('[data-workspace]').forEach(el=>el.onclick=()=>{
      const entry=result.entries[+el.dataset.workspace];if(entry.directory)return openWorkspacePicker(entry.path);
      const draft=draftFor(key);if(draft.files.length>=5)return toast('每条消息最多 5 个附件和引用文件');
      if(!draft.files.some(f=>f.localPath===entry.path))draft.files.push({file:{name:entry.name},localPath:entry.path,progress:'电脑文件引用'});
      const input=$('chat-input');input.value=input.value.replace(/(^|\s)@$/, '$1');draft.text=input.value;
      hideSheet();renderComposer();input.focus();
    });
  }catch(e){if(S.opened===key&&sequence===workspaceSequence&&!$('sheet-mask').classList.contains('hidden'))$('sheet').innerHTML=`<div class="picker-heading">引用电脑文件</div><div class="picker-note">${esc(e.message)}</div><button class="picker-retry" id="workspace-retry">重试</button>`;if($('workspace-retry'))$('workspace-retry').onclick=()=>openWorkspacePicker(path);}
}
/* ================= 项目文件浏览(聊天菜单 → 浏览项目文件夹) ================= */
function fmtBytes(n){
  if(!Number.isFinite(n)||n<0)return '';
  if(n<1024)return n+' B';
  if(n<1048576)return (n/1024).toFixed(1)+' KB';
  if(n<1073741824)return (n/1048576).toFixed(1)+' MB';
  return (n/1073741824).toFixed(2)+' GB';
}
const FILE_MIME={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',ico:'image/x-icon',svg:'image/svg+xml',pdf:'application/pdf',txt:'text/plain',md:'text/markdown',json:'application/json',js:'text/javascript',css:'text/css',html:'text/html',htm:'text/html',csv:'text/csv',xml:'application/xml',zip:'application/zip',gz:'application/gzip',tar:'application/x-tar',rar:'application/vnd.rar','7z':'application/x-7z-compressed',apk:'application/vnd.android.package-archive',jar:'application/java-archive',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',doc:'application/msword',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',mp4:'video/mp4',mkv:'video/x-matroska',mov:'video/quicktime',webm:'video/webm'};
function mimeOf(name){ const m=/\.([a-z0-9]+)$/i.exec(String(name||'')); return (m&&FILE_MIME[m[1].toLowerCase()])||'application/octet-stream'; }
const ICON_TEXT_EXT=new Set(['txt','md','mdx','markdown','json','js','mjs','cjs','ts','tsx','jsx','css','scss','less','html','htm','xml','yml','yaml','ini','cfg','conf','env','log','csv','tsv','py','rb','go','rs','java','kt','c','h','cpp','hpp','cs','php','sh','bash','zsh','ps1','bat','cmd','sql','toml','lua','swift','dart','vue','svelte','proto','gradle','properties','editorconfig','gitignore','lock','service','tf']);
function fileIcon(name){
  const m=/\.([a-z0-9]+)$/i.exec(String(name||'')); const ext=m?m[1].toLowerCase():'';
  if(new Set(['png','jpg','jpeg','gif','webp','bmp','ico','svg']).has(ext))return '🖼️';
  if(new Set(['mp3','wav','flac','m4a','mp4','mkv','mov','avi','webm']).has(ext))return '🎬';
  if(new Set(['zip','rar','7z','tar','gz','apk','jar','exe','msi','dmg']).has(ext))return '🗜️';
  return ICON_TEXT_EXT.has(ext)||!ext?'📄':'📦';
}
let fileSeq=0;
function fileFrameArgs(c){ return c.draft ? { cwd: c.cwd } : { chatId: c.id }; }
async function openFileBrowser(key, path){
  const c=S.chats.get(key); if(!c)return;
  if(!c.cwd)return toast('这个会话没有工作目录');
  revokeFvMedia();
  const seq=++fileSeq;
  openSubpanel('项目文件','<div class="empty"><span class="spin" style="border-color:rgba(0,0,0,.15);border-top-color:#999"></span> 正在读取文件夹…</div>');
  try{
    const result=await requestFrame(Object.assign({t:'browse_workspace',path},fileFrameArgs(c)),c._dev);
    if(seq!==fileSeq||!navStack.includes('subpanel'))return;
    renderFileBrowser(key,result);
  }catch(e){
    if(seq!==fileSeq||!navStack.includes('subpanel'))return;
    openSubpanel('项目文件',`<div class="empty">${esc(e.message)}</div><button class="btn-primary" id="fb-retry">重试</button>`);
    if($('fb-retry'))$('fb-retry').onclick=()=>openFileBrowser(key,path);
  }
}
function renderFileBrowser(key,result){
  const c=S.chats.get(key); if(!c)return;
  const title=result.path?basenameOf(result.path):('项目 · '+(c.project?basenameOf(c.cwd):basenameOf(c.cwd)));
  const files=result.entries.filter(e=>!e.directory), dirs=result.entries.filter(e=>e.directory);
  let html=`<div class="usage-card" style="overflow-wrap:anywhere"><b>${esc(title)}</b><p class="usage-note">${esc(result.path||c.cwd)} · ${dirs.length} 个文件夹 / ${files.length} 个文件</p></div>`;
  html+=`<div class="search-bar" style="padding:8px 12px;background:transparent"><input id="fb-filter" placeholder="筛选文件名" style="width:100%;height:32px;border:none;border-radius:6px;background:#fff;outline:none;padding:0 12px;font-size:14px;color:#191919"></div>`;
  html+=`<div class="cells">`;
  if(result.parent!==null&&result.parent!==undefined)html+=`<div class="cell" id="fb-parent"><div class="c-main"><div class="c-name" style="color:#576B95">‹ 上一级</div></div></div>`;
  for(const e of result.entries)html+=`<div class="cell fb-entry" data-file="${esc(e.path)}" data-dir="${e.directory?1:0}"><div class="c-avatar" style="background:#F2F2F2;width:36px;height:36px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:17px">${e.directory?'📁':fileIcon(e.name)}</div><div class="c-main"><div class="c-name" style="font-size:15px;${e.directory?'color:#191919':''}">${esc(e.name)}</div></div><div class="chev">›</div></div>`;
  if(!result.entries.length)html+=`<div class="cell"><div class="c-main"><div class="c-name" style="color:#999">此文件夹为空</div></div></div>`;
  html+=`</div>${result.truncated?'<div class="picker-note">仅展示前 1000 项,可进入子目录或用筛选。</div>':''}`;
  openSubpanel(title||'项目文件',html);
  if($('fb-parent'))$('fb-parent').onclick=()=>openFileBrowser(key,result.parent);
  const f=$('fb-filter');
  if(f)f.oninput=()=>{
    const q=f.value.toLowerCase();
    document.querySelectorAll('#subpanel-body .fb-entry').forEach(el=>{
      el.hidden=!el.querySelector('.c-name').textContent.toLowerCase().includes(q);
    });
  };
  document.querySelectorAll('#subpanel-body .fb-entry').forEach(el=>{
    el.onclick=()=>{
      const p=el.dataset.file;
      if(el.dataset.dir==='1')openFileBrowser(key,p);
      else openFileView(key,{path:p,name:p.split(/[\\/]/).pop()},result.path);
    };
  });
}
let fvMediaUrl=null;
function revokeFvMedia(){ if(fvMediaUrl){ try{URL.revokeObjectURL(fvMediaUrl);}catch(e){} fvMediaUrl=null; } }
async function fetchFileChunks(c, entry, onProgress){
  const parts=[]; let total=0, offset=0;
  for(;;){
    const r=await requestFrame(Object.assign({t:'file_read',path:entry.path,offset},fileFrameArgs(c)),c._dev);
    parts.push(r.data); total=r.total; offset=r.next;
    if(onProgress)onProgress(offset,total);
    if(r.done)break;
  }
  return {parts,total};
}
function partsToBlobUrl(parts,mime){
  let len=0;const bins=parts.map(p=>{const b=atob(p);len+=b.length;return b;});
  const bytes=new Uint8Array(len);let o=0;
  for(const b of bins)for(let i=0;i<b.length;i++)bytes[o++]=b.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes],{type:mime||'application/octet-stream'}));
}
function saveViaBridge(c,entry,open){
  return new Promise((resolve,reject)=>{
    (async()=>{
      const btn=document.getElementById(open?'fv-open':'fv-download');
      const label=btn?btn.textContent:'';
      if(btn){btn.disabled=true;}
      let id=null;
      try{
        const {parts,total}=await fetchFileChunks(c,entry,(off,total)=>{
          if(btn)btn.textContent=total?('传输 '+Math.min(99,Math.round(off/total*100))+'%'):'传输…';
        });
        if(!(IS_APK&&typeof CWApp.saveFileBegin==='function'))throw new Error('当前环境不支持保存到手机');
        id=CWApp.saveFileBegin(entry.name,mimeOf(entry.name));
        if(!id)throw new Error('无法开始保存');
        for(const part of parts){
          if(!CWApp.saveFileChunk(id,part)){CWApp.saveFileAbort(id);id=null;throw new Error('保存中断,请重试');}
        }
        let result;
        if(open){
          result=CWApp.saveFileEndAndOpen(id);id=null;
          if(result==='opened'){toast('已保存,请在系统弹窗中选择应用'+(/\.apk$/i.test(entry.name)?'或安装':''),4000);resolve();}
          else if(result==='saved'){toast('已保存到 下载/CodexWatch;此系统无法直接调起其他应用,请到下载目录打开',5000);resolve();}
          else throw new Error('打开失败');
        }else{
          if(!CWApp.saveFileEnd(id)){id=null;throw new Error('保存失败');}
          toast('已保存到 下载/CodexWatch/'+entry.name+'('+fmtBytes(total)+')',4000);resolve();
        }
      }catch(e){ if(id){try{CWApp.saveFileAbort(id);}catch(x){}} reject(e); }
      finally{ if(btn){btn.disabled=false;btn.textContent=label;} }
    })();
  });
}
async function downloadWorkspaceFile(c,entry,btn){
  if(IS_APK&&typeof CWApp.saveFileBegin==='function'){
    try{ await saveViaBridge(c,entry,false); }catch(e){ toast(esc(e.message||'下载失败'),4000); }
    return;
  }
  if(btn&&btn.disabled)return;
  const original=btn?btn.textContent:''; if(btn)btn.disabled=true;
  try{
    const {parts,total}=await fetchFileChunks(c,entry,(off,total)=>{
      if(btn)btn.textContent=total?('下载中 '+Math.min(99,Math.round(off/total*100))+'%'):'下载中…';
    });
    const url=partsToBlobUrl(parts,mimeOf(entry.name));
    const a=document.createElement('a');a.href=url;a.download=entry.name;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    toast('已开始下载 '+entry.name+'('+fmtBytes(total)+')');
  }catch(e){toast(esc(e.message||'下载失败'),4000);}
  finally{if(btn){btn.disabled=false;btn.textContent=original;}}
}
async function copyAnyText(text){
  try{
    if(IS_APK&&typeof CWApp.copyText==='function'){if(!CWApp.copyText(text))throw new Error('复制失败');}
    else if(navigator.clipboard&&navigator.clipboard.writeText)await navigator.clipboard.writeText(text);
    else throw new Error('复制失败');
    toast('已复制');
  }catch(e){toast('复制失败,请长按文本手动复制');}
}
function showImageFullscreen(url){
  let v=document.getElementById('fv-imgviewer');
  if(!v){
    v=document.createElement('div');v.id='fv-imgviewer';
    v.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:80;display:flex;align-items:center;justify-content:center';
    v.onclick=()=>v.remove();
    v.innerHTML='<img style="max-width:96vw;max-height:92vh;object-fit:contain" alt="">';
    document.body.appendChild(v);
  }
  v.querySelector('img').src=url;
  v.remove();document.body.appendChild(v);  // 置顶
}
async function openFileView(key,entry,dirPath){
  const c=S.chats.get(key); if(!c)return;
  const seq=++fileSeq;
  openSubpanel(entry.name,'<div class="empty"><span class="spin" style="border-color:rgba(0,0,0,.15);border-top-color:#999"></span> 正在读取文件…</div>');
  try{
    const r=await requestFrame(Object.assign({t:'file_preview',path:entry.path},fileFrameArgs(c)),c._dev);
    if(seq!==fileSeq||!navStack.includes('subpanel'))return;
    const info=`<div class="usage-card" style="overflow-wrap:anywhere"><b>${esc(r.name)}</b><p class="usage-note">${fmtBytes(r.size)} · ${r.mtime?dayLabel(r.mtime):''}${r.truncated?' · 仅预览前 64KB,完整内容请下载':''}</p></div>`;
    const back=`<div class="cells"><div class="cell" id="fv-back"><div class="c-main"><div class="c-name" style="color:#576B95">‹ 返回 ${esc(dirPath?basenameOf(dirPath):'目录')}</div></div></div></div>`;
    const openBtn=IS_APK&&typeof CWApp.saveFileEndAndOpen==='function'?`<button class="btn-primary" id="fv-open" style="margin-top:10px;background:#576B95">↗ 用其他应用打开${/\.apk$/i.test(entry.name)?'(可安装)':''}</button>`:'';
    const dl=`<button class="btn-primary" id="fv-download">⬇ 下载到手机(${fmtBytes(r.size)})</button>`;
    let body;
    if(r.isText){
      const isMd=/\.(md|markdown)$/i.test(r.name);
      const rawHtml=`<pre class="file-view">${esc(r.text)||'(空文件)'}</pre>`;
      const renderHtml=`<div class="file-view md-rendered bubble-md">${mdToHtml(r.text)||'<span style="color:#999">(空文件)</span>'}</div>`;
      body=back+info+`<div id="fv-text-body">${isMd?renderHtml:rawHtml}</div>
        <div class="cells"><div class="cell" id="fv-copy"><div class="c-main"><div class="c-name">📋 复制${isMd?'源码':'内容'}</div></div></div>${isMd?'<div class="cell" id="fv-md-toggle"><div class="c-main"><div class="c-name">📄 查看源码</div></div></div>':''}</div>`+dl+openBtn;
      openSubpanel(r.name,body);
      $('fv-copy').onclick=()=>copyAnyText(r.text);
      if($('fv-md-toggle')){
        let mdView=true;
        $('fv-md-toggle').onclick=()=>{
          mdView=!mdView;
          $('fv-text-body').innerHTML=mdView?renderHtml:rawHtml;
          $('fv-md-toggle').querySelector('.c-name').textContent=mdView?'📄 查看源码':'👁 查看渲染结果';
        };
      }
    }else if(r.kind==='image'||r.kind==='video'||r.kind==='audio'){
      revokeFvMedia();
      const mediaArea=`<div class="media-view" id="fv-media-box"><span class="spin" style="border-color:rgba(255,255,255,.3);border-top-color:#fff"></span><span style="color:#bbb;font-size:12px" id="fv-media-note"> 正在加载…</span></div>`;
      body=back+info+mediaArea+dl+openBtn;
      openSubpanel(r.name,body);
      // 分块拉取后用 blob 内置预览(≤20MB)
      try{
        const {parts}=await fetchFileChunks(c,entry,(off,total)=>{
          const n=$('fv-media-note'); if(n)n.textContent=' 加载 '+Math.min(99,Math.round(off/total*100))+'%';
        });
        if(seq!==fileSeq||!navStack.includes('subpanel')){revokeFvMedia();return;}
        fvMediaUrl=partsToBlobUrl(parts,mimeOf(entry.name));
        const box=$('fv-media-box');
        if(r.kind==='image'){
          box.innerHTML=`<img id="fv-media" src="${fvMediaUrl}" alt="">`;
          $('fv-media').onclick=()=>showImageFullscreen(fvMediaUrl);
        }else if(r.kind==='video'){
          box.innerHTML=`<video id="fv-media" src="${fvMediaUrl}" controls playsinline preload="metadata"></video>`;
        }else{
          box.innerHTML=`<audio id="fv-media" src="${fvMediaUrl}" controls style="width:100%"></audio>`;
        }
      }catch(e){ const box=$('fv-media-box'); if(box)box.innerHTML=`<div style="color:#FA5151;font-size:13px;padding:16px">${esc(e.message)}</div>`; }
    }else{
      body=back+info+`<div class="picker-note" style="text-align:center">此类型不支持内置预览,可下载或用其他应用打开。</div>`+dl+openBtn;
      openSubpanel(r.name,body);
    }
    $('fv-back').onclick=()=>openFileBrowser(key,dirPath);
    $('fv-download').onclick=e=>downloadWorkspaceFile(c,entry,e.currentTarget);
    const ob=$('fv-open'); if(ob)ob.onclick=()=>saveViaBridge(c,entry,true).catch(e=>toast(esc(e.message||'打开失败'),4000));
  }catch(e){
    if(seq!==fileSeq||!navStack.includes('subpanel'))return;
    openSubpanel(entry.name,`<div class="empty">${esc(e.message)}</div><button class="btn-primary" id="fv-back2">‹ 返回目录</button>`);
    if($('fv-back2'))$('fv-back2').onclick=()=>openFileBrowser(key,dirPath);
  }
}
let shutdownTicker=null;
function renderShutdownBar(){
  const bar=$('shutdown-bar'); if(!bar)return;
  const c=S.opened?S.chats.get(S.opened):null;
  const sd=S.shutdown;
  if(!c||!sd||sd.chatId!==c.id){
    bar.classList.add('hidden');
    if(shutdownTicker){clearInterval(shutdownTicker);shutdownTicker=null;}
    return;
  }
  if(sd.phase==='countdown'){
    const left=Math.max(0,Math.round((sd.deadline-(Date.now()+S.clockSkew))/1000));
    if(left<=0){bar.innerHTML='<span class="sh-ic">⏻</span><b>正在关机…</b>';}
    else{
      const m=Math.floor(left/60),s=left%60;
      bar.innerHTML=`<span class="sh-ic">⏻</span>任务已完成 <b>${m}:${String(s).padStart(2,'0')}</b> 后关机<span class="sh-cancel">点击取消</span>`;
      bar.onclick=()=>{if(S.opened){const cc=S.chats.get(S.opened);if(cc)Conn.send({t:'shutdown_cancel'},cc._dev);}};
    }
    if(!shutdownTicker)shutdownTicker=setInterval(renderShutdownBar,1000);
  }else{
    bar.innerHTML=`<span class="sh-ic">⏻</span>任务完成后 <b>${Math.max(1,Math.round(sd.delayMs/60000))}</b> 分钟自动关机<span class="sh-cancel">点击取消</span>`;
    bar.onclick=()=>{if(S.opened){const cc=S.chats.get(S.opened);if(cc)Conn.send({t:'shutdown_cancel'},cc._dev);}};
    if(shutdownTicker){clearInterval(shutdownTicker);shutdownTicker=null;}
  }
  bar.classList.remove('hidden');
}
function renderComposer(){
  if(!S.opened) return;
  const d=draftFor(S.opened);
  const isDraft=S.chats.get(S.opened)?.draft;
  renderShutdownBar();
  $('chat-send').disabled=d.busy || (!d.text.trim()&&!d.files.length);
  $('chat-send').textContent=d.busy?'…':'↑';
  $('chat-input').disabled=d.busy;
  $('chat-plus').disabled=d.busy||isDraft;$('chat-permission').disabled=d.busy;
  $('chat-plus').title=isDraft?'发起任务后可添加附件':'';
  $('chat-slash').disabled=d.busy||isDraft;$('chat-mention').disabled=d.busy||isDraft;
  $('chat-attachments').classList.toggle('hidden',!d.files.length);
  $('chat-attachments').innerHTML=d.files.map((a,i)=>`<div class="attachment-chip">${a.preview?`<img src="${a.preview}" alt="图片预览">`:'<span class="file-icon">▤</span>'}<div><span>${esc(a.file.name)}</span><small>${a.progress||'待发送'}</small></div><button data-remove="${i}" aria-label="移除附件"${d.busy?' disabled':''}>×</button></div>`).join('');
  $('chat-attachments').querySelectorAll('[data-remove]').forEach(el=>el.onclick=()=>{const [a]=d.files.splice(+el.dataset.remove,1);if(a.preview)URL.revokeObjectURL(a.preview);renderComposer();});
}
function openAttachmentSheet(){
  if(!S.opened||draftFor(S.opened).busy) return;
  $('sheet-mask').classList.remove('hidden');
  $('sheet').innerHTML='<div class="picker-heading">添加附件</div><div class="attachment-actions"><button id="pick-image">▧<span>图片</span></button><button id="pick-file">▤<span>文件</span></button></div><div class="picker-note">每条消息最多 5 个附件，单个文件不超过 20 MB</div>';
  for(const [button,input] of [['pick-image','chat-image-input'],['pick-file','chat-file-input']]) $(button).onclick=()=>{hideSheet();$(input)._chatKey=S.opened;$(input).click();};
}
function selectAttachments(input){
  const key=input._chatKey; const d=key&&draftFor(key); if(!d) return;
  for(const file of input.files){
    if(d.files.length>=5){toast('每条消息最多 5 个附件');break;}
    if(file.size<=0||file.size>20*1024*1024){toast(esc(file.name)+'：文件须大于 0 且不超过 20 MB');continue;}
    d.files.push({file,preview:/^image\/(png|jpeg|webp)$/.test(file.type)?URL.createObjectURL(file):null});
  }
  input.value=''; if(S.opened===key)renderComposer();
}
function readBase64(blob){ return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('读取附件失败'));reader.readAsDataURL(blob);}); }
async function sendChatMessage(){
  const key=S.opened; if(!key) return;
  const c=S.chats.get(key); const d=draftFor(key);
  d.text=$('chat-input').value;
  if(c.draft){
    if(d.busy||!d.text.trim())return;
    d.busy=true;renderComposer();
    try{
      const tune=chatTune(key);
      const result=await requestFrame({t:'new_task',cwd:c.cwd,prompt:d.text.trim(),model:tune.model||undefined,effort:tune.effort||undefined,approvalPolicy:tune.approvalPolicy||c.approvalPolicy,sandbox:c.sandbox||undefined},c._dev);
      S.chats.delete(key);drafts.delete(key);LS.set('tune:'+key,null);
      if(result.chatId){
        const createdKey=chatKey(c._dev,result.chatId);
        if(!S.chats.has(createdKey))S.chats.set(createdKey,Object.assign({},c,{id:result.chatId,draft:false,status:'running',title:d.text.trim().slice(0,50)}));
        LS.set('tune:'+createdKey,tune);
        if(S.opened===key)openChat(createdKey);
      }else if(S.opened===key)closeChat();
      renderChatList();if(S.tab==='projects')renderProjects();toast('任务已发起');
    }catch(e){toast(esc(e.message),4000);}
    finally{d.busy=false;if(S.opened===key)renderComposer();}
    return;
  }
  if(d.text.trim()==='/compact'&&!d.files.length){openSlashPanel();return;}
  if(d.busy||(!d.text.trim()&&!d.files.length))return;
  if(S.conn!=='connected')return toast('实时通道未连接，请先重连');
  d.busy=true;renderComposer();
  try {
    for(const a of d.files){
      if(a.id||a.localPath)continue;
      const begin=await requestFrame({t:'upload_begin',chatId:c.id,name:a.file.name,size:a.file.size,mime:a.file.type},c._dev);
      for(let offset=0,index=0;offset<a.file.size;offset+=65536,index++){
        const data=await readBase64(a.file.slice(offset,offset+65536));
        await requestFrame({t:'upload_chunk',id:begin.id,index,data},c._dev);
        a.progress='上传 '+Math.min(100,Math.round((offset+65536)/a.file.size*100))+'%'; if(S.opened===key)renderComposer();
      }
      const final=await requestFrame({t:'upload_finish',id:begin.id},c._dev);a.id=final.id;a.progress='已上传';
    }
    const tune=chatTune(key); const text=d.text.trim()||'请查看附带的文件和图片。';
    const result=await requestFrame({t:'send_msg',chatId:c.id,text,attachments:d.files.filter(a=>!a.localPath).map(a=>a.id),references:d.files.filter(a=>a.localPath).map(a=>a.localPath),model:tune.model||undefined,effort:tune.effort||undefined,approvalPolicy:c.interactive?tune.approvalPolicy||undefined:undefined},c._dev);
    if(result.mode==='desktop')toast('桌面已接收转发，请确认回复对应本次请求');
    else if(result.mode!=='queued'&&result.mode!=='local_queue')toast('已发送');
    for(const a of d.files)if(a.preview)URL.revokeObjectURL(a.preview);
    d.files=[];d.text='';if(S.opened===key)$('chat-input').value='';
  } catch(e){ for(const a of d.files){a.id=null;a.progress='发送失败，可重试';} toast(esc(e.message),4000); }
  finally{d.busy=false;if(S.opened===key)renderComposer();}
}

/* ================= 视图:项目(联系人式) ================= */
function projectGroups(){
  const m = new Map();
  for (const c of S.chats.values()) {
    if(c.draft)continue;
    if(S.archived.has(chatKey(c._dev, c.id)))continue;
    const key = c.cwd || '其他';
    const g = m.get(key) || { cwd: key, project: c.project || basenameOf(key), chats: 0, running: 0, waiting: 0, lastTs: 0 };
    g.chats++;
    if (c.status === 'running') g.running++;
    if (c.status === 'waiting_approval' || c.status === 'waiting_input') g.waiting++;
    if ((c.lastTs||0) > g.lastTs) g.lastTs = c.lastTs;
    m.set(key, g);
  }
  return [...m.values()].sort((a,b)=>b.lastTs-a.lastTs);
}
function basenameOf(p){ p=String(p||'').replace(/[\\/]+$/,''); const i=Math.max(p.lastIndexOf('/'),p.lastIndexOf('\\')); return i>=0?p.slice(i+1):p; }
function renderProjects(){
  const box = $('project-list');
  const groups = projectGroups();
  const newTaskEntry = `<div class="cells"><div class="cell" id="project-new" role="button" tabindex="0"><div class="c-avatar" style="background:#07C160;color:#fff;display:flex;align-items:center;justify-content:center;font-size:26px">＋</div><div class="c-main"><div class="c-name">新建任务</div><div class="c-sub">选择项目或电脑文件夹，进入聊天草稿</div></div><div class="chev">›</div></div></div>`;
  let html = newTaskEntry + (groups.length ? `<div class="group-h">共 ${groups.length} 个项目 · 按最近活跃排序</div><div class="cells">` : `<div class="empty"><div class="big">📁</div>还没有项目<br>发起第一个任务后自动出现在这里</div>`);
  for (const g of groups) {
    const badges = [];
    if (g.running) badges.push(`<span class="tag-mini">${g.running} 运行中</span>`);
    if (g.waiting) badges.push(`<span class="tag-mini" style="background:#FA5151">${g.waiting} 待处理</span>`);
    html += `<div class="cell" data-cwd="${esc(g.cwd)}">
      ${avatarHtml(g.cwd, (g.project||'?').charAt(0).toUpperCase())}
      <div class="c-main">
        <div class="c-name">${esc(g.project||g.cwd)} ${badges.join(' ')}</div>
        <div class="c-sub">${esc(g.cwd)}</div>
      </div>
      <div class="c-val">${g.chats} 个任务</div><div class="chev">›</div>
    </div>`;
  }
  if (groups.length) html += `</div>`;
  box.innerHTML = html;
  $('project-new').onclick = openNewTask;
  $('project-new').onkeydown = event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openNewTask();}};
  box.querySelectorAll('.cell[data-cwd]').forEach(el=>{
    el.onclick = ()=>openProject(el.dataset.cwd);
  });
}
function openProject(cwd){
  const chats = [...S.chats.values()].filter(c => !c.draft && !S.archived.has(chatKey(c._dev, c.id)) && (c.cwd||'') === cwd);
  const g = projectGroups().find(x=>x.cwd===cwd) || { project: basenameOf(cwd) };
  chats.sort((a,b)=>{ const d=statusW(a)-statusW(b); return d!==0?d:(b.lastTs||0)-(a.lastTs||0); });
  let html = `<div class="group-h">${esc(cwd)}</div><div class="cells">`;
  for (const c of chats) {
    const k = chatKey(c._dev, c.id);
    html += `<div class="cell" data-k="${esc(k)}">
      <div class="c-avatar" style="width:36px;height:36px;border-radius:5px;background:linear-gradient(135deg,${paletteOf(c.id).join(',')});color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px">${esc((c.title||'任').charAt(0))}</div>
      <div class="c-main"><div class="c-name" style="font-size:15px">${esc(c.title||'未命名任务')}</div>
      <div class="c-sub">${STATUS_TEXT[c.status]||''} · ${esc(mdStrip(c.lastMsg||'')).slice(0,30)}</div></div>
      <div class="c-val">${relTime(c.lastTs)}</div></div>`;
  }
  html += `</div><button class="btn-primary" id="proj-new">＋ 在此项目发起新任务</button>`;
  openSubpanel(g.project || '项目', html);
  $('subpanel-body').querySelectorAll('.cell[data-k]').forEach(el=>{ el.onclick = ()=>{ closeOverlay('subpanel'); openChat(el.dataset.k); }; });
  $('proj-new').onclick = ()=>{ closeOverlay('subpanel');NT.dev=IS_LOCAL?'local':(chats.find(c=>S.devices.some(d=>d.id===c._dev && d.online))?._dev||activeDeviceId());NT.cwd = cwd; openNewTask(); if(navStack.includes('newtask')&&NT.cwd)openNewTaskDraft(); };
}

/* ================= 弹层与交互 ================= */
function showOverlay(id){ navStack=navStack.filter(x=>x!==id);navStack.push(id);const el=$(id); el.classList.remove('hidden'); requestAnimationFrame(()=>{if(navStack.includes(id))el.classList.add('show');}); }
function closeOverlay(id){ navStack=navStack.filter(x=>x!==id);const el=$(id); el.classList.remove('show'); setTimeout(()=>{if(!el.classList.contains('show'))el.classList.add('hidden');},250); }
window.__cwback=()=>{
  for(const id of ['sheet-mask','chat-menu-mask']){if(!$(id).classList.contains('hidden')){$(id).classList.add('hidden');return true;}}
  const top=navStack[navStack.length-1];
  if(top){if(top==='chat')closeChat();else closeOverlay(top);return true;}
  if(!$('search-bar').classList.contains('hidden')){$('search-bar').classList.add('hidden');S.search='';$('search-input').value='';renderChatList();return true;}
  if(S.tab!=='chats'){switchTab('chats');return true;}
  return false;
};
function openSubpanel(title, html){
  $('subpanel-title').textContent = title;
  $('subpanel-body').innerHTML = html;
  showOverlay('subpanel');
}

function hideSheet(){ $('sheet-mask').classList.add('hidden'); }

function openChatMenu(){
  const k = S.opened; if (!k) return;
  const c = S.chats.get(k);
  if(c.draft){
    $('chat-menu').innerHTML='<div class="pop-item" id="draft-files">📁 浏览项目文件夹</div><div class="pop-item" id="draft-sandbox">沙箱权限</div>';
    $('chat-menu-mask').classList.remove('hidden');
    $('draft-files').onclick=()=>{
      $('chat-menu-mask').classList.add('hidden');
      openFileBrowser(k, '');
    };
    $('draft-sandbox').onclick=()=>{
      $('chat-menu-mask').classList.add('hidden');
      openSubpanel('任务参数',`<div class="usage-card"><b>工作目录</b><p>${esc(c.cwd)}</p></div><div class="form-section"><div class="form-cell"><div class="fl">沙箱权限</div><select id="draft-sandbox-select"><option value="">默认（电脑配置）</option><option value="read-only">只读</option><option value="workspace-write">可写工作区</option><option value="danger-full-access">完全访问</option></select></div></div><div class="picker-note">仅在发送第一条指令时应用，不会立即启动任务。</div>`);
      $('draft-sandbox-select').value=c.sandbox||'';
      $('draft-sandbox-select').onchange=event=>{c.sandbox=event.target.value;};
    };
    return;
  }
  const items = [];
  if (c.status === 'running') items.push({id:'stop', label: c.durable ? '⏹ 停止任务' : '⏹ 停止任务(仅限本程序发起)'});
  if (c.status === 'running' || (S.shutdown && S.shutdown.chatId === c.id)) items.push(S.shutdown && S.shutdown.chatId === c.id
    ? {id:'shutdown', label:'🚫 取消关机计划'}
    : {id:'shutdown', label:'⏻ 任务完成后关机(延迟5分钟)'});
  items.push({id:'copy', label:'📋 复制会话 ID'});
  if (c.cwd) items.push({id:'files', label:'📁 浏览项目文件夹'});
  items.push({id:'info', label:'ℹ️ 任务信息'});
  items.push({id:'archive', label: S.archived.get(k) ? '📤 取消归档' : '📦 归档该任务'});
  items.push({id:'mute', label: S.muted.get(k) ? '🔔 取消免打扰' : '🔕 免打扰该任务'});
  $('chat-menu').innerHTML = items.map(x=>`<div class="pop-item" data-id="${x.id}">${x.label}</div>`).join('');
  $('chat-menu-mask').classList.remove('hidden');
  $('chat-menu').querySelectorAll('.pop-item').forEach(el=>{
    el.onclick = ()=>{
      $('chat-menu-mask').classList.add('hidden');
      const id = el.dataset.id;
      if (id === 'stop') Conn.send({t:'stop_task', chatId: c.id}, c._dev);
      if (id === 'copy') { navigator.clipboard && navigator.clipboard.writeText(c.id); toast('已复制'); }
      if (id === 'info') openSubpanel('任务信息', `<div class="cells">
          <div class="cell"><div class="c-main"><div class="c-name">标题</div><div class="c-sub">${esc(c.title)}</div></div></div>
          <div class="cell"><div class="c-main"><div class="c-name">工作目录</div><div class="c-sub">${esc(c.cwd)}</div></div></div>
          <div class="cell"><div class="c-main"><div class="c-name">模型</div><div class="c-sub">${esc(c.model||'-')}</div></div></div>
          <div class="cell"><div class="c-main"><div class="c-name">状态</div><div class="c-sub">${esc(c.status)}</div></div></div>
          <div class="cell"><div class="c-main"><div class="c-name">会话ID</div><div class="c-sub" style="user-select:all">${esc(c.id)}</div></div></div>
          <div class="cell"><div class="c-main"><div class="c-name">Token</div><div class="c-sub">${c.tokens?fmtTokens(c.tokens):'-'}</div></div></div>
        </div>`);
      if (id === 'shutdown') {
        if (S.shutdown && S.shutdown.chatId === c.id) { Conn.send({t:'shutdown_cancel'}, c._dev); }
        else { Conn.send({t:'shutdown_arm', chatId: c.id, delayMs: 300000}, c._dev); toast('⏻ 已设置:任务完成后 5 分钟关机<br>输入框上方可随时点击取消', 4000); }
      }
      if (id === 'files') { $('chat-menu-mask').classList.add('hidden'); openFileBrowser(k, ''); }
      if (id === 'archive') { if (S.archived.get(k)) { unarchiveChat(k); toast('已恢复到任务列表'); } else archiveChat(k, c); }
      if (id === 'mute') { if (S.muted.get(k)) S.muted.delete(k); else S.muted.set(k, true); persistMuted(); toast(S.muted.get(k)?'已免打扰':'已恢复通知'); }
    };
  });
}

/* ================= Tab 切换 ================= */
function switchTab(tab){
  S.tab = tab;
  for (const v of ['chats','projects','devices','discover','me']) $('view-'+v).classList.toggle('hidden', v !== tab);
  $('tabbar').querySelectorAll('.tab').forEach(el=>el.classList.toggle('active', el.dataset.tab === tab));
  if (tab === 'devices') {renderDevices();syncDevices();}
  if (tab === 'discover') { Conn.send({t:'get_stats'}); renderDiscover(); }
  if (tab === 'me') renderMe();
  if (tab === 'chats') renderChatList();
  if (tab === 'projects') renderProjects();
}
function updateTabBadge(){
  const n = totalUnread();
  const b = $('tab-badge');
  b.classList.toggle('hidden', !n);
  b.textContent = n > 99 ? '99+' : n;
}

/* ================= 登录 ================= */
function showLogin(){ $('login').classList.remove('hidden'); $('main').classList.add('hidden'); }
function hideLogin(){ $('login').classList.add('hidden'); $('main').classList.remove('hidden'); }
let loginMode = 'login';
function bindLogin(){
  $('li-toggle').onclick = ()=>{
    loginMode = loginMode === 'login' ? 'register' : 'login';
    $('li-toggle').textContent = loginMode === 'login' ? '邀请码注册' : '返回登录';
    $('li-invite-wrap').classList.toggle('hidden', loginMode === 'login');
    $('li-submit').textContent = loginMode === 'login' ? '登录' : '注册并登录';
  };
  $('li-submit').onclick = async ()=>{
    const name = $('li-name').value.trim(), pass = $('li-pass').value;
    $('li-err').textContent = '';
    $('li-submit').disabled = true;
    try {
      let j;
      if (loginMode === 'login') j = await api('/api/login', { name, password: pass });
      else j = await api('/api/register', { invite: $('li-invite').value.trim(), name, password: pass });
      wsToken = j.token; S.user = j.user;
      LS.set('token', wsToken);
      hideLogin();
      Conn.connect();
      S.devicesReady=false;S.devices=[];syncDevices();
    } catch(e) { $('li-err').textContent = e.message; }
    $('li-submit').disabled = false;
  };
  $('li-pass').addEventListener('keydown', e=>{ if(e.key==='Enter') $('li-submit').click(); });
}

/* ================= 全局事件 ================= */
function bindEvents(){
  $('tabbar').querySelectorAll('.tab').forEach(el=>el.onclick=()=>switchTab(el.dataset.tab));
  $('btn-search').onclick = ()=>{ $('search-bar').classList.toggle('hidden'); const i=$('search-input'); if(!$('search-bar').classList.contains('hidden')) i.focus(); else { S.search=''; i.value=''; renderChatList(); } };
  $('search-input').oninput = (e)=>{ S.search = e.target.value.trim(); renderChatList(); };
  $('chat-list').addEventListener('click', (e)=>{
    const btn = e.target.closest('.swipe-btn');
    if (btn) { const item = btn.closest('.chat-item'); if (item) Swipe.runAction(item, btn.dataset.act); return; }
    if (Swipe.suppressClick) { Swipe.suppressClick = false; return; }
    if (Swipe.openEl) { Swipe.close(); return; }   // 先收起已展开的操作按钮
    const it = e.target.closest('.chat-item'); if (!it) return;
    openChat(it.dataset.k);
  });
  bindChatSwipe();
  $('chat-back').onclick = closeChat;
  $('chat-menu-btn').onclick = openChatMenu;
  $('chat-menu-mask').onclick = ()=>$('chat-menu-mask').classList.add('hidden');
  $('sheet-mask').onclick = hideSheet;
  $('sheet').onclick = e=>e.stopPropagation();
  $('newtask-cancel').onclick = ()=>closeOverlay('newtask');
  $('subpanel-back').onclick = ()=>closeOverlay('subpanel');
  // 文件预览里渲染后的 Markdown 代码块复制按钮(与聊天内同一逻辑,容器不同需单独委托)
  $('subpanel-body').addEventListener('click', (e)=>{
    const copy=e.target.closest('.md-copy');
    if(copy){copyMarkdownCode(copy);}
  });

  const input = $('chat-input');
  input.addEventListener('input', ()=>{
    if(S.opened)draftFor(S.opened).text=input.value;renderComposer();
    if(!input.isComposing && input.value.trim()==='/')openSlashPanel();
    else if(/(^|\s)@$/.test(input.value))openWorkspacePicker();
  });
  $('chat-send').onclick = sendChatMessage;
  input.addEventListener('keydown', e=>{ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); sendChatMessage(); } });
  $('chat-permission').onclick=openPermissionPanel;
  $('chat-plus').onclick = openAttachmentSheet;
  for(const id of ['chat-file-input','chat-image-input'])$(id).onchange=()=>selectAttachments($(id));
  $('chat-effort').onclick=openEffortPanel;
  $('chat-slash').onclick=openSlashPanel;
  $('chat-mention').onclick=()=>openWorkspacePicker();

  // 工具卡片展开/收起 + 授权/提问交互(事件委托)
  $('chat-body').addEventListener('click', (e)=>{
    const copy=e.target.closest('.md-copy');
    if(copy){copyMarkdownCode(copy);return;}
    const card = e.target.closest('.tool-card'); if (card) {
      if (e.target.closest('.tool-out') && !e.target.closest('.tool-out').classList.contains('open')) {
        e.target.closest('.tool-out').classList.add('open'); return;
      }
      const args = card.querySelector('.tool-args');
      if (args) args.classList.toggle('open');
      return;
    }
    const apBtn = e.target.closest('.ap-btn[data-req]');
    if (apBtn) {
      apBtn.disabled = true;
      Conn.send({ t: 'answer_approval', reqId: apBtn.dataset.req, decision: apBtn.dataset.dec });
      toast('<span class="spin"></span>已发送决定…', 1500);
      return;
    }
    const askOpt = e.target.closest('.ask-opt[data-req]');
    if (askOpt) {
      const cardEl = askOpt.closest('.ask-card');
      const qWraps = cardEl.querySelectorAll('.ask-q');
      if (qWraps.length <= 1) {
        // 单题:点选即答
        submitQuestion(askOpt.dataset.req,[askOpt.dataset.label],cardEl);
      } else {
        // 多题:toggle 选择
        const same = askOpt.closest('.ask-q');
        same.querySelectorAll('.ask-opt').forEach(x=>x.classList.remove('sel'));
        askOpt.classList.add('sel');
      }
      return;
    }
    const sendBtn = e.target.closest('[data-send][data-req]');
    if (sendBtn) {
      const input = $('chat-body').querySelector(`.ask-free input[data-req="${sendBtn.dataset.req}"]`);
      const val = input && input.value.trim();
      if (val) submitQuestion(sendBtn.dataset.req,[val],sendBtn.closest('.ask-card'));
      else toast('请输入回答或点选选项');
      return;
    }
    const multiBtn = e.target.closest('[data-sendmulti][data-req]');
    if (multiBtn) {
      const cardEl = multiBtn.closest('.ask-card');
      const sels = [...cardEl.querySelectorAll('.ask-opt.sel')];
      const qWraps = cardEl.querySelectorAll('.ask-q');
      const answers = [];
      for (const qw of qWraps) {
        const sel = qw.querySelector('.ask-opt.sel');
        const custom=qw.querySelector('.ask-custom')?.value.trim();
        if (custom || sel) answers.push(custom || sel.dataset.label);
      }
      if (answers.length < qWraps.length) return toast('还有问题未选择');
      submitQuestion(multiBtn.dataset.req,answers,cardEl);
      return;
    }
  });
  // 提问自由输入回车
  $('chat-body').addEventListener('keydown', (e)=>{
    if (e.key !== 'Enter') return;
    const inp = e.target.closest('.ask-free input[data-req]');
    if (inp) { e.preventDefault(); const btn = $('chat-body').querySelector(`[data-send][data-req="${inp.dataset.req}"]`); if (btn) btn.click(); }
  });

  // 模型/思考设置
  $('chat-tune').onclick = openTunePanel;
}

/* ================= APK 桥回调 ================= */
window.__cwonmessage = (s)=>{ let m; try{ m = typeof s === 'string' ? JSON.parse(s) : s; }catch{ return; } onNetMessage(m); };
window.__cwstatus = (s)=>{ let m; try{ m = typeof s === 'string' ? JSON.parse(s) : s; }catch{ return; }
  if (m && m.connected) { S.conn='connected'; S.sockError=null;syncDevices(); }
  else {
    S.conn='offline'; S.sockError = (m && m.error) || null;
    for(const pending of frameRequests.values()){clearTimeout(pending.timer);pending.reject(new Error('实时通道断开，文字已保留；请确认任务状态后重试'));}
    frameRequests.clear();
  }
  updateConnDot();
};
window.__cwdeeplink = (chatId)=>{
  const k = [...S.chats.keys()].find(x=>x.endsWith('/'+chatId));
  if (k) { switchTab('chats'); openChat(k); }
};

/* ================= 启动 ================= */
function boot(){
  bindEvents();
  bindLogin();
  if (IS_LOCAL) {
    S.user = { name: '本机', role: 'local' };
    hideLogin();
    Conn.connect();
    syncDevices();
    setTimeout(()=>{ if(S.chats.size===0) toast('守护进程已连接<br>正在读取 Codex 会话…', 3000); }, 600);
    return;
  }
  if (wsToken) {
    hideLogin();
    // 静默拉取用户信息(失败则要求重新登录)
    api('/api/me').then(r=>{ S.user = r.user; renderMe(); }).catch(()=>{});
    Conn.connect();
    syncDevices();
  } else {
    showLogin();
  }
  // APK 的心跳由原生通道承担；后台页面不轮询设备，避免重复联网。
  setInterval(()=>{ if(document.hidden)return;if (!IS_APK && S.conn === 'connected') Conn.raw({ t: 'ping' });if(!S.devicesReady)syncDevices(); }, 30000);
}
document.addEventListener('DOMContentLoaded', boot);
if (document.readyState !== 'loading') boot();
