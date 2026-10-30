'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname,'page.html'),'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({});
vm.runInContext(script.split('// Browser controller.')[0]+'\nthis.rules={fullTitle,stateName,baseEligible,matches,parentMap,selectDesk,stableOrder,shouldResort,allViewOrder,ownActionControl,selectProjectBoard,projectMatches,soundCues};',context);
const rules = context.rules;
const NOW = 1800000000000;
const session = (id, extra={}) => ({id,agent:'claude',fullTitle:'Full native conversation '+id,state:'finished',lastActivity:NOW-1000,...extra});
const ids = values => Array.from(values, value=>value.id);

test('desk includes recent unpinned work and active older work without importing old clutter',()=>{
  const rows=[session('recent'),session('working',{state:'working',lastActivity:NOW-3*86400000}),session('old',{lastActivity:NOW-3*86400000}),session('native',{nativePinned:true,lastActivity:0}),session('tower',{pinned:true,lastActivity:0})];
  assert.deepEqual(ids(rules.selectDesk(rows,NOW).current),['recent','working','native','tower']);
});
test('dismissed decisions leave current attention but remain in Earlier requests and Later',()=>{
  const waiting=session('waiting',{state:'decision',parked:true,dismissed:true,lastActivity:0});
  const later=session('later',{state:'working',parked:true});
  const selected=rules.selectDesk([waiting,later],NOW);
  assert.deepEqual(ids(selected.attention),[]);
  assert.deepEqual(ids(selected.earlier),['waiting']);
  assert.deepEqual(ids(selected.later),['waiting','later']);
  assert.equal(selected.later[1].state,'working');
  assert.deepEqual(ids(selected.current),[]);
});
test('an explicit child stays attached to its old parent, with missing parents left standalone',()=>{
  const old=session('parent',{lastActivity:0});
  const child=session('child',{relationship:{parentId:'parent',kind:'branch'}});
  const orphan=session('orphan',{relationship:{parentId:'missing',kind:'branch'}});
  const selected=rules.selectDesk([old,child,orphan],NOW);
  assert.deepEqual(ids(selected.current),['parent','orphan']);
  assert.equal(selected.parents.get('child'),'parent');
  assert.equal(selected.parents.has('orphan'),false);
});
test('same repository and title never create an inferred relationship',()=>{
  const first=session('one',{fullTitle:'Repeated title',context:{cwd:'/same/project'}});
  const second=session('two',{fullTitle:'Repeated title',context:{cwd:'/same/project'}});
  assert.deepEqual(ids(rules.selectDesk([first,second],NOW).current),['one','two']);
});
test('parking a parent does not conceal a still-working child',()=>{
  const rows=[session('parent',{parked:true}),session('child',{state:'working',relationship:{parentId:'parent'}})];
  assert.deepEqual(ids(rules.selectDesk(rows,NOW).current),['child']);
});
test('cyclic or self references do not hide sessions or loop forever',()=>{
  const rows=[session('one',{relationship:{parentId:'two'}}),session('two',{relationship:{parentId:'one'}}),session('self',{relationship:{parentId:'self'}})];
  assert.equal(rules.parentMap(rows).size,0);
  assert.deepEqual(ids(rules.selectDesk(rows,NOW).current),['one','two','self']);
});
test('statuses and activity changes do not shuffle existing work rows',()=>{
  const positions=new Map();
  assert.deepEqual(ids(rules.stableOrder([session('old',{lastActivity:1}),session('new',{lastActivity:2})],positions)),['new','old']);
  assert.deepEqual(ids(rules.stableOrder([session('old',{state:'working',lastActivity:30}),session('new',{state:'finished',lastActivity:2}),session('arrived',{lastActivity:40})],positions)),['new','old','arrived']);
  positions.clear();
  assert.deepEqual(ids(rules.stableOrder([session('old',{state:'working',lastActivity:30}),session('new',{state:'finished',lastActivity:2}),session('arrived',{lastActivity:40})],positions)),['arrived','old','new']);
});
test('a panel left alone re-sorts by latest activity, never while in use',()=>{
  assert.equal(rules.shouldResort(true,0,NOW),false);
  assert.equal(rules.shouldResort(false,NOW-30000,NOW),false);
  assert.equal(rules.shouldResort(false,NOW-60000,NOW),true);
});
test('an idle panel re-sorts on the next poll, and Keep for later moves the row before the save returns',async()=>{
  const ui=browserFixture(),order=()=>ui.cards().map(card=>card.dataset.recordKey);
  const rows=at=>[session('old',{lastActivity:at}),session('new',{lastActivity:NOW-1000})];
  await ui.poll(rows(NOW-5000));
  await ui.poll(rows(NOW));
  assert.deepEqual(order(),['current:new','current:old']);
  ui.browser.document.hasFocus=()=>false;vm.runInContext('lastSorted=0',ui.browser);
  await ui.poll(rows(NOW));
  assert.deepEqual(order(),['current:old','current:new']);
  const saving=vm.runInContext("act(allSessions.find(row=>row.id==='new'),'parked')",ui.browser);
  assert.deepEqual(order(),['current:old','later:new']);
  ui.browser.payload={sessions:[session('old',{lastActivity:NOW}),session('new',{lastActivity:NOW-1000,parked:true})],now:NOW};
  await saving;
  assert.deepEqual(order(),['current:old','later:new']);
  assert.ok(ui.requests.some(call=>call.url==='/api/organize' && call.body.parked===true));
});
test('All sessions keeps work set aside for later at the bottom',()=>{
  assert.deepEqual(ids(rules.allViewOrder([session('kept',{parked:true}),session('a'),session('b')])),['a','b','kept']);
});
test('titles remain verbatim, completion is scoped to a turn, and search includes context',()=>{
  const title='Wake word into the live app (4/7), with the entire native title';
  const row=session('full',{fullTitle:title,summary:{text:'Awaiting phone test'},context:{cwd:'/work/Atlas'}});
  assert.equal(rules.fullTitle(row),title);
  assert.equal(rules.stateName(row),'Finished for now');
  assert.equal(rules.stateName({...row,state:'unknown'}),'Status unclear');
  assert.equal(rules.matches(row,'phone'),true);
  assert.equal(rules.matches(row,'atlas'),true);
  assert.equal(rules.matches(row,'codex'),false);
});
test('script compiles and the page includes one fixed desktop report',()=>{
  assert.doesNotThrow(()=>new vm.Script(script));
  assert.equal((script.match(/towerLayout.report\(/g)||[]).length,1);
  assert.match(script,/view:'desk',width:980,height:760/);
});

test('explicitly brought-back old work remains on the desk after fresh view state',()=>{
  const restored=session('restored',{lastActivity:1,parked:false,pinned:false,nativePinned:false,onDesk:true});
  assert.deepEqual(ids(rules.selectDesk([restored],NOW).current),['restored']);
});

test('focus restoration chooses the parent action rather than a nested child action',()=>{
  const parent={},child={};
  const childOpen={dataset:{action:'open'},closest:()=>child};
  const childPark={dataset:{action:'parked'},closest:()=>child};
  const parentOpen={dataset:{action:'open'},closest:()=>parent};
  const parentPark={dataset:{action:'parked'},closest:()=>parent};
  parent.querySelectorAll=()=>[childOpen,childPark,parentOpen,parentPark];
  assert.equal(rules.ownActionControl(parent,'open'),parentOpen);
  assert.equal(rules.ownActionControl(parent,'parked'),parentPark);
});

// Minimal DOM exercises the actual card rendering and poll entrypoint without a browser dependency.
function browserFixture({hostname,width=980,storage}={}) {
  class Node {
    constructor(tag='div') { this.tagName=tag;this.children=[];this.dataset={};this.value='';this.className='';this.textContent='';this.listeners={};this.attributes={};this.classList={add:(name)=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),name])].join(' ');},remove:(name)=>{this.className=this.className.split(' ').filter(value=>value!==name).join(' ');}}; }
    get parentElement(){return this.parent||null;}
    append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
    replaceChildren(...nodes){if(this.contains(document.activeElement))document.activeElement=document.body;for(const node of this.children)node.parent=null;this.children=[];this.append(...nodes);}
    setAttribute(name,value){this.attributes[name]=String(value);} removeAttribute(name){delete this.attributes[name];} addEventListener(type,callback){this.listeners[type]=callback;}
    contains(node){return node===this || this.children.some(child=>child.contains(node));}
    matches(selector){if(selector==='details:not([open])')return this.tagName==='details'&&!this.open;if(selector.startsWith('[data-'))return this.dataset[selector.slice(6,-1).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]!==undefined;if(selector.startsWith('.'))return this.className.split(' ').includes(selector.slice(1));return this.tagName===selector;}
    closest(selector){return this.matches(selector)?this:this.parent?.closest(selector)||null;}
    querySelector(selector){if(selector==='.earlier-requests > summary')return this.querySelector('.earlier-requests')?.children.find(node=>node.tagName==='summary')||null;return this.querySelectorAll(selector)[0]||null;}
    querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
    focus(){document.activeElement=this;}
    scrollIntoView(options){this.scrolled=options;}
  }
  const nodes=new Map(),requests=[],windowListeners={};
  const document={createElement:tag=>new Node(tag),getElementById:id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);},addEventListener(){},hasFocus:()=>true,documentElement:{matches:()=>false},activeElement:null,body:new Node()};
  document.activeElement=document.body;
  const browser=vm.createContext({document,location:{protocol:'http:',hostname},window:{innerWidth:width,scrollY:0,scrollTo(){},addEventListener:(type,callback)=>{windowListeners[type]=callback;}},setTimeout:(...args)=>setTimeout(...args).unref(),clearTimeout,AbortController,Date,fetch:async(url,options)=>{requests.push({url,body:options?.body&&JSON.parse(options.body)});return {ok:true,json:async()=>browser.payload};},...(storage?{localStorage:storage}:{})});
  vm.runInContext(script.replace('refresh();setInterval(refresh,3000);',''),browser);
  const text=node=>[node.textContent,...node.children.map(text)].filter(Boolean).join('\n');
  const ownText=node=>[node.textContent,...node.children.filter(child=>child.className!=='record-bottom').map(text)].filter(Boolean).join('\n');
  const cards=()=>nodes.get('work').children.flatMap(section=>section.children.flatMap(node=>node.className==='records'?node.children:[])).filter(node=>node.className==='desk-record');
  return {browser,text,ownText,cards,requests,allCards:()=>nodes.get('work').querySelectorAll('[data-session-id]'),resize(width){browser.window.innerWidth=width;windowListeners.resize?.();},async poll(rows){browser.payload={sessions:rows,now:NOW};await vm.runInContext('refresh()',browser);}};
}
const recap=(text,updatedAt,stale=false)=>({text,updatedAt,stale,source:'Claude recap'});
test('parent card shows a newer explicit descendant update with attribution, retaining its own title and state',async()=>{
  const ui=browserFixture();
  const parent=session('parent',{fullTitle:'Parent work',state:'working',summary:recap('Old approval request',NOW-9000)});
  const child=session('child',{fullTitle:'Child continuation',state:'finished',relationship:{parentId:'parent'},summary:recap('Testing link ready',NOW-3000)});
  await ui.poll([parent,child]);
  const card=ui.cards()[0],text=ui.ownText(card);
  assert.match(text,/Parent work/);assert.match(text,/Working/);assert.match(text,/Testing link ready/);assert.match(text,/Child continuation/);
  assert.doesNotMatch(text,/Old approval request/);
});
test('parent newer update wins and unrelated similarly named work is excluded',async()=>{
  const ui=browserFixture();
  await ui.poll([session('parent',{summary:recap('Parent latest',NOW-1000)}),session('child',{relationship:{parentId:'parent'},summary:recap('Child earlier',NOW-2000)}),session('unrelated',{fullTitle:'Full native conversation parent',summary:recap('Unrelated newest',NOW)})]);
  const text=ui.ownText(ui.cards().find(card=>card.dataset.sessionId==='parent'));
  assert.match(text,/Parent latest/);assert.doesNotMatch(text,/Child earlier|Unrelated newest/);
});
test('nested descendant updates reach the card, cycles stay separate, and undated descendants do not displace dated context',async()=>{
  const ui=browserFixture();
  await ui.poll([session('parent',{summary:recap('Parent dated',NOW-9000)}),session('child',{relationship:{parentId:'parent'}}),session('grandchild',{relationship:{parentId:'child'},summary:recap('Grandchild newest',NOW-1000)}),session('undated',{relationship:{parentId:'parent'},summary:recap('Undated claim',0)})]);
  assert.match(ui.ownText(ui.cards()[0]),/Grandchild newest/);assert.doesNotMatch(ui.ownText(ui.cards()[0]),/Undated claim/);
  await ui.poll([session('one',{relationship:{parentId:'two'},summary:recap('One own recap',NOW-2000)}),session('two',{relationship:{parentId:'one'},summary:recap('Two own recap',NOW-1000)})]);
  assert.equal(ui.cards().length,2);assert.doesNotMatch(ui.ownText(ui.cards().find(card=>card.dataset.sessionId==='one')),/Two own recap/);
});
test('polling updates visible descendant context and keeps stale summary markers plus newer working activity visible',async()=>{
  const ui=browserFixture();
  const parent=session('parent',{state:'finished',summary:recap('Parent original',NOW-9000)});
  const child=session('child',{fullTitle:'Live continuation',state:'working',lastActivity:NOW-1000,relationship:{parentId:'parent'},summary:recap('Saved earlier',NOW-3000,true)});
  await ui.poll([parent,child]);
  let text=ui.ownText(ui.cards()[0]);
  assert.match(text,/Saved earlier/);assert.match(text,/Earlier update; newer activity exists/);assert.match(text,/Latest recorded activity/);assert.match(text,/Live continuation/);
  await ui.poll([parent,{...child,state:'finished',summary:recap('New finished reply',NOW)}]);
  text=ui.ownText(ui.cards()[0]);assert.match(text,/New finished reply/);assert.doesNotMatch(text,/Saved earlier|Latest recorded activity/);
});

