'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateKey = (d = new Date()) => [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
const localDate = s => new Date(s + 'T12:00:00');
const prettyDate = s => localDate(s).toLocaleDateString('zh-CN', {month:'long',day:'numeric',weekday:'short'});
const uid = () => crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
const subjects = ['语文','数学','英语','其他'];
const kinds = ['默写','单元测验','期中考试','期末考试','日常练习','其他'];
const causes = ['没记住','字形混淆','同音字混淆','漏题','抄错数字','计算错误','不懂题意','不会方法','待确认'];
const followups = ['待订正','已订正，待回看','独立完成','提示后完成','还不会'];
const difficulties = ['', '主动完成三步', '提醒后完成三步', '等待帮助，先做其他题', '今天没有卡住'];
const defaultState = () => ({version:1, settings:{nickname:'小小建造师',startTime:'18:30'}, days:{}, records:[], rewards:[
  {id:'family-game',name:'一起玩喜欢的游戏',description:'和爸爸或妈妈专心玩半小时。',cost:8,icon:'🎮'},
  {id:'family-movie',name:'家庭电影之夜',description:'选一部电影，准备好小零食，一起看。',cost:12,icon:'🎬'},
  {id:'weekend-adventure',name:'周末小冒险',description:'选一个全家都方便参加的周末活动。',cost:15,icon:'🌳'}
], redemptions:[], backupAt:null});
let state, db, page='today', selectedDate=dateKey(), monthOffset=0, busy=false, pendingImport=null;
let filters={subject:'全部科目',kind:'全部类型'}, toastTimer;
const countDay = day => (day?.tasks || []).filter(Boolean).length;
const earned = (s=state) => Object.values(s.days).reduce((a,d)=>a+countDay(d),0);
const spent = (s=state) => s.redemptions.reduce((a,r)=>a+r.cost,0);
const balance = (s=state) => earned(s)-spent(s);
const dayData = () => state.days[selectedDate] || {tasks:[false,false,false],difficulty:'',childNote:'',parentNote:''};
const recordSubjectClass = s => s==='数学'?'math':s==='英语'?'english':'';

function validateState(s) {
  const fail = () => {throw new Error('备份内容不完整或格式不正确，请选择本应用导出的备份。');};
  const str = (v,max) => typeof v==='string' && v.length<=max;
  const integer = (v,min,max) => Number.isInteger(v) && v>=min && v<=max;
  const date = v => str(v,10) && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v) && !isNaN(localDate(v)) && dateKey(localDate(v))===v && v>='2000-01-01' && v<='2100-12-31';
  const timestamp = v => str(v,40) && !isNaN(Date.parse(v));
  if (!s || s.version!==1 || !s.settings || !str(s.settings.nickname,30) || !s.settings.nickname.trim() || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s.settings.startTime)) fail();
  if (!s.days || typeof s.days!=='object' || Array.isArray(s.days) || Object.keys(s.days).length>37000) fail();
  for (const [key,d] of Object.entries(s.days)) {
    if (!date(key) || !d || !Array.isArray(d.tasks) || d.tasks.length!==3 || !d.tasks.every(t=>typeof t==='boolean') || !difficulties.includes(d.difficulty) || !str(d.childNote,500) || !str(d.parentNote,500)) fail();
    if (d.tasks[1] && !d.difficulty) fail();
  }
  for (const key of ['records','rewards','redemptions']) {
    if (!Array.isArray(s[key]) || s[key].length>10000) fail();
    const ids=new Set();
    for(const item of s[key]) { if(!item || !str(item.id,100) || !item.id || ids.has(item.id)) fail(); ids.add(item.id); }
  }
  for (const r of s.records) if (!date(r.date) || !subjects.includes(r.subject) || !kinds.includes(r.kind) || !str(r.title,80) || !r.title.trim() || !integer(r.total,1,1000) || !integer(r.wrong,0,r.total) || !Array.isArray(r.causes) || r.causes.length>causes.length || !r.causes.every(c=>causes.includes(c)) || !followups.includes(r.followup) || !str(r.note,500)) fail();
  for (const r of s.rewards) if (!str(r.name,60) || !r.name.trim() || !str(r.description,200) || !integer(r.cost,1,10000) || !str(r.icon,20)) fail();
  for (const r of s.redemptions) if (!str(r.rewardId,100) || !str(r.name,60) || !integer(r.cost,1,10000) || !timestamp(r.createdAt) || (r.fulfilledAt!==null && !timestamp(r.fulfilledAt))) fail();
  if (s.backupAt!==null && !timestamp(s.backupAt)) fail();
  if (balance(s)<0) fail();
  return s;
}

