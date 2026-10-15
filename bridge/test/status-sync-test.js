'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {ChatStore}=require('../lib/store');
const {DesktopLink}=require('../lib/desktop');

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cw-status-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'rollout.jsonl');
  const ts=new Date(Date.now()-3600e3).toISOString();
  const record=(type,payload)=>JSON.stringify({type,timestamp:ts,payload})+'\n';
  fs.writeFileSync(file,record('session_meta',{id:'c',cwd:root,timestamp:ts})+
    record('event_msg',{type:'task_started',turn_id:'turn-1'})+
    record('response_item',{type:'function_call_output',call_id:'tool',output:'x'.repeat(110000)}));
  const store=new ChatStore(root);store.quickScan();
  return {store,file,record,chat:store.get('c')};
}

test('工具输出挤出尾部时仍识别开始；无结束日志也能核对中断并广播',async t=>{
  const {store,chat}=fixture(t);
  assert.equal(chat.status,'running');
  store.ensureDetail('c');
  let notices=0;const updates=[];
  store.on('notify',()=>notices++);store.on('chat_update',s=>updates.push(s));
  await store.reconcileStatuses({readStatus:async()=>({status:'interrupted',turnId:'turn-1'})});
  assert.equal(chat.status,'interrupted');assert.equal(chat.runningSince,null);
  assert.equal(updates.length,1);assert.equal(updates[0].status,'interrupted');assert.equal(notices,0);
  store.poll();assert.equal(chat.status,'interrupted');
  chat.detailed=false;store.ensureDetail('c');assert.equal(chat.status,'interrupted');
  assert.equal(chat.lastMsg,'任务已中断');
});

test('长时间无日志但桌面仍执行或不可达时保持运行；本机进程由 Runner 管理',async t=>{
  const {store,chat,file}=fixture(t);
  fs.utimesSync(file,new Date(0),new Date(0));
  assert.equal(store.quickReadFile(file).status,'running');
  await store.reconcileStatuses({readStatus:async()=>({status:'running',turnId:'turn-1'})});
  assert.equal(chat.status,'running');
  await store.reconcileStatuses({readStatus:async()=>null});assert.equal(chat.status,'running');
  chat.spawn={pid:1};await store.reconcileStatuses({readStatus:async()=>{throw Error('不得检查本机子进程');}});
});

test('核对期间产生新轮次或收到另一轮响应时不得应用旧中断状态',async t=>{
  const {store,chat,file,record}=fixture(t);
  await store.reconcileStatuses({readStatus:async()=>({status:'interrupted',turnId:'other'})});
  assert.equal(chat.status,'running');
  await store.reconcileStatuses({readStatus:async()=>{
    fs.appendFileSync(file,record('event_msg',{type:'task_started',turn_id:'turn-2'}));store.poll();
    return {status:'interrupted',turnId:'turn-1'};
  }});
  assert.equal(chat.status,'running');assert.equal(chat.turnId,'turn-2');
});

test('已核对的中断任务可通过后续新开始事件恢复运行',async t=>{
  const {store,chat,file,record}=fixture(t);
  await store.reconcileStatuses({readStatus:async()=>({status:'interrupted',turnId:'turn-1'})});
  fs.appendFileSync(file,record('event_msg',{type:'task_started',turn_id:'turn-2'}));store.poll();
  assert.equal(chat.status,'running');assert.equal(chat.turnId,'turn-2');
});

test('桌面 notLoaded 不影响轮次判定；未知轮次或管道不可用不猜测状态',async()=>{
  let status='interrupted',fail=false;
  const link=new DesktopLink({paths:()=>['pipe'],request:async()=>{
    if(fail)throw Error('offline');
    return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({
      thread:{id:'c',kind:'codex',hostId:'local',status:{type:'notLoaded'}},turns:[{id:'turn-1',status}],
    })}]};
  }});
  for(const [source,target] of [['interrupted','interrupted'],['completed','idle'],['inProgress','running'],['failed','error']]){
    status=source;assert.deepEqual(await link.readStatus('c'),{status:target,turnId:'turn-1'});
  }
  status='unknown';assert.equal(await link.readStatus('c'),null);
  fail=true;assert.equal(await link.readStatus('c'),null);
});
