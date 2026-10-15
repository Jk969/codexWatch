'use strict';
// 解析后只保留聊天排版需要的元素；模型输出不能注入脚本或调用安卓 JS 桥。
window.CWMarkdown = (() => {
  const escape = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const parser = new marked.Marked({gfm:true,breaks:false});
  parser.use({renderer:{
    html(token){return escape(token.text);},
    image(token){return `<a href="${escape(token.href)}">🖼 ${escape(token.text||'查看图片')}</a>`;},
  }});
  function render(value){
    const safe=DOMPurify.sanitize(parser.parse(String(value??'')),{
      ALLOWED_TAGS:['p','br','h1','h2','h3','h4','h5','h6','strong','em','del','ul','ol','li','blockquote','pre','code','hr','a','table','thead','tbody','tr','th','td','input'],
      ALLOWED_ATTR:['href','title','class','start','align','type','checked','disabled'],
      ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false,
    });
    const fragment=document.createElement('template');fragment.innerHTML=safe;
    for(const a of fragment.content.querySelectorAll('a')){
      // 只允许网页链接；电脑文件路径作为文字保留，避免 file:// 读取手机文件。
      if(!/^https?:\/\//i.test(a.getAttribute('href')||''))a.replaceWith(...a.childNodes);
      else {a.target='_blank';a.rel='noopener noreferrer';}
    }
    for(const input of fragment.content.querySelectorAll('input')){
      if(input.type!=='checkbox')input.remove();else input.disabled=true;
    }
    for(const table of fragment.content.querySelectorAll('table')){
      const wrap=document.createElement('div');wrap.className='md-table-scroll';
      wrap.setAttribute('role','region');wrap.setAttribute('aria-label','表格，可左右滑动');
      table.replaceWith(wrap);wrap.append(table);
    }
    for(const pre of fragment.content.querySelectorAll('pre')){
      const block=document.createElement('div');block.className='md-code-block';
      const header=document.createElement('div');header.className='md-code-head';
      const label=document.createElement('span');
      label.textContent=(pre.querySelector('code')?.className.match(/language-([\w+-]+)/)?.[1]||'代码');
      const copy=document.createElement('button');copy.type='button';copy.className='md-copy';copy.textContent='复制';
      header.append(label,copy);pre.replaceWith(block);block.append(header,pre);
    }
    return fragment.innerHTML;
  }
  return {render};
})();
