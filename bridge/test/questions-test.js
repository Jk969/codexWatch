'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {translate}=require('../lib/rollout');const {ChatStore}=require('../lib/store');const {Hub}=require('../lib/hub');const {AppServerLink}=require('../lib/appserver');
const call={type:'response_item',timestamp:new Date().toISOString(),payload:{type:'function_call',id:'item-q',call_id:'call-q',name:'request_user_input_async',arguments:JSON.stringify({questions:[{title:'选哪个？',options:['方案一','方案二']},{title:'补充说明'}]})}};
test('桌面异步提问转为问答卡，通知一次，电脑回答同步，回放不通知',()=>{
  const store=new ChatStore('.');const chat=store.newChat('c',{});chat.items=[];const notices=[];store.on('notify',x=>notices.push(x));
  store.applyRecord(chat,call);store.applyRecord(chat,call);assert.equal(notices.length,1);
  const ask=chat.items[0];assert.equal(ask.k,'askuser');assert.equal(ask.questions[0].options[1].label,'方案二');
  const answers=ask.questions.map((q,i)=>({questionItemId:q.questionItemId,answer:i?'说明':'方案二'}));
  store.applyRecord(chat,{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<send_user_message_question_reply>'+JSON.stringify(answers)+'</send_user_message_question_reply>'}]}});
  assert.deepEqual(ask.answers,['方案二','说明']);assert.equal(store.summary(chat).pendingQuestions,0);
  const history=store.newChat('h',{});history.items=[];history._replaying=true;store.applyRecord(history,call);assert.equal(notices.length,1);
});
test('手机回答转交桌面含问题 ID 的回复，拒绝过期和不完整答案',async()=>{
  const store=new EventEmitter();const chat={id:'c',items:[translate(call).item]};store.get=()=>chat;store.summary=()=>({id:'c'});
  const runner=new EventEmitter();let prompt;runner.desktop={sendIfOwned:async(id,text)=>{prompt=text;return {ok:true}}};
  const hub=new Hub(store,runner);const frames=[];const sink={send:x=>frames.push(x)};
  await hub.handleFrame({t:'answer_user_input',chatId:'c',reqId:'desktop:call-q',answers:['方案二'],ref:'bad'},sink);assert.equal(frames.pop().t,'err');
  await hub.handleFrame({t:'answer_user_input',chatId:'c',reqId:'desktop:call-q',answers:['方案二','说明'],ref:'ok'},sink);
  assert.match(prompt,/send_user_message_question_reply/);assert.match(prompt,/questionItemId/);assert.equal(frames.pop().ok,true);
  await hub.handleFrame({t:'answer_user_input',chatId:'c',reqId:'desktop:call-q',answers:['方案二','说明'],ref:'duplicate'},sink);assert.equal(frames.pop().t,'err');
});
test('桥接 RPC 提问以问题 ID 返回答案映射，不能传数组',()=>{
  const as=Object.create(AppServerLink.prototype);as.openRequests=new Map([['123',{params:{questions:[{id:'q1'},{id:'q2'}]},chatId:'c'}]]);as.chats=new Map();let response;as.respond=(id,value)=>response=value;
  assert.equal(as.answerUserInput('123',['一']).ok,false);
  assert.equal(as.answerUserInput('123',['一','二']).ok,true);
  assert.deepEqual(response,{answers:{q1:{answers:['一']},q2:{answers:['二']}}});
});

test('手机提问卡：多题选择和自由输入、失败保留、确认后更新',async()=>{
  const {startLocalServer}=require('../lib/localserver');const path=require('node:path');
  const {chromium}=require(process.env.CW_PLAYWRIGHT||'playwright');
  const store=new ChatStore('.'),chat=store.newChat('c',{cwd:'D:/demo'});chat.items=[];chat.detailed=true;store.chats.set('c',chat);store.applyRecord(chat,call);chat.title='提问测试';
  const runner=new EventEmitter();let text,fail=true;runner.desktop={sendIfOwned:async(id,prompt)=>{text=prompt;return fail?{ok:false,error:'测试电脑未接收'}:{ok:true}}};
  const hub=new Hub(store,runner);const server=startLocalServer(hub,{port:0,webRoot:path.resolve(__dirname,'../../web')});await new Promise(r=>server.once('listening',r));
  const browser=await chromium.launch({headless:true,executablePath:process.env.CW_BROWSER||undefined});const page=await browser.newPage({viewport:{width:393,height:852}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('.chat-item').click();
    await page.locator('.ask-opt').nth(1).click();await page.locator('.ask-custom').nth(1).fill('手机输入的说明');
    await page.locator('[data-sendmulti]').click();await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('未接收'));
    assert.equal(await page.locator('.ask-custom').nth(1).inputValue(),'手机输入的说明');
    assert.equal(await page.locator('[data-sendmulti]').isDisabled(),false);
    fail=false;await page.locator('[data-sendmulti]').click();await page.waitForFunction(()=>document.getElementById('chat-body').textContent.includes('已提交回答'));
    assert.match(text,/方案二/);assert.match(text,/手机输入的说明/);assert.equal(await page.locator('.ask-opt').count(),0);
    await page.waitForTimeout(300);await page.screenshot({path:path.resolve(__dirname,'../../dist/question-answer.png')});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await new Promise(r=>server.close(r));}
});
