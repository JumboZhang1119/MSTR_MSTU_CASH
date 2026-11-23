/* v6: only signals + 3-window research + opt-in parameter editing. No portfolio ledger. */
(function(){'use strict';
const E=window.StrategyEngine,$=id=>document.getElementById(id),CFG=window.SUPABASE_CONFIG||{};
const hasCloud=!!(CFG.url&&CFG.publishableKey),PRICE_KEY='mstr_mstu_official_ohlc_v6',PARAM_KEY='mstr_mstu_strategy_params_v6';
const FMT=n=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const PRICE=n=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4});
const PCT=n=>(n*100).toFixed(1)+'%';
const LABEL={CASH:'100% CASH',MSTR:'100% MSTR',MSTU:'100% MSTU'};
let db=null,user=null,mode=hasCloud?'cloud':'local',prices=null,rows=null,params={...E.DEFAULTS},hybrid=null,live=null,decision=null,timer=null,results={},scanCache=null;
function alertUser(msg,bad=false){const el=$('alertBox');el.textContent=msg;el.className='alertbox show'+(bad?' error':'');clearTimeout(timer);timer=setTimeout(()=>el.className='alertbox',5000);}
function badge(s){$('syncBadge').textContent=s;}
function busy(on){for(const k of ['saveUpdate','saveParamsBtn','loginBtn','signupBtn','seedBtn','cloudReload'])$(k).disabled=on;}
function nextWeekday(day){let d=new Date(day+'T12:00:00Z');do{d.setUTCDate(d.getUTCDate()+1);}while([0,6].includes(d.getUTCDay()));return d.toISOString().slice(0,10);}
function checkBar(x){return /^\d{4}-\d{2}-\d{2}$/.test(x[0])&&Number.isFinite(x[1])&&x[1]>0&&Number.isFinite(x[2])&&x[2]>0;}
function cleanPrices(p){return {MSTR:(p.MSTR||[]).slice().sort((a,b)=>a[0].localeCompare(b[0])),MSTU:(p.MSTU||[]).slice().sort((a,b)=>a[0].localeCompare(b[0]))};}
function addBar(p,sym,bar){if(!checkBar(bar))throw Error('日線資料無效：'+sym+' '+bar[0]);const a=p[sym],k=a.findIndex(x=>x[0]===bar[0]);if(k>=0)a[k]=bar;else a.push(bar);a.sort((a,b)=>a[0].localeCompare(b[0]));}
function validData(){return prices?.MSTR?.length>=260&&prices?.MSTU?.length>=15;}
function allowedParams(obj){try{return E.checkParams({mstr:Number(obj.mstr),mstu:Number(obj.mstu),long:Number(obj.long),slope:Number(obj.slope),cost:E.DEFAULTS.cost,drag:E.DEFAULTS.drag});}catch(err){throw Error('策略設定錯誤：'+err.message);}}
function paramText(){return `MSTR ${params.mstr} · MSTU ${params.mstu} · 長線 ${params.long}／斜率 ${params.slope}`;}
function fillParams(){for(const [k,id] of [['mstr','paramMstr'],['mstu','paramMstu'],['long','paramLong'],['slope','paramSlope']])$(id).value=params[k];$('currentParamsBadge').textContent=paramText();}
function render(){if(!validData()){badge('等待匯入正式行情');$('modelTarget').textContent='需初始化行情';return;}
 try{
  rows=E.makeRows(prices,params.drag);hybrid=E.signals(rows,params,'hybrid');live=E.signals(rows,params,'realOnly');decision=E.nextDecision(rows,hybrid,params);
  renderDaily();renderStudy();badge((mode==='cloud'?'雲端已同步':'本機展示')+' · '+rows.at(-1).date);
 }catch(err){badge('資料或計算錯誤');alertUser(err.message,true);console.error(err);}
}
function renderDaily(){const r=rows.at(-1),d=decision;
 $('lastDate').textContent=r.date;$('nextDate').textContent='下次預估交易日 '+nextWeekday(r.date);
 $('modelTarget').textContent=LABEL[d.previous];
 $('modelExplanation').textContent=d.previous==='CASH'?'最後已完成交易日的模型風險狀態為現金；若翌日價格方向與昨收不同，仍須等待下一次收盤確認。':d.previous==='MSTU'?'模型處於加槓桿狀態。MSTU 先跌破短均線可轉 MSTR；MSTR 風險訊號則可直接轉 CASH。':'模型已確認持有 MSTR；只有長期牛市條件與 MSTU 短線強勢同時成立時才轉 MSTU。';
 $('bullLabel').textContent='牛市條件：'+(d.bull?'成立':'未成立');$('paramShort').textContent=paramText();
 $('mstrSmaLabel').textContent=`SMA${params.mstr}`;$('mstuSmaLabel').textContent=`SMA${params.mstu}`;
 $('mstrThreshold').textContent='$'+PRICE(d.m);$('mstuThreshold').textContent='$'+PRICE(d.u);
 $('mstrCloseSide').textContent=`昨收 $${PRICE(d.mc)}，在均線${d.mPrevAbove?'上':'下'}方`;
 $('mstuCloseSide').textContent=`昨收 $${PRICE(d.uc)}，在均線${d.uPrevAbove?'上':'下'}方`;
 $('callout').textContent=d.bull?'長線牛市允許 MSTU；是否啟用仍需 MSTR 和 MSTU 個別的「昨收＋今日價格」確認。':'長線牛市尚未成立，因此下次確認最多只會是 MSTR 或 CASH，不會加入 MSTU。';
 const out=$('matrix');out.replaceChildren();
 for(const item of d.combinations){
  const box=document.createElement('div');box.className='case-card '+item.target.toLowerCase() ;
  const h=document.createElement('div');h.className='bounds';h.textContent=`MSTR ${item.mstrAbove?'高於':'低於'} $${PRICE(d.m)} · MSTU ${item.mstuAbove?'高於':'低於'} $${PRICE(d.u)}`;
  const b=document.createElement('strong');b.className='target';b.textContent='→ '+LABEL[item.target];
  const sm=document.createElement('small');sm.textContent=(item.target===d.previous?'維持模型狀態':'模型 '+d.previous+' → '+item.target)+'；'+(!item.mConfirm?'MSTR 未二次確認，沿用前狀態；':'MSTR 二次確認；')+(!item.uConfirm?'MSTU 未二次確認':'MSTU 二次確認');
  box.append(h,b,sm);out.append(box);
 }
 if(!$('updateDate').value||$('updateDate').value<=r.date)$('updateDate').value=nextWeekday(r.date);
}
function renderStudy(){fillParams();const cases={
 historical:E.simulate(rows,hybrid,'2022-10-10','MSTR',params.cost),
 live:E.simulate(rows,live,'2024-09-18','MSTR',params.cost),
 forward:E.simulate(rows,live,'2026-11-20','MODEL',params.cost)};results=cases;
 for(const [key,v] of Object.entries(cases)){
  $(key+'Strategy').textContent='$'+FMT(v.strategy);$(key+'Hold').textContent='$'+FMT(v.benchmark);
  $(key+'Mdd').textContent=PCT(v.mdd);$(key+'Trades').textContent=v.trades+' 次';
  paint($(key+'Chart'),v.curve,v.buyhold);
 }
 // Rankings depend on settings and date; old rankings become stale after any update.
 $('rankHistorical').textContent='按「掃描候選參數」重新計算';$('rankLive').textContent='按「掃描候選參數」重新計算';
 scanCache=null;$('scanStatus').textContent='目前使用 '+paramText()+'。排行榜是樣本內比較，不會自動套用。';
}
function paint(canvas,s,b){const ctx=canvas.getContext('2d'),rect=canvas.getBoundingClientRect();if(rect.width<20||rect.height<20)return;
 const ratio=window.devicePixelRatio||1,w=rect.width,h=rect.height;canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);
 const pad={l:52,r:10,t:14,b:29},cw=w-pad.l-pad.r,ch=h-pad.t-pad.b;const all=s.concat(b).map(x=>x.value).filter(x=>x>0);const lo=Math.min(...all),hi=Math.max(...all),flat=hi/lo<1.05;
 const ymin=flat?Math.min(9500,lo*.98):lo*.88,ymax=flat?Math.max(10500,hi*1.02):hi*1.2;
 const log=!flat&&ymax/ymin>3,sc=x=>log?Math.log(x):x,yl=sc(ymin),yh=sc(ymax);
 const X=i=>pad.l+cw*(s.length===1?.5:i/(s.length-1)),Y=v=>pad.t+ch*(1-(sc(Math.max(ymin,Math.min(ymax,v)))-yl)/(yh-yl));
 ctx.font='10px system-ui';ctx.textAlign='right';ctx.fillStyle='#8391a5';
 for(let k=0;k<=3;k++){const f=k/3,y=pad.t+ch*f;ctx.strokeStyle='#e7edf5';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();const val=log?Math.exp(yh-(yh-yl)*f):ymax-(ymax-ymin)*f;ctx.fillText(val>=1000?'$'+Math.round(val/1000)+'k':'$'+Math.round(val),pad.l-6,y+3);}
 function trace(data,color){ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();data.forEach((x,i)=>i===0?ctx.moveTo(X(i),Y(x.value)):ctx.lineTo(X(i),Y(x.value)));if(data.length===1){ctx.moveTo(X(0)-2,Y(data[0].value));ctx.lineTo(X(0)+2,Y(data[0].value));}ctx.stroke();}
 trace(b,'#e8a14a');trace(s,'#4779ea');ctx.fillStyle='#8795a8';ctx.textAlign='left';ctx.fillText(s[0].date,pad.l,h-6);ctx.textAlign='right';ctx.fillText(s.at(-1).date,w-pad.r,h-6);
}
function quick(){if(!decision)return alertUser('先載入資料',true);const m=Number($('testMstr').value),u=Number($('testMstu').value);if(!(m>0&&u>0))return alertUser('請輸入兩檔價格',true);
 const x=decision.evaluate(m,u);$('quickResult').textContent=`條件式目標 ${LABEL[x.target]}；${x.target===decision.previous?'模型維持不變':`模型 ${decision.previous} → ${x.target}`}。MSTR ${x.mConfirm?'確認':'未確認'}，MSTU ${x.uConfirm?'確認':'未確認'}。僅供盤前參考，不是已執行交易。`;
 $('quickResult').className='quick-result ok';
}
function renderRanking(el,items){const t=document.createElement('table');t.className='rank-table';const head=document.createElement('thead');head.innerHTML='<tr><th>#</th><th>MSTR</th><th>MSTU</th><th>長線</th><th>期末</th><th>MDD</th><th>事件</th></tr>';t.append(head);
 const body=document.createElement('tbody');items.slice(0,12).forEach((a,i)=>{const row=document.createElement('tr');if(a.m===params.mstr&&a.u===params.mstu&&a.l===params.long)row.className='current-row';
 for(const val of [i+1,a.m,a.u,a.l,'$'+FMT(a.end),PCT(a.mdd),a.trades]){const c=document.createElement('td');c.textContent=val;row.append(c);}body.append(row);});t.append(body);el.replaceChildren(t);}
