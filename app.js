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
const legacyDefaultState = () => ({version:1, settings:{nickname:'小小建造师',startTime:'18:30'}, days:{}, records:[], rewards:[
  {id:'family-game',name:'一起玩喜欢的游戏',description:'和爸爸或妈妈专心玩半小时。',cost:8,icon:'🎮'},
  {id:'family-movie',name:'家庭电影之夜',description:'选一部电影，准备好小零食，一起看。',cost:12,icon:'🎬'},
  {id:'weekend-adventure',name:'周末小冒险',description:'选一个全家都方便参加的周末活动。',cost:15,icon:'🌳'}
], redemptions:[], backupAt:null});
let state, db, page='today', selectedDate=dateKey(), monthOffset=0, busy=false, pendingImport=null;
let filters={subject:'全部科目',kind:'全部类型'}, toastTimer;
const countDay = day => (day?.tasks || []).filter(Boolean).length;
const extraTasks = ['英语语法学习','语文默写','数学计算','体育跳绳'];
const countRuby = day => (day?.extraTasks || []).filter(Boolean).length;
const earned = (s=state) => Object.values(s.days).reduce((a,d)=>a+countDay(d),0);
const rubyEarned = (s=state) => Object.values(s.days).reduce((a,d)=>a+countRuby(d),0);
const spent = (s=state) => s.redemptions.reduce((a,r)=>a+r.cost,0)+(s.draws||[]).filter(r=>r.currency==='emerald').reduce((a,r)=>a+r.cost,0);
const rubySpent = (s=state) => [...s.redemptions,...(s.draws||[]).filter(r=>r.currency==='emerald')].reduce((a,r)=>a+(r.rubyCost||0),0);
const emeraldBalance = (s=state) => earned(s)-(spent(s)-rubySpent(s));
const rubyBalance = (s=state) => rubyEarned(s)-rubySpent(s);
const balance = (s=state) => emeraldBalance(s)+rubyBalance(s);
const payment = (cost,s=state) => ({rubyCost:Math.max(0,cost-emeraldBalance(s))});
const paymentLabel = r => [(r.cost-(r.rubyCost||0))+' 颗绿宝石',r.rubyCost?r.rubyCost+' 颗红宝石':''].filter(Boolean).join(' + ');
const dayData = () => state.days[selectedDate] || {tasks:[false,false,false],difficulty:'',childNote:'',parentNote:'',diamond:false,finishedAt:null,qualityChecks:[false,false,false],extraTasks:[null,null,null,null]};
const recordSubjectClass = s => s==='数学'?'math':s==='英语'?'english':'';

