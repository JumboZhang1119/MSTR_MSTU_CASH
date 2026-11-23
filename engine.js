/* MSTR / MSTU / CASH engine v6. Official adjusted OHLC. Pre-MSTU prices synthetic ONLY before launch. */
(function(root){'use strict';
const DEFAULTS=Object.freeze({mstr:22,mstu:13,long:200,slope:20,cost:0.0035,drag:0.40});
const assert=(x,msg)=>{if(!x)throw Error(msg)};
const valid=x=>Number.isFinite(x)&&x>0;
function checkParams(p){
 for(const k of ['mstr','mstu','long','slope'])assert(Number.isInteger(p[k])&&p[k]>=1,`參數 ${k} 必須是正整數`);
 assert(p.mstr>=2&&p.mstr<=80&&p.mstu>=2&&p.mstu<=80&&p.long>=40&&p.long<=400&&p.slope< p.long&&p.slope>=1,'SMA 或斜率超出有效範圍');
 assert(Number.isFinite(p.cost)&&p.cost>=0&&p.cost<=0.03,'交易成本設定不合理');
 assert(Number.isFinite(p.drag)&&p.drag>=0&&p.drag<=1,'合成 MSTU 拖累設定不合理');return p;
}
function makeRows(prices,drag=DEFAULTS.drag){
 const mm=new Map(prices.MSTR.map(r=>[r[0],r]));const uu=new Map(prices.MSTU.map(r=>[r[0],r]));
 const dates=[...mm.keys()].sort();assert(dates.length>=250,'MSTR 歷史不足 250 個交易日');
 const launch=[...uu.keys()].sort()[0];assert(launch,'缺少真實 MSTU 日線');const j=dates.indexOf(launch);assert(j>0,'MSTU 上市日與 MSTR 歷史不一致');
 const synthetic={};
 const factor=(i)=>1+2*(mm.get(dates[i])[2]/mm.get(dates[i-1])[2]-1)-drag/252;
 // Back out the synthetic close from first real MSTU closing price. Never replace real MSTU closes after IPO.
 const launchFactor=factor(j);assert(launchFactor>0,'合成 MSTU 上市首日跨期因子不合理');synthetic[dates[j-1]]=uu.get(launch)[2]/launchFactor;
 for(let i=j-2;i>=0;i--){const f=factor(i+1);assert(f>0,'合成 MSTU 日報酬因子不合理 '+dates[i+1]);synthetic[dates[i]]=synthetic[dates[i+1]]/f;}
 const rows=[];
 for(let i=0;i<dates.length;i++){
  const date=dates[i],m=mm.get(date);let u,syntheticBar=date<launch;
  if(syntheticBar){const c=synthetic[date],o=i===0?c:synthetic[dates[i-1]]*(1+2*(m[1]/mm.get(dates[i-1])[2]-1));u=[date,o,c];}
  else {u=uu.get(date);assert(!!u,'MSTU 上市後缺漏正式價格：'+date);}
  for(const x of [m[1],m[2],u[1],u[2]])assert(valid(x),'缺少或無效的正式價格：'+date);
  rows.push({date,mo:m[1],mc:m[2],uo:u[1],uc:u[2],synthetic:syntheticBar});
 }
 return rows;
}
function sma(vals,n){let sum=0,bad=0;return vals.map((v,i)=>{if(v===null||!Number.isFinite(v))bad++;else sum+=v;if(i>=n){const old=vals[i-n];if(old===null||!Number.isFinite(old))bad--;else sum-=old;}return i>=n-1&&bad===0?sum/n:null});}
function signals(rows,p=DEFAULTS,mode='hybrid'){
 checkParams(p);assert(['hybrid','realOnly'].includes(mode),'未知的模型訊號模式');
 const m=sma(rows.map(x=>x.mc),p.mstr),l=sma(rows.map(x=>x.mc),p.long);
 const u=sma(rows.map(x=>(mode==='realOnly'&&x.synthetic)?null:x.uc),p.mstu);
 let risk=true,gate=false;const daily=[];
 for(let i=0;i<rows.length;i++){
  if(i>0){
   if(m[i-1]!==null){const prev=rows[i-1].mc>m[i-1],op=rows[i].mo>m[i-1];if(prev===op)risk=prev;}
   if(u[i-1]!==null){const prev=rows[i-1].uc>u[i-1],op=rows[i].uo>u[i-1];if(prev===op)gate=prev;}
   else if(mode==='realOnly')gate=false;
  }
  const bull=i>p.slope&&l[i-1]!==null&&l[i-1-p.slope]!==null&&rows[i-1].mc>l[i-1]&&l[i-1]>l[i-1-p.slope];
  daily.push({risk,gate,bull,target:!risk?'CASH':(bull&&gate?'MSTU':'MSTR')});
 }
 return {ma:m,ua:u,la:l,daily,mode};
}
function nextDecision(rows,sig,p=DEFAULTS){
 const i=rows.length-1,r=rows[i],m=sig.ma[i],u=sig.ua[i],long=sig.la[i],old=sig.la[i-p.slope];
 assert([m,u,long,old].every(valid),'均線不足或新價格尚未建立');
 const bull=r.mc>long&&long>old,previous=sig.daily[i];
 function evaluate(mo,uo){
  assert(valid(mo)&&valid(uo),'請填正數報價');let risk=previous.risk,gate=previous.gate;
  const mConfirm=(r.mc>m)===(mo>m),uConfirm=(r.uc>u)===(uo>u);
  if(mConfirm)risk=r.mc>m;if(uConfirm)gate=r.uc>u;
  return {target:!risk?'CASH':bull&&gate?'MSTU':'MSTR',risk,gate,mConfirm,uConfirm};
 }
 const combinations=[];for(const ma of [true,false])for(const ua of [true,false])combinations.push({mstrAbove:ma,mstuAbove:ua,...evaluate(m*(ma?1.001:0.999),u*(ua?1.001:0.999))});
 return {date:r.date,mc:r.mc,uc:r.uc,m,u,long,longOld:old,bull,previous:previous.target,risk:previous.risk,gate:previous.gate,mPrevAbove:r.mc>m,uPrevAbove:r.uc>u,combinations,evaluate};
}
// All portfolios start with 10k at the anchor DAY CLOSE; first possible trade is next trading day OPEN.
// At every new day's open the previously held asset earns overnight close->open return,
// then one 100% position swap if needed, then the new asset earns open->close return.
// The 0.35% assumption is a FULL SWITCH total effective cost, not a cost per order.
function simulate(rows,sig,start,initialMode='MSTR',cost=DEFAULTS.cost){
 const k=rows.findIndex(r=>r.date>=start);assert(k>=0,'回測起點不存在：'+start);
 let value=10000,high=value,mdd=0,hold=initialMode==='MODEL'?sig.daily[k].target:initialMode,trades=0;
 const curve=[{date:rows[k].date,value,hold}],events=[];
 for(let i=k+1;i<rows.length;i++){
  const r=rows[i],prev=rows[i-1],next=sig.daily[i].target;
  if(hold==='MSTR')value*=r.mo/prev.mc;
  else if(hold==='MSTU')value*=r.uo/prev.uc;
  if(next!==hold){const old=hold;value*=1-cost;hold=next;trades++;events.push({date:r.date,from:old,to:next,at:'open'});}
  if(hold==='MSTR')value*=r.mc/r.mo;
  else if(hold==='MSTU')value*=r.uc/r.uo;
  high=Math.max(high,value);mdd=Math.min(mdd,value/high-1);curve.push({date:r.date,value,hold});
 }
 const base=rows[k].mc,buyhold=rows.slice(k).map(r=>({date:r.date,value:10000*r.mc/base}));let hhigh=10000,hmdd=0;
 for(const x of buyhold){hhigh=Math.max(hhigh,x.value);hmdd=Math.min(hmdd,x.value/hhigh-1);}
 return {start:rows[k].date,end:rows[rows.length-1].date,strategy:value,benchmark:buyhold.at(-1).value,mdd,benchmarkMdd:hmdd,trades,curve,buyhold,events};
}
const api={DEFAULTS,checkParams,makeRows,sma,signals,nextDecision,simulate};
if(typeof module!=='undefined'&&module.exports)module.exports=api;root.StrategyEngine=api;
})(typeof window!=='undefined'?window:globalThis);
