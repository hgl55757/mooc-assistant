const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('mooc-assistant.user.js','utf8');
let now=0,state,pending=null,headers,tabs,clicks=[],omitCurrent=false,failMenu=false,failSection=false,failFirst=false;
const chapters=[6,7,8],sections={6:[1,2,3],7:[1,2,3],8:[1]},row={};
const root={querySelectorAll:()=>[headers.chapter,headers.section,{getAttribute:()=> '音量',closest:()=>({})}]};
const context={URL,console:{log(){},warn(){},error(){}},GM_getValue:(k,f)=>f,GM_setValue(){},GM_addStyle(){},setTimeout(){},clearTimeout(){},
 document:{readyState:'complete',getElementById:id=>id==='learn-main-content'?root:null,querySelectorAll:()=>[],querySelector:()=>null},window:{},
 location:{href:'',pathname:'',hash:''},sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},localStorage:{getItem(){return null;}},Date:class extends Date{static now(){return now;}}};
function chapterName(c){return `${c} China's Financial System with a deliberately long English heading that exceeds thirty characters`;}
function sectionName(c,s){return `${c}.${s} Detailed English course content with a deliberately long title`;}
function make(label,attrs={}){return {textContent:label,disabled:false,parentElement:null,getAttribute(k){return attrs[k]??null;},closest(){return null;},scrollIntoView(){},querySelector(){return null;},click(){}};}
function schedule(change){pending={at:now+400,change};}
function render(){
 const c=state.chapter,s=state.section;
 context.location.pathname=`/mooc/learn/X/content/${c*100+s*10+state.tab}`;
 context.location.href=`https://www.icourse163.org${context.location.pathname}?tid=1&unitId=${c*100+s}`;
 headers={};
 for(const kind of ['chapter','section']){
  const label=kind==='chapter'?chapterName(c):sectionName(c,s);
  const button=make(label,{'aria-label':label,title:label,'aria-expanded':String(state.open===kind)});
  const wrapper={parentElement:row,querySelectorAll(){
   if(state.open!==kind)return [];
   let values=kind==='chapter'?chapters:sections[c];
   if(kind==='section'&&omitCurrent)values=values.filter(x=>x!==state.section);
   return values.map(value=>{
    const itemLabel=kind==='chapter'?chapterName(value):sectionName(c,value);
    const item=make(itemLabel,{title:itemLabel});
    item.click=()=>{
     clicks.push(`${kind}:${kind==='chapter'?value:c+'.'+value}`);
     if(kind==='section'&&(failSection||(failFirst&&state.chapter===7&&value===1)))return;
     schedule(()=>{if(kind==='chapter'){state.chapter=value;state.section=2;}else state.section=value;state.tab=0;state.open=null;});
    };
    return item;
   });
  }};
  button.parentElement=wrapper;button.click=()=>{if(failMenu)return;state.open=state.open===kind?null:kind;render();};headers[kind]=button;
 }
 tabs=['Video','Manuscript'].map((kind,index)=>{
  const label=`${kind} ${c}.${s}`;
  const node=make(label,{'aria-label':label,'aria-selected':String(index===state.tab),role:'tab'});
  node.click=()=>{state.tab=index;render();};return node;
 });
 tabs[0].nextElementSibling=tabs[1];tabs[1].nextElementSibling=null;
}
const exported=source.replace('    function init() {',`globalThis.t={headerDropdowns,findDropdownItems,nextOfMenuItems,goNext,taskState,set:function(name,value){eval(name+' = value');}};\n    function init() {`);
vm.createContext(context);vm.runInContext(exported,context);const t=context.t;
for(const n of ['logDebug','updateStatus'])t.set(n,()=>{});
t.set('isVisible',()=>true);t.set('currentContentTab',()=>tabs[state.tab]);t.set('contentTabs',()=>tabs);t.set('findVideo',()=>null);
t.set('sleep',async ms=>{now+=ms;if(pending&&now>=pending.at){const next=pending;pending=null;next.change();render();}});
function reset(){now=0;state={chapter:6,section:2,tab:1,open:null};pending=null;clicks=[];omitCurrent=failMenu=failSection=failFirst=false;t.taskState.cancelled=false;render();}
(async()=>{
 reset();assert.strictEqual(t.headerDropdowns().chapter,headers.chapter);assert.strictEqual(t.headerDropdowns().section,headers.section);
 assert.strictEqual(await t.goNext(),true);assert.strictEqual(`${state.chapter}.${state.section}`,'6.3');assert.strictEqual(state.tab,0);assert(!clicks.some(x=>x.startsWith('chapter:')));
 state.tab=1;render();assert.strictEqual(await t.goNext(),true);assert.strictEqual(`${state.chapter}.${state.section}`,'7.1');assert.strictEqual(state.tab,0);
 assert(clicks.includes('chapter:7'));assert(clicks.includes('section:7.1'));assert(!clicks.includes('chapter:8'));
 state.tab=1;render();assert.strictEqual(await t.goNext(),true);assert.strictEqual(`${state.chapter}.${state.section}`,'7.2');
 console.log('PASS sequence: 6.2 -> 6.3 -> 7.1 -> 7.2, even when the platform initially restores 7.2 after changing chapters.');
 // 小节内的视频和文档优先于切节。
 reset();state.tab=0;render();assert.strictEqual(await t.goNext(),true);assert.strictEqual(`${state.chapter}.${state.section}.${state.tab}`,'6.2.1');assert.strictEqual(clicks.length,0);
 // 无法匹配当前项不是到末尾：必须停止，不能点击左侧章节。
 reset();omitCurrent=true;await assert.rejects(t.goNext(),/未匹配到当前项/);assert(!clicks.some(x=>x.startsWith('chapter:')));
 reset();failMenu=true;await assert.rejects(t.goNext(),/目录未读取成功/);assert.strictEqual(clicks.length,0);
 // 小节点击没生效、路由仍是原处时，不得误报成功或跳章。
 reset();failSection=true;assert.strictEqual(await t.goNext(),false);assert.strictEqual(state.chapter,6);assert.strictEqual(state.section,2);assert(!clicks.some(x=>x.startsWith('chapter:')));
 // 进入新章但第一节未选中时必须失败，不能继续处理平台恢复的 7.2。
 reset();state.section=3;render();failFirst=true;assert.strictEqual(await t.goNext(),false);assert.strictEqual(state.section,2);assert(!clicks.includes('chapter:8'));
 // 同名标题前缀不误匹配（6.2 / 6.20），且不截断长英文标题。
 reset();const menu=[make('6.2 long',{title:'6.2 long'}),make('6.20 long',{title:'6.20 long'}),make('6.3 long',{title:'6.3 long'})];
 assert.strictEqual(t.nextOfMenuItems(menu,'6.20 long'),menu[2]);assert.throws(()=>t.nextOfMenuItems(menu,'6.2 missing'),/未匹配/);
 reset();t.taskState.cancelled=true;await assert.rejects(t.goNext(),e=>e.__cancelled);
 // 全部目录末尾才能返回结束。
 reset();state.chapter=8;state.section=1;render();assert.strictEqual(await t.goNext(),false);assert.strictEqual(clicks.length,0);
 console.log('PASS: real-page two-wrapper menu layout; long English headings; video/document priority; incomplete/unmatched menu stops; delayed route refresh; failed selection stops; exact title matching; cancellation; verified final chapter end.');
})().catch(e=>{console.error(e);process.exitCode=1;});