function applyScanFilter(){
 if(!scanCache)return;
 const limit=Number($('scanLimit').value),a=scanCache.historical.filter(x=>-x.mdd<=limit),b=scanCache.live.filter(x=>-x.mdd<=limit);
 renderRanking($('rankHistorical'),a);renderRanking($('rankLive'),b);
 $('scanStatus').textContent=`320 組已掃描；最大回撤條件 ${limit===1?'不限':(limit*100).toFixed(0)+'% 以內'}。歷史符合 ${a.length} 組，純真實符合 ${b.length} 組。`
 +(a.length?`歷史最高 $${FMT(a[0].end)}（${a[0].m}/${a[0].u}/${a[0].l}）。`:'歷史無符合組合。')
 +(b.length?`純真實最高 $${FMT(b[0].end)}（${b[0].m}/${b[0].u}/${b[0].l}）。`:'純真實無符合組合。')+'此為樣本內排名。';
}
async function scan(){if(!rows){alertUser('尚未載入行情',true);return;}
 $('scanBtn').disabled=true;const a=[],b=[],grid=[];for(const m of [16,18,20,22,24,26,28,30])for(const u of [7,9,11,13,15,17,19,21])for(const l of [150,175,200,225,250])grid.push({m,u,l});
 $('scanStatus').textContent=`正在掃描 ${grid.length} 組候選，計算兩段回測中…`;
 try{for(let i=0;i<grid.length;i++){
  const g=grid[i],p={...params,mstr:g.m,mstu:g.u,long:g.l,slope:20};
  const h=E.signals(rows,p,'hybrid'),x=E.simulate(rows,h,'2022-10-10','MSTR',p.cost);
  const y=E.signals(rows,p,'realOnly'),z=E.simulate(rows,y,'2024-09-18','MSTR',p.cost);
  a.push({m:g.m,u:g.u,l:g.l,end:x.strategy,mdd:x.mdd,trades:x.trades});b.push({m:g.m,u:g.u,l:g.l,end:z.strategy,mdd:z.mdd,trades:z.trades});
  if(i%40===39){$('scanStatus').textContent=`已完成 ${i+1} / ${grid.length} 組…`;await new Promise(res=>requestAnimationFrame(res));}
 }
 a.sort((x,y)=>y.end-x.end);b.sort((x,y)=>y.end-x.end);scanCache={historical:a,live:b};applyScanFilter();
 }catch(err){alertUser('掃描失敗：'+err.message,true);}finally{$('scanBtn').disabled=false;}
}
async function readSeed(){const res=await fetch('seed_prices.json',{cache:'no-store'});if(!res.ok)throw Error('無法載入 seed_prices.json。直接雙擊 HTML 時請改以本機 HTTP server 或 GitHub Pages 開啟。');return cleanPrices(await res.json());}
async function readLocal(){const p=await readSeed();try{for(const row of JSON.parse(localStorage.getItem(PRICE_KEY)||'[]')){for(const sym of ['MSTR','MSTU'])addBar(p,sym,[row.date,Number(row[sym+'_open']),Number(row[sym+'_close'])]);}}catch(e){console.warn(e);alertUser('本機新增資料無法載入：'+e.message,true);}return p;}
function saveLocal(date,m,u){const list=JSON.parse(localStorage.getItem(PRICE_KEY)||'[]'),r={date,MSTR_open:m[1],MSTR_close:m[2],MSTU_open:u[1],MSTU_close:u[2]};const k=list.findIndex(x=>x.date===date);if(k>=0)list[k]=r;else list.push(r);localStorage.setItem(PRICE_KEY,JSON.stringify(list));}
async function readCloud(){const p={MSTR:[],MSTU:[]};for(const sym of ['MSTR','MSTU']){let i=0;for(;;){const {data,error}=await db.from('market_daily_prices').select('trade_date,open,close').eq('user_id',user.id).eq('symbol',sym).order('trade_date',{ascending:true}).range(i,i+799);if(error)throw error;for(const r of data)p[sym].push([r.trade_date,Number(r.open),Number(r.close)]);if(data.length<800)break;i+=800;}}return p;}
async function loadCloudParams(){const {data,error}=await db.from('strategy_settings').select('params').eq('user_id',user.id).maybeSingle();if(error)throw error;params=data?allowedParams(data.params):{...E.DEFAULTS};}
async function reloadCloud(){prices=await readCloud();await loadCloudParams();if(validData())render();else{$('modelTarget').textContent='等待首次匯入行情';badge('需要初始化');}showAccess();}
async function initCloud(){if(!user)return;try{busy(true);const p=await readSeed();const existing=await readCloud();const seen=new Set();for(const s of ['MSTR','MSTU'])for(const r of existing[s])seen.add(s+'|'+r[0]);
 const rows=[];for(const s of ['MSTR','MSTU'])for(const r of p[s])if(!seen.has(s+'|'+r[0]))rows.push({user_id:user.id,symbol:s,trade_date:r[0],open:r[1],close:r[2]});
 // SAFETY: append missing historical rows only. Never overwrite any existing cloud prices.
 for(let i=0;i<rows.length;i+=200){const {error}=await db.from('market_daily_prices').upsert(rows.slice(i,i+200),{onConflict:'user_id,symbol,trade_date'});if(error)throw error;badge(`匯入 ${Math.min(i+200,rows.length)} / ${rows.length}`);}
 await reloadCloud();alertUser(rows.length?'已補齊 '+rows.length+' 筆歷史資料，原有雲端價格未被覆蓋。':'所有歷史資料都已存在，沒有重複覆蓋。');
 }catch(e){alertUser('初始化失敗：'+e.message,true);}finally{busy(false);}}
