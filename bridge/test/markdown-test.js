'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {Hub}=require('../lib/hub');
const {startLocalServer}=require('../lib/localserver');

test('手机 Markdown：结构、代码原样、表格局部滚动、链接清理和增量消息',async()=>{
  const {chromium}=require(process.env.CW_PLAYWRIGHT||'playwright');
  const code='const text = "**保持原样** <script> # 标题";\n'+ 'a'.repeat(180)+'\n';
  const md=['# 修改结果','','这是一段 **加粗**、*斜体*、~~删除线~~ 和 `行内代码`。','','## 验证步骤','',
    '1. 打开手机任务','2. 检查结果','   - 子步骤一','   - 子步骤二','','- [x] 已完成','- [ ] 待验证','',
    '> 引用说明：锁屏测试仍需要真机。','','| 项目 | 结果 | 详细说明 | 更多说明 |','| --- | --- | --- | --- |',
    '| 模型 | 正常 | 这是比较长的一列内容，用于验证手机表格 | 最后一列 |','',
    '```javascript',code+'```','', '[官方说明](https://example.com/docs?q=1&lang=zh)','',
    '<img src=x onerror="window.__unsafe=1">','', '[危险链接](javascript:alert(1))','',
    '[电脑文件](file:///C:/secret.txt)'].join('\n');
  const chat={id:'markdown',title:'Markdown 排版测试',status:'idle',lastTs:Date.now()};
  const items=[{iid:'md-main',k:'agent',ts:Date.now(),t:md}];
  const store=new EventEmitter();store.summaries=()=>[chat];store.recentDirs=()=>[];store.stats=()=>({});
  store.get=store.ensureDetail=()=>chat;store.summary=c=>c;store.itemsView=()=>({chatId:chat.id,items});
  const hub=new Hub(store,new EventEmitter());
  const server=startLocalServer(hub,{port:0,webRoot:path.resolve(__dirname,'../../web')});
  await new Promise(r=>server.once('listening',r));let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.CW_BROWSER||undefined});
    const page=await browser.newPage({viewport:{width:393,height:852},isMobile:true,hasTouch:true});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.locator('.chat-item').click();await page.locator('.bubble-md h1').waitFor();
    assert.equal(await page.locator('.bubble-md h1').textContent(),'修改结果');
    assert.equal(await page.locator('.bubble-md ol > li').count(),2);
    assert.equal(await page.locator('.bubble-md ol ul li').count(),2);
    assert.equal(await page.locator('.bubble-md input[disabled]').count(),2);
    assert.equal(await page.locator('.bubble-md pre code').textContent(),code);
    assert.equal(await page.locator('.bubble-md pre strong').count(),0);
    assert.equal(await page.locator('.bubble-md blockquote').count(),1);
    assert.equal(await page.locator('.bubble-md table th').count(),4);
    assert.equal(await page.locator('.bubble-md a').count(),1);
    assert.equal(await page.locator('.bubble-md img,.bubble-md script').count(),0);
    assert.equal(await page.evaluate(()=>window.__unsafe),undefined);
    assert.equal(await page.locator('.bubble-md a').getAttribute('rel'),'noopener noreferrer');
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>window.__copied=value},configurable:true}));
    await page.locator('.md-copy').click();assert.equal(await page.evaluate(()=>window.__copied),code);
    for(const width of [393,320]){
      await page.setViewportSize({width,height:852});
      const sizes=await page.evaluate(()=>{
        const scroll=document.getElementById('chat-scroll'),table=document.querySelector('.md-table-scroll'),pre=document.querySelector('.bubble-md pre');
        return {chatOverflow:scroll.scrollWidth-scroll.clientWidth,tableScrollable:table.scrollWidth>table.clientWidth,codeScrollable:pre.scrollWidth>pre.clientWidth};
      });
      assert(sizes.chatOverflow<=1,'聊天整页不横向溢出');assert(sizes.tableScrollable);assert(sizes.codeScrollable);
    }
    await page.locator('#chat-scroll').evaluate(el=>el.scrollTop=0);
    await page.locator('#toast').evaluate(el=>el.classList.add('hidden'));
    await page.waitForTimeout(300);
    await page.screenshot({path:path.resolve(__dirname,'../../dist/chat-markdown.png')});
    hub.broadcast({t:'item',chatId:chat.id,item:{iid:'md-new',k:'agent',t:'### 新消息\n\n- 新列表\n\n```text\n未结束的代码块'}});
    await page.locator('[data-iid="md-new"] h3').waitFor();
    assert.equal(await page.locator('[data-iid="md-new"] pre code').textContent(),'未结束的代码块\n');
    assert.deepEqual(errors,[]);
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
});