function openDB() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('growth-world',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('data');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
function readDB() {
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('data','readonly');
    const request=tx.objectStore('data').get('state');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
function writeDB(next) {
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('data','readwrite');
    tx.objectStore('data').put(next,'state');
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error || new Error('保存被中断'));
  });
}
async function commit(mutator, message, close=false) {
  if(busy) return false;
  busy=true;
  $('#save-state').textContent='正在保存…';
  try {
    const next=structuredClone(state);
    mutator(next);
    validateState(next);
    await writeDB(next);
    state=next;
    if(close) $('#editor').close();
    render();
    $('#save-state').textContent='已保存在此设备';
    if(message) toast(message);
    return true;
  } catch(error) {
    $('#save-state').textContent='保存失败，请导出备份';
    if($('#editor').open) formError('保存失败：'+error.message); else toast('保存失败，记录没有更新。请检查设备存储空间。');
    return false;
  } finally {busy=false;}
}
function toast(message) {
  clearTimeout(toastTimer); const el=$('#toast'); el.textContent=message; el.hidden=false;
  toastTimer=setTimeout(()=>el.hidden=true,3800);
}
function formError(message) {
  let el=$('.form-error',$('#editor'));
  if(!el){el=document.createElement('div');el.className='form-error';el.setAttribute('role','alert');$('#dialog-content').append(el);}
  el.textContent=message;
}
function dialog(title,body) {
  $('#dialog-content').innerHTML='<div class="dialog-heading"><h2 id="dialog-title">'+esc(title)+'</h2><button type="button" class="close-btn" data-close aria-label="关闭">×</button></div>'+body;
  if(!$('#editor').open) $('#editor').showModal();
}
function go(next) { if(next==='growth')next='today'; if(!['today','records','rewards'].includes(next)) return; page=next; location.hash=next; render(); }
function heading(title,subtitle,action='') {return '<div class="page-heading"><div><h1>'+title+'</h1><p>'+subtitle+'</p></div>'+action+'</div>';}
function empty(title,description,button='') {return '<div class="empty"><span class="empty-icon" aria-hidden="true">▧</span><h3>'+title+'</h3><p>'+description+'</p>'+button+'</div>';}
function options(values,current) {return values.map(v=>'<option'+(v===current?' selected':'')+'>'+esc(v)+'</option>').join('');}

