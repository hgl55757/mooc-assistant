const fs=require('fs'),vm=require('vm'),assert=require('assert');
let source=fs.readFileSync('mooc-assistant.user.js','utf8');
new Function(source);
assert(!/function (?:replyDiscussion|rateCurrentAssignment|autoReviewAll|learnDiscussionItem|handleVideo)\(/.test(source));
assert(!/data-tab="(?:review|discuss)"/.test(source));
assert(!/\bsk-[A-Za-z0-9_-]{16,}/.test(source));
assert(source.includes('mooc_merged_llm_config_v1'));
assert(!source.includes('"icourse_llm_config"'));
const store={};
let styles='';
const context={console:{log(){},warn(){},error(){}},setTimeout(){},clearTimeout(){},
    GM_getValue:(key,fallback)=>Object.prototype.hasOwnProperty.call(store,key)?store[key]:fallback,
    GM_setValue:(key,value)=>{store[key]=value;},GM_addStyle:s=>{styles+=s;},
    document:{readyState:'complete',querySelectorAll(){return [];},querySelector(){return null;},getElementById(){return null;},contains(){return true;}},
    window:{},location:{pathname:'/mooc/learn/X/content/1',href:'https://www.icourse163.org/mooc/learn/X/content/1',hash:''},
    localStorage:{getItem(){return null;},setItem(){},removeItem(){}},
    Event:function(){},URL,Date,Promise,Set,Map,JSON,
    btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary')};
source=source.replace('    function init() {',`    globalThis.t={
      getConfig,saveConfig,getLlmConfig,saveLlmConfig,resolveChoiceTexts,fillQuizAnswer,learnOne,solveSelectedQuiz,createFloatingPanel,taskState,
      set: function(name,value){eval(name+' = value');}
    };\n    function init() {`);
vm.createContext(context);vm.runInContext(source,context);
const t=context.t;
assert.strictEqual(t.getLlmConfig().apiKey,'');
assert.strictEqual(t.getLlmConfig().enabled,false);
assert.strictEqual(t.getConfig().blankSeparator,'，');
assert.deepStrictEqual(Array.from(t.resolveChoiceTexts('题目\nA、肢体 B、动作 C、气息 D、语言',['C','D','A','B'])),['气息','语言','肢体','动作']);

// 实际填写函数：单框合并和多框按序写入。
context.document.execCommand=()=>false;
function input(){return {value:'',tagName:'TEXTAREA',focus(){},closest(){return null;},dispatchEvent(){}};}
function blank(count){const fields=Array.from({length:count},input);return {fields,q:{type:'2',el:{querySelectorAll(){return fields;}}}};}
for(const [separator,expected] of [['，','甲，乙'],[' ','甲 乙'],['\\n','甲\n乙'],['','甲乙']]){
    t.saveConfig({blankSeparator:separator,autoSubmit:true});const b=blank(1);
    assert(t.fillQuizAnswer(b.q,'甲###乙'));assert.strictEqual(b.fields[0].value,expected);
}
const b=blank(2);assert(t.fillQuizAnswer(b.q,'甲###乙'));
assert.deepStrictEqual(b.fields.map(x=>x.value),['甲','乙']);

// 自动学习入口：视频和文档分别处理，其他类型只导航。
let type,videoCalls=0,docCalls=0,navCalls=0;
const originalSolve=t.solveSelectedQuiz;
t.set('sleep',async()=>{});t.set('dismissModal',async()=>{});t.set('waitContentReady',async()=>true);
t.set('learnLoadState',()=>({lastType:'video'}));t.set('learnSaveState',()=>{});t.set('learnClearState',()=>{});
t.set('setFloatVisible',()=>{});t.set('detectContentType',()=>type);
t.set('learnVideoItem',async()=>{videoCalls++;return true;});t.set('learnDocItem',async()=>{docCalls++;return true;});
t.set('goNext',async()=>{navCalls++;return false;});
(async()=>{
 for(type of ['video','doc','discussion','quiz','other','missing']){
    videoCalls=docCalls=navCalls=0;await t.learnOne();
    assert.strictEqual(videoCalls,type==='video'?1:0);
    assert.strictEqual(docCalls,type==='doc'?1:0);
    assert.strictEqual(navCalls,1);
 }
 // 测验用例：只请求选择/填空/判断；混合简答不交卷；填答失败不交卷。
 const promptCalls=[];let submissions=0,fillFails=false;
 t.set('handleQuizPreparePhase',async()=>{});t.set('hasReplayButton',()=>false);
 t.set('getLlmConfig',()=>({enabled:true,apiKey:'test-only-placeholder'}));
 t.set('askLLM',async(text,type)=>{promptCalls.push(type);return 'A';});
 t.set('fillQuizAnswer',()=>!fillFails);
 t.set('waitForReplayButton',async()=>true);
 t.set('findQuizSubmit',()=>({click(){submissions++;}}));
 t.saveConfig({blankSeparator:'，',autoSubmit:true});
 function question(type,index){return {type,index,text:'测试题',options:[],el:{}};}
 t.set('parseQuiz',()=>['0','1','2','3','4'].map(question));
 assert.strictEqual(await originalSolve(),'review');
 assert.deepStrictEqual(promptCalls,['0','1','2','3']);assert.strictEqual(submissions,0);
 t.set('parseQuiz',()=>['0','1','2','3'].map(question));
 assert.strictEqual(await originalSolve(),'done');assert.strictEqual(submissions,1);
 fillFails=true;assert.strictEqual(await originalSolve(),'review');assert.strictEqual(submissions,1);
 fillFails=false;
 // 模型请求返回后点击停止：不继续写入或提交。
 t.set('askLLM',async()=>{t.taskState.cancelled=true;return 'A';});
 await assert.rejects(originalSolve(),e=>e.__cancelled);
 assert.strictEqual(submissions,1);t.taskState.cancelled=false;
 console.log('PASS: full script loads; key defaults empty/isolated; choice mapping; configurable blanks; video/doc/skip routing; selected quiz types; submit guard; stop after request.');
})().catch(e=>{console.error(e);process.exitCode=1;});