function validateLegacyState(s) {
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

const cardTypes=[
 {id:'dishes',name:'洗碗卡',icon:'🍽️',description:'完成一次洗碗任务，和家长约定具体范围。',kind:'chore'},
 {id:'shoes',name:'摆鞋子卡',icon:'👟',description:'把家里的鞋子整理摆放一次。',kind:'chore'},
 {id:'tv-30',name:'看电视半小时卡',icon:'📺',description:'看电视 30 分钟，和家长约定使用时间。',kind:'leisure'},
 {id:'tv-60',name:'看电视一小时卡',icon:'📺',description:'看电视 60 分钟，和家长约定使用时间。',kind:'leisure'},
 {id:'playground',name:'游乐场卡',icon:'🎡',description:'加入待安排清单，和家长一起安排一次游乐场活动。',kind:'outing'},
 {id:'hike',name:'爬山卡',icon:'⛰️',description:'加入待安排清单，和家长一起安排一次爬山活动。',kind:'outing'},
 {id:'table',name:'擦桌子卡',icon:'🧽',description:'擦干净一次桌子，家长确认完成。',kind:'chore'}
];
const defaultState=()=>validateState(legacyDefaultState());
const diamondEarned=(s=state)=>Object.values(s.days).filter(d=>d.diamond).length;
const diamondSpent=(s=state)=>(s.draws||[]).filter(r=>r.currency==='diamond').reduce((a,r)=>a+r.cost,0);
const diamondBalance=(s=state)=>diamondEarned(s)-diamondSpent(s);
const isWeekend=key=>[0,6].includes(localDate(key).getDay());
const isWednesday=key=>localDate(key).getDay()===3;
const plannedTime=key=>isWeekend(key)?state.plans[key]||'':state.settings.startTime;
const currentTime=()=>new Date().toTimeString().slice(0,5);
function requireToday(){if(selectedDate!==dateKey())throw new Error('这一天已结束，只能查看，不能补打卡或修改任务。');}
function validateState(raw){
 let s=structuredClone(raw);
 if(s?.version===1){validateLegacyState(s);s.version=2;s.plans={};s.draws=[];Object.values(s.days).forEach(d=>Object.assign(d,{diamond:false,finishedAt:null,qualityChecks:[false,false,false]}));}
 if(s?.version===2){s.version=3;Object.values(s.days).forEach(d=>d.extraTasks=[null,null,null,null]);s.redemptions.forEach(r=>r.rubyCost=0);s.draws.forEach(r=>r.rubyCost=0);}
 if(!s||s.version!==3)throw new Error('不支持的备份版本。');
 const legacy=structuredClone(s);legacy.version=1;legacy.draws=[];validateLegacyState(legacy);
 const fail=()=>{throw new Error('备份中的宝石、额外任务、计划或卡片数据不正确。');};
 const time=v=>typeof v==='string'&&/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v);
 const validDate=v=>typeof v==='string'&&/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)&&!isNaN(localDate(v))&&dateKey(localDate(v))===v&&v>='2000-01-01'&&v<='2100-12-31';
 const stamp=v=>typeof v==='string'&&v.length<=40&&!isNaN(Date.parse(v));
 if(!s.plans||typeof s.plans!=='object'||Array.isArray(s.plans)||Object.keys(s.plans).length>37000)fail();
 for(const [key,v] of Object.entries(s.plans))if(!validDate(key)||!isWeekend(key)||!time(v))fail();
 for(const [key,d] of Object.entries(s.days)){
  if(!Array.isArray(d.extraTasks)||d.extraTasks.length!==4||!d.extraTasks.every(v=>v===null||(time(v)&&v<='20:30'))||(!isWednesday(key)&&countRuby(d)>0))fail();
  if(typeof d.diamond!=='boolean'||!Array.isArray(d.qualityChecks)||d.qualityChecks.length!==3||!d.qualityChecks.every(v=>typeof v==='boolean')||(d.finishedAt!==null&&!time(d.finishedAt)))fail();
  if(d.diamond&&(!d.qualityChecks.every(Boolean)||!d.finishedAt||d.finishedAt>'20:00'))fail();
 }
 if(!Array.isArray(s.draws)||s.draws.length>10000)fail();const ids=new Set();
 for(const r of s.draws){if(!r||typeof r.id!=='string'||!r.id||r.id.length>100||ids.has(r.id)||!cardTypes.some(c=>c.id===r.cardId)||!['emerald','diamond'].includes(r.currency)||r.cost!==(r.currency==='emerald'?20:1)||!stamp(r.createdAt)||(r.usedAt!==null&&!stamp(r.usedAt)))fail();ids.add(r.id);}
 for(const r of [...s.redemptions,...s.draws])if(!Number.isInteger(r.rubyCost)||r.rubyCost<0||r.rubyCost>r.cost||(r.currency==='diamond'&&r.rubyCost!==0))fail();
 if(emeraldBalance(s)<0||rubyBalance(s)<0||diamondBalance(s)<0)fail();return s;
}
const monthThemes=[
 ['雪原探宝记','积雪平原','#e4ede0','#cdddc4','#b6d8e8','snow'],['冰河探宝记','冰刺平原','#dbe9e9','#bfd8dd','#a6cddf','ice'],
 ['樱花探宝记','樱花树林','#d5e3b9','#bfd799','#abd3d2','cherry'],['花海探宝记','繁花森林','#cde2a9','#b5cf87','#acd2cb','flower'],
 ['竹林探宝记','竹林丛林','#c6ddae','#add194','#abd2c4','bamboo'],['海岛探宝记','海滩与海洋','#ede3b9','#d9ce9e','#94d2dc','palm'],
 ['丛林探宝记','热带丛林','#bddd9f','#a4c987','#a4d2bb','jungle'],['绿洲探宝记','沙漠绿洲','#ead8a5','#dcc489','#a1d2cc','cactus'],
 ['草原探宝记','稀树草原','#d8dda3','#c5cb8c','#b1d1c0','acacia'],['蘑菇探宝记','蘑菇岛','#dccedc','#cab9ce','#bad3dc','mushroom'],
 ['山林探宝记','山地针叶林','#d2dfb9','#becf9d','#accbd0','pine'],['雪松探宝记','积雪针叶林','#e4e8db','#ccd8c1','#b6d3e0','snowpine']
];
function themedSprite(kind){
 const shapes={
  ice:'<path d="M13 35h24v11H13zM17 19h16v16H17zM21 5h8v14h-8z" fill="#9ac9e1"/><path d="M17 19h7v27h-7zM21 5h4v14h-4z" fill="#d7eff3"/>',
  bamboo:'<path d="M11 7h6v40h-6zM29 3h6v44h-6zM5 9h9v4H5zM16 20h8v4h-8zM23 10h9v5h-9zM34 18h9v4h-9z" fill="#88aa68"/>',
  cactus:'<path d="M20 6h9v40h-9zM8 18h8v16H8zM16 27h4v7h-4zM33 13h8v16h-8zM29 23h4v6h-4z" fill="#79a462"/><path d="M22 7h3v38h-3z" fill="#a5c17d"/>',
  mushroom:'<path d="M19 23h10v23H19z" fill="#eddfbe"/><path d="M4 12h40v15H4zM10 5h28v7H10z" fill="#c87873"/><path d="M10 10h6v5h-6zM27 7h6v5h-6zM31 18h7v5h-7z" fill="#fff1d9"/>'
 };
 if(shapes[kind])return '<svg viewBox="0 0 48 48" aria-hidden="true" shape-rendering="crispEdges">'+shapes[kind]+'</svg>';
 if(kind==='flower')return pixelIcon('flower');
 const leaf={cherry:'#e9a6b5',snow:'#f0f6eb',snowpine:'#e5ede2',pine:'#86a27b',jungle:'#80aa61',acacia:'#b2b875',palm:'#a0b97a'}[kind]||'#8aa56c';
 const crown=kind.includes('pine')?'M5 28h38v8H5zM11 18h26v10H11zM17 9h14v9H17zM21 4h6v5h-6z':kind==='palm'||kind==='acacia'?'M4 9h40v12H4zM10 5h28v5H10z':'M6 12h37v22H6zM12 5h26v7H12z';
 return '<svg viewBox="0 0 48 48" aria-hidden="true" shape-rendering="crispEdges"><path d="M21 26h7v20h-7z" fill="#a18a66"/><path d="'+crown+'" fill="'+leaf+'"/><path d="M12 12h10v6H12z" fill="#ffffff55"/></svg>';
}

