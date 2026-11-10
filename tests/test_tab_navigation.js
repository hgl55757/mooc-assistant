const fs=require('fs'),vm=require('vm'),assert=require('assert');
let now=0,tabs=[],videos=[],step=()=>{},clicks=0;
const context={URL,console:{log(){},warn(){},error(){}},setTimeout(){},clearTimeout(){},GM_getValue:(k,f)=>f,GM_setValue(){},GM_addStyle(){},
 document:{readyState:'complete',querySelectorAll(){return [];},querySelector(){return null;},getElementById(){return null;}},window:{},
 location:{href:'https://www.icourse163.org/mooc/learn/X/content/1?unitId=1',pathname:'/mooc/learn/X/content/1'},
 sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},localStorage:{getItem(){return null;}},Date:class extends Date{static now(){return now;}}};
const source=fs.readFileSync('mooc-assistant.user.js','utf8');
const instrumented=source.replace('    function init() {',`globalThis.t={waitForTabActive,activateContentTab,findVideo,activeTabIsVideo,learnOne,taskState,set:function(name,value){eval(name+' = value');}};\n    function init() {`);
vm.createContext(context);vm.runInContext(instrumented,context);const t=context.t,realFind=t.findVideo;
t.set('contentTabs',()=>tabs);t.set('currentContentTab',()=>tabs.find(x=>x.selected)||null);
t.set('sleep',async ms=>{now+=ms;step();});t.set('logDebug',()=>{});t.set('updateStatus',()=>{});t.set('setFloatVisible',()=>{});
function tab(label,selected=false,kind='pdf'){return {selected,textContent:label,getAttribute(k){return k==='aria-selected'?String(this.selected):k==='aria-label'?label:null;},querySelector(s){return s===`[data-lesson-type-icon="${kind}"]`?{}:null;},click(){clicks++;}};}
function reset(){now=0;clicks=0;step=()=>{};tabs=[];t.taskState.cancelled=false;t.taskState.outcomeRecorded=false;context.location.href='https://www.icourse163.org/mooc/learn/X/content/1?unitId=1';}
(async()=>{
 // 原节点已失效，新节点已选中：必须成功；完成文字发生变化也不影响定位。
 reset();const old=tab('Manuscript 2.4');tabs=[old];step=()=>{tabs=[tab('Manuscript 2.4（已完成）',true)];};
 assert.strictEqual(await t.waitForTabActive(old),true);assert.strictEqual(old.selected,false);assert.strictEqual(now,200);
 // 首次点击重绘，原生 click 后从新目录确认，不误报超时。
 reset();const target=tab('文档');target.click=()=>{clicks++;tabs=[tab('文档',true)];};tabs=[target];
 assert.strictEqual(await t.activateContentTab(target),true);assert.strictEqual(clicks,1);
 // 首次点击未生效，第二次重新定位并重试；始终未生效则有界失败。
 reset();const retry=tab('文档');retry.click=()=>{clicks++;if(clicks===2)tabs=[tab('文档',true)];};tabs=[retry];
 assert.strictEqual(await t.activateContentTab(retry),true);assert.strictEqual(clicks,2);
 reset();tabs=[tab('文档')];assert.strictEqual(await t.activateContentTab(tabs[0]),false);assert.strictEqual(clicks,2);assert.strictEqual(now,10000);
 reset();tabs=[tab('文档')];t.taskState.cancelled=true;assert.strictEqual(await t.waitForTabActive(tabs[0]),false);
 // 弹题使画面不可见：只有当前视频标签下才采用仍有布局的媒体元素，文档页不误用隐藏视频。
 reset();const media={getBoundingClientRect:()=>({width:800,height:450}),ended:false};videos=[media];
 context.document.querySelectorAll=s=>s==='video'?videos:[];t.set('isVisible',()=>false);
 tabs=[tab('视频',true,'video')];assert.strictEqual(realFind(),media);
 tabs=[tab('文档',true)];assert.strictEqual(realFind(),null);
 // 已有逻辑错误返回 done 时，仍在播放的视频不能导航；第二轮返回 false 结束测试。
 reset();tabs=[tab('视频',true,'video')];t.set('findVideo',()=>media);t.set('learnLoadState',()=>({running:true}));t.set('learnSaveState',()=>{});t.set('learnClearState',()=>{});
 t.set('dismissModal',async()=>{});t.set('waitContentReady',async()=>true);t.set('detectContentType',()=> 'video');
 let handled=0,nav=0;t.set('learnVideoItem',async()=>++handled===1);t.set('goNext',async()=>{nav++;return false;});await t.learnOne();assert.strictEqual(handled,2);assert.strictEqual(nav,0);
 // 视频已结束后仍按原有路径导航。
 reset();tabs=[tab('视频',true,'video')];media.ended=true;handled=nav=0;t.set('learnVideoItem',async()=>{handled++;return true;});await t.learnOne();assert.strictEqual(nav,1);
 // 视频标签加载失败必须暂停，而不是按缺失内容跳过。
 reset();tabs=[tab('视频',true,'video')];t.set('waitContentReady',async()=>false);nav=0;await t.learnOne();assert.strictEqual(nav,0);
 console.log('PASS: replaced DOM tab; completed label; native click; bounded reacquired retry; timeout and stop; popup-hidden player; unfinished video and unloaded video never navigate; ended video normal navigation.');
})().catch(e=>{console.error(e);process.exitCode=1;});