test('working card activity advances on polling even when no new recap is saved; finished activity is not claimed as working',async()=>{
  const ui=browserFixture();
  const row=session('one',{state:'working',lastActivity:NOW-120000,summary:recap('Saved context unchanged',NOW-240000,true)});
  await ui.poll([row]);
  const before=ui.ownText(ui.cards()[0]);
  assert.match(before,/Latest recorded activity/);
  await ui.poll([{...row,lastActivity:NOW}]);
  const after=ui.ownText(ui.cards()[0]);
  assert.match(after,/Saved context unchanged/);assert.notEqual(after,before);
  await ui.poll([{...row,state:'finished',lastActivity:NOW}]);
  assert.doesNotMatch(ui.ownText(ui.cards()[0]),/Latest recorded activity/);
});

test('old unanswered requests leave current attention without resolving or removing their records',()=>{
  const old=session('old',{state:'decision',lastActivity:NOW-2*86400000});
  const fresh=session('fresh',{state:'decision',parked:true,dismissed:false,dismissId:'decision:new'});
  const dismissed=session('acknowledged',{state:'decision',dismissed:true});
  const selected=rules.selectDesk([old,fresh,dismissed],NOW);
  assert.deepEqual(ids(selected.attention),['fresh']);
  assert.deepEqual(ids(selected.earlier),['old','acknowledged']);
  assert.equal(old.state,'decision');
  assert.deepEqual(ids(selected.later),['fresh']);
});
test('a changed request reappears on the next poll even when kept for later',async()=>{
  const ui=browserFixture();
  const request=session('question',{state:'decision',parked:true,dismissed:true,dismissId:'decision:old',question:'Approve the preview?'});
  await ui.poll([request]);
  assert.equal(ui.cards().filter(card=>card.dataset.recordKey==='attention:question').length,0);
  await ui.poll([{...request,dismissed:false,dismissId:'decision:new',question:'Approve the new preview?'}]);
  assert.equal(ui.cards().filter(card=>card.dataset.recordKey==='attention:question').length,1);
});
test('earlier requests start collapsed, matching searches reveal them, and retain dates and dismissal labels',async()=>{
  const ui=browserFixture();
  await ui.poll([session('old',{state:'decision',dismissed:true,lastActivity:NOW-2*86400000,question:'Unusual archived question'})]);
  let earlier=vm.runInContext("work.children.find(node=>node.dataset.detailKey==='earlier-requests')",ui.browser);
  assert.ok(earlier);assert.equal(earlier.open,false);
  assert.match(ui.text(earlier),/Earlier requests · 1/);assert.match(ui.text(earlier),/Previously dismissed/);
  vm.runInContext("search.value='unusual';renderWork(true)",ui.browser);
  earlier=vm.runInContext("work.children.find(node=>node.dataset.detailKey==='earlier-requests')",ui.browser);
  assert.equal(earlier.open,true);assert.match(ui.text(earlier),/Unusual archived question/);
});
test('cards avoid duplicate question excerpts and keep full request and update under Details',async()=>{
  const ui=browserFixture();
  const question='Should the complete request remain readable with keyboard Details?';
  await ui.poll([session('one',{state:'decision',dismissId:'decision:one',question,summary:recap(question,NOW)})]);
  const card=ui.cards()[0];
  assert.equal(ui.ownText(card).split(question).length-1,1);
  assert.match(ui.text(card),/Full request/);assert.match(ui.text(card),/Dismiss this request/);
  assert.match(html,/\.question,\.recap[^}]*-webkit-line-clamp:3/);
  await ui.poll([session('one',{state:'finished',summary:recap('A distinct full update',NOW)})]);
  assert.match(ui.text(ui.cards()[0]),/Full update/);
});

test('dismiss sends only the shown event identity, preserves the chat, and returns keyboard focus to Earlier requests',async()=>{
  const ui=browserFixture(),request=session('ask',{state:'decision',dismissId:'decision:shown',question:'Approve this preview?'});
  await ui.poll([request]);
  vm.runInContext("work.querySelector('[data-action]').focus()",ui.browser);
  // Focus the real dismiss control, then let the next poll return the persisted acknowledgement.
  vm.runInContext("work.querySelectorAll('[data-action]').find(node=>node.dataset.action==='dismiss').focus()",ui.browser);
  ui.browser.payload={sessions:[{...request,dismissed:true}],now:NOW};
  await vm.runInContext("act(allSessions[0],'dismiss')",ui.browser);
  const mutation=ui.requests.find(call=>call.url==='/api/dismiss');
  assert.deepEqual(mutation.body,{id:'ask',dismissId:'decision:shown'});
  assert.equal(ui.requests.some(call=>call.url==='/api/organize'||call.url==='/api/focus'),false);
  assert.equal(vm.runInContext('document.activeElement.dataset.action',ui.browser),'earlier');
  assert.equal(vm.runInContext('allSessions[0].state',ui.browser),'decision');
});
test('open full details and keyboard focus survive a real refresh with changed content',async()=>{
  const ui=browserFixture(),row=session('one',{summary:recap('Original context',NOW-1000)});
  await ui.poll([row]);
  vm.runInContext("const detail=work.querySelector('details');detail.open=true;detail.querySelector('summary').focus()",ui.browser);
  await ui.poll([{...row,summary:recap('Fresh complete update',NOW)}]);
  assert.equal(vm.runInContext("work.querySelector('details').open",ui.browser),true);
  assert.equal(vm.runInContext('document.activeElement.dataset.action',ui.browser),'details');
  assert.match(ui.text(ui.cards()[0]),/Fresh complete update/);
});
test('a current child of an earlier request stays in front of you',()=>{
  const rows=[session('parent',{state:'decision',dismissed:true}),session('child',{state:'working',relationship:{parentId:'parent'}})];
  assert.deepEqual(ids(rules.selectDesk(rows,NOW).current),['child']);
});

test('current permission prompts stay visible despite old transcript activity, while exact dismissal remains honored',()=>{
  const prompt=session('permission',{state:'decision',decisionSource:'permission-prompt',lastActivity:NOW-3*86400000,dismissId:'decision:current',dismissed:false});
  assert.deepEqual(ids(rules.selectDesk([prompt],NOW).attention),['permission']);
  const dismissed={...prompt,dismissed:true};
  assert.deepEqual(ids(rules.selectDesk([dismissed],NOW).attention),[]);
  assert.deepEqual(ids(rules.selectDesk([dismissed],NOW).earlier),['permission']);
  const changed={...dismissed,dismissId:'decision:new',dismissed:false};
  assert.deepEqual(ids(rules.selectDesk([changed],NOW).attention),['permission']);
});

