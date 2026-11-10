const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('mooc-assistant.user.js','utf8');
let now=0,step=()=>{},video=null;const session=new Map();
const context={URL,console:{log(){},warn(){},error(){}},setTimeout(){},clearTimeout(){},GM_getValue:(k,f)=>f,GM_setValue(){},GM_addStyle(){},
 document:{readyState:'complete',querySelectorAll(){return [];},querySelector(){return null;},getElementById(){return null;}},window:{},
 location:{href:'https://www.icourse163.org/mooc/learn/X/content/1?tid=10&unitId=100',pathname:'/mooc/learn/X/content/1'},
 sessionStorage:{getItem:k=>session.get(k)||null,setItem:(k,v)=>session.set(k,v),removeItem:k=>session.delete(k)},
 localStorage:{getItem(){return null;}},Date:class extends Date{static now(){return now;}}};
const exported=source.replace('    function init() {',`globalThis.t={learnOne,learnVideoItem,followCurrentContent,waitForSwitchedPlayer,videoUnitContext,taskState,set:function(name,value){eval(name+' = value');}};\n    function init() {`);
vm.createContext(context);vm.runInContext(exported,context);const t=context.t,actualLearnVideo=t.learnVideoItem;
for(const name of ['logDebug','updateStatus','setFloatVisible','applyVideoRate'])t.set(name,()=>{});
t.set('findVideo',()=>video);t.set('waitForVideo',async()=>video);t.set('loadVideoRate',()=>1);
t.set('sleep',async ms=>{now+=ms;step();});
t.set('learnLoadState',()=>({running:true}));t.set('learnSaveState',()=>{});t.set('learnClearState',()=>{});
t.set('dismissModal',async()=>{});t.set('waitContentReady',async()=>true);t.set('detectContentType',()=> 'video');
function go(unit=100,course='X',term=10){context.location.href=`https://www.icourse163.org/mooc/learn/${course}/content/1?tid=${term}&unitId=${unit}`;context.location.pathname=`/mooc/learn/${course}/content/1`;}
function reset(){now=0;step=()=>{};go();video={currentSrc:'one.mp4',currentTime:120,duration:120,ended:false,paused:false,addEventListener(){}};Object.assign(t.taskState,{cancelled:false,outcomeRecorded:false});}
(async()=>{
 // 平台在同一个播放器上自动换源、重置进度，旧循环必须交还给新一轮，不能等待新视频结束才发现切换。
 for(const reuse of [true,false]){
  reset();t.set('playVideo',async()=>{go(101);if(reuse){video.currentSrc='two.mp4';video.currentTime=0;}else video={...video,currentSrc:'two.mp4',currentTime:0};});
  assert.strictEqual(await actualLearnVideo(),'navigated');assert.strictEqual(now,0);
 }
 // 完成等待后和播放中已跳转都不能再次 goNext，否则会漏掉第二集。
 for(const result of ['navigated',true]){
  reset();let handled=0,nextCalls=0;
  t.set('learnVideoItem',async()=>{handled++;if(handled===1){go(101);video.currentSrc='two.mp4';return result;}return false;});
  t.set('goNext',async()=>{nextCalls++;return false;});await t.learnOne();
  assert.strictEqual(handled,2);assert.strictEqual(nextCalls,0);
 }
 // 平台没有跳转时保留原有下一项流程。
 reset();let nextCalls=0;t.set('learnVideoItem',async()=>true);t.set('goNext',async()=>{nextCalls++;return false;});await t.learnOne();assert.strictEqual(nextCalls,1);
 // 路由已更新而旧播放器还在：等到换源再接管；永不换源则有界暂停。
 reset();const previous={video,source:'one.mp4'};step=()=>{if(now>=1000)video.currentSrc='two.mp4';};
 assert.strictEqual(await t.waitForSwitchedPlayer(previous),true);assert.strictEqual(now,1000);
 reset();assert.strictEqual(await t.waitForSwitchedPlayer({video,source:'one.mp4'}),false);assert(now>0&&now<=30000);
 // 新播放器节点以及切到文档不阻塞；跨课/跨学期和停止按钮仍取消。
 reset();const old=video;video={...video};assert.strictEqual(await t.waitForSwitchedPlayer({video:old,source:'one.mp4'}),true);
 video=null;assert.strictEqual(await t.waitForSwitchedPlayer({video:old,source:'one.mp4'}),true);
 for(const [course,term] of [['Y',10],['X',11]]){reset();const c=t.videoUnitContext();go(101,course,term);assert.throws(()=>t.followCurrentContent(c),e=>e.__cancelled);}
 reset();const c=t.videoUnitContext();t.taskState.cancelled=true;assert.throws(()=>t.followCurrentContent(c),e=>e.__cancelled);
 await assert.rejects(t.waitForSwitchedPlayer({video,source:'one.mp4'}),e=>e.__cancelled);
 console.log('PASS: platform auto-next reuses/replaces player; no double navigation; normal next preserved; delayed player replacement and bounded timeout; documents; cross-course/term and manual stop cancel.');
})().catch(e=>{console.error(e);process.exitCode=1;});
