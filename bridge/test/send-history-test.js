'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {ChatStore}=require('../lib/store');
const {Runner,startupError}=require('../lib/runner');
const {DesktopLink}=require('../lib/desktop');

test('桌面持有会话经本机消息接口发送；失败不另开 writer 或重复投递',async()=>{
  const calls=[];let fail=false;
  const desktop=new DesktopLink({paths:()=>['pipe'],request:async(pipe,method,params)=>{
    calls.push(params);
    const data=params.tool==='read_thread'?{thread:{id:'c',kind:'codex',hostId:'local',status:{type:'active'}}}:{accepted:true};
    return fail&&params.tool==='send_message_to_thread'?{success:false,contentItems:[{type:'inputText',text:'failed'}]}:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(data)}]};
  }});
  const runner=Object.create(Runner.prototype);runner.desktop=desktop;runner.store={get:()=>({id:'c',status:'running'})};
  runner.newTask=()=>{throw Error('不得另起 CLI')};runner.queueMessage=()=>{throw Error('不得另起 queue')};
  assert.deepEqual(await runner.sendMsg('c','来自手机',{model:'gpt-6.1-sol',effort:'high',attachments:[{path:'C:/phone/photo.png'}]}),{ok:true,mode:'desktop'});
  assert.equal(calls[1].tool,'send_message_to_thread');assert.equal(calls[1].arguments.thinking,'high');
  assert.match(calls[1].arguments.prompt,/来自手机[\s\S]*photo.png/);
  assert.match(calls[1].arguments.prompt,/手机端：当前用户请求/);
  fail=true;assert.equal((await runner.sendMsg('c','失败保留')).ok,false);
  assert.equal(calls.length,4);
  fail=false;
  const reply='<send_user_message_question_reply>[]</send_user_message_question_reply>';
  await runner.sendMsg('c',reply);
  assert.equal(calls.at(-1).arguments.prompt,reply);
  const error=startupError('thread-store conflict: thread c already has an active writer',1);
  assert.match(error,/桌面 Codex/);assert(!error.includes('active writer'));
});

test('恢复发送等待 turn.started，启动失败不得回执已发送',async()=>{
  const store=new EventEmitter();const chat={id:'c',status:'idle'};store.get=()=>chat;store.pushItem=()=>{};
  const runner=Object.create(Runner.prototype);Object.assign(runner,{store,pending:new Map(),spawnedByChat:new Map()});
  let child,args;
  runner.spawnCodex=a=>{args=a;child=new EventEmitter();child.pid=1;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stderr.setEncoding=()=>{};return child;};
  runner.on('spawn_failed',()=>{});
  let settled=false;const failed=runner.sendMsg('c','纯文字').then(r=>{settled=true;return r;});
  await new Promise(r=>setImmediate(r));assert.equal(settled,false);
  assert(!args.includes('--color'));assert(args.includes('--json'));
  child.stderr.emit('data','error: unexpected argument');child.emit('exit',2);
  assert.equal((await failed).ok,false);
  const success=runner.sendMsg('c','再次发送');
  child.stdout.emit('data','{"type":"turn.st');child.stdout.emit('data','arted"}\n');
  assert.equal((await success).ok,true);child.emit('exit',0);
});

test('加载历史不广播旧消息、不触发完成通知；尾读中文半行不丢字节',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cw-history-test-'));
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  try {
    const file=path.join(root,'rollout.jsonl');
    const record=(type,payload)=>JSON.stringify({type,timestamp:new Date().toISOString(),payload})+'\n';
    const message=t=>record('response_item',{type:'message',role:'user',content:[{type:'input_text',text:t}]});
    fs.writeFileSync(file,record('session_meta',{id:'c',cwd:root})+message('最早的消息')+record('event_msg',{type:'task_complete',last_agent_message:'完成'}));
    const store=new ChatStore(root);store.quickScan();
    const events=[];store.on('item',(id,it)=>events.push(it));let notices=0;store.on('notify',()=>notices++);
    const chat=store.ensureDetail('c');assert.equal(events.length,0);assert.equal(notices,0);
    assert.equal(chat.items.filter(it=>it.t==='最早的消息').length,1);
    for(const text of ['第二条','第三条']){fs.appendFileSync(file,message(text));store.poll();}
    const next=Buffer.from(message('中文半行最后一条'));const split=next.indexOf(Buffer.from('中文'))+1;
    fs.appendFileSync(file,next.subarray(0,split));store.poll();
    assert.equal(events.length,2);
    fs.appendFileSync(file,next.subarray(split));store.poll();store.poll();
    assert.deepEqual(events.map(it=>it.t),['第二条','第三条','中文半行最后一条']);
    assert.equal(store.filePos.get(file),fs.statSync(file).size);
    store.ensureDetail('c');assert.equal(events.length,3);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