// Multi-Mac view: machine tags, view-only rows and the peer status line.
let peerRuleCache;
const peerRules=new Proxy({},{get:(_,name)=>{if(!peerRuleCache){const peerContext=vm.createContext({});vm.runInContext(script.split('// Browser controller.')[0]+'\nthis.rules={viewOnly,viewOnlyCaption,peerStatusLines,isLoopbackHost,matches};',peerContext);peerRuleCache=peerContext.rules;}return peerRuleCache[name];}});
async function pollPayload(ui,payload) { ui.browser.payload={now:NOW,...payload};await vm.runInContext('refresh()',ui.browser); }
// Copying a title stays on the viewer's own device, so it is not one of a chat's actions.
const actionsOf=card=>card.querySelectorAll('[data-action]').filter(node=>node.closest('[data-record-key]')===card&&node.dataset.action!=='copy-title').map(node=>node.dataset.action);
const PEERS=[{label:'Mac mini',reachable:true,lastSeen:NOW}];
test('machine tags appear only when peers are configured',async()=>{
  const ui=browserFixture();
  await pollPayload(ui,{sessions:[session('one',{machine:'iMac'})],machine:'iMac',peers:PEERS});
  assert.equal(ui.cards()[0].querySelectorAll('.machine').length,1);assert.match(ui.text(ui.cards()[0]),/iMac/);
  await pollPayload(ui,{sessions:[session('one')]});
  assert.equal(ui.cards()[0].querySelectorAll('.machine').length,0);
  await pollPayload(ui,{sessions:[session('one',{machine:'iMac'})],machine:'iMac',peers:[]});
  assert.equal(ui.cards()[0].querySelectorAll('.machine').length,0);
  assert.equal(peerRules.matches({machine:'Mac mini'},'mini'),true);
});
test('peer rows are view only with a caption, while this Mac keeps its actions',async()=>{
  const ui=browserFixture();
  const own=session('own',{machine:'iMac',state:'decision',dismissId:'decision:own',question:'Approve?',context:{workPath:'/work/own.md'}});
  const peer=session('Mac mini:codex:far',{machine:'Mac mini',peer:true,viewOnly:true,focusable:false,state:'decision',dismissId:'decision:far',question:'Approve far?'});
  await pollPayload(ui,{sessions:[own,peer],machine:'iMac',peers:PEERS});
  const ownCard=ui.cards().find(card=>card.dataset.sessionId==='own'),peerCard=ui.cards().find(card=>card.dataset.sessionId==='Mac mini:codex:far');
  assert.deepEqual(actionsOf(ownCard).sort(),['details','dismiss','finder','open','parked']);
  assert.deepEqual(actionsOf(peerCard),['details']);
  assert.match(ui.text(peerCard),/On Mac mini\. Open it there\./);
  assert.doesNotMatch(ui.text(ownCard),/Open it there/);
  assert.doesNotMatch(ui.text(peerCard),/Folder path|Dismiss this request|Keep for later/);
  await vm.runInContext("act(allSessions.find(s=>s.id==='Mac mini:codex:far'),'parked')",ui.browser);
  assert.equal(ui.requests.some(call=>call.url!=='/api/sessions'),false);
});
test('a remote viewer sees every row view only and is told which Mac to use',async()=>{
  for(const [ui,payload] of [[browserFixture(),{viewer:'remote'}],[browserFixture({hostname:'imac-test.tail0000.ts.net'}),{}]]) {
    const own=session('own',{machine:'iMac',viewOnly:true,state:'decision',dismissId:'decision:own',question:'Approve?'});
    const peer=session('Mac mini:codex:far',{machine:'Mac mini',peer:true,viewOnly:true});
    await pollPayload(ui,{sessions:[own,{...own,id:'plain',viewOnly:undefined},peer],machine:'iMac',peers:PEERS,...payload});
    for(const card of ui.cards())assert.deepEqual(actionsOf(card),['details'],card.dataset.sessionId);
    assert.match(ui.text(ui.cards().find(card=>card.dataset.sessionId==='own')),/Open it on the iMac\./);
    assert.match(ui.text(ui.cards().find(card=>card.dataset.sessionId==='plain')),/Open it on the iMac\./);
    assert.match(ui.text(ui.cards().find(card=>card.dataset.sessionId==='Mac mini:codex:far')),/Open it on the Mac mini\./);
  }
  assert.equal(peerRules.isLoopbackHost('127.0.0.1'),true);assert.equal(peerRules.isLoopbackHost('localhost'),true);assert.equal(peerRules.isLoopbackHost(undefined),true);
  assert.equal(peerRules.isLoopbackHost('imac-test.tail0000.ts.net'),false);
  assert.equal(peerRules.viewOnlyCaption({machine:"Sam's iMac"},true,''),"Open it on Sam's iMac.");
});
test('an unreachable peer shows one status line and clears when it returns',async()=>{
  const ui=browserFixture();
  await pollPayload(ui,{sessions:[session('one',{machine:'iMac'})],machine:'iMac',peers:[{label:'Mac mini',reachable:false,lastSeen:NOW-60000,message:'Mac mini not reachable, last seen 4:12 PM'}]});
  const line=vm.runInContext("document.getElementById('peer-status')",ui.browser);
  assert.equal(line.textContent,'Mac mini not reachable, last seen 4:12 PM');assert.equal(line.hidden,false);
  await pollPayload(ui,{sessions:[session('one',{machine:'iMac'})],machine:'iMac',peers:PEERS});
  assert.equal(line.hidden,true);
  assert.deepEqual(peerRules.peerStatusLines([{reachable:false},{reachable:true,message:'x'},{reachable:false,message:'Mini not reachable'}]),['Mini not reachable']);
});
test('the page can be saved to an iPhone home screen and uses no em-dashes',()=>{
  for(const name of ['viewport','apple-mobile-web-app-capable','apple-mobile-web-app-title','apple-mobile-web-app-status-bar-style'])assert.match(html,new RegExp('<meta name="'+name+'"'),name);
  assert.equal(html.includes('\u2014'),false);
  assert.match(html,/id="peer-status"/);
});

