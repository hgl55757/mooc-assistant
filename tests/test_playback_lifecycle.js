const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('mooc-assistant.user.js','utf8');
const storage=new Map(),handlers={},logs=[];
const context={console:{log(){},warn(){},error(){}},GM_getValue:(k,f)=>f,GM_setValue(){},GM_addStyle(){},
 setTimeout(){},clearTimeout(){},
 document:{readyState:'complete',querySelectorAll(){return [];},querySelector(){return null;},getElementById(){return null;},addEventListener(type,fn){handlers[type]=fn;},hidden:false},
 window:{addEventListener(type,fn){handlers[type]=fn;}},location:{href:'https://www.icourse163.org/mooc/learn/X/content/1',pathname:'/mooc/learn/X/content/1',hash:''},
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}};
const exported=source.replace('    function init() {',`globalThis.t={learnVideoItem,runGuarded,requestStop,makeCancelError,taskState,resumeLearn,learnSaveState,learnLoadState,learnOne,initRunDiagnostics,set:function(name,value){eval(name+' = value');}};\n    function init() {`);
vm.createContext(context);vm.runInContext(exported,context);
const t=context.t;
t.set('logDebug',(category,message)=>logs.push({category,message}));
t.set('setButtonsRunning',()=>{});t.set('setFloatVisible',()=>{});
const events=()=>JSON.parse(storage.get('mooc.merged.run.events.v1')||'[]');
function reset(){storage.clear();logs.length=0;Object.assign(t.taskState,{running:false,cancelled:false,stopReason:'',outcomeRecorded:false,lastStatus:''});t.set('manualWaitFlag',false);}
(async()=>{
 // 视频停在123秒：启动不能改写currentTime，已经结束也不能调用play重播。
 reset();let writes=0,plays=0,waits=0,time=123;
 const video={duration:300,ended:false,paused:true,addEventListener(){},get currentTime(){return time;},set currentTime(value){writes++;time=value;}};
 t.set('waitForVideo',async()=>video);t.set('videoUnitContext',()=>({url:context.location.href}));
 t.set('playVideo',async()=>{plays++;assert.strictEqual(video.currentTime,123);t.taskState.cancelled=true;});
 await t.learnVideoItem();assert.strictEqual(writes,0);assert.strictEqual(plays,1);
 t.taskState.cancelled=false;video.ended=true;t.set('waitVideoCompletion',async()=>{waits++;return true;});
 assert.strictEqual(await t.learnVideoItem(),true);assert.strictEqual(plays,1);assert.strictEqual(waits,1);
 // 真实停止和程序触发必须留下不同的持久化记录，且不被通用取消覆盖。
 for(const trusted of [true,false]){
  reset();await t.runGuarded(async()=>{t.requestStop({isTrusted:trusted});throw t.makeCancelError();});
  assert.strictEqual(t.taskState.running,false);assert(!t.learnLoadState());
  assert.strictEqual(events().filter(e=>e.type==='stop').length,1);
  assert(events().some(e=>e.message.includes(trusted?'手动停止':'程序触发')));
 }
 reset();t.learnSaveState({running:true,course:'/mooc/learn/X'});
 await t.runGuarded(async()=>{throw new Error('模拟导航异常');});
 assert(events().some(e=>e.type==='error'&&e.message.includes('模拟导航异常')));
 assert(!t.learnLoadState());assert(!t.taskState.running);
 reset();await t.runGuarded(async()=>{throw t.makeCancelError('视频单元已切换');});
 assert(events().some(e=>e.type==='cancel'&&e.message==='视频单元已切换'));
 assert(!events().some(e=>e.type==='stop'));
 // 刷新续跑同样走异常收尾，不再留着running=true和脏计划。
 reset();t.learnSaveState({running:true,course:'/mooc/learn/X'});
 t.set('learnOne',async()=>{throw new Error('续跑异常');});t.resumeLearn();
 await new Promise(resolve=>setImmediate(resolve));
 assert(!t.taskState.running);assert(!t.learnLoadState());assert(events().some(e=>e.type==='error'));
 // 切后台不取消任务；页面离开记录进度但保留续跑计划。
 reset();t.initRunDiagnostics();t.taskState.running=true;t.learnSaveState({running:true});
 t.set('findVideo',()=>video);context.document.hidden=true;handlers.visibilitychange();handlers.pagehide();
 assert.strictEqual(t.taskState.cancelled,false);assert(t.learnLoadState());
 assert(events().some(e=>e.type==='visibility'));assert(events().some(e=>e.type==='pagehide'));
 console.log('PASS: preserve current position; no replay of ended video; distinguish trusted/synthetic stop; cancel reason; exception/resume cleanup; persistent events; background/pagehide do not stop.');
})().catch(e=>{console.error(e);process.exitCode=1;});