function pixelIcon(kind) {
 const art={
  chest:'<path d="M6 14h36v26H6z" fill="#83522b"/><path d="M6 11h36v13H6z" fill="#ce9247"/><path d="M10 15h28v5H10z" fill="#e8b35e"/><path d="M6 23h36v5H6zM9 11h4v29H9zM35 11h4v29h-4z" fill="#e9c069"/><path d="M20 22h8v10h-8z" fill="#ffe2a0"/><path d="M23 25h2v4h-2z" fill="#765735"/>',
  tree:'<path d="M20 26h8v20h-8z" fill="#8e603b"/><path d="M8 8h32v26H8zM4 16h40v14H4z" fill="#4d823f"/><path d="M8 8h16v12H8zM24 20h20v10H24z" fill="#70a251"/><path d="M16 4h16v5H16z" fill="#5e9448"/>',
  house:'<path d="M7 21h34v23H7z" fill="#d6b378"/><path d="M4 16h40v8H4zM10 10h28v6H10zM16 4h16v6H16z" fill="#a66e43"/><path d="M20 28h9v16h-9z" fill="#7f5839"/><path d="M11 28h6v6h-6zM32 28h6v6h-6z" fill="#add7da"/>',
  rock:'<path d="M7 23h34v17H7zM12 16h25v7H12zM18 10h14v6H18z" fill="#7d9088"/><path d="M12 16h12v8H12zM7 28h16v7H7zM30 23h11v7H30z" fill="#9ba99b"/>',
  flower:'<path d="M22 24h4v22h-4zM14 32h8v5h-8zM26 36h8v5h-8z" fill="#548747"/><path d="M18 8h12v8H18zM12 16h8v12h-8zM28 16h8v12h-8zM18 28h12v8H18z" fill="#e6bd69"/><path d="M20 18h8v8h-8z" fill="#f8e7ab"/>',
  flag:'<path d="M12 5h5v38h-5z" fill="#715741"/><path d="M17 7h23v17H17z" fill="#e6ab47"/><path d="M17 7h11v6H17z" fill="#f4d17f"/>'
 };
 return '<svg viewBox="0 0 48 48" aria-hidden="true" shape-rendering="crispEdges">'+(art[kind]||art.tree)+'</svg>';
}
function monthDates() {
 const first=localDate(dateKey());first.setDate(1);first.setMonth(first.getMonth()+monthOffset);
 const count=new Date(first.getFullYear(),first.getMonth()+1,0).getDate();
 return Array.from({length:count},(_,i)=>{const d=new Date(first);d.setDate(i+1);return dateKey(d);});
}
function render() {
 if(!state)return;
 $('#greeting').textContent=state.settings.nickname+'的探宝手册';$('#balance').textContent=balance();
 $$('.nav-item').forEach(b=>{b.classList.toggle('active',b.dataset.page===page);if(b.dataset.page===page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
 $('#content').innerHTML=({today:renderToday,records:renderRecords,rewards:renderRewards}[page]||renderToday)();
}
function renderToday() {
 const dates=monthDates(),cols=matchMedia('(max-width:560px)').matches?5:7,rows=Math.ceil(dates.length/cols),height=rows*112+85;
 const points=dates.map((key,i)=>{const row=Math.floor(i/cols),col=row%2?cols-1-i%cols:i%cols;return {key,x:12+76*col/(cols-1),y:61+112*row};});
 let path='M '+points[0].x*10+' '+points[0].y;
 points.slice(1).forEach((p,i)=>{const prev=points[i];if(p.y===prev.y)path+=' L '+p.x*10+' '+p.y;else{const edge=p.x>50?65:-65;path+=' C '+(prev.x*10+edge)+' '+prev.y+' '+(p.x*10+edge)+' '+p.y+' '+p.x*10+' '+p.y;}});
 const visited=dates.filter(k=>countDay(state.days[k])>0).length;
 const month=localDate(dates[0]).toLocaleDateString('zh-CN',{year:'numeric',month:'long'});
 const decor=[];
 for(let row=0;row<rows;row++){
  const y=(row*112+108)/height*100;
  decor.push('<span class="map-scenery scenery-tree" style="left:3%;top:'+y+'%">'+pixelIcon('tree')+'</span>');
  decor.push('<span class="map-scenery scenery-tree" style="left:93%;top:'+(y-5)+'%">'+pixelIcon('tree')+'</span>');
  if(row<rows-1)decor.push('<span class="map-scenery scenery-small" style="left:'+(row%2?34:64)+'%;top:'+y+'%">'+pixelIcon(row%2?'rock':'flower')+'</span>');
 }
 decor.push('<span class="map-scenery scenery-house" style="left:48%;top:3%">'+pixelIcon('house')+'</span>');
 return '<section class="adventure"><div class="adventure-heading"><div><div class="chapter-label">CHAPTER · 01 / 草原篇</div><h1>草原寻宝记</h1><p>每天一个小站，走出自己的冒险路线。</p></div><button class="pixel-button today-entry" data-action="open-today">'+pixelIcon('flag')+' 今天的小任务</button></div><div class="map-frame"><div class="map-toolbar"><div class="month-navigation"><button data-action="prev-month" class="map-arrow" aria-label="上个月" '+(dates[0]<='2000-01-01'?'disabled':'')+'>‹</button><strong>'+month+'</strong><button data-action="next-month" class="map-arrow" aria-label="下个月" '+(monthOffset>=0?'disabled':'')+'>›</button></div><span class="map-count">本月已探索 <strong>'+visited+'</strong> 天</span></div><div class="treasure-map" style="--map-height:'+height+'px"><div class="map-terrain" aria-hidden="true"><div class="map-pond"></div><div class="map-grass patch-one"></div><div class="map-grass patch-two"></div>'+decor.join('')+'</div><svg class="map-route" viewBox="0 0 1000 '+height+'" preserveAspectRatio="none" aria-hidden="true"><path d="'+path+'" class="road-edge"/><path d="'+path+'" class="road-fill"/><path d="'+path+'" class="road-dashes"/></svg>'+points.map((p,i)=>{
  const n=countDay(state.days[p.key]),today=p.key===dateKey(),future=p.key>dateKey(),final=i===points.length-1;
  return '<button class="day-node'+(n===3?' completed':n?' explored':'')+(today?' is-today':'')+(future?' is-future':'')+(final?' treasure-node':'')+'" data-action="open-day" data-date="'+p.key+'" style="left:'+p.x+'%;top:'+p.y/height*100+'%" aria-label="'+prettyDate(p.key)+'，'+(future?'还没到这一天':n+' 个任务已完成')+'" '+(future?'disabled':'')+'>'+(today?'<span class="you-are-here">你在这里</span>':'')+'<span class="node-surface">'+(final?pixelIcon('chest'):'<span class="node-number">'+(i+1)+'</span>')+(n===3?'<span class="node-check" aria-hidden="true">✓</span>':'')+'</span><span class="node-caption">'+(final?(i+1)+'日 · 宝藏站':today?'今天':(i+1)+'日')+'</span><span class="node-stars" aria-hidden="true">'+Array.from({length:3},(_,j)=>'<i class="'+(j<n?'filled':'')+'"></i>').join('')+'</span></button>';
 }).join('')+'</div><div class="map-legend"><span><i class="legend-today"></i>今天</span><span><i class="legend-done"></i>三个任务完成</span><span><i class="legend-future"></i>还没到这一天</span><span class="map-tip">点一个节点，打开当天任务</span></div></div><p class="adventure-footnote">每完成一个小任务，获得一颗绿宝石。漏一天也可以继续前进。</p></section>';
}
function dayDialog() {
 const d=dayData(),n=countDay(d);
 const tasks=[
  {icon:'◷',title:'按计划开始',text:esc(state.settings.startTime)+' 拿出作业，开始第一项。'},
  {icon:'⚒',title:'困难有办法',text:'圈出来，说卡点，得到提示后继续一小步。'},
  {icon:'▤',title:'完成后自己检查',text:'查作业有没有漏，再检查一项约定重点。'}
 ];
 dialog(prettyDate(selectedDate)+'的小任务','<div class="day-dialog-summary"><span>完成一个，收集一颗绿宝石。</span><strong>'+n+' / 3</strong></div><div class="day-tasks">'+tasks.map((t,i)=>'<article class="task'+(d.tasks[i]?' done':'')+'"><span class="task-icon" aria-hidden="true">'+t.icon+'</span><div class="day-task-copy"><h3>'+t.title+'</h3><p>'+t.text+'</p>'+(i===1?'<button class="task-extra" data-action="difficulty">'+esc(d.difficulty||'查看三步卡 / 今天没有卡住')+'</button>':'')+'</div><button class="task-button" data-action="task" data-index="'+i+'" aria-label="'+t.title+'：'+(d.tasks[i]?'已完成，点击修正':'我做到了')+'" aria-pressed="'+d.tasks[i]+'"><span class="star" aria-hidden="true">'+(d.tasks[i]?'★':'☆')+'</span><span>'+ (d.tasks[i]?'已完成':'做到了')+'</span></button></article>').join('')+'</div><div class="day-dialog-footer"><span>'+(n===3?'今天的宝藏，已经收好啦！':'不急，完成眼前这一小步。')+'</span><button class="pixel-button" data-close>回到地图</button></div>');
}
function renderRecords() {
 const list=state.records.filter(r=>(filters.subject==='全部科目'||r.subject===filters.subject)&&(filters.kind==='全部类型'||r.kind===filters.kind)).sort((a,b)=>b.date.localeCompare(a.date));
 return heading('学习手册','照实记下每一次，也看见后来学会的部分。','<button class="primary" data-action="new-record">＋ 记一次学习</button>')+
 '<div class="toolbar"><select id="subject-filter" aria-label="按科目筛选">'+options(['全部科目',...subjects],filters.subject)+'</select><select id="kind-filter" aria-label="按类型筛选">'+options(['全部类型',...kinds],filters.kind)+'</select><span class="small">'+list.length+' 条记录</span><span class="parent-label">家长录入</span></div>'+
 (list.length?'<div class="record-list">'+list.map(recordCard).join('')+'</div>':empty('手册的第一页，等你来写',state.records.length?'这个筛选下还没有记录，可以换个科目看看。':'默写、测验或练习后，记下总题数和错题数。不用每天额外测一次。','<button class="primary" data-action="new-record">记录一次学习</button>'))+
 '<div class="info-strip">语文按字词数、数学按题数记录。同一类任务保持相同的计数方法；不同范围和难度，不直接比较错误数量。</div>';
}
function recordCard(r) {
 return '<article class="record-card"><span class="subject-badge '+recordSubjectClass(r.subject)+'">'+esc(r.subject)+'</span><div><h3>'+esc(r.title)+'</h3><div class="record-meta">'+prettyDate(r.date)+' · '+esc(r.kind)+'</div><p class="record-result">共 <strong>'+r.total+'</strong> '+(r.subject==='语文'&&r.kind==='默写'?'个字词':'题')+'，错 <strong>'+r.wrong+'</strong> '+(r.subject==='语文'&&r.kind==='默写'?'个':'题')+'</p><div class="tags">'+r.causes.map(c=>'<span class="tag">'+esc(c)+'</span>').join('')+'<span class="tag '+(r.followup==='独立完成'?'ok':'')+'">'+esc(r.followup)+'</span></div>'+(r.note?'<p class="record-note">'+esc(r.note)+'</p>':'')+'</div><div class="record-actions"><button class="quiet" data-action="edit-record" data-id="'+esc(r.id)+'">编辑</button><button class="quiet" data-action="delete-record" data-id="'+esc(r.id)+'">删除</button></div></article>';
}
function renderRewards() {
 const b=balance(),history=state.redemptions.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 return heading('村民商店','把小小的努力，换成一起期待的好时光。','<button class="secondary" data-action="new-reward">＋ 和家长约定奖励</button>')+
 '<div class="info-strip" style="margin-top:0;margin-bottom:22px">累计获得 '+earned()+' 颗 · 已兑换使用 '+spent()+' 颗 · 现在有 '+b+' 颗绿宝石。日常陪伴、拥抱和基本玩耍时间照常。</div>'+
 (state.rewards.length?'<div class="shop-grid">'+state.rewards.map(r=>'<article class="shop-card"><div class="shop-illustration"><span aria-hidden="true">'+esc(r.icon)+'</span></div><div class="shop-body"><h3>'+esc(r.name)+'</h3><p>'+esc(r.description)+'</p><div class="row"><span class="price"><span class="emerald" aria-hidden="true"></span>'+r.cost+' 颗</span><button class="primary" data-action="redeem" data-id="'+esc(r.id)+'" '+(b<r.cost?'disabled':'')+'>'+(b>=r.cost?'兑换奖励':'还差 '+(r.cost-b)+' 颗')+'</button></div></div></article>').join('')+'</div>':empty('先一起约定一份小期待','选一个孩子喜欢、家长也方便兑现的奖励。','<button class="primary" data-action="new-reward">添加奖励</button>'))+
 '<section class="panel" style="margin-top:23px"><h2>已经兑换的小期待</h2><p class="panel-sub">兑换后，历史方块仍然保留。家长兑现后点一下确认。</p>'+(history.length?history.map(r=>'<div class="history-line"><div>'+esc(r.name)+'<small>'+new Date(r.createdAt).toLocaleDateString('zh-CN')+' · '+r.cost+' 颗绿宝石 · '+(r.fulfilledAt?'已兑现':'待家长兑现')+'</small></div>'+(r.fulfilledAt?'<span class="tag ok">已兑现 ✓</span>':'<div><button class="secondary" data-action="fulfill" data-id="'+esc(r.id)+'">确认兑现</button><button class="quiet" data-action="cancel-redemption" data-id="'+esc(r.id)+'">取消</button></div>')+'</div>').join(''):'<div class="muted-block">你的第一份小期待，正在路上。</div>')+'</section>';
}

function recordDialog(id) {
 const r=id?state.records.find(r=>r.id===id):{date:dateKey(),subject:'语文',kind:'默写',title:'',total:'',wrong:'',causes:[],followup:'待订正',note:''};
 if(!r) return;
 dialog(id?'编辑学习记录':'记一次学习','<form id="record-form" data-id="'+esc(id||'')+'"><div class="form-grid"><label class="field">日期<input name="date" type="date" required min="2000-01-01" max="'+dateKey()+'" value="'+r.date+'"></label><label class="field">科目<select name="subject">'+options(subjects,r.subject)+'</select></label><label class="field">类型<select name="kind">'+options(kinds,r.kind)+'</select></label><label class="field">范围 / 名称<input name="title" maxlength="80" required placeholder="例如：第六课字词" value="'+esc(r.title)+'"></label><label class="field">总题数 / 字词数<input name="total" inputmode="numeric" type="number" min="1" max="1000" step="1" required value="'+r.total+'"></label><label class="field">错题数 / 错字词数<input name="wrong" inputmode="numeric" type="number" min="0" max="1000" step="1" required value="'+r.wrong+'"></label><div class="field full">主要卡点（可多选，也可以留空）<div class="check-tags">'+causes.map(c=>'<label class="check-tag"><input type="checkbox" name="cause" value="'+c+'" '+(r.causes.includes(c)?'checked':'')+'>'+c+'</label>').join('')+'</div></div><label class="field full">后续情况<select name="followup">'+options(followups,r.followup)+'</select></label><label class="field full">补充一句（选填）<textarea name="note" maxlength="500" placeholder="例如：回看时，能自己分清这两个字了。">'+esc(r.note)+'</textarea></label></div><p class="small">只描述事实，不给“粗心”“不认真”贴标签。学习结果不影响绿宝石。</p><div class="dialog-actions"><button class="secondary" type="button" data-close>取消</button><button class="primary" type="submit">保存记录</button></div></form>');
}
function difficultyDialog() {
 const d=dayData();
 dialog('困难有办法 · 三步卡','<div class="difficulty-help"><ol><li><strong>圈出来：</strong>圈出不会的题号或字词。</li><li><strong>说出来：</strong>指着卡住的地方说，比如“我不懂这个词”。</li><li><strong>继续一小步：</strong>得到提示后，自己写下一步。</li></ol><p>不要求答案一定正确，也不要求全程没有烦躁。家长提醒后完成，也算做到。</p></div><form id="difficulty-form"><label class="field">今天是哪一种？<select name="difficulty" required><option value="">请选择今天的情况</option>'+options(difficulties.slice(1),d.difficulty)+'</select></label><div class="muted-block">家长暂时没空帮忙：圈好题、提出求助，先做其他会做的题，也算达标。<br>今天没有卡住、顺利完成，也能获得这颗绿宝石。</div><div class="dialog-actions"><button class="secondary" type="button" data-action="return-day">回到当天任务</button><button class="primary" type="submit">记下办法，获得绿宝石</button></div></form>');
}
function settingsDialog() {
 dialog('家长设置与备份','<form id="settings-form"><div class="form-grid"><label class="field">孩子的昵称<input name="nickname" maxlength="30" required value="'+esc(state.settings.nickname)+'"></label><label class="field">约定开始时间<input name="startTime" type="time" required value="'+esc(state.settings.startTime)+'"></label></div><p class="small">一起商量一个现实的开始时间；作业量变化时，可以调整。</p><button class="primary full-width" type="submit">保存设置</button></form><section class="setting-section"><h3>约定的奖励</h3>'+state.rewards.map(r=>'<div class="reward-setting"><span>'+esc(r.icon)+' '+esc(r.name)+' <small>'+r.cost+' 颗</small></span><span><button class="quiet" data-action="edit-reward" data-id="'+esc(r.id)+'">编辑</button><button class="quiet" data-action="delete-reward" data-id="'+esc(r.id)+'">移除</button></span></div>').join('')+'<button class="text-link" data-action="new-reward">＋ 添加小奖励</button></section><section class="setting-section"><h3>备份这本成长手册</h3><p class="small">数据保存在当前设备的浏览器里。清除网站数据、换设备或系统回收存储，可能丢失记录。建议每周导出一份，放到“文件”或网盘。</p><div class="backup-buttons"><button class="primary" data-action="export">导出备份</button><button class="secondary" data-action="import">导入备份</button><button class="secondary" data-action="persist">申请持久保存</button></div><p class="backup-status">'+(state.backupAt?'上次导出：'+new Date(state.backupAt).toLocaleString('zh-CN'):'还没有导出备份')+'</p><p class="small">持久保存能减少系统自动回收的风险，但不能代替备份。导入会替换此设备的全部记录。</p></section><section class="setting-section"><h3>安装与离线</h3><p class="small" id="offline-status">正在检查离线状态…</p><p class="small">安卓平板：首次联网打开 HTTPS 网址后，在支持 PWA 的浏览器里选择“安装应用”或“添加到主屏幕”。以后固定从这个入口使用。</p><p class="small">当前为家庭本地版，家长入口用于区分操作，没有密码锁。</p></section>');
 updateOfflineStatus();
}
async function updateOfflineStatus() {
 const el=$('#offline-status');if(!el)return;
 if(location.protocol==='file:'){el.textContent='直接打开文件不支持可靠的安装与离线缓存，请通过网页服务打开。';return;}
 if(!('serviceWorker' in navigator)||!window.isSecureContext){el.textContent='当前地址不支持离线安装。正式使用需要 HTTPS；电脑 localhost 可预览。';return;}
 const registration=await navigator.serviceWorker.getRegistration();
 const cache=await caches.open('growth-world-v2'); const ready=await cache.match('./index.html');
 if(!el.isConnected)return;
 el.textContent=registration?.active&&ready?'离线文件已准备好。可以断网打开；记录仍保存在此设备。':'离线文件正在准备，请保持联网后重新查看。';
}
function rewardDialog(id) {
 const r=id?state.rewards.find(r=>r.id===id):{name:'',description:'',cost:8,icon:'🎁'};if(!r)return;
 dialog(id?'修改约定奖励':'一起约定小奖励','<form id="reward-form" data-id="'+esc(id||'')+'" class="reward-form"><label class="field">奖励名称<input name="name" required maxlength="60" placeholder="例如：一起搭一个方块小屋" value="'+esc(r.name)+'"></label><label class="field">具体约定<textarea name="description" maxlength="200" placeholder="约定时长、时间或预算，让奖励容易兑现。">'+esc(r.description)+'</textarea></label><div class="form-grid"><label class="field">需要的绿宝石<input name="cost" type="number" inputmode="numeric" min="1" max="10000" step="1" required value="'+r.cost+'"></label><label class="field">奖励图标<select name="icon">'+options(['🎁','🎮','🎬','🌳','🧱','📚','🍜','🚲','🎨','🧩'],r.icon)+'</select></label></div><p class="small">第一份奖励可以从 8 颗开始，根据孩子目前能做到的程度调整。基本陪伴不需要兑换。</p><div class="dialog-actions"><button class="secondary" type="button" data-close>取消</button><button class="primary" type="submit">保存约定</button></div></form>');
}
function confirmDialog(title,description,action,id,label='确认') {
 dialog(title,'<p>'+esc(description)+'</p><div class="dialog-actions"><button class="secondary" data-close>取消</button><button class="primary" data-action="'+action+'" data-id="'+esc(id||'')+'">'+label+'</button></div>');
}

document.addEventListener('click',async event=>{
 const b=event.target.closest('button');if(!b)return;
 if(b.hasAttribute('data-close')){$('#editor').close();return;}
 if(b.dataset.page){go(b.dataset.page);return;}
 if(b.id==='settings-btn'){settingsDialog();return;}
 if(b.id==='wallet-btn'){go('rewards');return;}
 const id=b.dataset.id, action=b.dataset.action;
 if(!action||busy)return;
 if(action==='task') {
   const i=Number(b.dataset.index),d=dayData();
   if(i===1&&!d.tasks[1]){difficultyDialog();return;}
   if(d.tasks[i]){confirmDialog('修正这条记录？','如果刚才点错了，可以修正；这不是扣罚。已经兑换的奖励不能因此产生负余额。','undo-task',String(i),'修正记录');return;}
   const ok=await commit(s=>{const day=s.days[selectedDate] ||= structuredClone(d);day.tasks[i]=true;},'获得 1 颗绿宝石。');if(ok)dayDialog();
 }
 if(action==='undo-task') {
   if(balance()<1){formError('这颗绿宝石已经用于兑换。请先取消尚未兑现的兑换，再修正记录。');return;}
   const i=Number(id);const ok=await commit(s=>{s.days[selectedDate].tasks[i]=false;if(i===1)s.days[selectedDate].difficulty='';},'记录已修正。',true);if(ok)dayDialog();
 }
 if(action==='difficulty')difficultyDialog();
 if(action==='back-today'){selectedDate=dateKey();render();}
 if(action==='new-record')recordDialog();
 if(action==='edit-record')recordDialog(id);
 if(action==='delete-record')confirmDialog('删除这条学习记录？','删除后无法撤销。建议先导出备份。','confirm-delete-record',id,'删除');
 if(action==='confirm-delete-record')await commit(s=>s.records=s.records.filter(r=>r.id!==id),'学习记录已删除。',true);
 if(action==='prev-month'&&monthDates()[0]>'2000-01-01'){monthOffset--;render();}
 if(action==='next-month'&&monthOffset<0){monthOffset++;render();}
 if(action==='open-today'){selectedDate=dateKey();monthOffset=0;page='today';render();dayDialog();}
 if(action==='open-day'){const key=b.dataset.date;if(key&&key<=dateKey()&&monthDates().includes(key)){selectedDate=key;dayDialog();}}
 if(action==='return-day')dayDialog();
 if(action==='new-reward')rewardDialog();
 if(action==='edit-reward')rewardDialog(id);
 if(action==='delete-reward')confirmDialog('移除这份奖励？','商店里不再展示它，过去的兑换记录仍然保留。','confirm-delete-reward',id,'移除');
 if(action==='confirm-delete-reward')await commit(s=>s.rewards=s.rewards.filter(r=>r.id!==id),'奖励已移除。',true);
 if(action==='redeem') {const r=state.rewards.find(r=>r.id===id);if(r&&balance()>=r.cost)confirmDialog('兑换「'+r.name+'」？','使用 '+r.cost+' 颗绿宝石，兑换后还剩 '+(balance()-r.cost)+' 颗。请和家长确认这个约定。','confirm-redeem',id,'确认兑换');}
 if(action==='confirm-redeem') {const r=state.rewards.find(r=>r.id===id);if(!r||balance()<r.cost){formError('绿宝石不足，或这份奖励已被修改。');return;}await commit(s=>s.redemptions.push({id:uid(),rewardId:r.id,name:r.name,cost:r.cost,createdAt:new Date().toISOString(),fulfilledAt:null}),'兑换成功，和家长一起安排时间吧。',true);}
 if(action==='fulfill')confirmDialog('家长确认：已经兑现？','确认这份奖励已经完成，留下你们一起的好时光。','confirm-fulfill',id,'已经兑现');
 if(action==='confirm-fulfill')await commit(s=>{const r=s.redemptions.find(r=>r.id===id);if(r&&!r.fulfilledAt)r.fulfilledAt=new Date().toISOString();},'这份小期待已经兑现。',true);
 if(action==='cancel-redemption')confirmDialog('取消这次兑换？','尚未兑现的奖励可以取消，绿宝石会退回。','confirm-cancel-redemption',id,'取消兑换');
 if(action==='confirm-cancel-redemption')await commit(s=>s.redemptions=s.redemptions.filter(r=>r.id!==id||r.fulfilledAt),'兑换已取消，绿宝石已退回。',true);
 if(action==='export')await exportBackup();
 if(action==='import')$('#import-file').click();
 if(action==='confirm-import'){if(!pendingImport)return;const imported=pendingImport;const ok=await commit(s=>{Object.keys(s).forEach(k=>delete s[k]);Object.assign(s,imported);},'备份已恢复。',true);if(ok)pendingImport=null;}
 if(action==='persist') {
   try {const granted=await navigator.storage?.persist?.();toast(granted?'浏览器已允许持久保存，仍请定期备份。':'浏览器暂未授予持久保存，请继续定期备份。');}catch{toast('此浏览器不支持申请持久保存，请定期备份。');}
 }
});
document.addEventListener('change',event=>{
 if(event.target.id==='task-date') {const value=event.target.value;if(value&&value>='2000-01-01'&&value<=dateKey()){selectedDate=value;render();}}
 if(event.target.id==='subject-filter'){filters.subject=event.target.value;render();}
 if(event.target.id==='kind-filter'){filters.kind=event.target.value;render();}
});
document.addEventListener('submit',async event=>{
 const form=event.target;event.preventDefault();if(busy||!form.checkValidity())return;
 const data=new FormData(form);
 if(form.id==='difficulty-form'){const choice=data.get('difficulty');if(!choice){formError('先选一下今天的情况。');return;}const already=dayData().tasks[1];const ok=await commit(s=>{const d=s.days[selectedDate] ||= structuredClone(dayData());d.tasks[1]=true;d.difficulty=choice;},already?'今天的办法已更新。':'你找到了办法，获得 1 颗绿宝石。',true);if(ok)dayDialog();}
 if(form.id==='settings-form'){const nickname=data.get('nickname').trim();if(!nickname){formError('请填一个昵称。');return;}await commit(s=>s.settings={nickname,startTime:data.get('startTime')},'设置已保存。',true);}
 if(form.id==='record-form'){
   const total=Number(data.get('total')),wrong=Number(data.get('wrong')),title=data.get('title').trim();
   if(!title){formError('请写一下这次学习的范围或名称。');return;}
   if(!Number.isInteger(total)||!Number.isInteger(wrong)||wrong>total){formError('错题数不能超过总题数，请核对后再保存。');return;}
   const r={id:form.dataset.id||uid(),date:data.get('date'),subject:data.get('subject'),kind:data.get('kind'),title,total,wrong,causes:data.getAll('cause'),followup:data.get('followup'),note:data.get('note').trim()};
   await commit(s=>{const i=s.records.findIndex(item=>item.id===r.id);if(i<0)s.records.push(r);else s.records[i]=r;},'学习记录已保存，绿宝石不受影响。',true);
 }
 if(form.id==='reward-form'){
   const name=data.get('name').trim();if(!name){formError('请填一个奖励名称。');return;}
   const r={id:form.dataset.id||uid(),name,description:data.get('description').trim(),cost:Number(data.get('cost')),icon:data.get('icon')};
   await commit(s=>{const i=s.rewards.findIndex(item=>item.id===r.id);if(i<0)s.rewards.push(r);else s.rewards[i]=r;},'小奖励已约定。',true);
 }
});
async function exportBackup() {
 const stamp=new Date().toISOString();
 const exported=structuredClone(state);exported.backupAt=stamp;
 const blob=new Blob([JSON.stringify({app:'growth-world',exportedAt:stamp,data:exported},null,2)],{type:'application/json'});
 const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='成长世界备份-'+dateKey()+'.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
 const ok=await commit(s=>s.backupAt=stamp,'已发起下载，请确认备份文件保存成功。');if(ok)settingsDialog();
}
$('#import-file').addEventListener('change',async event=>{
 const file=event.target.files[0];event.target.value='';if(!file)return;
 try {
   if(file.size>10*1024*1024)throw new Error('备份文件过大，请选择小于 10 MB 的文件。');
   const raw=JSON.parse(await file.text());if(raw.app!=='growth-world')throw new Error('这不是成长世界的备份文件。');
   pendingImport=validateState(raw.data);
   confirmDialog('恢复这份成长手册？','备份包含 '+Object.keys(pendingImport.days).length+' 天任务、'+pendingImport.records.length+' 条学习记录、'+pendingImport.redemptions.length+' 次兑换。导入会替换当前设备的全部记录，请先导出当前备份。','confirm-import','','替换并恢复');
 }catch(error){pendingImport=null;toast('导入失败：'+error.message);}
});
$('#editor').addEventListener('close',()=>{pendingImport=null;});
window.addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(['today','records','rewards'].includes(next)){page=next;render();}else if(next==='growth'){go('today');}});
let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(page==='today')render();},120);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state){if(selectedDate!==dateKey()&&!state.days[selectedDate])selectedDate=dateKey();render();}});
async function init() {
 try {
   db=await openDB();const saved=await readDB();state=saved?validateState(saved):defaultState();
   db.onversionchange=()=>{db.close();toast('应用已在另一个页面更新，请刷新。');};
   page=['today','records','rewards'].includes(location.hash.slice(1))?location.hash.slice(1):'today';
   render();$('#save-state').textContent='已保存在此设备';
   if('serviceWorker' in navigator&&window.isSecureContext&&location.protocol!=='file:') navigator.serviceWorker.register('./sw.js').catch(()=>toast('离线文件尚未准备好，当前可以联网使用。'));
 }catch(error){$('#save-state').textContent='本地存储未能打开';$('#content').innerHTML=empty('暂时无法打开成长手册','请使用普通浏览模式，通过网页服务打开，并确认设备有可用存储空间。不会覆盖已有数据。')+'<p class="small">'+esc(error.message)+'</p>';}
}
init();