async function login(isNew){const email=$('email').value.trim(),password=$('password').value;if(!email||password.length<6)return alertUser('請提供 Email 與至少 6 碼密碼',true);try{busy(true);const {data,error}=isNew?await db.auth.signUp({email,password}):await db.auth.signInWithPassword({email,password});if(error)throw error;
 if(isNew&&!data.session){alertUser('註冊成功，請先到信箱完成驗證，再回網站登入。');return;}
 user=data.user;await reloadCloud();alertUser('登入成功。');}catch(e){alertUser('登入失敗：'+e.message,true);}finally{busy(false);}}
async function saveParams(e){e.preventDefault();let next;try{next=allowedParams({mstr:$('paramMstr').value,mstu:$('paramMstu').value,long:$('paramLong').value,slope:$('paramSlope').value});}catch(ex){return alertUser(ex.message,true);}
 try{busy(true);if(mode==='cloud'){
   if(!user)throw Error('請先登入 Supabase');const {error}=await db.from('strategy_settings').upsert({user_id:user.id,params:{mstr:next.mstr,mstu:next.mstu,long:next.long,slope:next.slope}},{onConflict:'user_id'});if(error)throw error;
  }else localStorage.setItem(PARAM_KEY,JSON.stringify({mstr:next.mstr,mstu:next.mstu,long:next.long,slope:next.slope}));
  params=next;render();alertUser('策略參數已套用。新的每日訊號與三段回測已同步重算。');
 }catch(ex){alertUser('保存參數失敗：'+ex.message,true);}finally{busy(false);}}