const boardFixture=(projects=[])=>({source:{title:'Project map',url:'https://example.com/projects',updatedAt:'2026-10-26T18:18:00Z',importedAt:'2026-10-26T21:30:00Z'},projects});
const project=(id,sessionIds=[],extra={})=>({id,title:'Project '+id,stage:'built',freshness:'Dated source note',description:'Source-reported project description',notes:[{status:'built',text:'A detailed source note stays readable.'},{status:'wait',text:'A fresh hands-on check is still needed.'}],next:'Try the current test surface.',sessionIds,...extra});
const findFold=(ui,key)=>vm.runInContext(`work.querySelectorAll('details').find(node=>node.dataset.detailKey===${JSON.stringify(key)})`,ui.browser);
const jumpButtons=ui=>vm.runInContext("work.querySelectorAll('[data-jump-id]')",ui.browser);
const projectColumns=ui=>vm.runInContext("work.querySelectorAll('.project-column')",ui.browser);
test('project cards use independent round-robin stacks at desktop, tablet, and phone breakpoints',async()=>{
  const board=boardFixture(Array.from({length:7},(_,index)=>project(String(index))));
  for(const [width,count] of [[980,3],[821,3],[820,2],[561,2],[560,1],[390,1]]) {
    const ui=browserFixture({width});await pollPayload(ui,{projectBoard:board,sessions:[]});
    const columns=projectColumns(ui);assert.equal(columns.length,count,'column count at '+width);
    assert.deepEqual(columns.map(column=>column.children.map(card=>card.dataset.detailKey)),Array.from({length:count},(_,column)=>board.projects.filter((_,index)=>index%count===column).map(project=>'project:'+project.id)));
  }
  assert.match(html,/\.project-column\{[^}]*display:flex;flex-direction:column;gap:14px/);assert.match(html,/\.project-column>\.project-card\{flex:none\}/);
});
test('only a changed column breakpoint rebuilds layout, preserving folds, focus, scroll, and allocations on polling',async()=>{
  const ui=browserFixture(),board=boardFixture(Array.from({length:7},(_,index)=>project(String(index),index===0?['one']:[])));await pollPayload(ui,{projectBoard:board,sessions:[session('one',{state:'working'})]});
  const card=findFold(ui,'project:0');card.open=false;findFold(ui,'notes:0:built').open=false;card.querySelector('summary').focus();
  vm.runInContext('window.scrollY=245;window.scrollTo=(x,y)=>{window.restoredY=y;}',ui.browser);
  ui.resize(900);assert.equal(findFold(ui,'project:0'),card);assert.equal(projectColumns(ui).length,3);
  for(const [width,count] of [[820,2],[560,1],[980,3]]) {
    ui.resize(width);assert.equal(projectColumns(ui).length,count);assert.equal(findFold(ui,'project:0').open,false);assert.equal(findFold(ui,'notes:0:built').open,false);assert.equal(vm.runInContext('document.activeElement',ui.browser),findFold(ui,'project:0').querySelector('summary'));assert.equal(vm.runInContext('window.restoredY',ui.browser),245);
  }
  const allocation=projectColumns(ui).map(column=>column.children.map(card=>card.dataset.detailKey));
  await pollPayload(ui,{projectBoard:board,sessions:[session('one',{state:'working',summary:recap('Updated progress',NOW)})]});
  assert.deepEqual(projectColumns(ui).map(column=>column.children.map(card=>card.dataset.detailKey)),allocation);assert.equal(findFold(ui,'project:0').open,false);
  jumpButtons(ui)[0].listeners.click();assert.equal(findFold(ui,'project:0').open,true);assert.equal(vm.runInContext('document.activeElement',ui.browser),ui.allCards().find(card=>card.dataset.sessionId==='one'));
});
test('Other work starts folded without hiding live alerts, and each alert opens its exact unmatched chat',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one')]);await pollPayload(ui,{projectBoard:board,sessions:[session('working',{state:'working'}),session('ask',{state:'decision',question:'Permission needed?',dismissId:'exact'})]});
  const other=findFold(ui,'other-work');assert.ok(other);assert.equal(other.open,false);assert.equal(other.tagName,'details');assert.equal(other.querySelector('summary').children[0].className,'fold-chevron');assert.deepEqual(jumpButtons(ui).map(button=>button.dataset.jumpId).sort(),['ask','working']);
  for(const id of ['ask','working']) {
    other.open=false;jumpButtons(ui).find(button=>button.dataset.jumpId===id).listeners.click();assert.equal(other.open,true);assert.equal(vm.runInContext('document.activeElement',ui.browser),ui.allCards().find(card=>card.dataset.sessionId===id));
  }
});
test('Other work search opens matching chats and its user fold and summary focus survive changed polls',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one')]),rows=[session('unmatched',{summary:recap('Distinctive unmatched evidence',NOW)})];await pollPayload(ui,{projectBoard:board,sessions:rows});
  vm.runInContext("search.value='distinctive';renderWork(true)",ui.browser);assert.equal(findFold(ui,'other-work').open,true);assert.equal(ui.allCards().length,1);
  vm.runInContext("search.value='';renderWork(true)",ui.browser);findFold(ui,'other-work').open=false;findFold(ui,'other-work').querySelector('summary').focus();
  await pollPayload(ui,{projectBoard:board,sessions:[{...rows[0],summary:recap('A changed recap',NOW)}]});
  assert.equal(findFold(ui,'other-work').open,false);assert.equal(vm.runInContext('document.activeElement',ui.browser),findFold(ui,'other-work').querySelector('summary'));
  findFold(ui,'other-work').open=true;await pollPayload(ui,{projectBoard:board,sessions:[{...rows[0],summary:recap('Another changed recap',NOW)}]});assert.equal(findFold(ui,'other-work').open,true);
});
test('individual Other work cards start independently folded with their title, app, machine, and activity visible',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one')]);
  await pollPayload(ui,{projectBoard:board,peers:PEERS,machine:'iMac',sessions:[session('one',{machine:'iMac',summary:recap('Hidden recap',NOW)}),session('two',{machine:'Mac mini',remote:true,state:'working'})]});
  const one=findFold(ui,'other-card:one'),two=findFold(ui,'other-card:two');assert.ok(one);assert.ok(two);
  for(const fold of [one,two]) {
    assert.equal(fold.open,false);assert.equal(fold.children[0].tagName,'summary');assert.equal(fold.children[0].children[0].className,'fold-chevron');
    assert.match(ui.text(fold.children[0]),/Full native conversation/);assert.equal(fold.querySelectorAll('[data-session-id]').length,1);
  }
  assert.match(ui.text(one.children[0]),/Claude/);assert.match(ui.text(one.children[0]),/iMac/);assert.match(ui.text(one.children[0]),/Turn ended/);assert.doesNotMatch(ui.text(one.children[0]),/Hidden recap/);
  assert.equal(two.children[0].querySelector('.title-spinner').attributes['aria-label'],'Working');
  one.open=true;assert.equal(two.open,false);findFold(ui,'other:one').open=true;one.open=false;assert.equal(findFold(ui,'other:one').open,true);
  assert.match(html,/\.other-work>\.records\{[^}]*align-items:start/);
});
test('a project need lives in the chat card that asked; otherwise its box names that chat, the saved notes, or you',async()=>{
  const ui=browserFixture(),board=boardFixture([project('desk',['ask'],{title:'Desktop app',attention:{state:'waiting',origin:'request',sessionId:'ask',reason:'Should I hand this over?'}}),project('elsewhere',[],{title:'Elsewhere',attention:{state:'waiting',origin:'request',sessionId:'loose',reason:'Pick a lane?'}}),project('saved',[],{title:'Search',stage:'wait',attention:{state:'waiting',origin:'source',reason:'Drive the wake word.'}}),project('gone',[],{title:'Gone',attention:{state:'later',origin:'request',sessionId:'missing',reason:'Old ask'}}),project('mine',[],{title:'Mine',attention:{state:'waiting',origin:'manual',reason:''}})]);
  await pollPayload(ui,{projectBoard:board,peers:PEERS,sessions:[session('ask',{fullTitle:'Workshop App',state:'working',machine:'iMac'}),session('loose',{fullTitle:'Loose chat',state:'working',machine:'iMac'})]});
  const desk=findFold(ui,'project:desk'),chat=ui.allCards().find(card=>card.dataset.sessionId==='ask');
  assert.equal(desk.querySelectorAll('.project-need').length,0);assert.equal(chat.closest('.project-card'),desk);
  const ask=chat.querySelector('.chat-need');assert.ok(ask);assert.equal(ask.closest('[data-record-key]'),chat);assert.match(ask.className,/waiting/);
  assert.match(ui.text(ask),/Should I hand this over\?/);assert.match(ui.ownText(chat),/Claude[\s\S]*Workshop App/);assert.doesNotMatch(ui.text(desk),/Asked in/);
  assert.deepEqual(actionsOf(chat).filter(action=>action.startsWith('project-')),[],'the chat keeps one set of buttons');
  const source=id=>findFold(ui,'project:'+id).querySelector('.project-need-source');
  assert.match(ui.text(source('elsewhere')),/^Claude\s+Loose chat/);assert.doesNotMatch(ui.text(source('elsewhere')),/Asked in|iMac/);
  const link=source('elsewhere').querySelector('[data-need-chat]');assert.equal(link.dataset.needChat,'loose');assert.ok(source('elsewhere').querySelector('[data-copy-title]'));
  link.listeners.click();assert.equal(vm.runInContext('document.activeElement',ui.browser),ui.allCards().find(card=>card.dataset.sessionId==='loose'));
  assert.match(ui.text(source('saved')),/From your saved project notes · Source/);
  assert.match(ui.text(source('gone')),/Asked in a chat Tower no longer lists/);
  assert.match(ui.text(source('mine')),/Marked by you/);
});
test('a chat request in its card has no project buttons; your own needs and missing chats keep theirs in the box',async()=>{
  const ui=browserFixture(),need=(state,origin='request')=>boardFixture([project('desk',['ask'],{title:'Desktop app',attention:{state,origin,sessionId:'ask',reason:'Should I hand this over?'}})]);
  const rows=[session('ask',{fullTitle:'Workshop App',state:'working'})],chat=()=>ui.allCards().find(card=>card.dataset.sessionId==='ask'),box=()=>findFold(ui,'project:desk').querySelector('.project-need');
  await pollPayload(ui,{projectBoard:need('waiting'),sessions:rows});
  assert.match(ui.text(chat().querySelector('.chat-need')),/Should I hand this over\?/);assert.ok(!box());
  assert.deepEqual(actionsOf(chat()).filter(action=>action.startsWith('project-')),[]);
  await pollPayload(ui,{projectBoard:need('later'),sessions:rows});
  assert.match(ui.text(chat().querySelector('.chat-need')),/For later[\s\S]*Should I hand this over\?/);assert.doesNotMatch(chat().querySelector('.chat-need').className,/waiting/);
  assert.deepEqual(actionsOf(chat()).filter(action=>action.startsWith('project-')),[]);assert.ok(!box());
  await pollPayload(ui,{projectBoard:need('resolved'),sessions:rows});
  assert.equal(chat().querySelectorAll('.chat-need').length,0);
  assert.deepEqual(box().querySelectorAll('[data-action]').map(button=>button.dataset.action),['project-waiting']);
  await pollPayload(ui,{projectBoard:need('waiting','manual'),sessions:rows});
  assert.equal(chat().querySelectorAll('.chat-need').length,0,'a need you marked stays yours to clear');
  assert.deepEqual(box().querySelectorAll('[data-action]').map(button=>button.dataset.action),['need-chat','copy-title','project-later','project-resolved']);
  await pollPayload(ui,{projectBoard:need('waiting'),sessions:[]});
  assert.match(ui.text(box()),/Asked in a chat Tower no longer lists/);
  assert.deepEqual(box().querySelectorAll('[data-action]').map(button=>button.dataset.action),['project-later','project-resolved'],'a chat no longer listed leaves Later and Resolved in the box');
});
test('a need from a chat already asking shows the question once, keeping the chat and project controls together',async()=>{
  const ui=browserFixture(),board=boardFixture([project('desk',['ask'],{attention:{state:'waiting',origin:'request',sessionId:'ask',reason:'Allow this write?'}})]);
  await pollPayload(ui,{projectBoard:board,sessions:[session('ask',{state:'decision',question:'Allow this write?',dismissId:'shown'})]});
  let chat=ui.allCards().find(card=>card.dataset.sessionId==='ask');
  assert.equal(findFold(ui,'project:desk').querySelectorAll('.project-need').length,0);
  assert.equal(ui.ownText(chat).split('Allow this write?').length-1,1);assert.equal(chat.querySelectorAll('.chat-need').length,0);
  assert.deepEqual(actionsOf(chat),['open','details','parked','dismiss']);
  assert.equal(jumpButtons(ui).find(button=>button.attributes['aria-label'].startsWith('Needs me:')).dataset.jumpId,'ask');
  await pollPayload(ui,{projectBoard:board,sessions:[session('ask',{state:'decision',question:'Allow a different write?',dismissId:'newer'})]});
  chat=ui.allCards().find(card=>card.dataset.sessionId==='ask');
  assert.match(ui.ownText(chat),/Allow a different write\?/);assert.equal(chat.querySelector('.chat-need').querySelector('.project-need-reason')?.textContent,'Allow this write?');
});
test('the Needs me jump for a need from a shown chat opens and focuses that chat card at any depth, and chip focus survives polls',async()=>{
  const ui=browserFixture(),board=boardFixture([project('desk',['root'],{title:'Desktop app',attention:{state:'waiting',origin:'request',sessionId:'ask',reason:'Should I hand this over?'}})]);
  const rows=[session('root'),session('ask',{fullTitle:'Workshop App',state:'working',relationship:{parentId:'root'}})];
  await pollPayload(ui,{projectBoard:board,sessions:rows});
  const card=findFold(ui,'project:desk');card.open=false;findFold(ui,'project:desk:root').open=false;
  const root=ui.allCards().find(row=>row.dataset.sessionId==='root'),target=ui.allCards().find(row=>row.dataset.sessionId==='ask');
  assert.equal(actionsOf(root).some(action=>action.startsWith('project-')),false);assert.equal(target.querySelectorAll('.chat-need').length,1);
  assert.equal(card.querySelectorAll('.project-need').length,0);assert.equal(vm.runInContext("work.querySelectorAll('[data-jump-project]').length",ui.browser),0);
  const chip=jumpButtons(ui).find(button=>button.attributes['aria-label'].startsWith('Needs me:'));assert.equal(chip.dataset.jumpId,'ask');
  chip.listeners.click();
  assert.equal(card.open,true);assert.equal(findFold(ui,'project:desk:root').open,true);
  assert.equal(vm.runInContext('document.activeElement',ui.browser),target);assert.match(target.className,/record-highlight/);assert.equal(chip.attributes['aria-current'],'location');
  assert.equal(jumpButtons(ui).some(button=>button.attributes['aria-label'].startsWith('Working:')),false,'the asking chat is not also in Working');
  chip.focus();
  await pollPayload(ui,{projectBoard:board,sessions:[rows[0],{...rows[1],summary:recap('Changed progress',NOW)}]});
  assert.match(vm.runInContext('document.activeElement',ui.browser).attributes['aria-label']||'',/^Needs me:/);
});
test('every chat title has a copy button that puts the exact native title on the clipboard without opening or folding anything',async()=>{
  const ui=browserFixture(),board=boardFixture([project('project',['assigned'])]),copied=[];
  vm.runInContext('navigator={clipboard:{writeText:async text=>copiedTitles.push(text)}}',Object.assign(ui.browser,{copiedTitles:copied}));
  await pollPayload(ui,{projectBoard:board,sessions:[session('assigned',{fullTitle:'Tower dashboard: pings live test'}),session('loose',{state:'working'})]});
  const card=ui.allCards().find(row=>row.dataset.sessionId==='assigned'),button=card.querySelector('[data-copy-title]');
  assert.equal(button.attributes['aria-label'],'Copy title: Tower dashboard: pings live test');
  let prevented=0;const event={preventDefault(){prevented++;},stopPropagation(){}};
  await button.listeners.click(event);
  assert.deepEqual(copied,['Tower dashboard: pings live test']);assert.equal(prevented,1);assert.match(button.className,/copied/);assert.equal(button.title,'Copied');
  const fold=findFold(ui,'other-card:loose'),foldButton=fold.children[0].querySelector('[data-copy-title]');
  await foldButton.listeners.click(event);
  assert.equal(copied[1],'Full native conversation loose');assert.equal(fold.open,false);assert.equal(prevented,2);
  card.querySelector('[data-copy-title]').focus();
  await pollPayload(ui,{projectBoard:board,sessions:[session('assigned',{fullTitle:'Tower dashboard: pings live test',summary:recap('A changed recap',NOW)}),session('loose',{state:'working'})]});
  assert.equal(vm.runInContext('document.activeElement',ui.browser),ui.allCards().find(row=>row.dataset.sessionId==='assigned').querySelector('[data-copy-title]'));
  vm.runInContext("navigator={clipboard:{writeText:async()=>{throw new Error('blocked');}}}",ui.browser);
  await ui.allCards().find(row=>row.dataset.sessionId==='assigned').querySelector('[data-copy-title]').listeners.click(event);
  assert.match(ui.text(vm.runInContext("document.getElementById('notice')",ui.browser)),/Could not copy the title/);
});
test('a parent card spins while a spin-off at any depth is working, and stops when it finishes',async()=>{
  const ui=browserFixture(),board=boardFixture([project('project')]);
  const rows=state=>[session('root'),session('mid',{relationship:{parentId:'root'}}),session('leaf',{state,relationship:{parentId:'mid'}}),session('alone')];
  const spinner=id=>findFold(ui,'other-card:'+id).children[0].querySelector('.title-spinner');
  await pollPayload(ui,{projectBoard:board,sessions:rows('working')});
  assert.equal(spinner('root')?.attributes['aria-hidden'],'true');assert.match(ui.text(findFold(ui,'other-card:root').children[0]),/Related chat working/);assert.equal(spinner('alone'),null);
  const leafCard=ui.allCards().find(card=>card.dataset.sessionId==='leaf'),midCard=ui.allCards().find(card=>card.dataset.sessionId==='mid');
  assert.equal(leafCard.querySelector('.title-spinner').attributes['aria-label'],'Working');assert.equal(midCard.querySelector('.title-spinner').attributes['aria-hidden'],'true');
  await pollPayload(ui,{projectBoard:board,sessions:rows('finished')});
  assert.equal(spinner('root'),null);assert.equal(ui.allCards().find(card=>card.dataset.sessionId==='mid').querySelector('.title-spinner'),null);
  await pollPayload(ui,{projectBoard:board,sessions:[session('root',{state:'working'}),session('mid',{state:'working',relationship:{parentId:'root'}})]});
  assert.equal(spinner('root').attributes['aria-label'],'Working');
});
test('Other work card search and exact related-chat alerts open all required folds without opening another card',async()=>{
  const ui=browserFixture(),board=boardFixture([project('project')]),rows=[session('root',{summary:recap('Distinctive root update',NOW)}),session('child',{state:'decision',dismissId:'exact',question:'Unique approval request?',relationship:{parentId:'root'}}),session('separate')];
  await pollPayload(ui,{projectBoard:board,sessions:rows});
  jumpButtons(ui).find(button=>button.dataset.jumpId==='child').listeners.click();
  assert.equal(findFold(ui,'other-work').open,true);assert.equal(findFold(ui,'other-card:root').open,true);assert.equal(findFold(ui,'other:root').open,true);assert.equal(findFold(ui,'other-card:separate').open,false);
  assert.equal(vm.runInContext('document.activeElement',ui.browser),ui.allCards().find(card=>card.dataset.sessionId==='child'));
  for(const query of ['distinctive','unique approval']) {
    findFold(ui,'other-card:root').open=false;vm.runInContext(`search.value=${JSON.stringify(query)};renderWork(true)`,ui.browser);
    assert.equal(findFold(ui,'other-card:root').open,true);assert.equal(ui.allCards().some(card=>card.dataset.sessionId==='separate'),false);
    if(query==='unique approval')assert.equal(findFold(ui,'other:root').open,true);
  }
  assert.equal(ui.requests.some(call=>call.url!=='/api/sessions'),false);
});
test('Other work card folds and header focus survive changed polls and responsive rebuilds',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one')]),rows=[session('one'),session('two')];await pollPayload(ui,{projectBoard:board,sessions:rows});
  findFold(ui,'other-work').open=true;findFold(ui,'other-card:one').open=true;findFold(ui,'other:one').open=true;findFold(ui,'other-card:two').open=false;findFold(ui,'other-card:two').children[0].focus();
  await pollPayload(ui,{projectBoard:board,sessions:[{...rows[0],summary:recap('Changed update',NOW)},rows[1]]});
  for(const width of [820,390,980]) {
    ui.resize(width);assert.equal(findFold(ui,'other-card:one').open,true);assert.equal(findFold(ui,'other:one').open,true);assert.equal(findFold(ui,'other-card:two').open,false);
    assert.equal(vm.runInContext('document.activeElement',ui.browser),findFold(ui,'other-card:two').children[0]);
  }
  for(const folded of [false,true]) {
    findFold(ui,'other-card:one').open=!folded;const header=findFold(ui,'other-card:one').children[0],open=header.querySelectorAll('[data-action]').find(button=>button.dataset.action==='open');open.focus();
    await vm.runInContext("act(allSessions.find(session=>session.id==='one'),'open')",ui.browser);
    assert.equal(findFold(ui,'other-card:one').open,!folded);assert.equal(vm.runInContext('document.activeElement.dataset.action',ui.browser),'open');
  }
  assert.equal(ui.requests.filter(call=>call.url==='/api/focus').length,2);assert.equal(ui.requests.some(call=>call.url==='/api/organize'||call.url==='/api/dismiss'),false);
});
test('project assignment uses exact IDs, direct child mappings beat ancestor inheritance, and duplicates have one owner',()=>{
  const rows=[session('parent'),session('child',{relationship:{parentId:'parent'}}),session('grandchild',{relationship:{parentId:'child'}}),session('same-title',{fullTitle:'Full native conversation parent',context:{cwd:'/same/repo'}}),session('cycle-a',{relationship:{parentId:'cycle-b'}}),session('cycle-b',{relationship:{parentId:'cycle-a'}})];
  const selected=rules.selectProjectBoard(boardFixture([project('desktop',['parent','parent','missing']),project('tagging',['child','parent']),project('tagging',['same-title'])]),rows,NOW);
  assert.deepEqual(Array.from(selected.assignments,pair=>Array.from(pair)),[['parent','desktop'],['child','tagging'],['grandchild','tagging']]);
  assert.equal(selected.parents.has('child'),false);assert.equal(selected.parents.get('grandchild'),'child');
  assert.deepEqual(ids(selected.roots),['parent','child','same-title','cycle-a','cycle-b']);
  assert.equal(selected.assignments.has('missing'),false);assert.equal(selected.projects.length,2);
});
test('unassigned descendants inherit their nearest explicit ancestor and unknown roots stay visible',()=>{
  const rows=[session('old',{lastActivity:0}),session('active',{state:'working',relationship:{parentId:'old'}}),session('deep',{relationship:{parentId:'active'}}),session('unmatched'),session('unrelated-old',{lastActivity:0})];
  const selected=rules.selectProjectBoard(boardFixture([project('one',['old'])]),rows,NOW);
  assert.equal(selected.assignments.get('deep'),'one');assert.deepEqual(ids(selected.roots),['old','unmatched']);
  assert.deepEqual(ids(selected.alerts),['active']);assert.equal(selected.active.has('unrelated-old'),false);
});
test('ordinary parked chats leave active project rows, while current parked requests and working children remain visible',()=>{
  const rows=[session('parked',{state:'working',parked:true}),session('active-child',{state:'working',relationship:{parentId:'parked'}}),session('ask',{state:'decision',parked:true,question:'Approve this?',dismissId:'new'}),session('earlier',{state:'decision',dismissed:true}),session('live-child',{state:'working',relationship:{parentId:'earlier'}})];
  const selected=rules.selectProjectBoard(boardFixture([project('one',['parked','ask','earlier'])]),rows,NOW);
  assert.deepEqual(ids(selected.roots),['active-child','ask','live-child']);assert.deepEqual(ids(selected.alerts),['active-child','ask','live-child']);
  assert.equal(selected.parents.has('active-child'),false);assert.equal(selected.parents.has('live-child'),false);
});
test('the real board renders dated source notes and separate live chats with no example activity or per-note dots',async()=>{
  const ui=browserFixture();await pollPayload(ui,{projectBoard:boardFixture([project('desktop',['parent']),project('tagging',['child'])]),sessions:[session('parent',{state:'working'}),session('child',{state:'decision',question:'Allow this write?',dismissId:'shown',relationship:{parentId:'parent'}}),session('unmatched')]});
  const work=vm.runInContext('work',ui.browser),text=ui.text(work);
  assert.equal(work.querySelectorAll('.project-card').length,2);assert.match(text,/Project notes copied/);assert.match(text,/Source updated/);assert.match(text,/Chat activity live/);assert.match(text,/A detailed source note stays readable/);
  assert.match(text,/Other work/);assert.match(text,/Full native conversation unmatched/);assert.doesNotMatch(text,/Example activity|illustrative/);
  assert.equal(ui.allCards().filter(card=>card.dataset.sessionId==='child').length,1);
  assert.ok(ui.allCards().find(card=>card.dataset.sessionId==='child').closest('.project-card').dataset.detailKey==='project:tagging');
  for(const list of work.querySelectorAll('.project-notes'))assert.equal(list.querySelectorAll('.activity-dot').length,0);
  for(const card of work.querySelectorAll('.project-card'))assert.equal(card.children[0].children[0].className,'fold-chevron');
  assert.equal(work.querySelectorAll('.needs-pulse').length,3);assert.ok(work.querySelectorAll('.working-dot').length>=1);
});
test('an alert opens every enclosing project and related-chat fold, then scrolls and focuses its actual request',async()=>{
  const ui=browserFixture();await pollPayload(ui,{projectBoard:boardFixture([project('one',['root'])]),sessions:[session('root'),session('child',{relationship:{parentId:'root'}}),session('ask',{state:'decision',dismissId:'new',question:'Approve this exact request?',relationship:{parentId:'child'}})]});
  const card=findFold(ui,'project:one');card.open=false;
  const button=jumpButtons(ui).find(button=>button.dataset.jumpId==='ask');button.listeners.click();
  const target=ui.allCards().find(row=>row.dataset.sessionId==='ask');
  assert.equal(card.open,true);assert.equal(findFold(ui,'project:one:root').open,true);assert.equal(findFold(ui,'project:one/root:child').open,true);
  assert.equal(vm.runInContext('document.activeElement',ui.browser),target);assert.equal(target.scrolled.block,'center');assert.match(target.className,/record-highlight/);assert.equal(button.attributes['aria-current'],'location');
  assert.equal(ui.requests.some(call=>call.url!=='/api/sessions'),false);
});
test('project stage stays unchanged as chat activity moves from working to a request to turn ended',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one',['one'])]);
  for(const state of ['working','decision','finished']) {
    await pollPayload(ui,{projectBoard:board,sessions:[session('one',{state,question:state==='decision'?'Approve now?':undefined,dismissId:'event'})]});
    assert.equal(findFold(ui,'project:one').querySelector('.project-stage').textContent,'Saved: Built, not live');
    const alerts=jumpButtons(ui);assert.equal(alerts.length,state==='finished'?0:1);
    if(state==='finished'){assert.match(ui.ownText(ui.allCards()[0]),/Turn ended/);assert.equal(vm.runInContext("work.querySelectorAll('.needs-pulse').length+work.querySelectorAll('.working-dot').length",ui.browser),0);}
  }
});
test('saved waiting stages seed outstanding project needs without inventing a live request',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one',['one'],{stage:'wait'})]);board.source.updatedAt='Oct 26, 2:18 PM ET';
  await pollPayload(ui,{projectBoard:board,sessions:[session('one')]});
  const card=findFold(ui,'project:one'),heading=ui.text(card.querySelector('summary'));
  assert.match(heading,/Saved: Waiting on me/);assert.match(heading,/Oct 26, 2:18 PM ET/);
  assert.equal(card.querySelectorAll('.project-attention').length,1);
  assert.equal(jumpButtons(ui).length,0);
  assert.equal(vm.runInContext("work.querySelectorAll('[data-jump-project]').length",ui.browser),1);
  assert.doesNotMatch(ui.text(vm.runInContext('work',ui.browser)),/Nothing waiting on you/);
  assert.match(ui.text(findFold(ui,'notes:one:wait').querySelector('summary')),/Saved: Waiting on me/);
});
test('closed project headers and the top strip retain an outstanding need through chat lifecycle changes',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one',['one'],{stage:'park',attention:{state:'waiting',origin:'request',reason:'Allow this action?'}})]);
  for(const extra of [{state:'decision',dismissId:'e1'},{state:'decision',dismissId:'e1',dismissed:true},{state:'decision',lastActivity:NOW-25*3600000},{state:'working'},{state:'decision',dismissId:'e2'}]) {
    await pollPayload(ui,{projectBoard:board,sessions:[session('one',{question:'Allow this action?',...extra})]});
    const card=findFold(ui,'project:one');card.open=false;
    const active=extra.state==='decision'&&!extra.dismissed&&!extra.lastActivity;
    assert.equal(card.querySelectorAll('.project-attention').length,1);
    assert.equal(jumpButtons(ui).filter(button=>button.attributes['aria-label'].startsWith('Needs me:')).length,active?1:0);
    assert.equal(vm.runInContext("work.querySelectorAll('[data-jump-project]').length",ui.browser),active?0:1);
    assert.equal(card.querySelector('.project-stage').textContent,'Saved: Parked');
    if(active){assert.match(ui.text(card.querySelector('summary')),/Needs me/);assert.equal(card.querySelectorAll('.project-attention')[0].querySelectorAll('.needs-pulse').length,1);}
  }
});
test('project attention uses the same search matches as the top strip without multiplying the badge',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one',['one','two'])]);
  await pollPayload(ui,{projectBoard:board,sessions:[session('one',{state:'decision',fullTitle:'Allow export?',question:'Allow export?'}),session('two',{state:'decision',fullTitle:'Approve import?',question:'Approve import?'}),session('three',{state:'working',fullTitle:'Unrelated work'})]});
  assert.equal(findFold(ui,'project:one').querySelectorAll('.project-attention').length,1);
  vm.runInContext("search.value='allow export';renderWork(true)",ui.browser);
  assert.equal(findFold(ui,'project:one').querySelectorAll('.project-attention').length,1);assert.deepEqual(jumpButtons(ui).map(button=>button.dataset.jumpId),['one']);
  vm.runInContext("search.value='unrelated';renderWork(true)",ui.browser);
  assert.equal(vm.runInContext("work.querySelectorAll('.project-attention').length",ui.browser),0);
  assert.equal(jumpButtons(ui).some(button=>button.attributes['aria-label'].startsWith('Needs me:')),false);
});
test('outstanding project needs persist with no live chat and jump to the project itself',async()=>{
  const ui=browserFixture(),board=boardFixture([project('cloudflare',['gone'],{title:'Cloudflare',stage:'wait',attention:{state:'waiting',origin:'source',reason:'Approve the next local check.'}})]);
  for(const rows of [[],[session('gone',{state:'working'})],[session('gone',{state:'finished'})],[]]) {
    await pollPayload(ui,{projectBoard:board,sessions:rows});
    const card=findFold(ui,'project:cloudflare');card.open=false;
    const chip=vm.runInContext("work.querySelectorAll('[data-jump-project]').find(node=>node.dataset.jumpProject==='cloudflare')",ui.browser);
    assert.ok(chip);assert.equal(card.querySelectorAll('.project-attention').length,1);chip.listeners.click();
    assert.equal(card.open,true);assert.equal(vm.runInContext('document.activeElement',ui.browser),card.querySelector('summary'));
    assert.match(ui.text(card),/Approve the next local check/);
  }
});
test('project Later and Resolved suppress mapped requests while working and unrelated needs remain visible',async()=>{
  const ui=browserFixture();
  for(const state of ['later','resolved']) {
    await pollPayload(ui,{projectBoard:boardFixture([project('one',['ask','work'],{stage:'wait',attention:{state,origin:'manual',reason:'Saved request'}})]),sessions:[session('ask',{state:'decision',question:'Approve?',eventId:'same'}),session('work',{state:'working'}),session('other',{state:'decision',question:'Different request?'})]});
    const card=findFold(ui,'project:one');assert.equal(card.querySelectorAll('.project-attention').length,0);
    assert.deepEqual(jumpButtons(ui).map(button=>button.dataset.jumpId).sort(),['other','work']);
    assert.match(ui.text(card),state==='later'?/For later/:/Resolved here/);
  }
});
test('project need controls persist only the chosen project and remain usable after changed polling',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one',[],{attention:{state:'waiting',origin:'manual',reason:'Choose the next check'}}),project('two')]);
  await pollPayload(ui,{projectBoard:board,sessions:[]});
  const control=findFold(ui,'project:one').querySelectorAll('[data-action]').find(button=>button.dataset.action==='project-later');
  assert.ok(control);control.focus();
  ui.browser.payload={now:NOW,projectBoard:boardFixture([{...board.projects[0],attention:{...board.projects[0].attention,state:'later'}},board.projects[1]]),sessions:[]};
  await control.listeners.click();
  assert.deepEqual(ui.requests.find(call=>call.url==='/api/project').body,{id:'one',attention:'later'});
  assert.equal(ui.requests.some(call=>['/api/organize','/api/dismiss'].includes(call.url)),false);
  assert.equal(vm.runInContext('document.activeElement',ui.browser),findFold(ui,'project:one').querySelector('summary'));
  assert.match(ui.text(findFold(ui,'project:one')),/For later/);
});
test('failed project actions preserve attention and offline controls cannot send a change',async()=>{
  const ui=browserFixture(),payload={projectBoard:boardFixture([project('one',[],{attention:{state:'waiting',origin:'manual',reason:'Choose the next check'}})]),sessions:[]};
  await pollPayload(ui,payload);
  const originalFetch=ui.browser.fetch;
  ui.browser.fetch=async(url,options)=>url==='/api/project'?{ok:false,json:async()=>({ok:false})}:originalFetch(url,options);
  await findFold(ui,'project:one').querySelectorAll('[data-action]').find(button=>button.dataset.action==='project-later').listeners.click();
  assert.equal(findFold(ui,'project:one').querySelectorAll('.project-attention').length,1);
  assert.match(vm.runInContext("document.getElementById('notice').textContent",ui.browser),/Could not save/);
  vm.runInContext('online=false;renderWork(true)',ui.browser);
  const controls=findFold(ui,'project:one').querySelectorAll('[data-action]').filter(button=>button.dataset.action.startsWith('project-'));
  assert.ok(controls.every(button=>button.disabled));
  const requestCount=ui.requests.length;await controls[0].listeners.click();assert.equal(ui.requests.length,requestCount);
  assert.equal(findFold(ui,'project:one').querySelectorAll('.project-attention').length,1);
});
test('multiple mapped chat requests have one project alert and a local display title retains exact membership',async()=>{
  const ui=browserFixture();await pollPayload(ui,{projectBoard:boardFixture([project('stable',['first','second'],{title:'Cloudflare',sourceTitle:'Cloudflare trial',attention:{state:'waiting',origin:'request',reason:'Approve the check'}})]),sessions:[session('first',{state:'decision',question:'First?'}),session('second',{state:'decision',question:'Second?'})]});
  const chips=jumpButtons(ui).filter(button=>button.attributes['aria-label'].startsWith('Needs me:'));
  assert.equal(chips.length,1);assert.equal(chips[0].textContent,'Cloudflare');
  assert.equal(findFold(ui,'project:stable').querySelector('h2').textContent,'Cloudflare');
  assert.equal(ui.allCards().filter(card=>card.closest('.project-card')?.dataset.detailKey==='project:stable').length,2);
});
test('an ended parent with a working descendant says related chat working and links directly to the child',async()=>{
  const ui=browserFixture();await pollPayload(ui,{projectBoard:boardFixture([project('one',['parent'])]),sessions:[session('parent'),session('child',{state:'working',relationship:{parentId:'parent'}})]});
  const parent=ui.allCards().find(row=>row.dataset.sessionId==='parent');assert.match(ui.ownText(parent),/Related chat working/);assert.doesNotMatch(ui.ownText(parent),/Turn ended/);
  assert.deepEqual(jumpButtons(ui).map(button=>button.dataset.jumpId),['child']);
});
test('a parent decision retains its orange request while a related child is still working, and source freshness stays verbatim',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one',['parent'])]);board.source.updatedAt='Oct 26, 2:18 PM ET';
  await pollPayload(ui,{projectBoard:board,sessions:[session('parent',{state:'decision',question:'Give permission?',dismissId:'exact'}),session('child',{state:'working',relationship:{parentId:'parent'}})]});
  const parent=ui.allCards().find(row=>row.dataset.sessionId==='parent');assert.match(ui.ownText(parent),/Needs me/);assert.doesNotMatch(ui.ownText(parent),/Related chat working/);assert.equal(parent.querySelectorAll('.needs-pulse').length,1);
  assert.equal(parent.querySelector('.title-spinner').attributes['aria-label'],'Related chat working');
  assert.deepEqual(jumpButtons(ui).map(button=>button.dataset.jumpId),['parent']);assert.match(ui.text(vm.runInContext('work',ui.browser)),/Source updated Oct 26, 2:18 PM ET/);assert.doesNotMatch(ui.text(vm.runInContext('work',ui.browser)),/date unavailable/);
});
test('a deeply related live alert always has a real rendered target',async()=>{
  const ui=browserFixture(),rows=[session('root')];for(let depth=1;depth<=15;depth++)rows.push(session('child-'+depth,{relationship:{parentId:depth===1?'root':'child-'+(depth-1)},state:depth===15?'working':'finished'}));
  await pollPayload(ui,{projectBoard:boardFixture([project('one',['root'])]),sessions:rows});
  const button=jumpButtons(ui).find(button=>button.dataset.jumpId==='child-15');button.listeners.click();const target=ui.allCards().find(row=>row.dataset.sessionId==='child-15');assert.ok(target);assert.equal(vm.runInContext('document.activeElement',ui.browser),target);
});
test('closed project and note folds, scroll, and keyboard focus survive changed data polls',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one',['one'])]);await pollPayload(ui,{projectBoard:board,sessions:[session('one')]});
  findFold(ui,'project:one').open=false;findFold(ui,'notes:one:built').open=false;findFold(ui,'project:one').querySelector('summary').focus();
  vm.runInContext('window.scrollY=217;window.scrollTo=(x,y)=>{window.restoredY=y;}',ui.browser);
  await pollPayload(ui,{projectBoard:board,sessions:[session('one',{state:'working',summary:recap('A new live update',NOW)})]});
  assert.equal(findFold(ui,'project:one').open,false);assert.equal(findFold(ui,'notes:one:built').open,false);assert.equal(vm.runInContext('document.activeElement',ui.browser),findFold(ui,'project:one').querySelector('summary'));assert.equal(vm.runInContext('window.restoredY',ui.browser),217);
});
test('jump highlight and the focused actual chat survive polling without moving scroll',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one',['one'])]);await pollPayload(ui,{projectBoard:board,sessions:[session('one',{state:'working'})]});
  jumpButtons(ui)[0].listeners.click();vm.runInContext('window.scrollY=410;window.scrollTo=(x,y)=>{window.restoredY=y;}',ui.browser);
  await pollPayload(ui,{projectBoard:board,sessions:[session('one',{state:'working',summary:recap('Newer text',NOW)})]});
  const card=ui.allCards()[0];assert.equal(vm.runInContext('document.activeElement',ui.browser),card);assert.match(card.className,/record-highlight/);assert.equal(vm.runInContext('window.restoredY',ui.browser),410);
});
test('an unactivated top activity jump keeps keyboard focus by exact chat ID across changed polls',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one',['first','second'])]);await pollPayload(ui,{projectBoard:board,sessions:[session('first',{state:'working'}),session('second',{state:'working'})]});
  jumpButtons(ui).find(button=>button.dataset.jumpId==='second').focus();vm.runInContext('window.scrollY=136;window.scrollTo=(x,y)=>{window.restoredY=y;}',ui.browser);
  await pollPayload(ui,{projectBoard:board,sessions:[session('first',{state:'working'}),session('second',{state:'working',summary:recap('Changed progress',NOW)})]});
  const focused=vm.runInContext('document.activeElement',ui.browser);assert.equal(focused,jumpButtons(ui).find(button=>button.dataset.jumpId==='second'));assert.equal(vm.runInContext('window.restoredY',ui.browser),136);assert.equal(ui.allCards().some(card=>card.className.includes('record-highlight')),false);
});
test('search includes project notes, opens project folds, and All sessions remains the raw tracked list',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one',['one'],{notes:[{status:'built',text:'Distinctive catalog evidence'}]}),project('two')]);
  await pollPayload(ui,{projectBoard:board,sessions:[session('one'),session('unmatched'),session('parked',{parked:true})]});
  vm.runInContext("search.value='distinctive';renderWork(true)",ui.browser);
  assert.equal(vm.runInContext("work.querySelectorAll('.project-card').length",ui.browser),1);assert.equal(findFold(ui,'project:one').open,true);assert.equal(findFold(ui,'notes:one:built').open,true);
  vm.runInContext("search.value='';setView('all')",ui.browser);assert.deepEqual(ui.cards().map(card=>card.dataset.sessionId).sort(),['one','parked','unmatched']);assert.equal(vm.runInContext("work.querySelectorAll('.project-card').length",ui.browser),0);
});
test('invalid or absent imports retain the desk and remote viewers never render private project notes',async()=>{
  const ui=browserFixture();await pollPayload(ui,{projectBoardStatus:'unavailable',sessions:[session('one')]});
  assert.match(ui.text(vm.runInContext('work',ui.browser)),/Project notes could not be loaded/);assert.equal(ui.cards().length,1);
  await pollPayload(ui,{sessions:[session('one')]});assert.doesNotMatch(ui.text(vm.runInContext('work',ui.browser)),/Project notes could not be loaded/);
  await pollPayload(ui,{viewer:'remote',projectBoard:boardFixture([project('private',['one'])]),sessions:[session('one',{machine:'iMac'})]});
  assert.doesNotMatch(ui.text(vm.runInContext('work',ui.browser)),/Project private|A detailed source note/);assert.deepEqual(actionsOf(ui.cards()[0]),['details']);
});
test('the board uses native details, local fonts, bold leading chevrons, and reduced-motion rules',()=>{
  assert.match(html,/font:900 23px\/14px/);assert.match(html,/prefers-reduced-motion:reduce/);assert.match(html,/\.needs-pulse,\.working-dot,\.title-spinner\{animation:none\}/);
  assert.doesNotMatch(html,/@import|fonts\.googleapis|data-lucide/);assert.doesNotMatch(html,/\.project-notes[^}]*::before/);
});

