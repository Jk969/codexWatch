'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {AppServerLink}=require('../lib/appserver');
const {Hub}=require('../lib/hub');

function fixture() {
  const source={id:'same-thread',title:'旧会话',cwd:process.cwd(),status:'idle',createdAt:1,lastTs:2,turns:1,_recordVersion:3,items:[{k:'user',t:'历史指令',id:'old'},{k:'askuser',desktop:true,async:true,reqId:'desktop:old',questions:[]}]};
  const store=new EventEmitter();
  Object.assign(store,{poll(){},get:id=>id===source.id?source:null,ensureDetail:id=>id===source.id?source:null,summary:c=>({...c}),summaries:()=>[store.summary(source)],recentDirs:()=>[],stats:()=>({})});
  const runner=new EventEmitter();runner.pending=new Map();runner.sendMsg=()=>{throw Error('不应另开 writer');};
  const as=Object.create(AppServerLink.prototype);EventEmitter.call(as);Object.assign(as,{available:true,chats:new Map(),openRequests:new Map()});
  const calls=[];as.send=async(method,params)=>{calls.push({method,params});return method==='thread/resume'?{thread:{id:source.id},model:'gpt-test'}:{turn:{id:'turn'}}};
  const hub=new Hub(store,runner,as),events=[];hub.addSink(f=>events.push(f),'test');
  const reply=[];const sink={send:f=>reply.push(f)};
  return {source,store,runner,as,hub,events,reply,sink,calls};
}

test('明确交接空闲会话，保留历史，过滤重复事件，两端共用原生控制',async()=>{
  const x=fixture();
  await x.hub.handleFrame({t:'adopt_chat',chatId:x.source.id},x.sink);assert.match(x.reply.at(-1).error,/确认/);assert.equal(x.calls.length,0);
  x.source.status='running';await x.hub.handleFrame({t:'adopt_chat',chatId:x.source.id,confirmClosed:true},x.sink);assert.match(x.reply.at(-1).error,/运行/);assert.equal(x.calls.length,0);
  x.source.status='idle';x.source.pendingMsgs=[{text:'未发'}];await x.hub.handleFrame({t:'adopt_chat',chatId:x.source.id,confirmClosed:true},x.sink);assert.match(x.reply.at(-1).error,/排队/);x.source.pendingMsgs=[];
  await x.hub.handleFrame({t:'adopt_chat',ref:'r',chatId:x.source.id,confirmClosed:true},x.sink);
  assert.equal(x.reply.at(-1).ok,true);assert.equal(x.calls[0].method,'thread/resume');assert.equal(x.calls[0].params.threadId,x.source.id);
  const chat=x.as.chats.get(x.source.id);assert.equal(chat.items[0].t,'历史指令');assert.equal(chat.items[1].decision,'expired');assert.equal(x.hub.stateFrame().chats.length,1);assert.equal(x.hub.stateFrame().chats[0].interactive,true);
  assert(x.events.some(e=>e.t==='chat_reset'));x.events.length=0;x.store.emit('item',chat.id,{k:'agent',t:'重复日志'});x.store.emit('chat_update',x.source);x.store.emit('notify',{chatId:chat.id});assert.equal(x.events.length,0);
  await x.hub.handleFrame({t:'send_msg',ref:'s',chatId:chat.id,text:'新指令',approvalPolicy:'on-request'},x.sink);assert.equal(x.reply.at(-1).ok,true);assert.equal(x.calls.at(-1).method,'turn/start');
  await x.hub.handleFrame({t:'stop_task',ref:'z',chatId:chat.id},x.sink);assert.equal(x.reply.at(-1).ok,true);assert.equal(x.calls.at(-1).method,'turn/interrupt');
});

test('接入期间禁止并发控制；发现原会话活动或恢复失败不得自动发送',async()=>{
  const x=fixture();let resolve;const calls=[];
  x.as.send=(m,p)=>{calls.push(m);if(m==='thread/resume')return new Promise(r=>{resolve=r});return Promise.resolve({});};
  const handoff=x.hub.handleFrame({t:'adopt_chat',chatId:x.source.id,confirmClosed:true},x.sink);
  await x.hub.handleFrame({t:'send_msg',chatId:x.source.id,text:'不能发'},x.sink);assert.match(x.reply.at(-1).error,/正在接入/);
  x.source._recordVersion++;resolve({thread:{id:x.source.id}});await handoff;
  assert.match(x.reply.at(-1).error,/新活动/);assert.equal(x.as.chats.has(x.source.id),false);assert.deepEqual(calls,['thread/resume','thread/unsubscribe']);
  assert.equal(x.hub.stateFrame().chats.length,1);assert.equal(x.hub.stateFrame().chats[0].interactive,undefined);
});

test('电脑与手机视图同步接入、发消息和处理审批',async()=>{
  const path=require('node:path');const {startLocalServer}=require('../lib/localserver');
  const {chromium}=require(process.env.CW_PLAYWRIGHT||'playwright');
  const x=fixture();x.as.listModels=async()=>[];
  x.as.send=async(method,params)=>{
    x.calls.push({method,params});
    if(method==='thread/resume')return {thread:{id:x.source.id}};
    if(method==='turn/start'){
      setImmediate(()=>{x.as.onNotification({method:'turn/started',params:{threadId:params.threadId,turn:{id:'turn1'}}});x.as.onNotification({method:'item/started',params:{threadId:params.threadId,item:{id:'msg1',type:'userMessage',text:params.input[0].text}}});});
      return {turn:{id:'turn1'}};
    }
    return {};
  };
  let response;x.as.respond=(id,result)=>{response={id,result};};
  x.store.itemsView=c=>({chatId:c.id,items:c.items,summary:x.store.summary(c)});
  const server=startLocalServer(x.hub,{port:0,webRoot:path.resolve(__dirname,'../../web')});await new Promise(r=>server.once('listening',r));let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.CW_BROWSER||undefined});
    const pc=await browser.newPage({viewport:{width:900,height:800}}),phone=await browser.newPage({viewport:{width:390,height:800},isMobile:true});
    const errors=[];pc.on('pageerror',e=>errors.push(e.message));phone.on('pageerror',e=>errors.push(e.message));
    for(const page of [pc,phone]){await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('.chat-item').click();await page.getByText('历史指令').waitFor();}
    await phone.locator('#chat-menu-btn').click();await phone.locator('[data-id="adopt"]').click();await phone.getByText('先等待当前任务结束').waitFor();await phone.locator('#adopt-confirm').click();
    await phone.getByText('已接入统一控制').waitFor();await pc.getByText('原会话的提问已失效').waitFor();
    await pc.locator('#chat-permission').click();await pc.locator('[data-approval="on-request"]').click();
    await phone.locator('#chat-input').fill('来自手机');await phone.locator('#chat-send').click();await pc.getByText('来自手机',{exact:true}).waitFor();
    x.as.onServerRequest({id:41,method:'item/commandExecution/requestApproval',params:{threadId:x.source.id,itemId:'ap1',command:'test-command'}});
    await pc.getByText('test-command',{exact:true}).waitFor();await phone.getByText('test-command',{exact:true}).waitFor();await pc.locator('[data-req="41"][data-dec="accept"]').click();
    await phone.getByText('已允许',{exact:true}).waitFor();assert.equal(response.id,41);assert.equal(response.result.decision,'accept');assert.deepEqual(errors,[]);
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
});