async function savePrice(ev){ev.preventDefault();if(!prices)return alertUser('請先匯入行情',true);
 const date=$('updateDate').value,m=[date,Number($('mstrOpen').value),Number($('mstrClose').value)],u=[date,Number($('mstuOpen').value),Number($('mstuClose').value)];
 if(!checkBar(m)||!checkBar(u))return alertUser('請輸入四個有效的正式美股價格',true);
 if([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay()))return alertUser('週末非美股正常交易日',true);
 const last=prices.MSTR.at(-1)[0];if(date<last)return alertUser('為避免損壞 SMA，目前只能更新最後一天或新增更晚的交易日',true);
 if(date===last&&!confirm(`確定更正 ${date} 最後一筆正式價格嗎？`))return;
 if(date>last){let missing=[];for(let d=new Date(last+'T12:00:00Z'),stop=new Date(date+'T12:00:00Z');(d.setUTCDate(d.getUTCDate()+1),d<stop);){if(![0,6].includes(d.getUTCDay()))missing.push(d.toISOString().slice(0,10));}
  if(missing.length&&!confirm('中間有 '+missing.length+' 個平日尚無資料（可能是休市，也可能漏填）：'+missing.slice(0,8).join('、')+'。如果漏掉交易日會造成 SMA 不正確。仍要繼續？'))return;
  if(!confirm('請確認 '+date+' 的美股正常交易時段已結束，四個數字都是正式日線？'))return;}
 const gap=Math.max(Math.abs(m[1]/prices.MSTR.at(-1)[2]-1),Math.abs(u[1]/prices.MSTU.at(-1)[2]-1));if(gap>.5&&!confirm('新價格相對前一日超過 50%！如果發生拆股，必須先重新統一復權尺度。仍要儲存？'))return;
 try{busy(true);if(mode==='cloud'){
  const {error}=await db.from('market_daily_prices').upsert([{user_id:user.id,symbol:'MSTR',trade_date:date,open:m[1],close:m[2]},{user_id:user.id,symbol:'MSTU',trade_date:date,open:u[1],close:u[2]}],{onConflict:'user_id,symbol,trade_date'});if(error)throw error;prices=await readCloud();
  }else{saveLocal(date,m,u);addBar(prices,'MSTR',m);addBar(prices,'MSTU',u);}
  $('updateForm').reset();render();alertUser('已儲存 '+date+'；均線、訊號與三段回測均已更新。');
 }catch(ex){alertUser('儲存價格失敗：'+ex.message,true);}finally{busy(false);}}
