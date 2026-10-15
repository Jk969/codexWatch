'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {EventEmitter}=require('node:events');
const {browseWorkspace,resolveReferences}=require('../lib/directories');const {Hub}=require('../lib/hub');const {startLocalServer}=require('../lib/localserver');

test('手机快捷指令与电脑文件引用：筛选、子目录、发送实际路径和小屏布局',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cw-shortcuts-'));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  const work=path.join(root,'工作区');fs.mkdirSync(work);fs.mkdirSync(path.join(work,'src'));
  const file=path.join(work,'src','测试.js');fs.writeFileSync(file,'console.log("中文")');
  fs.writeFileSync(path.join(work,'README.md'),'test');fs.writeFileSync(path.join(root,'outside.txt'),'outside');
  const chat={id:'shortcut',cwd:work,title:'快捷输入测试',status:'idle',lastTs:Date.now()};
  const store=new EventEmitter();store.summaries=()=>[chat];store.recentDirs=()=>[];store.stats=()=>({});store.get=store.ensureDetail=()=>chat;store.summary=c=>c;store.itemsView=()=>({chatId:chat.id,items:[]});
  const runner=new EventEmitter();let sent;runner.sendMsg=async(id,text,opts)=>{sent={text,opts};return {ok:true,mode:'desktop'};};
  const hub=new Hub(store,runner);const server=startLocalServer(hub,{port:0,webRoot:path.resolve(__dirname,'../../web')});await new Promise(r=>server.once('listening',r));
  let browser;
  try{
    const listing=await browseWorkspace(work);assert.equal(listing.parent,null);assert.equal(listing.entries[0].directory,true);
    await assert.rejects(resolveReferences(work,[path.join(root,'outside.txt')]),/工作目录/);
    await assert.rejects(browseWorkspace(work,'../'),/无效/);
    await assert.rejects(resolveReferences(work,[path.join(work,'src')]),/文件夹/);
    const {chromium}=require(process.env.CW_PLAYWRIGHT||'playwright');browser=await chromium.launch({headless:true,executablePath:process.env.CW_BROWSER||undefined});
    const page=await browser.newPage({viewport:{width:320,height:850},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('.chat-item').click();
    await page.locator('#chat-input').fill('/');await page.locator('[data-command="compact"]').waitFor();
    assert.equal(await page.locator('[data-command="model"],[data-command="effort"],[data-command="new"]').count(),0);
    assert.equal(await page.locator('[data-command="compact"]').isDisabled(),true);
    await page.evaluate(()=>window.__cwback());await page.locator('#chat-input').fill('');
    await page.locator('#chat-mention').click();
    await page.locator('[data-workspace]').filter({hasText:'src'}).click();
    await page.locator('#workspace-filter').fill('测试');await page.locator('[data-workspace]').filter({hasText:'测试.js'}).click();
    assert.equal(await page.locator('.attachment-chip').count(),1);assert.equal(await page.locator('#chat-input').inputValue(),'');
    await page.locator('#chat-input').fill('请分析所引用的文件');
    const width=await page.locator('.composer-tools').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));assert(width.scroll<=width.width+1);
    await page.locator('#chat-slash').click();await page.locator('[data-command="compact"]').waitFor();assert.equal(await page.evaluate(()=>window.__cwback()),true);
    assert.equal(await page.locator('#chat-input').inputValue(),'请分析所引用的文件');
    await page.waitForTimeout(300);await page.screenshot({path:path.resolve(__dirname,'../../dist/composer-shortcuts.png')});
    await page.locator('#chat-send').click();await page.waitForFunction(()=>document.getElementById('chat-input').value==='');
    assert.equal(sent.text,'请分析所引用的文件');assert.equal(sent.opts.attachments[0].path,fs.realpathSync(file));
    assert.equal(sent.opts.attachments[0].name,'测试.js');assert.equal(await page.locator('.attachment-chip').count(),0);
    await page.locator('#chat-input').fill('请查看 @');await page.locator('[data-workspace]').first().waitFor();
    assert.deepEqual(errors,[]);
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
