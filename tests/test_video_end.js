const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('mooc-assistant.user.js','utf8');
new Function(source);
assert(!/waitVideoCompletion|readVideoUnitCompletion|videoCompletionWait|videoCompletionTimeout|mar-completion-wait|mar-completion-timeout/.test(source));
let now=0,video=null,step=()=>{},plays=0;
const context={URL,console:{log(){},warn(){},error(){}},setTimeout(){},clearTimeout(){},GM_getValue:(k,f)=>f,GM_setValue(){},GM_addStyle(){},
 document:{readyState:'complete',querySelectorAll(){return [];},querySelector(){return null;},getElementById(){return null;}},window:{},
 location:{href:'https://www.icourse163.org/mooc/learn/X/content/1?unitId=1',pathname:'/mooc/learn/X/content/1'},
 sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},localStorage:{getItem(){return null;}},Date:class extends Date{static now(){return now;}}};
const instrumented=source.replace('    function init() {',`globalThis.t={learnVideoItem,taskState,set:function(name,value){eval(name+' = value');}};\n    function init() {`);
vm.createContext(context);vm.runInContext(instrumented,context);const t=context.t;
t.set('logDebug',()=>{});t.set('updateStatus',()=>{});t.set('findVideo',()=>video);t.set('waitForVideo',async()=>video);
t.set('applyVideoRate',()=>{});t.set('loadVideoRate',()=>1);t.set('findQuizPopup',()=>null);t.set('clickQuizContinue',()=>false);
t.set('sleep',async ms=>{now+=ms;step();});t.set('playVideo',async()=>{plays++;video.paused=false;});
function reset(){now=0;plays=0;step=()=>{};t.taskState.cancelled=false;t.set('manualWaitFlag',false);context.location.href='https://www.icourse163.org/mooc/learn/X/content/1?unitId=1';video={duration:10,currentTime:8.5,ended:false,paused:false,addEventListener(){}};}
(async()=>{
 // 不提前结束：剩余 1.5 秒时仍播放；真正 ended 后立即返回，没有 3 秒或 30 秒等待。
 reset();step=()=>{if(now>=600){video.currentTime=10;video.ended=true;}};
 assert.strictEqual(await t.learnVideoItem(),true);assert.strictEqual(now,600);assert.strictEqual(plays,1);
 // 已结束的媒体不重播，也无需任何完成标记。
 reset();video.ended=true;assert.strictEqual(await t.learnVideoItem(),true);assert.strictEqual(now,0);assert.strictEqual(plays,0);
 // 平台切到下一单元：交还当前项，后续流程负责接管，不能误当作旧视频结束。
 reset();step=()=>{context.location.href='https://www.icourse163.org/mooc/learn/X/content/1?unitId=2';};assert.strictEqual(await t.learnVideoItem(),'navigated');assert.strictEqual(now,600);
 reset();step=()=>{context.location.href='https://www.icourse163.org/mooc/learn/Y/content/1?unitId=2';};await assert.rejects(t.learnVideoItem(),e=>e.__cancelled);
 reset();step=()=>{t.taskState.cancelled=true;};assert.strictEqual(await t.learnVideoItem(),false);
 reset();t.set('manualWaitFlag',true);assert.strictEqual(await t.learnVideoItem(),true);assert.strictEqual(now,0);
 console.log('PASS: real ended only; immediate finish without completion marks or delay; ended video not replayed; platform handoff; cross-course cancellation; stop and manual next; obsolete settings removed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