function showAccess(){$('authArea').hidden=!(hasCloud&&!user);$('signoutBtn').hidden=!(hasCloud&&user);$('cloudReload').hidden=!(hasCloud&&user);$('seedBtn').hidden=!(hasCloud&&user&&!validData());
 $('connectionText').textContent=!hasCloud?'目前尚未設定 Supabase；只使用瀏覽器本機示範資料，跨裝置不會同步。':user?'已登入 '+user.email+'。market_daily_prices 與 strategy_settings 皆受 RLS 保護。':'請先註冊／登入，再第一次匯入歷史行情。';
 $('setupHint').textContent=hasCloud?'資料庫建表 SQL 及 GitHub Pages 操作詳見 README。登入後請確認頂部顯示雲端同步。':'GitHub Pages 與 Supabase 連線需要在 config.js 填寫 URL 與 publishable key。';}
async function boot(){
 document.querySelectorAll('.page-tabs button').forEach(btn=>btn.addEventListener('click',()=>{for(const x of document.querySelectorAll('.view-page'))x.hidden=x.id!==btn.dataset.target;for(const b of document.querySelectorAll('.page-tabs button'))b.classList.toggle('tab-active',b===btn);if(rows&&btn.dataset.target==='studyPage')for(const [key,v] of Object.entries(results))paint($(key+'Chart'),v.curve,v.buyhold);}));
 $('settingsToggle').onclick=()=>{$('connectionPanel').hidden=!$('connectionPanel').hidden;showAccess()};$('hideSettings').onclick=()=>{$('connectionPanel').hidden=true};
 $('loginBtn').onclick=()=>login(false);$('signupBtn').onclick=()=>login(true);$('seedBtn').onclick=initCloud;
 $('cloudReload').onclick=async()=>{try{await reloadCloud();alertUser('雲端資料已更新')}catch(e){alertUser(e.message,true)}};
 $('signoutBtn').onclick=async()=>{await db.auth.signOut();user=null;prices=null;badge('請登入');$('modelTarget').textContent='請登入';showAccess();};
 $('updateForm').addEventListener('submit',savePrice);$('paramForm').addEventListener('submit',saveParams);
 $('resetParamsBtn').onclick=()=>{for(const [k,id] of [['mstr','paramMstr'],['mstu','paramMstu'],['long','paramLong'],['slope','paramSlope']])$(id).value=E.DEFAULTS[k];alertUser('已填入預設值。按「套用並同步設定」後才會生效。');};
 $('testPriceBtn').onclick=quick;$('scanBtn').onclick=scan;$('scanLimit').onchange=applyScanFilter;
 window.addEventListener('resize',()=>{if(rows&&Object.keys(results).length)for(const key of Object.keys(results))paint($(key+'Chart'),results[key].curve,results[key].buyhold);});
 try{if(hasCloud){if(!window.supabase?.createClient)throw Error('Supabase CDN 載入失敗，檢查網路連線');db=window.supabase.createClient(CFG.url,CFG.publishableKey);
  const {data}=await db.auth.getUser();user=data?.user||null;
  if(user)await reloadCloud();else{badge('等待登入');$('modelTarget').textContent='請登入 Supabase';$('connectionPanel').hidden=false;}
 }else{mode='local';try{const s=JSON.parse(localStorage.getItem(PARAM_KEY)||'null');if(s)params=allowedParams(s);}catch(e){console.warn('Invalid local settings',e)}prices=await readLocal();render();}
 }catch(e){badge('載入失敗');$('connectionPanel').hidden=false;alertUser('初始化失敗：'+e.message,true);console.error(e);}showAccess();
}
boot();
})();
