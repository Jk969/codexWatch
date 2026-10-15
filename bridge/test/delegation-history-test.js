'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {translate}=require('../lib/rollout');
const {ChatStore}=require('../lib/store');
const prefix='【CodexWatch 手机端：当前用户请求】\n用户正在手机上向这个聊天发送新的请求。请承接下面的请求；若与此前任务不冲突，请继续完成它，不要只重复回答此前的问题。\n\n';
const output=text=>'<codex_delegation>\n  <source_thread_id>c</source_thread_id>\n  <input>'+text+'</input>\n</codex_delegation>';
const payload=text=>({type:'function_call_output',id:'mobile-message',name:'send_message_to_thread',namespace:'codex_app',output:output(text)});
const rec=payload=>({type:'response_item',timestamp:'2026-10-09T13:09:24.222Z',payload});
test('桌面真实转发结构显示原始手机消息；普通工具输出不可冒充用户',()=>{
  const p=payload(prefix+'任务完成后没有通知');
  assert.deepEqual(translate(rec(p)).item,{id:'mobile-message',k:'user',ts:Date.parse(rec(p).timestamp),t:'任务完成后没有通知',source:'mobile_forward'});
  const shadow={type:'event_msg',timestamp:rec(p).timestamp,payload:{type:'item_completed',item:{...p,type:'FunctionCallOutput'}}};
  assert.deepEqual(translate(shadow),translate(rec(p)));
  for(const invalid of [{...p,name:'exec'},{...p,namespace:'other'},{...p,output:'普通工具文本 '+p.output}])assert(!translate(rec(invalid)).item);
  const reply='<send_user_message_question_reply>[{"questionItemId":"q","answer":"纯文字"}]</send_user_message_question_reply>';
  assert.equal(translate(rec(payload(reply))).questionAnswers[0].answer,'纯文字');
});
test('手机消息增量出现一次，重复事件、压缩、重新打开及守护程序重启不重复、不丢失',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cw-delegation-history-'));
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  const file=path.join(root,'rollout.jsonl');const line=r=>JSON.stringify(r)+'\n';
  try{
    fs.writeFileSync(file,line({type:'session_meta',payload:{id:'c',cwd:root}})+line(rec({type:'message',id:'old-user',role:'user',content:[{type:'input_text',text:'旧的设备问题'}]})));
    const store=new ChatStore(root);store.quickScan();const chat=store.ensureDetail('c');const emitted=[];store.on('item',(id,it)=>emitted.push(it));
    const p=payload(prefix+'最新通知问题');fs.appendFileSync(file,line(rec(p)));store.poll();
    fs.appendFileSync(file,line({type:'event_msg',payload:{type:'item_completed',item:{...p,type:'FunctionCallOutput'}}}));
    fs.appendFileSync(file,line({type:'compacted',payload:{replacement_history:[rec({type:'message',role:'user',content:[{type:'input_text',text:'旧的设备问题'}]}).payload]}}));store.poll();store.poll();
    assert.equal(emitted.length,1);assert.equal(chat.items.at(-1).t,'最新通知问题');assert.equal(store.ensureDetail('c').items.filter(x=>x.id==='mobile-message').length,1);
    const restarted=new ChatStore(root);restarted.quickScan();assert.equal(restarted.ensureDetail('c').items.filter(x=>x.t==='最新通知问题').length,1);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});


test('真实文件增量经本机通道显示手机气泡，重开、重复帧和压缩不删除消息',async()=>{
  const {chromium}=require(process.env.CW_PLAYWRIGHT||'playwright');
  const {EventEmitter}=require('node:events');const {Hub}=require('../lib/hub');const {startLocalServer}=require('../lib/localserver');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cw-mobile-message-ui-'));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  const file=path.join(root,'rollout.jsonl');const line=r=>JSON.stringify(r)+'\n';
  fs.writeFileSync(file,line({type:'session_meta',timestamp:new Date().toISOString(),payload:{id:'c',cwd:root}})+line(rec({type:'message',id:'old',role:'user',content:[{type:'input_text',text:'旧的设备问题'}]})));
  const store=new ChatStore(root);store.quickScan();store.ensureDetail('c');const hub=new Hub(store,new EventEmitter());const server=startLocalServer(hub,{port:0,webRoot:path.resolve(__dirname,'../../web')});
  await new Promise(resolve=>server.once('listening',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.CW_BROWSER||undefined});const page=await browser.newPage({viewport:{width:393,height:852}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('.chat-item').click();await page.locator('.msg.user').waitFor();
    const input=payload(prefix+'任务完成后没有通知，中文真实请求');fs.appendFileSync(file,line(rec(input)));store.poll();
    await page.locator('.msg.user .bubble').filter({hasText:'中文真实请求'}).waitFor();assert.equal(await page.locator('.msg.user').count(),2);
    assert.equal(await page.locator('.message-source').textContent(),'手机消息 · 经桌面转发');assert(!(await page.locator('#chat-body').textContent()).includes('请承接下面的请求'));
    fs.appendFileSync(file,line({type:'event_msg',payload:{type:'item_completed',item:{...input,type:'FunctionCallOutput'}}}));fs.appendFileSync(file,line({type:'compacted',payload:{replacement_history:[]}}));store.poll();
    await page.evaluate(()=>{closeChat()});await page.locator('.chat-item').click();await page.waitForTimeout(250);assert.equal(await page.locator('.msg.user').count(),2);
    await page.reload();await page.locator('.chat-item').click();await page.locator('.message-source').waitFor();assert.equal(await page.locator('.msg.user').count(),2);assert.deepEqual(errors,[]);
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
