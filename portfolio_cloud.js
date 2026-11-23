/* MSTR / MSTU / CASH portfolio + Supabase. No brokerage access and no automated orders. */
'use strict';
(() => {
  const bridge = window.StrategyBridge;
  if (!bridge) { console.error('原策略引擎尚未載入'); return; }
  const $ = id => document.getElementById(id);
  const STORAGE_PORTFOLIO = 'mstr_mstu_portfolio_v1';
  const STORAGE_CONFIG = 'mstr_mstu_supabase_public_config_v1';
  const DOCS = { legacy:'legacy_v1', portfolio:'portfolio_v1' };
  const stable = obj => JSON.stringify(obj, (_,value)=> value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().reduce((o,k)=>(o[k]=value[k],o),{}):value);
  const clean = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (n, digits=2) => Number(n).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits});
  const numeric = (v, label, allowZero=true) => { const n=Number(v);if(v===''||!Number.isFinite(n)||n<0||(!allowZero&&n<=0))throw Error(label+' 必須是'+(allowZero?'非負':'正')+'數');return n; };
  const dateRE = /^\d{4}-\d{2}-\d{2}$/;
  const isoDay = d => new Date(d).toLocaleDateString('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'});
  const localDay = () => {const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')};
  const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'local_'+Date.now()+'_'+Math.random().toString(36).slice(2));
  const blank = () => ({version:1,start:null,events:[]});
  let pf; try{pf=Object.assign(blank(),JSON.parse(localStorage.getItem(STORAGE_PORTFOLIO)||'{}'))}catch(_){pf=blank()}
  if(!Array.isArray(pf.events))pf.events=[];
  let cloudClient=null, cloudUser=null, cloudRevisions={legacy:null,portfolio:null}, cloudDirty={legacy:false,portfolio:false}, changeCount={legacy:0,portfolio:0}, suppress=false, cloudReady=false, cloudBusy=false, cloudSaveTimer=null;
  const cloudStatus=(msg,kind='')=>{const el=$('sbStatus');el.textContent=msg;el.className='note mt '+kind;};
  const savePf = () => {localStorage.setItem(STORAGE_PORTFOLIO,JSON.stringify(pf)); if(!suppress) changed('portfolio');renderPf();};
  const money = v => '$'+fmt(v);
  const asDate = event => event.date || event.at.slice(0,10);
  const sortedEvents = p => [...p.events].sort((a,b)=> (a.at||a.date).localeCompare(b.at||b.date) || (a.kind==='MARK'?1:0)-(b.kind==='MARK'?1:0) || String(a.id).localeCompare(String(b.id)));
  function replay(data){
    if(!data.start)return null;
    const s=data.start;
    let cash=s.cash, mq=s.mstrQty, uq=s.mstuQty, mp=s.mstrPrice||0, up=s.mstuPrice||0;
    let nav0=cash+mq*mp+uq*up;
    if(!(nav0>0))throw Error('起始資產必須大於 0');
    let fundShares=nav0, nav=nav0, rows=[{date:s.date,index:10000,nav:nav0,kind:'START'}], lastDate=s.date;
    for(const ev of sortedEvents(data)){
      if(asDate(ev)<s.date)throw Error('紀錄日期早於追蹤起點');
      let before=cash+mq*mp+uq*up;
      if(ev.kind==='MARK'){
        if(ev.mstr>0)mp=ev.mstr;
        if(ev.mstu>0)up=ev.mstu;
        if(mq>0&&!(mp>0)||uq>0&&!(up>0))throw Error('估值價格不足');
      }else if(ev.kind==='TRADE'){
        const q=ev.qty, price=ev.price, fee=ev.fee||0;
        if(!(q>0&&price>0&&fee>=0))throw Error('成交紀錄含錯誤數值');
        if(ev.symbol==='MSTR')mp=price;else if(ev.symbol==='MSTU')up=price;else throw Error('標的必須為 MSTR 或 MSTU');
        if(ev.side==='BUY'){
          const total=q*price+fee;
          if(total>cash+0.000001)throw Error('買進金額超出現金：'+asDate(ev));
          cash-=total;if(ev.symbol==='MSTR')mq+=q;else uq+=q;
        }else if(ev.side==='SELL'){
          if(ev.symbol==='MSTR') {if(q>mq+1e-9)throw Error('賣出 MSTR 數量超過持倉：'+asDate(ev));mq-=q}
          else {if(q>uq+1e-9)throw Error('賣出 MSTU 數量超過持倉：'+asDate(ev));uq-=q}
          cash+=q*price-fee;
          if(cash< -1e-8)throw Error('費用超出現金');
        }else throw Error('未知成交方向');
      }else if(ev.kind==='FLOW'){
        const amount=ev.amount;
        if(!(amount>0))throw Error('出入金金額必須為正');
        if(!(before>0))throw Error('出入金之前資產不可為 0');
        if(ev.side==='DEPOSIT'){fundShares+=amount*fundShares/before;cash+=amount}
        else if(ev.side==='WITHDRAW'){
          if(amount>cash+1e-8||amount>=before-1e-8)throw Error('出金超出可用現金或將資產清空：'+asDate(ev));
          fundShares-=amount*fundShares/before;cash-=amount;
        }else throw Error('未知出入金方向');
      }else throw Error('未知紀錄類型');
      if(cash< -1e-8||mq< -1e-8||uq< -1e-8||fundShares<=0)throw Error('帳務餘額異常：'+asDate(ev));
      nav=cash+mq*mp+uq*up;
      if(nav<0)throw Error('資產淨值為負');
      lastDate=asDate(ev);
      // Only mark-to-market records are plotted, to avoid showing a stale price as a new daily quote.
      if(ev.kind==='MARK')rows.push({date:lastDate,index:nav/fundShares*10000,nav,kind:'MARK'});
    }
    return{cash,mq,uq,mp,up,nav,nav0,normalized:nav/fundShares*10000,fundShares,rows,lastDate,marks:rows.filter(r=>r.kind==='MARK')};
  }
  function emitError(err){$('pfTradeMsg').textContent=String(err.message||err); $('pfTradeMsg').style.color='#bb3f48';}
  function addRecord(ev){const next=structuredClone(pf);next.events.push(ev);replay(next);pf=next;savePf();$('pfTradeMsg').textContent='已保存本機並準備雲端同步；並不代表交易已在幣安成交';$('pfTradeMsg').style.color='#147d57';}
  $('pfStart').value=localDay();$('pfMarkDate').value=localDay();$('pfTime').value=localDay()+'T21:30';
  function renderPf(){
    const active=!!pf.start; $('pfStatus').textContent=active?'追蹤自 '+pf.start.date:'尚未建立';
    if(!active){$('pfNav').textContent='—';$('pfIndex').textContent='—';$('pfPositions').textContent='—';$('pfUnits').textContent='請先設定起始資產';$('pfComparison').innerHTML='<p class="hint">請先設定起點</p>';$('pfLedger').innerHTML='<p class="hint">尚無流水</p>';return}
    try{
      const p=replay(pf);
      $('pfNav').textContent=money(p.nav);$('pfIndex').textContent=money(p.normalized);
      const profit=p.normalized/10000-1;
      $('pfReturn').textContent='標準化累積報酬 '+(profit>=0?'+':'')+(profit*100).toFixed(2)+'%；出入金已中性化';
      $('pfPositions').textContent='現金 '+money(p.cash);
      $('pfUnits').textContent='MSTR '+fmt(p.mq,6)+' 單位 · MSTU '+fmt(p.uq,6)+' 單位';
      $('pfMarkAt').textContent=p.marks.length?'最新估值 '+p.marks.at(-1).date:'目前使用初始及成交價估值；尚未補記每日報價';
      renderLedger();renderCompare(p);
    }catch(e){$('pfIndex').textContent='帳務錯誤';$('pfReturn').textContent=e.message}
  }
  function renderLedger(){
    const events=sortedEvents(pf).reverse().slice(0,80);
    $('pfLedger').innerHTML=events.length?'<table><thead><tr><th>日期</th><th>類型</th><th>內容</th><th>費用</th></tr></thead><tbody>'+events.map(e=>'<tr><td>'+clean(asDate(e))+'</td><td>'+clean(e.kind)+'</td><td>'+(e.kind==='MARK'?'MSTR $'+fmt(e.mstr)+' ／ MSTU $'+fmt(e.mstu):e.kind==='TRADE'?clean(e.side+' '+e.symbol)+' '+fmt(e.qty,6)+' × $'+fmt(e.price,4):clean(e.side)+' $'+fmt(e.amount))+'</td><td>'+(e.fee?'$'+fmt(e.fee):'—')+'</td></tr>').join('')+'</tbody></table>':'<p class="hint">尚無成交、出入金或估值紀錄</p>';
  }
  $('pfKind').addEventListener('change',()=>{
    const flow=['DEPOSIT','WITHDRAW'].includes($('pfKind').value);
    for(let id of ['pfSymbolWrap','pfQtyWrap','pfPriceWrap'])$(id).style.display=flow?'none':'';
    $('pfAmountWrap').style.display=flow?'':'none';
  });
  $('pfCreate').onclick=()=>{
    try{
      if(pf.start)throw Error('目前已有追蹤起點；若需要重設，請先另存備份並按「重新建立起點」');
      const date=$('pfStart').value;if(!dateRE.test(date))throw Error('日期不正確');
      const cash=numeric($('pfCash').value,'現金'),mstrQty=numeric($('pfMstrQty').value,'MSTR 數量'),mstuQty=numeric($('pfMstuQty').value,'MSTU 數量');
      const mstrPrice=mstrQty>0?numeric($('pfMstrPrice').value,'MSTR 起始報價',false):Number($('pfMstrPrice').value)||0;
      const mstuPrice=mstuQty>0?numeric($('pfMstuPrice').value,'MSTU 起始報價',false):Number($('pfMstuPrice').value)||0;
      const data={version:1,start:{date,cash,mstrQty,mstuQty,mstrPrice,mstuPrice,label:$('pfLabel').value.trim()},events:[]};
      replay(data);pf=data;savePf();$('pfTradeMsg').textContent='起點已建立，開始記錄實際成交與每日估值';
    }catch(e){emitError(e)}
  };
  $('pfReset').onclick=()=>{
    if(!pf.start)return;
    if(!confirm('這會刪除本裝置的追蹤起點及全部實盤流水，並在同步時更新雲端。請先備份。確定？'))return;
    pf=blank();savePf();$('pfTradeMsg').textContent='已重設追蹤起點';
  };
  $('pfAddEvent').onclick=()=>{
    try{
      if(!pf.start)throw Error('請先設定起始資產');
      const t=$('pfTime').value;if(!t||!Number.isFinite(new Date(t).getTime()))throw Error('請輸入有效成交時間');
      const at=new Date(t).toISOString(),date=t.slice(0,10),kind=$('pfKind').value;
      let event={id:uid(),at,date};
      if(kind==='BUY'||kind==='SELL'){
        event={...event,kind:'TRADE',symbol:$('pfSymbol').value,side:kind,qty:numeric($('pfQty').value,'數量',false),price:numeric($('pfPrice').value,'實際成交價',false),fee:numeric($('pfFee').value,'費用')};
      }else{
        event={...event,kind:'FLOW',side:kind,amount:numeric($('pfAmount').value,'金額',false)};
      }
      addRecord(event);
    }catch(e){emitError(e)}
  };
  $('pfSaveMark').onclick=()=>{
    try{
      if(!pf.start)throw Error('請先設定起始資產');
      const date=$('pfMarkDate').value;if(!dateRE.test(date))throw Error('請輸入有效估值日期');
      const mstr=numeric($('pfMarkMstr').value,'MSTR 報價',false),mstu=numeric($('pfMarkMstu').value,'MSTU 報價',false);
      addRecord({id:uid(),date,at:date+'T23:59:00+08:00',kind:'MARK',mstr,mstu});
    }catch(e){emitError(e)}
  };
  $('pfExport').onclick=()=>{
    const blob=new Blob([JSON.stringify({schema:3,exportedAt:new Date().toISOString(),legacy:bridge.getLegacy(),portfolio:pf},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='MSTR_MSTU_完整私人備份_'+localDay()+'.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1200);
  };
  $('pfImport').onchange=async e=>{
    try{
      const file=e.target.files[0];if(!file)return;
      const incoming=JSON.parse(await file.text());
      if(incoming.schema!==3||!incoming.portfolio||!Array.isArray(incoming.portfolio.events)||!incoming.legacy||!Array.isArray(incoming.legacy.rows))throw Error('僅接受新版完整備份（schema 3），請勿直接匯入舊版 JSON');
      replay(incoming.portfolio);
      if(!confirm('這會同時覆蓋本機的正式行情更新及真實投資流水，並嘗試同步到雲端。確定匯入？'))return;
      bridge.replaceLegacy(incoming.legacy);pf=incoming.portfolio;savePf();
      $('pfTradeMsg').textContent='完整備份已匯入，請檢查「雲端同步」頁是否成功';
    }catch(err){emitError(err)}finally{e.target.value=''}
  };
  $('pfUndo').onclick=()=>{
    if(!pf.events.length)return;
    const latest=sortedEvents(pf).at(-1);
    if(!confirm('確定刪除 '+asDate(latest)+' 的最後一筆「'+latest.kind+'」紀錄？'))return;
    pf.events=pf.events.filter(e=>e.id!==latest.id);savePf();
  };
  function paperSeries(start){
    const rows=bridge.getRows();
    if(!rows.length)return null;
    const i0=rows.findIndex(r=>r.date>=start);
    if(i0<0)return null;
    const cfg=bridge.getConfig(),calc=bridge.getSignals(),cost=cfg.cost;
    const models=[{key:'buy',label:'單純持有 MSTR',pct:-1,color:'#db9541'},
      {key:'mstuBuy',label:'單純持有 MSTU',pct:-2,color:'#be647f'},
      {key:'0',label:'SMA22 / CASH（0% MSTU）',pct:0,color:'#299a84'},
      {key:'40',label:'三段輪動 40% MSTU',pct:.4,color:'#786abf'},
      {key:'60',label:'三段輪動 60% MSTU',pct:.6,color:'#a17529'},
      {key:'100',label:'三段輪動 100% MSTU',pct:1,color:'#295bd9'}];
    const output=[];
    for(const model of models){
      if(model.pct===-2 && rows[i0].date<'2024-09-18')continue;
      let cash=0,mShares=10000/rows[i0].mc,uShares=0,mode='MSTR',curve=[{date:rows[i0].date,y:10000}],peak=10000,mdd=0,trades=0;
      if(model.pct===-2){mShares=0;uShares=10000/rows[i0].uc;mode='MSTU'}
      for(let i=i0+1;i<rows.length;i++){
        const r=rows[i];
        if(model.pct>=0){
          const target=calc.out[i].target==='CASH'?'CASH':calc.out[i].target==='MSTU'? (model.pct===0?'MSTR':model.pct===1?'MSTU':'MIX'):'MSTR';
          // Only rebalance upon a state change, just like the original research model.
          if(target!==mode){
            const gross=cash+mShares*r.mo+uShares*r.uo;
            const frac=target==='CASH'?[0,0]:target==='MSTR'?[1,0]:target==='MSTU'?[0,1]:[1-model.pct,model.pct];
            const sell=Math.max(0,mShares*r.mo-frac[0]*gross)+Math.max(0,uShares*r.uo-frac[1]*gross);
            const buy=Math.max(0,frac[0]*gross-mShares*r.mo)+Math.max(0,frac[1]*gross-uShares*r.uo);
            const turnover=Math.max(sell,buy)/gross;
            const net=gross*(1-cost*turnover);
            cash=net*(1-frac[0]-frac[1]);mShares=net*frac[0]/r.mo;uShares=net*frac[1]/r.uo;
            mode=target;trades++;
          }
        }
        const nav=cash+mShares*r.mc+uShares*r.uc;
        peak=Math.max(peak,nav);mdd=Math.min(mdd,nav/peak-1);curve.push({date:r.date,y:nav});
      }
      output.push({...model,curve,last:curve.at(-1),mdd:mdd*100,trades});
    }
    return output;
  }
  let lastPaper=null;
  function renderCompare(actual){
    const ps=paperSeries(pf.start.date),rows=bridge.getRows();
    const ac=actual.rows,modelMap=ps||[];lastPaper=ps;
    const endActual=actual.marks.at(-1)||ac[0];
    let table='<table><thead><tr><th>組合</th><th>比較值（起始 $10,000）</th><th>資料截至</th><th>歷史最大回撤</th></tr></thead><tbody>';
    table+='<tr><td><strong>我的真實幣安實盤</strong></td><td>'+money(endActual.index)+'</td><td>'+clean(endActual.date)+(actual.marks.length?'':'（只有起始點）')+'</td><td>估值點不足時不可判斷</td></tr>';
    for(const s of modelMap){const comparable=s.curve.filter(r=>r.date<=endActual.date);const p=comparable.length?comparable.at(-1):null;
      table+='<tr><td>'+clean(s.label)+'</td><td>'+(p?money(p.y):'尚無已完成美股日線')+'</td><td>'+(p?p.date:'—')+'</td><td>'+s.mdd.toFixed(1)+'%（至最新歷史日）</td></tr>';
    }
    table+='</tbody></table>';$('pfComparison').innerHTML=table;
    $('pfLegend').innerHTML='<span><i class="dot" style="background:#111827"></i>真實幣安資產（手動估值）</span>'+modelMap.map(s=>'<span><i class="dot" style="background:'+s.color+'"></i>'+clean(s.label)+'</span>').join('');
    // Chart draws each independent series on the same calendar date scale; never interpolates actual marks.
    requestAnimationFrame(()=>paintPf([{color:'#111827',data:ac,width:3,markers:true},...modelMap.map(s=>({color:s.color,data:s.curve,width:1.7}))]));
  }
  function paintPf(series){
    const c=$('pfChart'); if(!c)return;const width=c.getBoundingClientRect().width,height=c.getBoundingClientRect().height;if(width<100||height<100)return;
    const ctx=c.getContext('2d'),dpr=window.devicePixelRatio||1;c.width=width*dpr;c.height=height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
    const all=series.flatMap(s=>s.data||[]).filter(p=>p.y>0&&/^\d{4}-\d{2}-\d{2}$/.test(p.date));if(!all.length)return;
    const day=x=>Date.parse(x+'T12:00:00Z'),xmin=Math.min(...all.map(p=>day(p.date))),xmax=Math.max(...all.map(p=>day(p.date))),vmin=Math.min(...all.map(p=>p.y)),vmax=Math.max(...all.map(p=>p.y));
    const p={left:66,right:12,top:12,bottom:35};const logMin=Math.floor(Math.log10(Math.max(.01,vmin))*2)/2,logMax=Math.max(logMin+.5,Math.ceil(Math.log10(vmax)*2)/2);
    const xx=d=>p.left+(width-p.left-p.right)*(day(d)-xmin)/(xmax-xmin||1),yy=v=>p.top+(height-p.top-p.bottom)*(logMax-Math.log10(Math.max(.01,v)))/(logMax-logMin);
    ctx.font='11px system-ui';ctx.fillStyle='#68768b';ctx.lineWidth=.75;
    for(let j=0;j<=5;j++){let v=Math.pow(10,logMin+(logMax-logMin)*j/5),y=yy(v);ctx.strokeStyle='#e0e7f1';ctx.beginPath();ctx.moveTo(p.left,y);ctx.lineTo(width-p.right,y);ctx.stroke();ctx.fillText(v>=1000?'$'+(v/1000).toFixed(1)+'k':'$'+Math.round(v),5,y+3)}
    for(let j=0;j<=4;j++){let d=new Date(xmin+(xmax-xmin)*j/4).toISOString().slice(0,7);ctx.fillText(d,p.left+(width-p.left-p.right)*j/4-21,height-9)}
    for(const s of series){if(!s.data.length)continue;ctx.strokeStyle=s.color;ctx.fillStyle=s.color;ctx.lineWidth=s.width||2;ctx.beginPath();s.data.forEach((a,i)=>{const x=xx(a.date),y=yy(a.y);if(!i)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke();if(s.markers){for(const a of s.data){ctx.beginPath();ctx.arc(xx(a.date),yy(a.y),3.3,0,Math.PI*2);ctx.fill()}}}
  }
  window.addEventListener('resize',()=>{if(pf.start)renderPf()});
  document.querySelector('[data-page="portfolio"]').addEventListener('click',()=>{if(pf.start)requestAnimationFrame(renderPf)});
  // Cloud service: only the publishable key is used in the public browser.
  function configLoad(){try{return JSON.parse(localStorage.getItem(STORAGE_CONFIG)||'{}')}catch(_){return {}}}
  const c=Object.assign({},window.SUPABASE_CONFIG||{},configLoad());
  $('sbUrl').value=c.url||'';$('sbKey').value=c.publishableKey||'';
  function validSettings(url,key){
    if(!/^https:\/\/[A-Za-z0-9-]+\.supabase\.co\/?$/.test(url))throw Error('請填入有效的 https://*.supabase.co 專案 URL');
    if(!key||key.length<20||/service_role|sb_secret_/i.test(key))throw Error('只能使用 Supabase publishable／anon 公開金鑰，不得使用秘密金鑰');
  }
  async function connect(){
    const url=$('sbUrl').value.trim().replace(/\/$/,''),key=$('sbKey').value.trim();
    try{
      validSettings(url,key);
      if(!window.supabase||!window.supabase.createClient)throw Error('Supabase JS 套件尚未載入。請檢查網路或 CDN 是否被封鎖');
      if(cloudClient){if(!confirm('重新連線會重建登入狀態，確定？'))return}
      cloudClient=window.supabase.createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
      localStorage.setItem(STORAGE_CONFIG,JSON.stringify({url,publishableKey:key}));
      cloudClient.auth.onAuthStateChange((event,session)=>{
        cloudUser=session?.user||null;
        if(!cloudUser){cloudReady=false;cloudStatus('未登入。資料目前仍保存在這台裝置','warn');return}
        cloudStatus('已登入 '+cloudUser.email+'，正在確認雲端文件版本…');
        if(event==='SIGNED_IN'||event==='INITIAL_SESSION')setTimeout(()=>initialSync(),100);
      });
      const {data,error}=await cloudClient.auth.getSession();if(error)throw error;
      cloudUser=data.session?.user||null;
      if(cloudUser)await initialSync();else cloudStatus('已建立 Supabase 連線。請使用電子郵件登入');
    }catch(e){cloudStatus('連線失敗：'+e.message,'danger')}
  }
  $('sbConnect').onclick=connect;
  $('sbLogin').onclick=async()=>{
    try{
      if(!cloudClient)throw Error('請先點「使用此設定連線」');
      const email=$('sbEmail').value.trim();if(!/^\S+@\S+\.\S+$/.test(email))throw Error('請輸入有效 email');
      if(location.protocol!=='https:'&&location.hostname!=='localhost')throw Error('請先用 GitHub Pages HTTPS 網址開啟網站，再使用 Email 登入');
      const {error}=await cloudClient.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});
      if(error)throw error;
      cloudStatus('登入連結已寄出（實際是否寄達請查看信箱）。點信件後回到這個網站即可同步。');
    }catch(e){cloudStatus('寄送登入信失敗：'+e.message,'danger')}
  };
  $('sbLogout').onclick=async()=>{if(cloudClient){const {error}=await cloudClient.auth.signOut();if(error)cloudStatus(error.message,'danger');cloudUser=null;cloudReady=false;cloudRevisions={legacy:null,portfolio:null};cloudStatus('已登出；本機資料仍保留。請勿在共用裝置保存個人紀錄。')}};
  function changed(which){cloudDirty[which]=true;changeCount[which]++;if(!cloudUser||!cloudReady||suppress)return;clearTimeout(cloudSaveTimer);cloudSaveTimer=setTimeout(()=>flushDirty(),1100)}
  window.addEventListener('strategy:legacy-change',()=>{if(!suppress)changed('legacy')});
  const currentDoc = which => which==='legacy'?bridge.getLegacy():pf;
  async function fetchDoc(which){
    const {data,error}=await cloudClient.from('user_documents').select('payload,revision,updated_at').eq('user_id',cloudUser.id).eq('doc_key',DOCS[which]).maybeSingle();
    if(error)throw error;return data;
  }
  async function writeDoc(which){
    if(!cloudUser||!cloudClient)return;
    const revision=cloudRevisions[which],payload=JSON.parse(JSON.stringify(currentDoc(which))),generation=changeCount[which];
    if(revision===null){
      const {data,error}=await cloudClient.from('user_documents').insert({user_id:cloudUser.id,doc_key:DOCS[which],payload,revision:1}).select('revision').single();
      if(error)throw Error('首次寫入失敗，可能已有其他裝置建立資料：'+error.message);
      cloudRevisions[which]=data.revision;
    }else{
      const {data,error}=await cloudClient.from('user_documents').update({payload,revision:revision+1,updated_at:new Date().toISOString()}).eq('user_id',cloudUser.id).eq('doc_key',DOCS[which]).eq('revision',revision).select('revision').maybeSingle();
      if(error)throw error;
      if(!data)throw Error('雲端版本衝突：其他裝置已修改資料。本機仍保留，請先備份並重新讀取雲端；系統不會自動覆寫。');
      cloudRevisions[which]=data.revision;
    }
    if(changeCount[which]===generation)cloudDirty[which]=false;
  }
  async function flushDirty(){
    if(cloudBusy||!cloudUser||!cloudReady)return;
    cloudBusy=true;try{
      for(const which of ['legacy','portfolio'])if(cloudDirty[which])await writeDoc(which);
      cloudStatus('雲端已同步 · '+new Date().toLocaleTimeString('zh-TW')+' · '+cloudUser.email);
    }catch(e){cloudStatus('同步未完成：'+e.message,'danger')}finally{cloudBusy=false;if(cloudReady&&cloudUser&&(cloudDirty.legacy||cloudDirty.portfolio))setTimeout(()=>flushDirty(),2500)}
  }
  async function initialSync(forceReload=false){
    if(!cloudUser||cloudBusy)return;
    cloudBusy=true;cloudReady=false;clearTimeout(cloudSaveTimer);
    try{
      for(const which of ['legacy','portfolio']){
        const remote=await fetchDoc(which);
        if(remote){
          cloudRevisions[which]=remote.revision;
          const local=currentDoc(which),localHas=which==='legacy'?(local.rows?.length||local.trades?.length||local.opens&&Object.keys(local.opens).length):!!local.start;
          const diff=stable(local)!==stable(remote.payload);
          if(localHas&&diff&&!forceReload){
            const takeCloud=confirm('「'+(which==='legacy'?'正式行情／原交易紀錄':'真實資產追蹤')+'」雲端與此裝置不一樣。\n\n確定＝先在本機留副本，再讀取雲端版本；取消＝本機保留，請手動檢查後再同步。');
            if(!takeCloud){cloudDirty[which]=true;continue}
          }
          if(diff){
            localStorage.setItem('strategy_before_cloud_'+which+'_'+Date.now(),JSON.stringify(local));
            suppress=true;
            try{if(which==='legacy')bridge.replaceLegacy(remote.payload);else{if(!remote.payload||!Array.isArray(remote.payload.events))throw Error('雲端資產文件格式錯誤');pf=remote.payload;localStorage.setItem(STORAGE_PORTFOLIO,JSON.stringify(pf));renderPf()}}
            finally{suppress=false}
          }
          cloudDirty[which]=false;
        }else{
          cloudRevisions[which]=null;cloudDirty[which]=true;
        }
      }
      cloudReady=true;
      // Do not overwrite an existing remote document when the user deliberately declined its replacement.
      for(const which of ['legacy','portfolio'])if(cloudRevisions[which]===null)await writeDoc(which);
      cloudStatus('雲端已連線 · '+cloudUser.email+' · 兩份文件完成初始化。');
    }catch(e){cloudStatus('讀取雲端失敗：'+e.message,'danger')}
    finally{cloudBusy=false}
  }
  $('sbPull').onclick=async()=>{
    if(!cloudUser)return cloudStatus('尚未登入，無法讀取雲端','warn');
    if(!confirm('重新載入雲端會取代此裝置尚未同步的修改，請先備份。確定要讀取雲端？'))return;
    await initialSync(true);
  };
  $('sbPush').onclick=async()=>{
    if(!cloudUser)return cloudStatus('尚未登入，無法上傳','warn');
    if(!cloudReady)return cloudStatus('尚未完成版本核對，請先重新讀取雲端','warn');
    if(!confirm('要以本機兩份文件的內容寫入雲端嗎？這會修改你其他裝置之後讀到的資料。請先備份。'))return;
    cloudDirty.legacy=true;cloudDirty.portfolio=true;await flushDirty();
  };
  window.addEventListener('focus',async()=>{
    if(!cloudReady||!cloudUser||cloudBusy||cloudDirty.legacy||cloudDirty.portfolio)return;
    try{
      let newer=false;
      for(const k of ['legacy','portfolio']){const d=await fetchDoc(k);if(d&&d.revision!==cloudRevisions[k])newer=true}
      if(newer)await initialSync(true);
    }catch(e){cloudStatus('無法檢查其他裝置的更新：'+e.message,'warn')}
  });
  // Public diagnostics useful when validating with test harnesses.
  window.PortfolioTools={replay, paperSeries, getPortfolio:()=>structuredClone(pf)};
  renderPf();
  if(c.url&&c.publishableKey){setTimeout(()=>connect(),250)}
})();
