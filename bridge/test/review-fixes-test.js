'use strict';
// 代码审查修复的回归测试：会话扫描、rollout 解析、附件索引、中继定向回执。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const WS=require('../node_modules/ws');
const {ChatStore}=require('../lib/store');
const {translate}=require('../lib/rollout');
const {Attachments}=require('../lib/attachments');

const tmp=prefix=>fs.mkdtempSync(path.join(os.tmpdir(),prefix));
const meta=(id,extra='')=>JSON.stringify({timestamp:new Date().toISOString(),type:'session_meta',payload:{id,cwd:'/w',originator:'codex_cli',base_instructions:extra}})+'\n';

test('rollout：显示推理摘要，隐藏 AGENTS.md / 环境注入消息',()=>{
  const r=translate({type:'response_item',timestamp:'2024-01-01T00:00:00Z',payload:{type:'reasoning',id:'r1',summary:[{type:'summary_text',text:'先读代码'},{type:'summary_text',text:'再改'}]}});
  assert.equal(r.item.k,'reason');assert.match(r.item.t,/先读代码[\s\S]*再改/);
  const injected=translate({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>x</INSTRUCTIONS>'}]}});
  assert.equal(injected,null);
  const env=translate({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context><cwd>/w</cwd></environment_context>'}]}});
  assert.equal(env,null);
  const real=translate({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'修复登录 bug'}]}});
  assert.equal(real.item.t,'修复登录 bug');
});

test('store：首行未写完的新文件下次仍能识别；超大 session_meta 可解析',()=>{
  const root=tmp('cw-store-');
  try{
    const store=new ChatStore(root);
    const file=path.join(root,'a.jsonl');
    fs.writeFileSync(file,'{"type":"session_meta","payload":{"id":"abc"');
    assert.deepEqual(store.quickReadFile(file),{pending:true});
    fs.writeFileSync(file,meta('abc'));
    assert.equal(store.quickReadFile(file).meta.chatKey,'abc');
    const big=path.join(root,'b.jsonl');
    fs.writeFileSync(big,meta('big','x'.repeat(300*1024)));
    assert.equal(store.quickReadFile(big).meta.chatKey,'big');
    fs.writeFileSync(path.join(root,'c.jsonl'),'{"type":"other"}\n');
    assert.equal(store.quickReadFile(path.join(root,'c.jsonl')),null);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('store：保留期外的 YYYY/MM/DD 目录被剪枝',()=>{
  const root=tmp('cw-list-');
  try{
    const now=new Date();
    const today=path.join(root,String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));
    const old=path.join(root,'2001','01','01');
    fs.mkdirSync(today,{recursive:true});fs.mkdirSync(old,{recursive:true});
    fs.writeFileSync(path.join(today,'new.jsonl'),meta('n'));
    fs.writeFileSync(path.join(old,'old.jsonl'),meta('o'));   // mtime 是现在，但目录日期很旧
    fs.mkdirSync(path.join(root,'misc'));fs.writeFileSync(path.join(root,'misc','x.jsonl'),meta('x'));
    const names=new ChatStore(root,{retainDays:14}).listFiles().map(f=>path.basename(f.p)).sort();
    assert.deepEqual(names,['new.jsonl','x.jsonl']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('附件：已完成条目 24 小时后移出索引，累计上传不再永久卡死',()=>{
  const root=tmp('cw-att-');
  try{
    const att=new Attachments(root);
    const up=()=>{const {id}=att.begin({name:'a.txt',size:3,mime:'text/plain',chatId:'c'});att.chunk({id,index:0,data:'YWJj'});return att.finish({id});};
    const first=up();
    assert.equal(att.resolve([first.id],'c').length,1);
    att.prune(Date.now()+25*3600e3);
    assert.equal(att.entries.size,0);
    for(let i=0;i<1005;i++){const e={id:'old'+i,complete:true,ts:Date.now(),path:path.join(root,'none')};att.entries.set(e.id,e);}
    assert.ok(up().id);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('中继：带 to 的设备回执只发给请求方；离线补发带 deviceId',async()=>{
  const root=tmp('cw-relay-route-');
  fs.writeFileSync(path.join(root,'relay.json'),JSON.stringify({
    users:[{id:'a',name:'a',role:'user'},{id:'b',name:'b',role:'user'},{id:'c',name:'c',role:'user'}],
    tokens:{'ta':'a','tb':'b','tc':'c'},devices:[{id:'d',name:'pc',token:'dt'}],
    pairs:[{userId:'a',deviceId:'d'},{userId:'b',deviceId:'d'},{userId:'c',deviceId:'d'}]}));
  const srv=net.createServer();srv.listen(0,'127.0.0.1');await once(srv,'listening');const port=srv.address().port;await new Promise(r=>srv.close(r));
  const child=spawn(process.execPath,[path.resolve(__dirname,'../../relay/index.js')],{env:{...process.env,PORT:String(port),CODEXWATCH_DATA_DIR:root},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  const socks=[];
  const open=async(route,token,headers)=>{const ws=new WS(`ws://127.0.0.1:${port}/${route}?token=${token}`,{headers});socks.push(ws);ws.got=[];ws.on('message',m=>ws.got.push(JSON.parse(m)));await once(ws,'open');return ws;};
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  try{
    for(let i=0;i<200&&!logs.includes('relay listening');i++)await wait(25);
    const dev=await open('ws-device','dt',{'X-CodexWatch-Protocol':'2'});
    const a=await open('ws','ta'),b=await open('ws','tb');
    await wait(200);
    const req=once(dev,'message');
    a.send(JSON.stringify({t:'dev_frame',deviceId:'d',d:{t:'list_dir',ref:'r1'}}));
    const fwd=JSON.parse((await req)[0]);
    assert.equal(fwd.d.ref,'r1');assert.equal(typeof fwd.from,'string');
    a.got.length=0;b.got.length=0;
    dev.send(JSON.stringify({t:'frame',to:fwd.from,d:{t:'dir',ref:'r1',secret:'only-a'}}));
    dev.send(JSON.stringify({t:'frame',d:{t:'item',chatId:'x'}}));   // 无 to 的事件仍广播
    await wait(300);
    assert.ok(a.got.some(m=>m.d&&m.d.secret==='only-a'));
    assert.ok(!b.got.some(m=>m.d&&m.d.secret));
    assert.ok(b.got.some(m=>m.d&&m.d.t==='item'));
    // c 不在线：通知进入离线队列，上线后补发并带上来源设备
    dev.send(JSON.stringify({t:'frame',d:{t:'notify',d:{chatId:'x',title:'完成',nid:'n1'}}}));
    await wait(200);
    const c=await open('ws','tc');await wait(300);
    const q=c.got.find(m=>m.t==='notify');
    assert.ok(q,'offline notify missing');assert.equal(q.queued,true);assert.equal(q.deviceId,'d');
  }finally{
    for(const ws of socks)ws.terminate();child.kill();await once(child,'exit');fs.rmSync(root,{recursive:true,force:true});
  }
});
