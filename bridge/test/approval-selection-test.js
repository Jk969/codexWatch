'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {EventEmitter}=require('node:events'),path=require('node:path');
const {AppServerLink}=require('../lib/appserver'),{Hub}=require('../lib/hub'),{startLocalServer}=require('../lib/localserver');
test('审批模式随原生 turn/start 生效；失败不改状态，拒绝废弃模式与桌面伪切换',async()=>{
  const as=Object.create(AppServerLink.prototype);EventEmitter.call(as);as.available=true;const chat=as.newChat('c',{cwd:process.cwd(),approvalPolicy:'on-request',sandbox:'workspace-write'});as.chats=new Map([['c',chat]]);const calls=[];
  as.send=async(method,params)=>{calls.push({method,params});return {turn:{id:'turn'}}};await as.sendTurn('c','纯文字',{approvalPolicy:'never'});assert.equal(calls[0].params.approvalPolicy,'never');assert.equal(as.summary(chat).approvalPolicy,'never');assert.equal(chat.sandbox,'workspace-write');
  chat.turnId=null;as.send=async()=>{throw Error('服务拒绝')};await assert.rejects(as.sendTurn('c','第二条',{approvalPolicy:'on-request'}),/服务拒绝/);assert.equal(chat.approvalPolicy,'never');chat.turnId='running';await assert.rejects(as.sendTurn('c','非法',{approvalPolicy:'untrusted'}),/不支持/);assert(!chat.pendingTurns);
  const store=new EventEmitter();store.get=()=>({id:'desktop',cwd:process.cwd()});const runner=new EventEmitter();runner.sendMsg=()=>{throw Error('不得伪切换后投递')};runner.newTask=()=>{throw Error('不得忽略审批模式回退 CLI')};const hub=new Hub(store,runner,as),replies=[],sink={send:m=>replies.push(m)};
  await hub.handleFrame({t:'send_msg',ref:'d',chatId:'desktop',text:'保留草稿',approvalPolicy:'never'},sink);assert.match(replies.at(-1).error,/桌面转发接口/);
  as.startThread=async()=>{throw Error('启动拒绝')};await hub.handleFrame({t:'new_task',ref:'n',cwd:process.cwd(),prompt:'测试',approvalPolicy:'on-request'},sink);assert.equal(replies.at(-1).ok,false);assert.match(replies.at(-1).error,/启动拒绝/);
});
test('手机审批面板、发送参数及文字选区在实时刷新中保持',async()=>{
  const {chromium}=require(process.env.CW_PLAYWRIGHT||'playwright');const chat={id:'c',title:'交互聊天',interactive:true,status:'idle',approvalPolicy:'on-request',cwd:process.cwd()};const items=[{iid:'agent',k:'agent',t:'选择这几个中文字，再复制。',ts:Date.now()}];
  const store=new EventEmitter();store.summaries=()=>[chat];store.recentDirs=()=>[];store.stats=()=>({});store.get=store.ensureDetail=()=>chat;store.summary=c=>c;store.itemsView=()=>({chatId:'c',items,summary:chat});
  const as=new EventEmitter();as.chats=new Map([['c',chat]]);as.available=true;as.summaries=()=>[];as.itemsView=()=>({chatId:'c',items,summary:chat});as.listModels=async()=>[];let sent;as.sendTurn=async(id,text,opts)=>{sent=opts;chat.approvalPolicy=opts.approvalPolicy;hub.broadcast({t:'chat_update',chat});return {}};
  const hub=new Hub(store,new EventEmitter(),as);const server=startLocalServer(hub,{port:0,webRoot:path.resolve(__dirname,'../../web')});await new Promise(r=>server.once('listening',r));let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.CW_BROWSER||undefined});const page=await browser.newPage({viewport:{width:393,height:852}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('.chat-item').click();await page.locator('#chat-permission').click();await page.locator('[data-approval="never"]').click();assert.match(await page.locator('#chat-permission').textContent(),/下条：无需审批/);
    await page.locator('#chat-input').fill('中文测试');await page.locator('#chat-send').click();await page.waitForFunction(()=>document.getElementById('chat-input').value==='');assert.equal(sent.approvalPolicy,'never');assert.match(await page.locator('#chat-permission').textContent(),/^审批：无需审批/);
    const selected=await page.evaluate(()=>{const node=document.querySelector('.bubble-md p').firstChild,range=document.createRange();range.setStart(node,2);range.setEnd(node,8);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return {text:selection.toString(),css:getComputedStyle(node.parentElement).userSelect}});assert.equal(selected.text,'这几个中文字');assert.equal(selected.css,'text');
    const changed={...items[0],t:'新的实时内容'};items[0]=changed;hub.broadcast({t:'item_refresh',chatId:'c',item:changed});hub.broadcast({t:'chat',chatId:'c',items,summary:chat});await page.waitForTimeout(120);assert.equal(await page.evaluate(()=>getSelection().toString()),'这几个中文字');assert.match(await page.locator('.bubble-md').textContent(),/选择这几个中文字/);
    await page.evaluate(()=>getSelection().removeAllRanges());await page.waitForFunction(()=>document.querySelector('.bubble-md').textContent.includes('新的实时内容'));
    chat.interactive=false;hub.broadcast({t:'chat_update',chat});await page.locator('#chat-permission').click();assert.equal(await page.locator('[data-approval]').count(),0);assert.match(await page.locator('#sheet').textContent(),/请在电脑端切换/);
    await page.setViewportSize({width:320,height:740});const width=await page.locator('.composer-meta').evaluate(el=>el.scrollWidth-el.clientWidth);assert(width<=1);assert.deepEqual(errors,[]);
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
});


test('真实 rollout 审批状态兼容快速摘要、详情重放和增量更新',()=>{
  const fs=require('node:fs'),os=require('node:os'),{ChatStore}=require('../lib/store');const root=fs.mkdtempSync(path.join(os.tmpdir(),'cw-approval-context-'));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  const file=path.join(root,'rollout.jsonl');const row=(type,payload)=>JSON.stringify({type,payload,timestamp:new Date().toISOString()})+'\n';
  try{
    fs.writeFileSync(file,row('session_meta',{id:'approval-history',cwd:root})+row('turn_context',{approval_policy:'on-request',sandbox_policy:{type:'workspace-write'},model:'gpt-6.1-sol'}));const store=new ChatStore(root);store.quickScan();assert.equal(store.chats.size,1);assert.equal(store.summary(store.get('approval-history')).approvalPolicy,'on-request');const chat=store.ensureDetail('approval-history');assert.equal(chat.approvalPolicy,'on-request');
    fs.appendFileSync(file,row('turn_context',{approval_policy:'never',sandbox_policy:{type:'danger-full-access'}}));store.poll();assert.equal(chat.approvalPolicy,'never');assert.equal(chat.sandbox.type,'danger-full-access');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
