const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('mooc-assistant.user.js','utf8');
new Function(source);
let now=0,tab=null,video=null,config={},step=()=>{};
const logs=[];
const context={URL,console:{log(){},warn(){},error(){}},setTimeout(){},clearTimeout(){},
 GM_getValue:(k,f)=>f,GM_setValue(){},GM_addStyle(){},
 document:{readyState:'complete',querySelectorAll(){return [];},querySelector(){return null;},getElementById(){return null;},body:{textContent:''}},
 location:{href:'https://www.icourse163.org/mooc/learn/X/content/1?unitId=1',pathname:'/mooc/learn/X/content/1',hash:''},
 window:{},localStorage:{getItem(){return null;}},Date:class extends Date{static now(){return now;}},
 btoa(){},atob(){}};
const instrumented=source.replace('    function init() {',`globalThis.t={readVideoUnitCompletion,waitVideoCompletion,learnVideoItem,videoUnitContext,taskState,
set:function(name,value){eval(name+' = value');}};\n    function init() {`);
vm.createContext(context);vm.runInContext(instrumented,context);
const t=context.t;
t.set('currentContentTab',()=>tab);
t.set('getConfig',()=>config);
t.set('logDebug',(cat,msg)=>logs.push(msg));t.set('updateStatus',()=>{});
t.set('sleep',async ms=>{now+=ms;step();});
t.set('findVideo',()=>video);t.set('waitForVideo',async()=>video);t.set('applyVideoRate',()=>{});
t.set('loadVideoRate',()=>1);t.set('clickQuizContinue',()=>false);t.set('findQuizPopup',()=>null);
t.set('playVideo',async()=>{video.paused=false;});
function makeTab(completed=false){return {complete:completed,getAttribute(){return this.complete?'绪论（已完成）':'绪论';},textContent:'绪论',querySelector(){return this.complete?{}:null;}};}
function reset(){now=0;logs.length=0;step=()=>{};tab=makeTab();config={videoCompletionWait:5,videoCompletionTimeout:'continue'};t.taskState.cancelled=false;t.set('manualWaitFlag',false);context.location.href='https://www.icourse163.org/mooc/learn/X/content/1?unitId=1';}
(async()=>{
 reset();tab.complete=true;let c=t.videoUnitContext();assert.strictEqual(t.readVideoUnitCompletion(c),'complete');
 assert.strictEqual(await t.waitVideoCompletion(c),true);assert.strictEqual(now,3000);
 reset();c=t.videoUnitContext();step=()=>{if(now>=4000)tab.complete=true;};
 assert.strictEqual(await t.waitVideoCompletion(c),true);assert.strictEqual(now,4000);
 reset();c=t.videoUnitContext();assert.strictEqual(await t.waitVideoCompletion(c),true);assert.strictEqual(now,5000);assert(logs.some(x=>x.includes('UNCONFIRMED')));
 reset();config.videoCompletionTimeout='pause';c=t.videoUnitContext();assert.strictEqual(await t.waitVideoCompletion(c),false);assert.strictEqual(now,5000);
 reset();tab=null;c=t.videoUnitContext();assert.strictEqual(await t.waitVideoCompletion(c),true);assert.strictEqual(now,5000);
 reset();c=t.videoUnitContext();step=()=>{if(now>=500)t.taskState.cancelled=true;};await assert.rejects(t.waitVideoCompletion(c),e=>e.__cancelled);
 reset();c=t.videoUnitContext();step=()=>{if(now>=500)t.set('manualWaitFlag',true);};assert.strictEqual(await t.waitVideoCompletion(c),true);assert.strictEqual(now,500);
 reset();c=t.videoUnitContext();step=()=>{if(now>=500)context.location.href+='2';};assert.strictEqual(await t.waitVideoCompletion(c),'navigated');
 reset();c=t.videoUnitContext();step=()=>{if(now>=500)context.location.href=context.location.href.replace('/X/','/Y/');};await assert.rejects(t.waitVideoCompletion(c),e=>e.__cancelled);
 // 完整视频循环：剩余1.5秒不跳转，只有真实ended后才进入完成确认。
 reset();video={duration:10,currentTime:8.5,ended:false,paused:false,addEventListener(){}};
 let observedNearEnd=false;
 t.set('playVideo',async()=>{video.currentTime=8.5;video.paused=false;});
 step=()=>{if(now===600){observedNearEnd=true;video.currentTime=10;video.ended=true;tab.complete=true;}};
 assert.strictEqual(await t.learnVideoItem(),true);assert(observedNearEnd);assert(now>=3600);
 assert(!source.includes('LEARN_VIDEO_END_MARGIN'));
 console.log('PASS: complete mark grace; delayed update; bounded timeout continue/pause; missing mark; cancellation; manual next; changed unit; real-ended loop; 1.5-second-early finish removed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
