const fs=require('fs'),vm=require('vm'),assert=require('assert');
const nodes=[];
class Element {
 constructor(tag='div',attrs={}){
  this.tagName=tag.toUpperCase();this.attrs=attrs;this.id=attrs.id||'';this.dataset={tab:attrs['data-tab'],pane:attrs['data-pane']};this.style={};this.children=[];this.events={};
  this.classes=new Set((attrs.class||'').split(/\s+/));
  this.classList={add:c=>this.classes.add(c),remove:c=>this.classes.delete(c),contains:c=>this.classes.has(c),toggle:(c,on)=>on?this.classes.add(c):this.classes.delete(c)};
  nodes.push(this);
 }
 set innerHTML(html){
  this.html=html;
  for(const match of html.matchAll(/<([a-z]+)\b([^>]*)>/gi)){
   const attrs={};for(const attr of match[2].matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))attrs[attr[1]]=attr[2]??attr[3]??attr[4];
   this.children.push(new Element(match[1],attrs));
  }
 }
 get innerHTML(){return this.html||'';}
 appendChild(el){this.children.push(el);el.parentNode=this;}
 getAttribute(key){return this.attrs[key]||null;}
 addEventListener(name,handler){this.events[name]=handler;}
 querySelectorAll(selector){return select(selector,this.children);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 focus(){}select(){}
}
function select(selector,pool=nodes){
 let result=pool;
 if(selector.includes('.mar-tab'))result=result.filter(e=>e.classes.has('mar-tab'));
 else if(selector.includes('.mar-pane'))result=result.filter(e=>e.classes.has('mar-pane'));
 else if(selector.includes('.mar-btn'))result=result.filter(e=>e.classes.has('mar-btn'));
 else if(selector.includes('.mar-seg'))return [];
 else if(selector.startsWith('#'))return result.filter(e=>e.id===selector.slice(1));
 else return [];
 const pane=selector.match(/data-pane="([^"]+)"/);if(pane)result=result.filter(e=>e.dataset.pane===pane[1]);
 return result;
}
const document={head:new Element('head'),body:new Element('body'),readyState:'complete',
 createElement:tag=>new Element(tag),getElementById:id=>nodes.find(e=>e.id===id)||null,
 querySelectorAll:selector=>select(selector),querySelector:selector=>select(selector)[0]||null,addEventListener(){}};
const context={document,window:{},console,location:{pathname:'/mooc/learn/X/content/1',hash:''},
 GM_getValue:(key,fallback)=>fallback,GM_setValue(){},GM_addStyle(){},
 localStorage:{getItem(){return null;}},setTimeout(){},clearTimeout(){},btoa(){},atob(){}};
let source=fs.readFileSync('mooc-assistant.user.js','utf8');
source=source.replace('    function init() {','    globalThis.uiTest={createFloatingPanel,showLlmConfigPanel};\n    function init() {');
vm.createContext(context);vm.runInContext(source,context);
context.uiTest.createFloatingPanel();
assert.deepStrictEqual(nodes.filter(e=>e.classes.has('mar-tab')).map(e=>e.dataset.tab),['auto','quiz','log','settings']);
assert(document.getElementById('mar-learn-start').onclick);
assert(document.getElementById('mar-quiz-start').onclick);
assert.strictEqual(document.getElementById('mar-blank-separator').value,'，');
assert.strictEqual(document.getElementById('mar-quiz-submit').checked,true);
assert(!document.getElementById('mar-one'));
assert(!document.getElementById('mar-discuss-reply'));
assert(!document.getElementById('mar-completion-wait'));
assert(!document.getElementById('mar-completion-timeout'));
context.uiTest.showLlmConfigPanel();
assert(document.getElementById('cf-apiKey'));
assert.strictEqual(document.getElementById('cf-apiKey').attrs.value,'');
assert(document.getElementById('pv-save').onclick);
assert(document.getElementById('pv-test').onclick);
assert(document.getElementById('cf-provider').events.change);
assert(!document.getElementById('icourse-panel'));
console.log('PASS: single main panel; four correct tabs; all handlers bind; original LLM configuration dialog builds with empty key and test/save controls; review/discussion buttons absent.');
