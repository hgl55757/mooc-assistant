const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('mooc-assistant.user.js','utf8');
const shared=new Map();
function storage(map){return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}
function page(session=new Map(),url='https://www.icourse163.org/mooc/learn/X/content/1?tid=10&unitId=100'){
 const u=new URL(url),context={URL,console:{log(){},warn(){},error(){}},setTimeout(){},clearTimeout(){},
  GM_getValue:(k,f)=>f,GM_setValue(){},GM_addStyle(){},
  document:{readyState:'complete',querySelectorAll(){return [];},querySelector(){return null;},getElementById(){return null;}},window:{},
  location:{href:url,pathname:u.pathname,hash:u.hash},sessionStorage:storage(session),localStorage:storage(shared)};
 const instrumented=source.replace('    function init() {',`globalThis.t={videoUnitContext,contentUnitChanged,learnSaveState,learnLoadState,learnClearState,resumeLearn,recordRunEvent,readRunEvents,set:function(name,value){eval(name+' = value');}};\n    function init() {`);
 vm.createContext(context);vm.runInContext(instrumented,context);
 const t=context.t;t.set('logDebug',()=>{});t.set('setFloatVisible',()=>{});
 let label='绪论（未完成）',present=true;
 t.set('currentContentTab',()=>present?{getAttribute:()=>label,textContent:label,querySelector:()=>null}:null);
 return {t,context,session,go(url){const u=new URL(url);Object.assign(context.location,{href:url,pathname:u.pathname,hash:u.hash});},label(v){label=v;},present(v){present=v;}};
}
const a=page(),b=page();const original=a.context.location.href,c=a.t.videoUnitContext();
assert.strictEqual(!!a.t.contentUnitChanged(c,a.t.videoUnitContext()),false);
a.label('绪论（已完成）');assert.strictEqual(!!a.t.contentUnitChanged(c,a.t.videoUnitContext()),false);
a.label('平台更新后的标题（已完成）');assert.strictEqual(!!a.t.contentUnitChanged(c,a.t.videoUnitContext()),false);
a.go(original+'&chapterId=2&tracking=1#play');assert.strictEqual(!!a.t.contentUnitChanged(c,a.t.videoUnitContext()),false);
a.go('https://www.icourse163.org/mooc/learn/X/content/1/?unitId=100&tid=10');assert.strictEqual(!!a.t.contentUnitChanged(c,a.t.videoUnitContext()),false);
a.present(false);assert.strictEqual(!!a.t.contentUnitChanged(c,a.t.videoUnitContext()),false);a.present(true);
a.go('https://www.icourse163.org/mooc/learn/X/content/1?tid=10');assert.strictEqual(!!a.t.contentUnitChanged(c,a.t.videoUnitContext()),false);
for(const url of [original.replace('unitId=100','unitId=101'),original.replace('tid=10','tid=11'),original.replace('content/1','content/2'),original.replace('/X/','/Y/')]){
 a.go(url);assert.strictEqual(!!a.t.contentUnitChanged(c,a.t.videoUnitContext()),true);
}
// 两页共享 localStorage，但启动、停止和日志不会相互覆盖。
a.go(original);a.t.learnSaveState({running:true,course:'/mooc/learn/X',term:'10'});
b.t.learnSaveState({running:true,course:'/mooc/learn/Y'});b.t.learnClearState();assert(a.t.learnLoadState());
a.t.recordRunEvent('start','A页');b.t.recordRunEvent('stop','B页');assert(!a.t.readRunEvents().some(e=>e.message==='B页'));
// 同页刷新保留计划，刷新后能续跑；同页真实切课不续跑。
const refreshed=page(a.session);let resumed=0;refreshed.t.set('runGuarded',()=>resumed++);refreshed.t.resumeLearn();assert.strictEqual(resumed,1);
refreshed.go(original.replace('/X/','/Y/'));refreshed.t.resumeLearn();assert.strictEqual(resumed,1);assert(!refreshed.t.learnLoadState());
// 旧共享计划不导入，避免更新后从其他页面自动启动。
shared.set('mooc.merged.learn.state.v1',JSON.stringify({running:true,course:'/mooc/learn/X'}));assert(!page().t.learnLoadState());
console.log('PASS: semantic unit identity; status/title/hash/query rerender; actual course/term/unit switch; tab-isolated state/history; refresh resume; legacy shared plan ignored.');
