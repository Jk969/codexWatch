'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const WS=require('../node_modules/ws');
const {EventEmitter}=require('node:events');
const {Hub}=require('../lib/hub');
test('真实中继：新版保留连接，旧版无法抢占，消息和附件分片正常路由',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cw-relay-test-'));
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  const fixture={users:[{id:'u',name:'test',role:'user'}],tokens:{'user-token':'u'},devices:[{id:'d',name:'test',token:'device-token'}],pairs:[{userId:'u',deviceId:'d'}]};
  fs.writeFileSync(path.join(root,'relay.json'),JSON.stringify(fixture));
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const child=spawn(process.execPath,[path.resolve(__dirname,'../../relay/index.js')],{windowsHide:true,env:{...process.env,PORT:String(port),CODEXWATCH_DATA_DIR:root},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  const sockets=[];
  const open=async(route,token,protocol,balanced=false)=>{const ws=new WS(`ws://127.0.0.1:${port}/${route}?token=${token}${balanced?'&power=balanced':''}`,protocol?{headers:{'X-CodexWatch-Protocol':protocol}}:{});sockets.push(ws);await once(ws,'open');return ws;};
  try {
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Relay start timeout: '+logs)),5000);const check=setInterval(()=>{if(logs.includes('relay listening')){clearTimeout(timer);clearInterval(check);resolve();}},25);});
    const modern=await open('ws-device','device-token','2');
    let closed=false;modern.on('close',()=>closed=true);
    const legacy=await open('ws-device','device-token');
    const [code]=await once(legacy,'close');assert.equal(code,4009);assert.equal(closed,false);
    const user=await open('ws','user-token',null,true);
    const receipt=once(modern,'message');user.send(JSON.stringify({t:'dev_frame',deviceId:'d',d:{t:'upload_chunk',data:'YWJj',id:'fixture',index:0}}));
    const [raw]=await receipt;assert.equal(JSON.parse(raw).d.t,'upload_chunk');
    const reply=once(user,'message');modern.send(JSON.stringify({t:'frame',d:{t:'models',ok:true,models:[{model:'gpt-6.1-sol'}]}}));
    const [response]=await reply;assert.equal(JSON.parse(response).d.models[0].model,'gpt-6.1-sol');
    const refreshed=once(user,'message');user.send(JSON.stringify({t:'get_devices'}));
    const [snapshot]=await refreshed;assert.equal(JSON.parse(snapshot).devices[0].online,true);
    // 降低心跳只影响保活；完成通知仍立即路由，不等待两分钟心跳。
    const notified=once(user,'message');
    modern.send(JSON.stringify({t:'frame',d:{t:'notify',d:{chatId:'chat',nid:'turn',title:'完成',level:'done'}}}));
    const [notice]=await notified;assert.equal(JSON.parse(notice).d.d.nid,'turn');
    const pong=once(modern,'pong');modern.ping();await pong;
    assert.equal(closed,false);assert(!logs.includes('uncaught'));
    const offlineReply=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('offline reply missing')),3000);
      user.on('message',raw=>{const m=JSON.parse(raw);if(m.t==='dev_frame'&&m.d.ref==='offline-request'){clearTimeout(timer);resolve(m.d)}});
    });
    modern.close();await once(modern,'close');
    user.send(JSON.stringify({t:'dev_frame',deviceId:'d',d:{t:'send_msg',ref:'offline-request'}}));
    assert.equal((await offlineReply).error,'设备不在线');
  } finally {
    for(const ws of sockets)ws.terminate();child.kill();await once(child,'exit');fs.rmSync(root,{recursive:true,force:true});
  }
});