// Sound cues: a chime when a chat newly needs you, a ding when work finishes.
const cueRun=(memory,rows)=>rules.soundCues(memory,rows,NOW);
test('sound cues: the first poll only seeds, a new request chimes once, and a new event on the same chat chimes again',()=>{
  const ask=session('ask',{state:'decision',eventId:'e1',dismissId:'decision:1'}),busy=session('busy',{state:'working',eventId:null});
  let step=cueRun(null,[ask,busy]);assert.equal(step.cue,null);
  step=cueRun(step.memory,[ask,busy]);assert.equal(step.cue,null);
  const fresh=session('fresh',{state:'decision',eventId:'f1'});
  step=cueRun(step.memory,[ask,busy,fresh]);assert.equal(step.cue,'needs');
  step=cueRun(step.memory,[ask,busy,fresh]);assert.equal(step.cue,null);
  step=cueRun(step.memory,[ask,busy,fresh]);assert.equal(step.cue,null);
  step=cueRun(step.memory,[{...ask,eventId:'e2'},busy,fresh]);assert.equal(step.cue,'needs');
  step=cueRun(step.memory,[{...ask,eventId:'e2'},busy,fresh]);assert.equal(step.cue,null);
  step=cueRun(step.memory,[{...ask,eventId:'e2'},{...busy,state:'decision',eventId:'q:1'},fresh]);assert.equal(step.cue,'needs');
});
test('sound cues: working to finished dings once; other routes to finished stay silent',()=>{
  let step=cueRun(null,[session('a',{state:'working'}),session('b',{state:'unknown'}),session('c',{state:'finished',eventId:'c1'})]);
  step=cueRun(step.memory,[session('a',{state:'finished',eventId:'a1'}),session('b',{state:'unknown'}),session('c',{state:'finished',eventId:'c1'})]);assert.equal(step.cue,'finished');
  step=cueRun(step.memory,[session('a',{state:'finished',eventId:'a1'}),session('b',{state:'finished',eventId:'b1'}),session('c',{state:'finished',eventId:'c2'})]);assert.equal(step.cue,null);
  step=cueRun(step.memory,[session('new',{state:'finished',eventId:'n1'})]);assert.equal(step.cue,null);
});
test('sound cues: a request and a finish in the same poll play only the request chime',()=>{
  let step=cueRun(null,[session('a',{state:'working'}),session('b',{state:'working'})]);
  step=cueRun(step.memory,[session('a',{state:'finished',eventId:'a1'}),session('b',{state:'decision',eventId:'b1'})]);assert.equal(step.cue,'needs');
});
test('sound cues: dismissed and earlier requests never chime, while a fresh request kept for later does',()=>{
  let step=cueRun(null,[]);
  step=cueRun(step.memory,[session('dismissed',{state:'decision',eventId:'d1',dismissed:true}),session('old',{state:'decision',eventId:'o1',lastActivity:NOW-2*86400000})]);assert.equal(step.cue,null);
  step=cueRun(step.memory,[session('kept',{state:'decision',eventId:'k1',parked:true})]);assert.equal(step.cue,'needs');
});
test('sound cues: rows from a newly seen Mac seed silently, then count like local rows, and a returning row does not replay',()=>{
  let step=cueRun(null,[session('own',{state:'finished'})]);
  const far=(state,extra={})=>session('Mac mini:claude:far',{machine:'Mac mini',peer:true,viewOnly:true,state,...extra});
  step=cueRun(step.memory,[session('own',{state:'finished'}),far('decision',{eventId:'x1'}),{...far('working'),id:'Mac mini:claude:busy'}]);assert.equal(step.cue,null);
  step=cueRun(step.memory,[session('own',{state:'finished'}),far('decision',{eventId:'x1'}),{...far('finished',{eventId:'b1'}),id:'Mac mini:claude:busy'}]);assert.equal(step.cue,'finished');
  step=cueRun(step.memory,[session('own',{state:'finished'}),far('decision',{eventId:'x2'})]);assert.equal(step.cue,'needs');
  step=cueRun(step.memory,[session('own',{state:'finished'})]);assert.equal(step.cue,null);
  step=cueRun(step.memory,[session('own',{state:'finished'}),far('decision',{eventId:'x2'})]);assert.equal(step.cue,null);
});
function fakeAudio() {
  const log={contexts:0,resumed:0,oscillators:[],gains:[]};
  class Param { constructor(){this.events=[];} setValueAtTime(value,at){this.events.push([value,at]);} exponentialRampToValueAtTime(value,at){this.events.push([value,at]);} linearRampToValueAtTime(value,at){this.events.push([value,at]);} }
  class AudioContext {
    constructor(){log.contexts++;this.state='suspended';this.currentTime=0;this.destination={};}
    resume(){log.resumed++;this.state='running';return Promise.resolve();}
    createOscillator(){const node={frequency:new Param(),connect:target=>target,start(at){node.startAt=at;},stop(at){node.stopAt=at;}};log.oscillators.push(node);return node;}
    createGain(){const node={gain:new Param(),connect:target=>target};log.gains.push(node);return node;}
  }
  return {AudioContext,log};
}
const soundButtons=ui=>vm.runInContext("work.querySelectorAll('.sound-toggle')",ui.browser);
const memoryStorage=(initial={})=>{const values=new Map(Object.entries(initial));return {values,getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>{values.set(key,String(value));}};};
test('only the desktop panel plays sounds: a quiet rising chime for a request, one lower ding for a finish, and mutes are respected',async()=>{
  const storage=memoryStorage(),ui=browserFixture({storage}),audio=fakeAudio(),board=boardFixture([project('one',['a','b','c'])]);
  ui.browser.window.AudioContext=audio.AudioContext;
  const rows=(a,b,c)=>[session('a',a),session('b',b),session('c',c)];
  await pollPayload(ui,{projectBoard:board,sessions:rows({state:'working'},{state:'working'},{state:'finished'})});
  await pollPayload(ui,{projectBoard:board,sessions:rows({state:'decision',eventId:'a1'},{state:'working'},{state:'finished'})});
  assert.equal(audio.log.contexts,0,'a browser tab without the panel bridge stays silent');
  ui.browser.window.towerLayout={report(){}};
  await pollPayload(ui,{projectBoard:board,sessions:rows({state:'decision',eventId:'a2'},{state:'working'},{state:'finished'})});
  assert.equal(audio.log.contexts,1);assert.equal(audio.log.resumed,1);assert.equal(audio.log.oscillators.length,2);
  const [low,high]=audio.log.oscillators.map(node=>node.frequency.events[0][0]);assert.ok(high>low,'the chime rises');
  const peaks=audio.log.gains.map(node=>Math.max(...node.gain.events.map(event=>event[0])));
  for(const peak of peaks)assert.ok(peak>=0.1&&peak<=0.18,'quiet peak '+peak);
  for(const node of audio.log.gains)assert.ok(node.gain.events[0][0]<=0.001&&node.gain.events.at(-1)[0]<=0.001,'starts and ends silent');
  assert.ok(Math.max(...audio.log.oscillators.map(node=>node.stopAt))-Math.min(...audio.log.oscillators.map(node=>node.startAt))<=0.5);
  await pollPayload(ui,{projectBoard:board,sessions:rows({state:'decision',eventId:'a2'},{state:'working'},{state:'finished'})});
  assert.equal(audio.log.oscillators.length,2,'an unchanged request stays quiet');
  await pollPayload(ui,{projectBoard:board,sessions:rows({state:'decision',eventId:'a2'},{state:'finished',eventId:'b1'},{state:'working'})});
  assert.equal(audio.log.oscillators.length,3,'one ding for a finish');
  assert.ok(audio.log.oscillators[2].frequency.events[0][0]<low,'the ding is lower than the chime');
  assert.ok(Math.max(...audio.log.gains[2].gain.events.map(event=>event[0]))<=Math.min(...peaks),'the ding is softer');
  const needs=soundButtons(ui).find(button=>button.id==='sound-needs');needs.listeners.click();
  assert.equal(storage.values.get('tower.sound.needs'),'off');
  await pollPayload(ui,{projectBoard:board,sessions:rows({state:'decision',eventId:'a3'},{state:'finished',eventId:'b1'},{state:'working'})});
  assert.equal(audio.log.oscillators.length,3,'muted request chime');
  await pollPayload(ui,{projectBoard:board,sessions:rows({state:'decision',eventId:'a3'},{state:'finished',eventId:'b1'},{state:'finished',eventId:'c1'})});
  assert.equal(audio.log.oscillators.length,4,'the finish ding has its own switch');
  soundButtons(ui).find(button=>button.id==='sound-finished').listeners.click();
  await pollPayload(ui,{projectBoard:board,sessions:rows({state:'decision',eventId:'a3'},{state:'working'},{state:'finished',eventId:'c1'})});
  await pollPayload(ui,{projectBoard:board,sessions:rows({state:'decision',eventId:'a3'},{state:'finished',eventId:'b2'},{state:'finished',eventId:'c1'})});
  assert.equal(audio.log.oscillators.length,4,'muted finish ding');
  soundButtons(ui).find(button=>button.id==='sound-needs').listeners.click();
  await pollPayload(ui,{projectBoard:board,sessions:rows({state:'decision',eventId:'a3'},{state:'finished',eventId:'b2'},{state:'finished',eventId:'c1'})});
  assert.equal(audio.log.oscillators.length,4,'unmuting does not replay a request seen while muted');
});
test('sound switches sit beside the Needs me and Working labels, persist, and keep focus across a rebuilt strip',async()=>{
  const storage=memoryStorage(),ui=browserFixture({storage}),board=boardFixture([project('one',['one'])]);
  await pollPayload(ui,{projectBoard:board,sessions:[session('one',{state:'working'})]});
  const strip=vm.runInContext("work.querySelector('.project-alerts')",ui.browser);
  const groups=strip.children.filter(node=>node.className==='alert-group');
  assert.equal(groups.length,2);
  for(const [group,kind,id,label,tip] of [[groups[0],'needs','sound-needs','Needs me sound','Mute the Needs me sound'],[groups[1],'working','sound-finished','Working chat finished sound','Mute the sound when a working chat finishes']]) {
    assert.match(group.children[0].className,new RegExp('activity-label '+kind));
    const button=group.children[1];
    assert.equal(button.id,id);assert.equal(button.tagName,'button');assert.equal(button.type,'button');
    assert.match(button.className,new RegExp('sound-toggle '+kind));
    assert.equal(button.attributes['aria-pressed'],'false');assert.equal(button.attributes['aria-label'],label);
    assert.ok(button.title.startsWith(tip),button.title);assert.ok(!button.title.includes('\u2014'));assert.match(button.innerHTML,/<svg[^>]*aria-hidden="true"/);
  }
  let needs=soundButtons(ui).find(button=>button.id==='sound-needs');
  needs.focus();needs.listeners.click();
  assert.equal(needs.attributes['aria-pressed'],'true');assert.equal(needs.attributes['aria-label'],'Needs me sound','the name stays fixed; aria-pressed carries the state');assert.ok(needs.title.startsWith('Unmute the Needs me sound'));
  const finishedSwitch=soundButtons(ui).find(button=>button.id==='sound-finished');finishedSwitch.listeners.click();assert.equal(finishedSwitch.attributes['aria-label'],'Working chat finished sound');assert.ok(finishedSwitch.title.startsWith('Unmute the sound when a working chat finishes'));finishedSwitch.listeners.click();
  assert.equal(storage.values.get('tower.sound.needs'),'off');assert.equal(storage.values.get('tower.sound.finished'),'on');
  vm.runInContext('window.scrollY=180;window.scrollTo=(x,y)=>{window.restoredY=y;}',ui.browser);
  await pollPayload(ui,{projectBoard:board,sessions:[session('one',{state:'working',summary:recap('Changed progress',NOW)})]});
  needs=soundButtons(ui).find(button=>button.id==='sound-needs');
  assert.notEqual(vm.runInContext("work.querySelector('.project-alerts')",ui.browser),strip,'the strip was rebuilt');
  assert.equal(needs.attributes['aria-pressed'],'true');assert.equal(vm.runInContext('document.activeElement',ui.browser),needs);assert.equal(vm.runInContext('window.restoredY',ui.browser),180);
  assert.equal(soundButtons(ui).find(button=>button.id==='sound-finished').attributes['aria-pressed'],'false');
  const reopened=browserFixture({storage});await pollPayload(reopened,{projectBoard:board,sessions:[session('one',{state:'working'})]});
  assert.equal(soundButtons(reopened).find(button=>button.id==='sound-needs').attributes['aria-pressed'],'true');
  const blocked=browserFixture({storage:{getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}}});
  await pollPayload(blocked,{projectBoard:board,sessions:[session('one',{state:'working'})]});
  const fallback=soundButtons(blocked).find(button=>button.id==='sound-needs');assert.equal(fallback.attributes['aria-pressed'],'false');
  assert.doesNotThrow(()=>fallback.listeners.click());assert.equal(fallback.attributes['aria-pressed'],'true');
});