function openDB() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('growth-world',2);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('data'))request.result.createObjectStore('data');};
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
  const tx=db.transaction('data','readwrite');let conflict=null;
  const store=tx.objectStore('data'),request=store.get('state');
  request.onsuccess=()=>{
   try{if(request.result&&JSON.stringify(validateState(request.result))!==JSON.stringify(state)){conflict=new Error('另一窗口更新了记录，请刷新后再操作。');tx.abort();return;}store.put(next,'state');}
   catch(error){conflict=error;tx.abort();}
  };
  tx.oncomplete=()=>resolve();tx.onerror=()=>reject(conflict||tx.error);tx.onabort=()=>reject(conflict||tx.error||new Error('保存被中断'));
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
    if($('#editor').open) formError('保存失败：'+error.message); else toast('保存失败：'+error.message);
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
 $('#greeting').textContent=state.settings.nickname+'的探宝手册';$('#balance').textContent=emeraldBalance();$('#ruby-balance').textContent=rubyBalance();$('#diamond-balance').textContent=diamondBalance();
 $$('.nav-item').forEach(b=>{b.classList.toggle('active',b.dataset.page===page);if(b.dataset.page===page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
 $('#content').innerHTML=({today:renderToday,records:renderRecords,rewards:renderRewards}[page]||renderToday)();
}
function renderToday() {
 const dates=monthDates(),theme=monthThemes[localDate(monthDates()[0]).getMonth()],cols=matchMedia('(max-width:560px)').matches?5:7,rows=Math.ceil(dates.length/cols),height=rows*112+85;
 const points=dates.map((key,i)=>{const row=Math.floor(i/cols),col=row%2?cols-1-i%cols:i%cols;return {key,x:12+76*col/(cols-1),y:61+112*row};});
 let path='M '+points[0].x*10+' '+points[0].y;
 points.slice(1).forEach((p,i)=>{const prev=points[i];if(p.y===prev.y)path+=' L '+p.x*10+' '+p.y;else{const edge=p.x>50?65:-65;path+=' C '+(prev.x*10+edge)+' '+prev.y+' '+(p.x*10+edge)+' '+p.y+' '+p.x*10+' '+p.y;}});
 const visited=dates.filter(k=>countDay(state.days[k])+countRuby(state.days[k])+(state.days[k]?.diamond?1:0)>0).length;
 const month=localDate(dates[0]).toLocaleDateString('zh-CN',{year:'numeric',month:'long'});
 const decor=[];
 for(let row=0;row<rows;row++){
  const y=(row*112+108)/height*100;
  decor.push('<span class="map-scenery scenery-tree" style="left:3%;top:'+y+'%">'+themedSprite(theme[5])+'</span>');
  decor.push('<span class="map-scenery scenery-tree" style="left:93%;top:'+(y-5)+'%">'+themedSprite(theme[5])+'</span>');
  if(row<rows-1)decor.push('<span class="map-scenery scenery-small" style="left:'+(row%2?34:64)+'%;top:'+y+'%">'+pixelIcon(row%2?'rock':'flower')+'</span>');
 }
 decor.push('<span class="map-scenery scenery-house" style="left:48%;top:3%">'+pixelIcon('house')+'</span>');
 return '<section class="adventure"><div class="adventure-heading"><div><div class="chapter-label">'+esc(theme[1])+'</div><h1>'+esc(theme[0])+'</h1><p>每天一个小站，走出自己的冒险路线。</p></div><button class="pixel-button today-entry" data-action="open-today">'+pixelIcon('flag')+' 今天的小任务</button></div><div class="map-frame"><div class="map-toolbar"><div class="month-navigation"><button data-action="prev-month" class="map-arrow" aria-label="上个月" '+(dates[0]<='2000-01-01'?'disabled':'')+'>‹</button><strong>'+month+'</strong><button data-action="next-month" class="map-arrow" aria-label="下个月" '+(monthOffset>=0?'disabled':'')+'>›</button></div><span class="map-count">本月已探索 <strong>'+visited+'</strong> 天</span></div><div class="treasure-map" style="--map-height:'+height+'px;--map-ground:'+theme[2]+';--map-patch:'+theme[3]+';--map-pond:'+theme[4]+'"><div class="map-terrain" aria-hidden="true"><div class="map-pond"></div><div class="map-grass patch-one"></div><div class="map-grass patch-two"></div>'+decor.join('')+'</div><svg class="map-route" viewBox="0 0 1000 '+height+'" preserveAspectRatio="none" aria-hidden="true"><path d="'+path+'" class="road-edge"/><path d="'+path+'" class="road-fill"/><path d="'+path+'" class="road-dashes"/></svg>'+points.map((p,i)=>{
  const n=countDay(state.days[p.key]),today=p.key===dateKey(),future=p.key>dateKey(),final=i===points.length-1;
  return '<button class="day-node'+(n===3?' completed':n?' explored':'')+(today?' is-today':'')+(future?' is-future':'')+(final?' treasure-node':'')+'" data-action="open-day" data-date="'+p.key+'" style="left:'+p.x+'%;top:'+p.y/height*100+'%" aria-label="'+prettyDate(p.key)+'，'+(future?'还没到这一天':n+' 个普通任务已完成，获得 '+n+' 颗绿宝石、'+countRuby(state.days[p.key])+' 颗红宝石、'+(state.days[p.key]?.diamond?1:0)+' 颗钻石')+'" '+(future?'disabled':'')+'>'+(today?'<span class="you-are-here">你在这里</span>':'')+'<span class="node-surface">'+(final?pixelIcon('chest'):'<span class="node-number">'+(i+1)+'</span>')+(n===3?'<span class="node-check" aria-hidden="true">✓</span>':'')+'</span><span class="node-caption">'+(final?(i+1)+'日 · 宝藏站':today?'今天':(i+1)+'日')+'</span><span class="node-stars" aria-hidden="true">'+Array.from({length:3},(_,j)=>'<i class="'+(j<n?'filled':'')+'"></i>').join('')+'</span>'+(!future?dailyGems(state.days[p.key]):'')+'</button>';
 }).join('')+'</div><div class="map-legend"><span><i class="legend-today"></i>今天</span><span><i class="legend-done"></i>绿宝石任务完成</span><span><i class="legend-future"></i>还没到这一天</span><span class="map-tip">点一个节点，打开当天任务</span></div></div><p class="adventure-footnote">节点下方显示当天获得的宝石数量：绿宝石、红宝石、钻石。仅当天可打卡，过去日期保留查看。</p></section>';
}
function dayDialog(){
 const d=dayData(),active=selectedDate===dateKey(),time=plannedTime(selectedDate);
 const tasks=[
  {icon:'◷',title:'按计划开始',text:time?time+' 拿出作业，开始第一项。':'周末先和家长约定今天的开始时间。'},
  {icon:'⚒',title:'困难有办法',text:'圈出来，说卡点，得到提示后继续一小步。'},
  {icon:'▤',title:'完成后自己检查',text:'查作业有没有漏，再检查错别字并订正。'}
 ];
 dialog(prettyDate(selectedDate)+'的小任务','<div class="day-dialog-summary"><span>'+(!active?'已结束 · 仅查看记录':'每个小任务获得一颗绿宝石。')+'</span><strong>'+countDay(d)+' / 3</strong></div><div class="day-tasks">'+tasks.map((t,i)=>'<article class="task'+(d.tasks[i]?' done':'')+'"><span class="task-icon" aria-hidden="true">'+t.icon+'</span><div class="day-task-copy"><h3>'+t.title+'</h3><p>'+esc(t.text)+'</p>'+(i===0&&isWeekend(selectedDate)&&active?'<button class="task-extra" data-action="plan-day">'+(time?'查看 / 修改今日约定':'约定今天的开始时间')+'</button>':'')+(i===1?'<button class="task-extra" data-action="difficulty" '+(!active?'disabled':'')+'>'+esc(d.difficulty||'查看三步卡 / 今天没有卡住')+'</button>':'')+'</div><button class="task-button" data-action="task" data-index="'+i+'" aria-label="'+t.title+'：'+(d.tasks[i]?'已完成，点击修正':'我做到了')+'" aria-pressed="'+d.tasks[i]+'" '+(!active||(i===0&&!time)?'disabled':'')+'><span class="emerald '+(!d.tasks[i]?'gem-empty':'')+'" aria-hidden="true"></span><span>'+(d.tasks[i]?'已完成':!active?'已结束':'做到了')+'</span></button></article>').join('')+'<article class="task diamond-task'+(d.diamond?' done':'')+'"><span class="task-icon"><span class="diamond" aria-hidden="true"></span></span><div class="day-task-copy"><h3>20:00 前高质量完成</h3><p>完成清单、检查错别字、处理不会的题。家长确认，获得一颗钻石。</p>'+(d.diamond?'<span class="small">完成时间 '+esc(d.finishedAt)+'</span>':'')+'</div><button class="task-button" data-action="diamond-task" aria-label="钻石任务'+(d.diamond?'已完成':'家长确认')+'" '+(!active?'disabled':'')+'><span class="diamond '+(!d.diamond?'gem-empty':'')+'" aria-hidden="true"></span><span>'+(d.diamond?'已完成':!active?'已结束':'家长确认')+'</span></button></article></div>'+extraTaskList(d,active)+'<div class="day-dialog-footer"><span>'+(active?'小任务得绿宝石，按时认真完成得钻石。':'过去的宝藏已经保存，今天继续前进。')+'</span><button class="pixel-button" data-close>回到地图</button></div>');
}
function weekendDates(){const d=localDate(dateKey());d.setDate(d.getDate()+(6-d.getDay()+7)%7);const next=new Date(d);next.setDate(next.getDate()+1);return [dateKey(d),dateKey(next)];}
function dailyGems(d){
 const green=countDay(d),red=countRuby(d),diamond=d?.diamond?1:0,total=green+red+diamond;
 return '<span class="daily-gems" aria-hidden="true">'+(total?'<span class="daily-gem-total">'+total+' 颗</span><span class="daily-gem-detail"><span class="emerald"></span>'+green+' <span class="ruby"></span>'+red+' <span class="diamond"></span>'+diamond+'</span>':'<span class="daily-gem-zero">0 颗</span>')+'</span>';
}
function extraTaskList(d,active){
 if(!isWednesday(selectedDate))return '';
 return '<section class="extra-study"><h3>周三额外学习 · 红宝石奖励</h3><p>晚上 20:30 前，每完成一项获得 1 颗红宝石。每项当天只领取一次，和绿宝石等值。</p><div class="day-tasks">'+extraTasks.map((name,i)=>'<article class="task ruby-task'+(d.extraTasks[i]?' done':'')+'"><span class="task-icon"><span class="ruby"></span></span><div class="day-task-copy"><h3>'+name+'</h3><p>'+(d.extraTasks[i]?'完成时间 '+esc(d.extraTasks[i]):'完成与家长约定的这一项学习内容。')+'</p></div><button class="task-button" data-action="ruby-task" data-index="'+i+'" aria-label="'+name+'：'+(d.extraTasks[i]?'已完成，点击修正':'领取红宝石')+'" '+(!active?'disabled':'')+'><span class="ruby '+(!d.extraTasks[i]?'gem-empty':'')+'"></span><span>'+(d.extraTasks[i]?'已完成':active?'做到了':'已结束')+'</span></button></article>').join('')+'</div></section>';
}
function rubyDialog(i){
 if(selectedDate!==dateKey()||!isWednesday(selectedDate)||!Number.isInteger(i)||i<0||i>=extraTasks.length)return;
 if(dayData().extraTasks[i]){confirmDialog('修正额外任务？','只用于修正误点。已用于兑换的红宝石不能产生负余额。','undo-ruby',String(i),'修正记录');return;}
 dialog(extraTasks[i]+' · 红宝石','<form id="ruby-form" data-index="'+i+'"><p class="small">完成与家长约定的这一项内容，获得 1 颗红宝石。</p><label class="field">实际完成时间（晚上，不晚于 20:30）<input name="finishedAt" type="time" max="20:30" required value="'+(currentTime()<='20:30'?currentTime():'')+'"></label><p class="small">当天晚些时候也可记录真实完成时间，过期不能补打卡。</p><div class="dialog-actions"><button type="button" class="secondary" data-action="return-day">返回任务</button><button type="submit" class="primary">确认，获得红宝石</button></div></form>');
}
function planDialog(){
 if(selectedDate!==dateKey()||!isWeekend(selectedDate))return;
 dialog('约定今天的开始时间','<form id="plan-form"><p class="small">最好前一晚一起约定。今天只按这个时间判断“开始第一项”。</p><label class="field">'+prettyDate(selectedDate)+'<input name="planTime" type="time" required value="'+esc(state.plans[selectedDate]||'')+'"></label><div class="dialog-actions"><button type="button" class="secondary" data-action="return-day">返回任务</button><button type="submit" class="primary">保存约定</button></div></form>');
}
function diamondDialog(){
 if(selectedDate!==dateKey())return;
 const d=dayData();
 if(d.diamond){confirmDialog('修正钻石任务？','只用于修正误点。已经抽盲盒的钻石不能产生负余额。','undo-diamond','','修正记录');return;}
 dialog('家长确认 · 钻石任务','<form id="diamond-form"><p class="small">今天完成学校作业，逐项核对后获得一颗钻石。</p><div class="quality-checks">'+['作业清单全部完成','已经检查错别字并订正','不会的题已圈出并求助；提示后能做的部分已完成'].map((t,i)=>'<label><input type="checkbox" name="quality" value="'+i+'" required>'+t+'</label>').join('')+'</div><label class="field">实际完成时间（不晚于 20:00）<input type="time" name="finishedAt" max="20:00" required value="'+(currentTime()<='20:00'?currentTime():'')+'"></label><label class="parent-confirm"><input type="checkbox" name="parentConfirm" required>家长已核对以上三项和实际完成时间</label><p class="small">今天晚些时候确认也可以，填写真实完成时间。过了今天就不能补打卡。</p><div class="dialog-actions"><button class="secondary" type="button" data-action="return-day">返回任务</button><button class="primary" type="submit">确认，获得钻石</button></div></form>');
}
function renderBlindBox(){
 const cards=state.draws.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 return '<section class="blind-box"><div class="blind-box-art">'+pixelIcon('chest')+'<span>?</span></div><div class="blind-box-copy"><span class="chapter-label">村民的惊喜卡包</span><h2>今天会开出什么卡？</h2><p>绿宝石和红宝石合计 20 颗，或 1 颗钻石，抽一次。</p><div class="draw-buttons"><button class="primary" data-action="draw-box" data-currency="emerald" '+(balance()<20?'disabled':'')+'><span class="emerald"></span><span class="ruby"></span>合计 20 颗</button><button class="primary diamond-button" data-action="draw-box" data-currency="diamond" '+(diamondBalance()<1?'disabled':'')+'><span class="diamond"></span>1 颗钻石</button></div><p class="gem-payment-note">红宝石和绿宝石等值，可混合使用；先用绿宝石，再用红宝石。</p><button class="text-link" data-action="box-rules">查看七种卡片和规则</button></div></section><section class="panel card-collection"><h2>我的卡片清单</h2><p class="panel-sub">抽到后保存在这里，完成或使用后由家长核销。</p>'+(cards.length?'<div class="collected-cards">'+cards.map(r=>{const c=cardTypes.find(c=>c.id===r.cardId);return '<article class="collected-card'+(r.usedAt?' used':'')+'"><span class="card-symbol">'+c.icon+'</span><div><h3>'+esc(c.name)+'</h3><p>'+esc(c.description)+'</p><small>'+new Date(r.createdAt).toLocaleDateString('zh-CN')+' · '+(r.currency==='emerald'?paymentLabel(r):'1 颗钻石')+' · '+(r.usedAt?'已核销':c.kind==='outing'?'待安排':'待使用 / 完成')+'</small></div>'+(r.usedAt?'<span class="tag ok">已核销</span>':'<button class="secondary" data-action="use-card" data-id="'+esc(r.id)+'">家长核销</button>')+'</article>';}).join('')+'</div>':'<div class="muted-block">抽到的电视卡、家务卡和出游卡都会出现在这里。</div>')+'</section>';
}
function boxRules(){dialog('盲盒里的七种卡','<div class="box-rules">'+cardTypes.map(c=>'<div><span>'+c.icon+'</span><p><strong>'+esc(c.name)+'</strong><small>'+esc(c.description)+'</small></p></div>').join('')+'</div><p class="small">七种卡机会相同，每种 1/7，可以抽到重复卡。确认后扣除所选宝石并保存结果，不能取消抽取或退回宝石重抽。</p><div class="dialog-actions"><button class="primary" data-close>知道啦</button></div>');}
function chooseCard(){const range=4294967296,limit=Math.floor(range/cardTypes.length)*cardTypes.length;const value=new Uint32Array(1);do{crypto.getRandomValues(value);}while(value[0]>=limit);return cardTypes[value[0]%cardTypes.length];}

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
 return renderBlindBox()+heading('村民商店','把小小的努力，换成一起期待的好时光。','<button class="secondary" data-action="new-reward">＋ 和家长约定奖励</button>')+
 '<div class="info-strip" style="margin-top:0;margin-bottom:22px">累计获得 '+(earned()+rubyEarned())+' 颗 · 已兑换使用 '+spent()+' 颗 · 现在有 '+b+' 颗绿宝石与红宝石（等值，可合用）。日常陪伴、拥抱和基本玩耍时间照常。</div>'+
 (state.rewards.length?'<div class="shop-grid">'+state.rewards.map(r=>'<article class="shop-card"><div class="shop-illustration"><span aria-hidden="true">'+esc(r.icon)+'</span></div><div class="shop-body"><h3>'+esc(r.name)+'</h3><p>'+esc(r.description)+'</p><div class="row"><span class="price"><span class="emerald" aria-hidden="true"></span>'+r.cost+' 颗</span><button class="primary" data-action="redeem" data-id="'+esc(r.id)+'" '+(b<r.cost?'disabled':'')+'>'+(b>=r.cost?'兑换奖励':'还差 '+(r.cost-b)+' 颗')+'</button></div></div></article>').join('')+'</div>':empty('先一起约定一份小期待','选一个孩子喜欢、家长也方便兑现的奖励。','<button class="primary" data-action="new-reward">添加奖励</button>'))+
 '<section class="panel" style="margin-top:23px"><h2>已经兑换的小期待</h2><p class="panel-sub">兑换后，历史方块仍然保留。家长兑现后点一下确认。</p>'+(history.length?history.map(r=>'<div class="history-line"><div>'+esc(r.name)+'<small>'+new Date(r.createdAt).toLocaleDateString('zh-CN')+' · '+paymentLabel(r)+' · '+(r.fulfilledAt?'已兑现':'待家长兑现')+'</small></div>'+(r.fulfilledAt?'<span class="tag ok">已兑现 ✓</span>':'<div><button class="secondary" data-action="fulfill" data-id="'+esc(r.id)+'">确认兑现</button><button class="quiet" data-action="cancel-redemption" data-id="'+esc(r.id)+'">取消</button></div>')+'</div>').join(''):'<div class="muted-block">你的第一份小期待，正在路上。</div>')+'</section>';
}

function recordDialog(id) {
 const r=id?state.records.find(r=>r.id===id):{date:dateKey(),subject:'语文',kind:'默写',title:'',total:'',wrong:'',causes:[],followup:'待订正',note:''};
 if(!r) return;
 dialog(id?'编辑学习记录':'记一次学习','<form id="record-form" data-id="'+esc(id||'')+'"><div class="form-grid"><label class="field">日期<input name="date" type="date" required min="2000-01-01" max="'+dateKey()+'" value="'+r.date+'"></label><label class="field">科目<select name="subject">'+options(subjects,r.subject)+'</select></label><label class="field">类型<select name="kind">'+options(kinds,r.kind)+'</select></label><label class="field">范围 / 名称<input name="title" maxlength="80" required placeholder="例如：第六课字词" value="'+esc(r.title)+'"></label><label class="field">总题数 / 字词数<input name="total" inputmode="numeric" type="number" min="1" max="1000" step="1" required value="'+r.total+'"></label><label class="field">错题数 / 错字词数<input name="wrong" inputmode="numeric" type="number" min="0" max="1000" step="1" required value="'+r.wrong+'"></label><div class="field full">主要卡点（可多选，也可以留空）<div class="check-tags">'+causes.map(c=>'<label class="check-tag"><input type="checkbox" name="cause" value="'+c+'" '+(r.causes.includes(c)?'checked':'')+'>'+c+'</label>').join('')+'</div></div><label class="field full">后续情况<select name="followup">'+options(followups,r.followup)+'</select></label><label class="field full">补充一句（选填）<textarea name="note" maxlength="500" placeholder="例如：回看时，能自己分清这两个字了。">'+esc(r.note)+'</textarea></label></div><p class="small">只描述事实，不给“粗心”“不认真”贴标签。学习结果不影响绿宝石。</p><div class="dialog-actions"><button class="secondary" type="button" data-close>取消</button><button class="primary" type="submit">保存记录</button></div></form>');
}
function difficultyDialog() {
 const d=dayData();
 if(selectedDate!==dateKey())return;
 dialog('困难有办法 · 三步卡','<div class="difficulty-help"><ol><li><strong>圈出来：</strong>圈出不会的题号或字词。</li><li><strong>说出来：</strong>指着卡住的地方说，比如“我不懂这个词”。</li><li><strong>继续一小步：</strong>得到提示后，自己写下一步。</li></ol><p>不要求答案一定正确，也不要求全程没有烦躁。家长提醒后完成，也算做到。</p></div><form id="difficulty-form"><label class="field">今天是哪一种？<select name="difficulty" required><option value="">请选择今天的情况</option>'+options(difficulties.slice(1),d.difficulty)+'</select></label><div class="muted-block">家长暂时没空帮忙：圈好题、提出求助，先做其他会做的题，也算达标。<br>今天没有卡住、顺利完成，也能获得这颗绿宝石。</div><div class="dialog-actions"><button class="secondary" type="button" data-action="return-day">回到当天任务</button><button class="primary" type="submit">记下办法，获得绿宝石</button></div></form>');
}
function settingsDialog() {
 dialog('家长设置与备份','<form id="settings-form"><div class="form-grid"><label class="field">孩子的昵称<input name="nickname" maxlength="30" required value="'+esc(state.settings.nickname)+'"></label><label class="field">周中开始时间<input name="startTime" type="time" required value="'+esc(state.settings.startTime)+'"></label></div><div class="weekend-settings"><h3>周末：前一晚一起约定</h3><div class="form-grid">'+weekendDates().map(key=>'<label class="field">'+prettyDate(key)+'<input type="time" name="plan-'+key+'" value="'+esc(state.plans[key]||'')+'"></label>').join('')+'</div><p class="small">周六、周日分别设置；留空表示还没有约定。周末当天也可从任务里设置。</p></div><button class="primary full-width" type="submit">保存设置</button></form><section class="setting-section"><h3>约定的奖励</h3>'+state.rewards.map(r=>'<div class="reward-setting"><span>'+esc(r.icon)+' '+esc(r.name)+' <small>'+r.cost+' 颗</small></span><span><button class="quiet" data-action="edit-reward" data-id="'+esc(r.id)+'">编辑</button><button class="quiet" data-action="delete-reward" data-id="'+esc(r.id)+'">移除</button></span></div>').join('')+'<button class="text-link" data-action="new-reward">＋ 添加小奖励</button></section><section class="setting-section"><h3>备份这本成长手册</h3><p class="small">数据保存在当前设备的浏览器里。清除网站数据、换设备或系统回收存储，可能丢失记录。建议每周导出一份，放到“文件”或网盘。</p><div class="backup-buttons"><button class="primary" data-action="export">导出备份</button><button class="secondary" data-action="import">导入备份</button><button class="secondary" data-action="persist">申请持久保存</button></div><p class="backup-status">'+(state.backupAt?'上次导出：'+new Date(state.backupAt).toLocaleString('zh-CN'):'还没有导出备份')+'</p><p class="small">持久保存能减少系统自动回收的风险，但不能代替备份。导入会替换此设备的全部记录。</p></section><section class="setting-section"><h3>安装与离线</h3><p class="small" id="offline-status">正在检查离线状态…</p><p class="small">安卓平板：首次联网打开 HTTPS 网址后，在支持 PWA 的浏览器里选择“安装应用”或“添加到主屏幕”。以后固定从这个入口使用。</p><p class="small">当前为家庭本地版，家长入口用于区分操作，没有密码锁。</p></section>');
 updateOfflineStatus();
}
async function updateOfflineStatus() {
 const el=$('#offline-status');if(!el)return;
 if(location.protocol==='file:'){el.textContent='直接打开文件不支持可靠的安装与离线缓存，请通过网页服务打开。';return;}
 if(!('serviceWorker' in navigator)||!window.isSecureContext){el.textContent='当前地址不支持离线安装。正式使用需要 HTTPS；电脑 localhost 可预览。';return;}
 const registration=await navigator.serviceWorker.getRegistration();
 const cache=await caches.open('growth-world-v4'); const ready=await cache.match('./index.html');
 if(!el.isConnected)return;
 el.textContent=registration?.active&&ready?'离线文件已准备好。可以断网打开；记录仍保存在此设备。':'离线文件正在准备，请保持联网后重新查看。';
}
function rewardDialog(id) {
 const r=id?state.rewards.find(r=>r.id===id):{name:'',description:'',cost:8,icon:'🎁'};if(!r)return;
 dialog(id?'修改约定奖励':'一起约定小奖励','<form id="reward-form" data-id="'+esc(id||'')+'" class="reward-form"><label class="field">奖励名称<input name="name" required maxlength="60" placeholder="例如：一起搭一个方块小屋" value="'+esc(r.name)+'"></label><label class="field">具体约定<textarea name="description" maxlength="200" placeholder="约定时长、时间或预算，让奖励容易兑现。">'+esc(r.description)+'</textarea></label><div class="form-grid"><label class="field">需要的宝石（绿 / 红等值）<input name="cost" type="number" inputmode="numeric" min="1" max="10000" step="1" required value="'+r.cost+'"></label><label class="field">奖励图标<select name="icon">'+options(['🎁','🎮','🎬','🌳','🧱','📚','🍜','🚲','🎨','🧩'],r.icon)+'</select></label></div><p class="small">第一份奖励可以从 8 颗开始，根据孩子目前能做到的程度调整。基本陪伴不需要兑换。</p><div class="dialog-actions"><button class="secondary" type="button" data-close>取消</button><button class="primary" type="submit">保存约定</button></div></form>');
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
 if(['task','undo-task','difficulty','diamond-task','undo-diamond','plan-day','ruby-task','undo-ruby'].includes(action)&&selectedDate!==dateKey()){toast('过期日期只能查看，不能再打卡。');return;}
 if(action==='task') {
   const i=Number(b.dataset.index),d=dayData();
   if(i===0&&!plannedTime(selectedDate)){planDialog();return;}
   if(i===1&&!d.tasks[1]){difficultyDialog();return;}
   if(d.tasks[i]){confirmDialog('修正这条记录？','如果刚才点错了，可以修正；这不是扣罚。已经兑换的奖励不能因此产生负余额。','undo-task',String(i),'修正记录');return;}
   const ok=await commit(s=>{requireToday();const day=s.days[selectedDate] ||= structuredClone(d);day.tasks[i]=true;},'获得 1 颗绿宝石。');if(ok)dayDialog();
 }
 if(action==='undo-task') {
   if(emeraldBalance()<1){formError('这颗绿宝石已经用于兑换。请先取消尚未兑现的兑换，再修正记录。');return;}
   const i=Number(id);const ok=await commit(s=>{requireToday();s.days[selectedDate].tasks[i]=false;if(i===1)s.days[selectedDate].difficulty='';},'记录已修正。',true);if(ok)dayDialog();
 }
 if(action==='difficulty')difficultyDialog();
 if(action==='diamond-task')diamondDialog();
 if(action==='ruby-task')rubyDialog(Number(b.dataset.index));
 if(action==='undo-ruby'){
  const i=Number(id);const ok=await commit(s=>{requireToday();if(!isWednesday(selectedDate)||!Number.isInteger(i)||i<0||i>=4)throw new Error('额外任务不正确。');if(rubyBalance(s)<1)throw new Error('这颗红宝石已用于兑换，不能修正。');s.days[selectedDate].extraTasks[i]=null;},'额外任务已修正。',true);if(ok)dayDialog();
 }
 if(action==='plan-day')planDialog();
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
 if(action==='box-rules')boxRules();
 if(action==='draw-box'){
  const currency=b.dataset.currency;if(!['emerald','diamond'].includes(currency))return;
  const cost=currency==='emerald'?20:1;if((currency==='emerald'?balance():diamondBalance())<cost){toast('宝石不足，先完成今天的小任务。');return;}
  dialog('打开一个盲盒？','<p>使用 '+(currency==='emerald'?paymentLabel({cost:20,...payment(20)}):'1 颗钻石')+'，随机抽一张卡。结果会保存到卡片清单。</p><p class="small">七种卡机会相同，可以重复。确认后不能取消抽取或退回宝石重抽。</p><div class="dialog-actions"><button class="secondary" data-close>先不抽</button><button class="primary" data-action="confirm-draw" data-currency="'+currency+'">确认抽取</button></div>');
 }
 if(action==='confirm-draw'){
  const currency=b.dataset.currency;if(!['emerald','diamond'].includes(currency))return;
  const cost=currency==='emerald'?20:1;let card;
  const ok=await commit(s=>{if((currency==='emerald'?balance(s):diamondBalance(s))<cost)throw new Error('宝石不足。');card=chooseCard();s.draws.push({id:uid(),cardId:card.id,currency,cost,...(currency==='emerald'?payment(cost,s):{rubyCost:0}),createdAt:new Date().toISOString(),usedAt:null});},'',true);
  if(ok)dialog('你抽到了！','<div class="card-reveal"><span>'+card.icon+'</span><h3>'+esc(card.name)+'</h3><p>'+esc(card.description)+'</p><small>已经放入你的卡片清单。</small></div><div class="dialog-actions"><button class="primary" data-close>收好卡片</button></div>');
 }
 if(action==='use-card'){const r=state.draws.find(r=>r.id===id);if(r&&!r.usedAt){const c=cardTypes.find(c=>c.id===r.cardId);confirmDialog('家长确认 · '+c.name,'确认这张卡的家务或活动已经完成，核销后保留历史记录。','confirm-use-card',id,'确认完成');}}
 if(action==='confirm-use-card')await commit(s=>{const r=s.draws.find(r=>r.id===id);if(r&&!r.usedAt)r.usedAt=new Date().toISOString();},'卡片已核销。',true);
 if(action==='undo-diamond'){
  if(diamondBalance()<1){formError('这颗钻石已用于抽盲盒，不能产生负余额。');return;}
  const ok=await commit(s=>{requireToday();const d=s.days[selectedDate];d.diamond=false;d.finishedAt=null;d.qualityChecks=[false,false,false];},'钻石记录已修正。',true);if(ok)dayDialog();
 }
 if(action==='new-reward')rewardDialog();
 if(action==='edit-reward')rewardDialog(id);
 if(action==='delete-reward')confirmDialog('移除这份奖励？','商店里不再展示它，过去的兑换记录仍然保留。','confirm-delete-reward',id,'移除');
 if(action==='confirm-delete-reward')await commit(s=>s.rewards=s.rewards.filter(r=>r.id!==id),'奖励已移除。',true);
 if(action==='redeem') {const r=state.rewards.find(r=>r.id===id);if(r&&balance()>=r.cost)confirmDialog('兑换「'+r.name+'」？','使用 '+r.cost+' 颗宝石（绿宝石与红宝石等值），兑换后还剩 '+(balance()-r.cost)+' 颗。请和家长确认这个约定。','confirm-redeem',id,'确认兑换');}
 if(action==='confirm-redeem') {const r=state.rewards.find(r=>r.id===id);if(!r||balance()<r.cost){formError('绿宝石和红宝石不足，或这份奖励已被修改。');return;}await commit(s=>s.redemptions.push({id:uid(),rewardId:r.id,name:r.name,cost:r.cost,...payment(r.cost,s),createdAt:new Date().toISOString(),fulfilledAt:null}),'兑换成功，和家长一起安排时间吧。',true);}
 if(action==='fulfill')confirmDialog('家长确认：已经兑现？','确认这份奖励已经完成，留下你们一起的好时光。','confirm-fulfill',id,'已经兑现');
 if(action==='confirm-fulfill')await commit(s=>{const r=s.redemptions.find(r=>r.id===id);if(r&&!r.fulfilledAt)r.fulfilledAt=new Date().toISOString();},'这份小期待已经兑现。',true);
 if(action==='cancel-redemption')confirmDialog('取消这次兑换？','尚未兑现的奖励可以取消，使用的绿宝石和红宝石会按原数量退回。','confirm-cancel-redemption',id,'取消兑换');
 if(action==='confirm-cancel-redemption')await commit(s=>s.redemptions=s.redemptions.filter(r=>r.id!==id||r.fulfilledAt),'兑换已取消，宝石已按原颜色退回。',true);
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
 if(['difficulty-form','diamond-form','plan-form','ruby-form'].includes(form.id)&&selectedDate!==dateKey()){formError('这一天已经结束，不能再打卡。');return;}
 if(form.id==='difficulty-form'){const choice=data.get('difficulty');if(!choice){formError('先选一下今天的情况。');return;}const already=dayData().tasks[1];const ok=await commit(s=>{requireToday();const d=s.days[selectedDate] ||= structuredClone(dayData());d.tasks[1]=true;d.difficulty=choice;},already?'今天的办法已更新。':'你找到了办法，获得 1 颗绿宝石。',true);if(ok)dayDialog();}
 if(form.id==='plan-form'){
  const time=data.get('planTime');const ok=await commit(s=>{requireToday();if(!isWeekend(selectedDate))throw new Error('周中使用固定开始时间。');s.plans[selectedDate]=time;},'今日约定已保存。',true);if(ok)dayDialog();
 }
 if(form.id==='ruby-form'){
  const i=Number(form.dataset.index),finishedAt=data.get('finishedAt');
  const ok=await commit(s=>{requireToday();if(!isWednesday(selectedDate)||!Number.isInteger(i)||i<0||i>=4)throw new Error('只有周三可以领取额外任务奖励。');if(typeof finishedAt!=='string'||!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(finishedAt)||finishedAt>'20:30')throw new Error('请填写不晚于 20:30 的实际完成时间。');const d=s.days[selectedDate] ||= structuredClone(dayData());if(d.extraTasks[i])throw new Error('这一项已获得红宝石，不能重复领取。');d.extraTasks[i]=finishedAt;},'获得 1 颗红宝石！',true);if(ok)dayDialog();
 }
 if(form.id==='diamond-form'){
  const finishedAt=data.get('finishedAt');if(!finishedAt||finishedAt>'20:00'||data.getAll('quality').length!==3||!data.get('parentConfirm')){formError('请核对三个动作、家长确认和 20:00 前的实际完成时间。');return;}
  const ok=await commit(s=>{requireToday();const d=s.days[selectedDate] ||= structuredClone(dayData());if(d.diamond)throw new Error('今天已经获得钻石，不能重复领取。');d.diamond=true;d.finishedAt=finishedAt;d.qualityChecks=[true,true,true];},'按时认真完成，获得 1 颗钻石！',true);if(ok)dayDialog();
 }
 if(form.id==='settings-form'){const nickname=data.get('nickname').trim();if(!nickname){formError('请填一个昵称。');return;}await commit(s=>{s.settings={nickname,startTime:data.get('startTime')};for(const key of weekendDates()){const value=data.get('plan-'+key);if(value)s.plans[key]=value;else delete s.plans[key];}},'设置与周末约定已保存。',true);}
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
   db=await openDB();const saved=await readDB();state=saved?validateState(saved):defaultState();if(saved&&saved.version!==3)await writeDB(state);
   db.onversionchange=()=>{db.close();toast('应用已在另一个页面更新，请刷新。');};
   page=['today','records','rewards'].includes(location.hash.slice(1))?location.hash.slice(1):'today';
   render();$('#save-state').textContent='已保存在此设备';
   if('serviceWorker' in navigator&&window.isSecureContext&&location.protocol!=='file:') navigator.serviceWorker.register('./sw.js').catch(()=>toast('离线文件尚未准备好，当前可以联网使用。'));
 }catch(error){$('#save-state').textContent='本地存储未能打开';$('#content').innerHTML=empty('暂时无法打开成长手册','请使用普通浏览模式，通过网页服务打开，并确认设备有可用存储空间。不会覆盖已有数据。')+'<p class="small">'+esc(error.message)+'</p>';}
}
init();