test('APK 原生桥模式通过真实中继发送纯文字并收到回执',async()=>{
  const {chromium}=require(process.env.CW_PLAYWRIGHT||'playwright');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cw-apk-route-test-'));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  fs.writeFileSync(path.join(root,'relay.json'),JSON.stringify({users:[{id:'u',name:'test',role:'user'}],tokens:{'user-token':'u'},devices:[{id:'device-remote',name:'test',token:'device-token'}],pairs:[{userId:'u',deviceId:'device-remote'}]}));
  const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const child=spawn(process.execPath,[path.resolve(__dirname,'../../relay/index.js')],{windowsHide:true,env:{...process.env,PORT:String(port),CODEXWATCH_DATA_DIR:root,WEB_ROOT:path.resolve(__dirname,'../../web')},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  let browser,device;
  try {
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs)),5000);const poll=setInterval(()=>{if(logs.includes('relay listening')){clearInterval(poll);clearTimeout(timer);resolve()}},25)});
    const c={id:'chat-remote',title:'远程纯文字',status:'idle',model:'gpt-6.1-sol'};
    const store=new EventEmitter();store.summaries=()=>[c];store.recentDirs=()=>[];store.stats=()=>({});store.get=id=>id===c.id?c:null;store.ensureDetail=store.get;store.summary=x=>x;store.itemsView=()=>({chatId:c.id,items:[]});
    const runner=new EventEmitter();let sent;runner.sendMsg=async(id,text,opts)=>{sent={id,text,opts};return {ok:true,mode:'resume'}};
    const hub=new Hub(store,runner);
    device=new WS(`ws://127.0.0.1:${port}/ws-device?token=device-token`,{headers:{'X-CodexWatch-Protocol':'2'}});await once(device,'open');
    const sink=hub.addSink(frame=>device.send(JSON.stringify({t:'frame',d:frame})),'test-cloud');
    device.on('message',raw=>{const m=JSON.parse(raw);if(m.t==='frame')hub.handleFrame(m.d,sink)});
    browser=await chromium.launch({headless:true,executablePath:process.env.CW_BROWSER||undefined});
    const page=await browser.newPage({viewport:{width:393,height:852}});
    // REST 暂不可达、首个设备快照被 WebView 错过时，已连通的原生通道应主动补拉。
    await page.route('**/api/devices',route=>route.abort());
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      localStorage.setItem('cw:server',JSON.stringify(location.origin));localStorage.setItem('cw:token',JSON.stringify('user-token'));
      let config,ws,missed=false;window.CWApp={getVersion:()=> '1.2.4',setConfig:json=>config=JSON.parse(json),requestConnect:()=>{ws=new WebSocket(config.endpoint+'?token='+config.token);ws.onopen=()=>window.__cwstatus({connected:true});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.t==='devices'&&!missed){missed=true;window.initialSnapshotMissed=true;return;}window.__cwonmessage(m);};ws.onclose=()=>window.__cwstatus({connected:false});},send:json=>ws.send(json),isConnected:()=>!window.testNativeOffline&&ws&&ws.readyState===1};
    });
    await page.goto(`http://127.0.0.1:${port}`);await page.locator('.chat-item').first().click();
    assert.equal(await page.evaluate(()=>window.initialSnapshotMissed),true);
    await page.locator('#chat-input').fill('纯文字发送回执测试');await page.locator('#chat-send').click();
    await page.waitForFunction(()=>document.getElementById('chat-input').value==='',{timeout:5000});
    assert.equal(sent.text,'纯文字发送回执测试');assert.deepEqual(errors,[]);
    await page.evaluate(()=>window.testNativeOffline=true);
    await page.locator('#chat-input').fill('断开连接时保留这条文字');
    await page.locator('#chat-send').click();
    assert.equal(await page.locator('#chat-input').inputValue(),'断开连接时保留这条文字');
    assert.equal(await page.locator('#chat-input').isDisabled(),false);
    assert.match(await page.locator('#toast').textContent(),/未连接/);
  } finally {if(browser)await browser.close();if(device)device.terminate();child.kill();await once(child,'exit');fs.rmSync(root,{recursive:true,force:true});}
});