// A finished chat lingers grey in Working for ten seconds, then leaves.
test('sound cues report exactly which chats finished this poll, never while seeding',()=>{
  let step=cueRun(null,[session('a',{state:'working'}),session('b',{state:'working'})]);assert.deepEqual(Array.from(step.finished),[]);
  step=cueRun(step.memory,[session('a',{state:'finished',eventId:'a1'}),session('b',{state:'decision',eventId:'b1'})]);assert.deepEqual(Array.from(step.finished),['a']);assert.equal(step.cue,'needs');
  step=cueRun(step.memory,[session('a',{state:'finished',eventId:'a1'}),session('b',{state:'decision',eventId:'b1'})]);assert.deepEqual(Array.from(step.finished),[]);
});
test('the board lists a just-finished chat among working alerts in place, but never a parked or unlisted one',()=>{
  const rows=[session('first',{state:'working'}),session('done'),session('parked-done',{parked:true}),session('other-done'),session('last',{state:'working'})];
  const board=boardFixture([project('one',rows.map(row=>row.id))]);
  assert.deepEqual(ids(rules.selectProjectBoard(board,rows,NOW).alerts),['first','last']);
  assert.deepEqual(ids(rules.selectProjectBoard(board,rows,NOW,new Set(['done','parked-done'])).alerts),['first','done','last']);
});
function fixtureClock(ui) {
  const RealDate=Date,timers=[];let at=RealDate.now();
  class FakeDate extends RealDate { constructor(...args){if(args.length)super(...args);else super(at);} static now(){return at;} }
  ui.browser.Date=FakeDate;
  ui.browser.setTimeout=(callback,ms)=>{timers.push({callback,due:at+Number(ms||0),cleared:false});return timers.length;};
  ui.browser.clearTimeout=id=>{if(timers[id-1])timers[id-1].cleared=true;};
  return {now:()=>at,advance(ms){at+=ms;},runDue(){for(const timer of timers.filter(timer=>!timer.cleared&&timer.due<=at)){timer.cleared=true;timer.callback();}},pending:()=>timers.filter(timer=>!timer.cleared)};
}
const workingGroup=ui=>vm.runInContext("work.querySelector('.project-alerts')",ui.browser).children.filter(node=>node.className==='alert-group')[1];
const chipsOf=group=>group.children.filter(node=>node.dataset.jumpId);
test('a chat that finishes stays grey in Working for ten seconds, keeps its place, still jumps, then leaves on its own',async()=>{
  const ui=browserFixture(),clock=fixtureClock(ui),board=boardFixture([project('one',['a','b'])]);
  await pollPayload(ui,{projectBoard:board,sessions:[session('a',{state:'working'}),session('b',{state:'working'})]});
  await pollPayload(ui,{projectBoard:board,sessions:[session('a',{state:'finished',eventId:'a1'}),session('b',{state:'working'})]});
  let chips=chipsOf(workingGroup(ui));
  assert.deepEqual(chips.map(chip=>chip.dataset.jumpId),['a','b']);
  assert.match(chips[0].className,/just-finished/);assert.doesNotMatch(chips[1].className,/just-finished/);
  assert.match(chips[0].attributes['aria-label'],/^Finished just now: /);assert.match(chips[0].title,/Finished just now/);
  assert.match(workingGroup(ui).children[0].children[0].className,/working-dot/,'b is still working');
  assert.match(html,/\.jump\.just-finished\{[^}]*color:var\(--muted\)/);
  clock.advance(9000);await pollPayload(ui,{projectBoard:board,sessions:[session('a',{state:'finished',eventId:'a1'}),session('b',{state:'working'})]});
  chips=chipsOf(workingGroup(ui));assert.match(chips[0].className,/just-finished/);
  chips[0].listeners.click();assert.equal(vm.runInContext('document.activeElement',ui.browser),ui.allCards().find(card=>card.dataset.sessionId==='a'));
  const expiry=clock.pending().filter(timer=>timer.due>clock.now()&&timer.due<=clock.now()+1100);
  assert.equal(expiry.length,1,'one re-render is scheduled for the expiry');
  clock.advance(1100);clock.runDue();
  assert.deepEqual(chipsOf(workingGroup(ui)).map(chip=>chip.dataset.jumpId),['b']);
  assert.equal(vm.runInContext('recentlyFinished.size',ui.browser),0);
});
test('only grey chips still hide the empty message, and it returns once they leave',async()=>{
  const ui=browserFixture(),clock=fixtureClock(ui),board=boardFixture([project('one',['a'])]);
  await pollPayload(ui,{projectBoard:board,sessions:[session('a',{state:'working'})]});
  await pollPayload(ui,{projectBoard:board,sessions:[session('a',{state:'finished',eventId:'a1'})]});
  const group=workingGroup(ui);
  assert.equal(chipsOf(group).length,1);assert.equal(group.querySelectorAll('.alert-empty').length,0);
  assert.doesNotMatch(group.children[0].children[0].className,/working-dot/,'nothing is spinning for a finished chat');
  clock.advance(10200);clock.runDue();
  assert.equal(chipsOf(workingGroup(ui)).length,0);assert.match(ui.text(workingGroup(ui)),/No chats working/);
});
test('no grey chip for a chat that moves to Needs me or is kept for later, and a grey chat that restarts is a normal chip',async()=>{
  const ui=browserFixture(),board=boardFixture([project('one',['a','b']),project('two',['c'])]);fixtureClock(ui);
  const poll=rows=>pollPayload(ui,{projectBoard:board,sessions:rows});
  await poll([session('a',{state:'working'}),session('b',{state:'working',parked:true}),session('c',{state:'working'})]);
  await poll([session('a',{state:'decision',eventId:'a1',question:'Approve?'}),session('b',{state:'finished',eventId:'b1',parked:true}),session('c',{state:'finished',eventId:'c1'})]);
  assert.deepEqual(chipsOf(workingGroup(ui)).map(chip=>chip.dataset.jumpId),['c']);
  assert.equal(jumpButtons(ui).filter(chip=>chip.dataset.jumpId==='a').length,1,'a sits only in Needs me');
  await poll([session('a',{state:'decision',eventId:'a1',question:'Approve?'}),session('b',{state:'finished',eventId:'b1',parked:true}),session('c',{state:'working'})]);
  const chips=chipsOf(workingGroup(ui));assert.deepEqual(chips.map(chip=>chip.dataset.jumpId),['c']);
  assert.doesNotMatch(chips[0].className,/just-finished/);assert.match(chips[0].attributes['aria-label'],/^Working: /);
  assert.equal(vm.runInContext('recentlyFinished.has("c")',ui.browser),false);
});
test('a project that needs you sits only in Needs me, never also in Working',async()=>{
  const ui=browserFixture(),board=boardFixture([project('cloudflare',['ask','busy'],{title:'Cloudflare'}),project('search',['tuning'],{title:"Search tuning",stage:'wait',attention:{state:'waiting',origin:'source',reason:'Approve the next check.'}}),project('tower',['pings'],{title:'Tower'})]);
  await pollPayload(ui,{projectBoard:board,sessions:[session('ask',{state:'decision',question:'Hand this over?'}),session('busy',{state:'working'}),session('tuning',{state:'working'}),session('pings',{state:'working'})]});
  const needs=vm.runInContext("work.querySelectorAll('[data-jump-need]')",ui.browser).map(button=>button.textContent);
  assert.deepEqual(needs.sort(),['Cloudflare',"Search tuning"]);
  assert.deepEqual(chipsOf(workingGroup(ui)).map(chip=>chip.dataset.jumpId),['pings']);
});
test('review fixes: a chat need agrees with the strip under search, is never hidden in a closed fold, and never borrows saved notes',async()=>{
  const notice=ui=>vm.runInContext("document.getElementById('notice').textContent",ui.browser);
  // Search matching only the asking chat: card, header and strip all agree it needs you.
  let ui=browserFixture();
  await pollPayload(ui,{projectBoard:boardFixture([project('w',['ask'],{attention:{state:'waiting',origin:'request',sessionId:'ask',reason:'Should I hand this over?'}})]),sessions:[session('ask',{fullTitle:'Workshop App',state:'working'})]});
  vm.runInContext("search.value='workshop';renderWork(true)",ui.browser);
  assert.equal(ui.allCards().find(card=>card.dataset.sessionId==='ask').querySelectorAll('.chat-need').length,1);
  assert.equal(findFold(ui,'project:w').querySelectorAll('.project-attention').length,1);
  assert.equal(vm.runInContext("work.querySelectorAll('[data-jump-need]').length",ui.browser),1);
  assert.equal(chipsOf(workingGroup(ui)).length,0);
  // An asking child under a same-project root: its fold opens by default, until you close it.
  ui=browserFixture();
  const nested=()=>pollPayload(ui,{projectBoard:boardFixture([project('d',['root'],{attention:{state:'waiting',origin:'request',sessionId:'ask',reason:'Ship it?'}})]),sessions:[session('root',{state:'working'}),session('ask',{state:'working',relationship:{parentId:'root'}})]});
  await nested();
  assert.equal(findFold(ui,'project:d:root').open,true);assert.equal(findFold(ui,'project:d').querySelectorAll('.project-need').length,0);
  findFold(ui,'project:d:root').open=false;findFold(ui,'project:d:root').listeners.toggle();await nested();
  assert.equal(findFold(ui,'project:d:root').open,false);
  // Working says its chats moved up rather than that nothing is working.
  assert.match(ui.text(workingGroup(ui)),/No other chats working/);
  // A chat need with no stored request text says Needs me, never the saved Next note; a manual need is yours.
  ui=browserFixture();
  await pollPayload(ui,{projectBoard:boardFixture([project('r',['ask'],{attention:{state:'waiting',origin:'request',sessionId:'ask',reason:''}}),project('m',[],{attention:{state:'waiting',origin:'manual',reason:''}})]),sessions:[session('ask',{state:'working'})]});
  const block=ui.allCards().find(card=>card.dataset.sessionId==='ask').querySelector('.chat-need');
  assert.doesNotMatch(ui.text(block),/Try the current test surface/);assert.match(ui.text(block),/Needs me/);
  assert.match(ui.text(findFold(ui,'project:m').querySelector('.project-need-source')),/Marked by you/);
  // A search hiding the asking chat says so instead of sending you to All sessions.
  ui=browserFixture();
  await pollPayload(ui,{projectBoard:boardFixture([project('s',['a','b'],{attention:{state:'waiting',origin:'request',sessionId:'a',reason:'Ship alpha?'}})]),sessions:[session('a',{fullTitle:'Alpha chat',state:'working'}),session('b',{fullTitle:'Beta chat',state:'working'})]});
  vm.runInContext("search.value='beta';renderWork(true)",ui.browser);
  findFold(ui,'project:s').querySelector('[data-need-chat]').listeners.click();
  assert.match(notice(ui),/The search is hiding that chat/);
});
