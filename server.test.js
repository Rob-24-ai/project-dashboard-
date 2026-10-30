'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'tower-test-'));
process.env.TOWER_DATA_DIR=root;
process.env.TOWER_HOME=root;
const m=require('./server');
const event=(type,extra={},time='2026-10-09T13:00:00Z')=>({timestamp:time,type:'event_msg',payload:{type,...extra}});
const response=payload=>({timestamp:'2026-10-09T13:00:01Z',type:'response_item',payload});
test('native pin readers use desktop settings, retain stale pins, and apply removals',()=>{
 const home=fs.mkdtempSync(path.join(root,'native-reader-'));
 const codex=path.join(home,'.codex','.codex-global-state.json'),claude=path.join(home,'Library','Application Support','Claude','claude_desktop_config.json');
 fs.mkdirSync(path.dirname(codex),{recursive:true});fs.mkdirSync(path.dirname(claude),{recursive:true});
 const read=m.createNativePinReader(home);
 assert.equal(read().status.codex.status,'unavailable');
 fs.writeFileSync(codex,JSON.stringify({'pinned-thread-ids':['one','two']}));
 fs.writeFileSync(claude,JSON.stringify({preferences:{epitaxyPrefs:{'starred-local-code-sessions':['local_one']}}}));
 let pins=read();assert.deepEqual([...pins.ids.codex],['one','two']);assert.deepEqual([...pins.ids.claude],['local_one']);assert.equal(pins.status.codex.available,true);
 fs.writeFileSync(codex,'{');fs.unlinkSync(claude);pins=read();assert.deepEqual([...pins.ids.codex],['one','two']);assert.deepEqual([...pins.ids.claude],['local_one']);assert.equal(pins.status.codex.status,'stale');assert.equal(pins.status.claude.available,false);
 fs.writeFileSync(codex,JSON.stringify({'pinned-thread-ids':['two']}));pins=read();assert.deepEqual([...pins.ids.codex],['two']);assert.equal(pins.status.codex.status,'available');
 fs.writeFileSync(codex,JSON.stringify({'pinned-thread-ids':[]}));pins=read();assert.equal(pins.ids.codex.size,0);assert.equal(pins.status.codex.status,'available');
 fs.writeFileSync(codex,JSON.stringify({'pinned-thread-ids':[null]}));assert.equal(read().status.codex.status,'stale');
});
test('native membership stays separate from local parking and cannot be unpinned in Tower',()=>{
 const tracked={agent:'codex',sessionId:'native',nativePinned:true},id='codex:native',source={...m.blank(),state:'decision',lastActivity:1};
 let store={startedAt:0,dismissed:{},organization:{}};
 const row=()=>m.rowFrom(id,tracked,source,{},[],true,store);
 assert.equal(row().nativePinned,true);assert.equal(row().pinned,true);
 assert.throws(()=>m.organize(row(),{id,pinned:false},store),/Codex/);
 store=m.organize(row(),{id,parked:true},store);assert.equal(row().parked,true);assert.equal(row().pinned,true);assert.equal(row().state,'decision');
 assert.equal(store.organization[id].pinned,false);
 store=m.organize(row(),{id,parked:false},store);assert.equal(row().parked,false);assert.equal(row().pinned,true);
});
test('native pins discover old desktop roots, exclude crew, and keep imported status unknown',()=>{
 const {execFileSync}=require('child_process'),home=fs.mkdtempSync(path.join(root,'native-discovery-'));
 const dir=path.join(home,'.codex','sessions','2020','01','01');fs.mkdirSync(dir,{recursive:true});
 const old='2020-01-01T00:00:00Z';
 for(const id of ['old-root','old-import','old-crew','old-terminal','not-pinned']){
  const meta={id,originator:id==='old-terminal'?'codex_cli_rs':'Codex Desktop',source:id==='old-crew'?{subagent:{}}:'vscode'};
  const records=id==='old-import'?[event('task_started',{turn_id:'external-import-turn-1'},old),event('task_complete',{turn_id:'external-import-turn-1'},old)]:[event('task_started',{turn_id:id},old),event('task_complete',{turn_id:id},old)];
  const file=path.join(dir,id+'.jsonl');fs.writeFileSync(file,[{type:'session_meta',payload:meta},...records].map(JSON.stringify).join('\n')+'\n');fs.utimesSync(file,new Date(old),new Date(old));
 }
 fs.writeFileSync(path.join(home,'.codex','.codex-global-state.json'),JSON.stringify({'pinned-thread-ids':['old-root','old-import','old-crew','old-terminal']}));
 const desktop=path.join(home,'Library','Application Support','Claude'),sessions=path.join(desktop,'claude-code-sessions');fs.mkdirSync(sessions,{recursive:true});
 fs.writeFileSync(path.join(desktop,'claude_desktop_config.json'),JSON.stringify({preferences:{epitaxyPrefs:{'starred-local-code-sessions':['local_old']}}}));
 fs.writeFileSync(path.join(sessions,'local_old.json'),JSON.stringify({sessionId:'local_old',cliSessionId:'old',title:'Old pinned Claude',cwd:'/project',lastActivityAt:Date.parse(old)}));
 const program=`const cp=require('child_process');cp.execFileSync=()=>'';const m=require(${JSON.stringify(path.join(__dirname,'server.js'))});const first=m.collect();require('fs').writeFileSync(${JSON.stringify(path.join(home,'.codex','.codex-global-state.json'))},JSON.stringify({'pinned-thread-ids':[]}));m.discover(Date.now()+20000);console.log(JSON.stringify({first,second:m.collect()}));`;
 const {first,second}=JSON.parse(execFileSync(process.execPath,['-e',program],{env:{...process.env,TOWER_HOME:home,TOWER_DATA_DIR:home},encoding:'utf8'}));
 assert.deepEqual(first.sessions.map(s=>s.id).sort(),['claude:local_old','codex:old-import','codex:old-root']);
 assert.equal(first.sessions.every(s=>s.nativePinned && s.pinned),true);assert.equal(first.sessions.find(s=>s.id==='codex:old-import').state,'unknown');assert.equal(first.sessions.find(s=>s.id==='claude:local_old').state,'unknown');
 assert.equal(second.sessions.find(s=>s.id==='codex:old-root').nativePinned,false);assert.equal(second.sessions.some(s=>s.id==='codex:old-import'),false);
 const stored=JSON.parse(fs.readFileSync(path.join(home,'notifications.json')));assert.deepEqual(stored.organization,{});assert.equal(Object.values(stored.tracked).some(s=>s.nativePinned),false);
});
test('retained Claude metadata gates archived identity and missing native pins are reported',()=>{
 const {execFileSync}=require('child_process'),home=fs.mkdtempSync(path.join(root,'native-metadata-'));
 const desktop=path.join(home,'Library','Application Support','Claude'),sessions=path.join(desktop,'claude-code-sessions'),project=path.join(home,'.claude','projects','-project');
 fs.mkdirSync(sessions,{recursive:true});fs.mkdirSync(project,{recursive:true});fs.mkdirSync(path.join(home,'.codex'),{recursive:true});
 const metadata=path.join(sessions,'local_retained.json'),record={sessionId:'local_retained',cliSessionId:'retained',title:'Retained Claude',cwd:'/project',lastActivityAt:Date.now()};
 fs.writeFileSync(metadata,JSON.stringify(record));
 fs.writeFileSync(path.join(project,'retained.jsonl'),JSON.stringify({type:'assistant',uuid:'end',timestamp:new Date().toISOString(),message:{content:[{type:'text',text:'Done.'}],stop_reason:'end_turn'}})+'\n');
 fs.writeFileSync(path.join(desktop,'claude_desktop_config.json'),JSON.stringify({preferences:{epitaxyPrefs:{'starred-local-code-sessions':['local_retained']}}}));
 fs.writeFileSync(path.join(home,'.codex','.codex-global-state.json'),JSON.stringify({'pinned-thread-ids':['missing-root']}));
 const program=`const cp=require('child_process');cp.execFileSync=()=>'';const fs=require('fs'),m=require(${JSON.stringify(path.join(__dirname,'server.js'))});const first=m.collect();fs.writeFileSync(${JSON.stringify(metadata)},JSON.stringify(${JSON.stringify({...record,isArchived:true})}));const archived=m.collect();fs.unlinkSync(${JSON.stringify(metadata)});const missing=m.collect();fs.writeFileSync(${JSON.stringify(metadata)},JSON.stringify(${JSON.stringify({...record,cliSessionId:'another'})}));const changed=m.collect();console.log(JSON.stringify({first,archived,missing,changed}));`;
 const {first,archived,missing,changed}=JSON.parse(execFileSync(process.execPath,['-e',program],{env:{...process.env,TOWER_HOME:home,TOWER_DATA_DIR:home},encoding:'utf8'}));
 assert.equal(first.sessions.length,1);assert.equal(first.sessions[0].state,'finished');
 assert.equal(first.nativePinStatus.codex.unmatchedCount,1);assert.equal(first.nativePinStatus.codex.incomplete,true);
 assert.equal(archived.sessions.length,0);assert.equal(archived.nativePinStatus.claude.unmatchedCount,1);
 assert.equal(missing.sessions[0].state,'unknown');assert.equal(missing.sessions[0].nativePinned,true);
 assert.equal(changed.sessions.length,0);
});
test('organization persists by identity without touching lifecycle or other sessions',()=>{
 const row={id:'codex:one'}, other={id:'claude:one'};
 const initial={startedAt:1,tracked:{},dismissed:{[row.id]:'complete:old'},organization:{}};
 let store=m.organize(row,{id:row.id,pinned:true},initial);
 assert.deepEqual(initial.organization,{});
 assert.deepEqual(store.organization[row.id],{pinned:true,parked:false});
 assert.equal(store.dismissed[row.id],undefined);
 store=m.organize(other,{id:other.id,parked:true},store);
 store=JSON.parse(JSON.stringify(store));
 assert.equal(store.organization[row.id].pinned,true);
 assert.equal(store.organization[other.id].parked,true);
 store=m.organize(row,{id:row.id,parked:true},store);
 assert.deepEqual(store.organization[row.id],{pinned:false,parked:true});
 store.dismissed[row.id]='complete:new';
 store=m.organize(row,{id:row.id,parked:false},store);
 assert.deepEqual(store.organization[row.id],{pinned:false,parked:false});
 assert.equal(store.dismissed[row.id],undefined);
 assert.equal(store.organization[other.id].parked,true);
 for(const patch of [{pinned:'true'},{parked:null},{pinned:true,parked:true},{},{pinned:true,unexpected:1}])
   assert.throws(()=>m.organize(row,patch,store));
});
test('organization survives new turns and parked decision state remains authoritative',()=>{
 const id='codex:organized',tracked={agent:'codex',sessionId:'organized',title:'Investigate duplicate session labels'};
 const store={startedAt:0,dismissed:{},organization:{[id]:{pinned:false,parked:true}}};
 const s=m.blank();m.applyCodex(s,event('task_started',{turn_id:'first'}));
 let row=m.rowFrom(id,tracked,s,{},[],true,store);
 assert.equal(row.parked,true);assert.equal(row.pinned,false);
 assert.equal(row.searchTitle,tracked.title);
 m.applyCodex(s,response({type:'function_call',name:'functions.request_user_input',call_id:'q'}));
 row=m.rowFrom(id,tracked,s,{},[],true,store);
 assert.equal(row.state,'decision');assert.equal(row.parked,true);
 m.applyCodex(s,event('task_started',{turn_id:'second'}));
 assert.equal(m.rowFrom(id,tracked,s,{},[],true,store).parked,true);
 const unsafe={...tracked,title:'Read /Users/someone/private-prompt.md'};
 assert.equal(m.rowFrom(id,unsafe,s,{},[],true,store).searchTitle,'Codex');
 const legacy=m.rowFrom(id,tracked,s,{},[],true,{startedAt:0,dismissed:{}});
 assert.equal(legacy.pinned,false);assert.equal(legacy.parked,false);
});
test('restoring a baselined finished session returns it to Focus while later dismissals still work',()=>{
 const id='codex:baseline-restore',tracked={agent:'codex',sessionId:'baseline-restore'};
 const source={...m.blank(),state:'finished',eventId:'complete:old',lastActivity:50};
 let store={startedAt:100,dismissed:{},organization:{[id]:{pinned:false,parked:true}}};
 const row=()=>m.rowFrom(id,tracked,source,{},[],true,store);
 assert.equal(row().dismissed,true);
 store=m.organize(row(),{id,parked:false},store);
 assert.equal(row().dismissed,false);
 store=JSON.parse(JSON.stringify(store));assert.equal(row().dismissed,false);
 m.dismiss(row(),row().dismissId,store.dismissed);assert.equal(row().dismissed,true);
});
test('simultaneous threads retain independent state and new turns invalidate completion',()=>{
 const a=m.blank(),b=m.blank();m.applyCodex(a,event('task_started',{turn_id:'a1'}));m.applyCodex(b,event('task_started',{turn_id:'b1'}));
 m.applyCodex(b,event('task_complete',{turn_id:'b1'}));assert.equal(a.state,'working');assert.equal(b.state,'finished');assert.equal(b.eventId,'complete:b1');
 m.applyCodex(b,event('task_started',{turn_id:'b2'}));assert.equal(b.state,'working');assert.equal(b.eventId,null);
 m.applyCodex(b,event('task_complete',{turn_id:'b2'}));assert.equal(b.eventId,'complete:b2');
});
test('unknown or aborted signals and silence are never completion',()=>{
 const s=m.blank();m.applyCodex(s,event('token_count'));assert.equal(s.state,'unknown');m.applyCodex(s,event('task_started'));m.applyCodex(s,event('token_count',{},'2099-01-01T00:00:00Z'));assert.equal(s.state,'working');m.applyCodex(s,event('turn_aborted'));assert.equal(s.state,'unknown');
});
test('explicit question tools resolve, async handles do not falsely resolve',()=>{
 const s=m.blank();m.applyCodex(s,response({type:'function_call',name:'functions.request_user_input',call_id:'a'}));assert.equal(s.state,'decision');
 m.applyCodex(s,response({type:'function_call_output',call_id:'a',output:'{}'}));assert.equal(s.state,'working');
 m.applyCodex(s,response({type:'function_call',name:'functions.request_user_input_async',call_id:'b'}));
 m.applyCodex(s,response({type:'function_call_output',call_id:'b',output:'{"question_id":"q"}'}));assert.equal(s.state,'decision');
 m.applyCodex(s,event('task_complete',{turn_id:'one'}));assert.equal(s.state,'decision');
 m.applyCodex(s,response({type:'function_call_output',call_id:'b',output:'{"answers":{"q":"yes"}}'}));assert.equal(s.state,'working');
});
test('an async question answered through a tagged reply message clears only the questions it names',()=>{
 const reply=(ids,lead='')=>response({type:'message',role:'user',content:[{type:'input_text',text:lead+'<send_user_message_question_reply>\n'+JSON.stringify(ids.map(id=>({questionItemId:JSON.stringify(['request_user_input_async',id,0]),question:'May I publish?',answer:'y'})))+'\n</send_user_message_question_reply>'}]});
 const s=m.blank();m.applyCodex(s,event('task_started'));
 for(const id of ['q1','q2']){m.applyCodex(s,response({type:'function_call',name:'functions.request_user_input_async',call_id:id}));m.applyCodex(s,response({type:'function_call_output',call_id:id,output:'{"accepted":true}'}));}
 assert.equal(s.state,'decision');
 m.applyCodex(s,reply(['q1'],'[145] assistant: forwarded text\n'));assert.equal(s.state,'decision','a quoted reply is not an answer');
 m.applyCodex(s,reply(['q1']));assert.equal(s.state,'decision');assert.deepEqual(Object.keys(s.pending),['q2']);
 m.applyCodex(s,reply(['q2','unknown']));assert.equal(s.state,'working');assert.equal(s.eventId,null);
 m.applyCodex(s,event('task_complete',{turn_id:'one',last_agent_message:'Published and verified.'}));assert.equal(s.state,'finished');
});
test('a pending async question keeps its identity at turn completion and cannot undo a project choice',()=>{
 const {applyProjectPreferences,updateProjectPreference}=require('./project-board');
 const id='codex:stable-question',tracked={agent:'codex',sessionId:'stable-question'};
 const board={projects:[{id:'cloudflare',title:'Cloudflare',stage:'built',next:'',sessionIds:[id]}]};
 const at=Date.parse('2026-10-09T13:00:02Z'),store={startedAt:0,dismissed:{},organization:{}};
 for(const choice of ['later','resolved']) {
  const s=m.blank();m.applyCodex(s,event('task_started',{turn_id:'first'}));
  m.applyCodex(s,response({type:'function_call',name:'functions.request_user_input_async',call_id:'q1',arguments:JSON.stringify({questions:[{question:'May I continue the check?'}]})}));
  m.applyCodex(s,response({type:'function_call_output',call_id:'q1',output:'{"question_id":"open"}'}));
  const row=()=>m.rowFrom(id,tracked,s,{},[],true,store);
  let result=applyProjectPreferences(board,[row()],{},at);
  const preferences=updateProjectPreference(result.board,result.preferences,{id:'cloudflare',attention:choice},at+1);
  m.applyCodex(s,event('task_complete',{turn_id:'first',last_agent_message:'I am waiting for your answer.'}));
  assert.equal(s.eventId,'question:q1');assert.equal(s.state,'decision');
  result=applyProjectPreferences(board,[row()],preferences,at+2);
  assert.equal(result.board.projects[0].attention.state,choice);assert.equal(result.changed,false);
  m.applyCodex(s,response({type:'function_call_output',call_id:'q1',output:'{"answers":{"q1":"yes"}}'}));
  m.applyCodex(s,event('task_complete',{turn_id:'second',last_agent_message:'May I deploy the preview now?'}));
  assert.equal(s.eventId,'complete:second');
  result=applyProjectPreferences(board,[row()],result.preferences,at+3);
  assert.equal(result.board.projects[0].attention.state,'waiting');assert.match(result.board.projects[0].attention.reason,/deploy the preview/);
 }
});
test('current final direct requests surface; quotes, code, and generic questions do not',()=>{
 for(const text of ['Can I push this to production now?','Can I push this to production with the new rule switched off? Railway deploys automatically.','Should we deploy the change?','Please approve the deployment.','Do you approve that replacement and the production redeploy?','Why did the process stop?','Which one first?'])assert.equal(m.asksDecision(text),true,text);
 for(const text of ['The test asks “Can I push this?” and passes.','> Can I push this to production?','```\nCan I push this?\n```','Why did it stop?\n\nThe disk was full, so it is fixed now.','No decision needed.'])assert.equal(m.asksDecision(text),false,text);
 const s=m.blank();m.applyCodex(s,event('task_complete',{turn_id:'x',last_agent_message:'Ready. Can I push this to production now?'}));assert.equal(s.state,'decision');assert.equal(s.decisionSource,'explicit-request-text');
 // A picture after the question must not hide it.
 const pic=m.blank();m.applyCodex(pic,event('task_complete',{turn_id:'y',last_agent_message:'I found the failure.\n\nI opened both pages. **Do you approve that replacement and the production redeploy?** That is the decision needed now.\n\n![Key setting, value hidden](/private/tmp/setting.png)\n\n'}));
 assert.equal(pic.state,'decision');assert.match(pic.finalQuestion,/Do you approve that replacement/);
});
test('direct final requests survive a separate closing explanation in both agent lifecycles',()=>{
 const request='The loop is now blocked awaiting one decision: **may I take over the separately reserved Cloudflare test app’s local release and recovery preparation?**';
 const closing='The migration remains unfinished. Deployment and spending would still require separate approval.';
 const text=request+'\n\n'+closing;
 assert.equal(m.asksDecision(text),true);
 for(const agent of ['codex','claude']) {
  const s=m.blank();
  if(agent==='codex') {
   m.applyCodex(s,event('task_started',{turn_id:'request'}));
   m.applyCodex(s,event('task_complete',{turn_id:'request',last_agent_message:text}));
  } else {
   m.applyClaude(s,{type:'user',uuid:'u',message:{content:'Continue'}});
   m.applyClaude(s,{type:'assistant',uuid:'a',message:{content:[{type:'text',text}],stop_reason:'end_turn'}});
  }
  assert.equal(s.state,'decision',agent);assert.equal(s.decisionSource,'explicit-request-text',agent);
  assert.match(s.finalQuestion,/may I take over/);assert.doesNotMatch(s.finalQuestion,/migration remains unfinished/);
  if(agent==='codex')m.applyCodex(s,event('task_started',{turn_id:'next'}));
  else m.applyClaude(s,{type:'user',uuid:'next',message:{content:'Approved'}});
  assert.equal(s.state,'working',agent);assert.equal(s.finalQuestion,'',agent);
 }
});
test('only explicit earlier requests survive closing text; examples and answered questions stay finished',()=>{
 for(const text of [
  'Please approve the replacement.\n\nProduction has not changed.',
  'Ready. Can I push this to production now?\n\nThe current site remains unchanged.',
  'Would you like me to prepare that version?\n\nIt is not deployed.'
 ])assert.equal(m.asksDecision(text),true,text);
 for(const text of [
  'Why did it stop?\n\nThe disk was full, so it is fixed now.',
  'Can the parser read this file?\n\nYes. The focused check passed.',
  'Should we retry the request?\n\nNo. Retrying would repeat the same failure.',
  'The test asks “May I deploy this?” and passes.\n\nNo action is needed.',
  '"May I deploy this?"\n\nThat is a quoted example.',
  '> May I deploy this?\n\nThat is a quoted example.',
  '```text\nMay I deploy this?\n```\n\nThat is sample output.',
  '~~~text\nMay I deploy this?\n~~~\n\nThat is sample output.',
  '`May I deploy this?`\n\nThat is sample output.',
  'Example: May I deploy this?\n\nThat is sample wording.'
 ])assert.equal(m.asksDecision(text),false,text);
});
for(const [label,text] of [
 ['answered retry','Should we retry the request?\n\nNo retry is needed. The passing verification already settles it.'],
 ['resolved check','May I retry this check?\n\nThat question is now resolved. I already completed the check; no action is needed.'],
 ['answered rebuild','Should we repeat the build?\n\nNo further build is required. The passing verification already settles it.'],
 ['separate example','Example request:\n\nMay I deploy this?\n\nThat is sample wording.']
])test('a current final '+label+' stays finished in both agent lifecycles',()=>{
 for(const agent of ['codex','claude']) {
  const s=m.blank();
  if(agent==='codex') {
   m.applyCodex(s,event('task_started',{turn_id:'request'}));
   m.applyCodex(s,event('task_complete',{turn_id:'request',last_agent_message:text}));
  } else {
   m.applyClaude(s,{type:'user',uuid:'u',message:{content:'Continue'}});
   m.applyClaude(s,{type:'assistant',uuid:'a',message:{content:[{type:'text',text}],stop_reason:'end_turn'}});
  }
  assert.equal(s.state,'finished',agent);assert.equal(s.finalQuestion,'',agent);
 }
});
test('resolved questions and one-paragraph examples cannot swallow a later current request',()=>{
 for(const earlier of [
  'Should we retry the request?\n\nNo retry is needed. The passing verification already settles it.',
  'May I retry this check?\n\nThat question is now resolved. I already completed the check; no action is needed.',
  'Example request:\n\nMay I deploy this?\n\nThat is sample wording.'
 ]) {
  const text=earlier+'\n\nMay I prepare the separate preview?\n\nProduction has not changed.';
  assert.equal(m.asksDecision(text),true,text);
  const s=m.blank();m.applyCodex(s,event('task_complete',{turn_id:'later',last_agent_message:text}));
  assert.match(s.finalQuestion,/May I prepare the separate preview/);
 }
 assert.equal(m.asksDecision('Example request:\n\nMay I deploy this?'),false);
});
for(const [label,text,question] of [
 ['direct request','The current build remains unchanged. '.repeat(30)+'May I deploy this?\n\nProduction has not changed.','May I deploy this?'],
 ['direct request before long explanation','The current build remains unchanged. '.repeat(30)+'May I deploy this? '+'The preview and production remain separate. '.repeat(30)+'\n\nDeployment requires your approval.','May I deploy this?'],
 ['generic closing question','The current build remains unchanged. '.repeat(30)+'Which one first?','Which one first?']
])test('a long paragraph exposes its detected '+label+' in both agent lifecycles',()=>{
 for(const agent of ['codex','claude']) {
  const s=m.blank();
  if(agent==='codex') {
   m.applyCodex(s,event('task_started',{turn_id:'request'}));
   m.applyCodex(s,event('task_complete',{turn_id:'request',last_agent_message:text}));
  } else {
   m.applyClaude(s,{type:'user',uuid:'u',message:{content:'Continue'}});
   m.applyClaude(s,{type:'assistant',uuid:'a',message:{content:[{type:'text',text}],stop_reason:'end_turn'}});
  }
  assert.equal(s.state,'decision',agent);assert.ok(s.finalQuestion.includes(question),agent+': '+s.finalQuestion);
 }
});
test('a bounded prefix is not mistaken for the actual closing question',()=>{
 const text='x'.repeat(65500)+' Why did the process stop? '+ 'x'.repeat(100)+'\n\nThe disk was full. No decision is needed.';
 assert.equal(m.asksDecision(text),false);
});
test('Claude completion, new user input, question and tool result form one lifecycle',()=>{
 const s=m.blank();const put=(type,content,stop_reason,uuid)=>m.applyClaude(s,{type,uuid,timestamp:'2026-10-09T13:00:00Z',message:{content,stop_reason}});
 put('assistant',[{type:'text',text:'Done.'}],'end_turn','end1');assert.equal(s.state,'finished');
 put('user','Continue');assert.equal(s.state,'working');assert.equal(s.eventId,null);
 put('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'q'}],'tool_use');assert.equal(s.state,'decision');
 put('user',[{type:'tool_result',tool_use_id:'q'}]);assert.equal(s.state,'working');
 put('assistant',[{type:'text',text:'Can I push this to production now?'}],'end_turn','end2');assert.equal(s.state,'decision');
});
test('finished dismissal retains compatibility with saved completion records',()=>{
 const tracked={agent:'codex',sessionId:'one'}, id='codex:one';const store={startedAt:50,dismissed:{[id]:'complete:one'}};
 const s={state:'finished',eventId:'complete:one',lastActivity:100,meta:{}};
 assert.equal(m.rowFrom(id,tracked,s,{},[],true,store).dismissed,true);
 assert.equal(m.rowFrom(id,tracked,{...s,eventId:'complete:two'}, {},[],true,store).dismissed,false);
 assert.equal(m.rowFrom(id,tracked,{...s,eventId:'old',lastActivity:1},{},[],true,store).dismissed,true);
});
test('task titles take priority over project umbrella and retain custom names',()=>{
 assert.equal(m.shortName('/x/Atlas','SAM Masker Latency Tests','','claude'),'SAM latency');
 assert.equal(m.shortName('/Users/someone','Clarify 50-pound weight pair','','codex'),'Weight pair');
 assert.equal(m.shortName('/x/garden','Garden Planner activity monitoring','','claude'),'Garden Planner');
 assert.equal(m.shortName('/x/shop','Listings','','codex'),'Listings');
 assert.equal(m.shortName('/x/Atlas','Fix image recall','','codex'),'Image recall');
 assert.equal(m.shortName('/Users/someone','Read /Users/someone/a-very-long-prompt.md','','codex'),'Codex');
 assert.equal(m.shortName('/x/Atlas','SAM Masker Latency Tests','AI Code','codex'),'AI Code');
 assert.equal(m.shortName('/x/shop','','','codex'),'Codex');
 assert.ok(m.shortName('','ABCDEFGHIJKLMNOPQRSTUVWXYZ latency tests','','codex').length<=24);
 assert.ok(m.shortName('','Investigate intermittent conversation recovery after browser refresh','','codex').length<=24);
});
test('desktop roots only: no terminal or subagent rows',()=>{
 assert.equal(m.isRootDesktop({originator:'Codex Desktop',source:'vscode'}),true);assert.equal(m.isRootDesktop({originator:'Codex Desktop',source:{subagent:{}}}),false);assert.equal(m.isRootDesktop({originator:'Codex CLI',source:'cli'}),false);
});
test('focus targets exact Codex stable id and honest Claude app fallback',()=>{
 const id='01a120dc-f15b-7411-afef-5b0bff442d3b';assert.deepEqual(m.focusArgs({agent:'codex',sessionId:id}),['-b','com.openai.codex','codex://threads/'+id]);assert.deepEqual(m.focusArgs({agent:'claude',sessionId:'local_one'}),['-b','com.anthropic.claudefordesktop']);assert.throws(()=>m.focusArgs({agent:'codex',sessionId:'; bad'}));
});
test('incremental transcript reading retains partial JSON and UTF8',()=>{
 const p=path.join(root,'partial.jsonl');fs.writeFileSync(p,JSON.stringify(event('task_started'))+'\n');assert.equal(m.readTranscript(p,'codex').state,'working');
 const finish=JSON.stringify(event('task_complete',{turn_id:'second',last_agent_message:'Café done.'}))+'\n';fs.appendFileSync(p,finish.slice(0,-5));assert.equal(m.readTranscript(p,'codex').state,'working');fs.appendFileSync(p,finish.slice(-5));assert.equal(m.readTranscript(p,'codex').state,'finished');
});
test('an old creation directory resumed today is discovered',()=>{
 const dir=path.join(root,'.codex','sessions','2020','01','01');fs.mkdirSync(dir,{recursive:true});const p=path.join(dir,'rollout-old.jsonl');const id='01a00000-0000-0000-0000-000000000000';
 fs.writeFileSync(p,[{type:'session_meta',payload:{id,originator:'Codex Desktop',source:'vscode',cwd:'/x/garden'}},event('task_started',{},new Date().toISOString())].map(x=>JSON.stringify(x)).join('\n')+'\n');m.discover(Date.now());const data=JSON.parse(fs.readFileSync(path.join(root,'notifications.json')));assert.equal(data.tracked['codex:'+id].file,p);
});
test('backward scanner skips giant history, keeps root metadata and latest run lifecycle',()=>{
 const p=path.join(root,'huge.jsonl');const header={type:'session_meta',payload:{id:'root',originator:'Codex Desktop',source:'vscode'}};
 fs.writeFileSync(p,JSON.stringify(header)+'\n'+JSON.stringify({type:'padding',text:'x'.repeat(20*1024*1024)})+'\n'+JSON.stringify(event('task_started',{turn_id:'new'}))+'\n'+JSON.stringify(event('task_complete',{turn_id:'new'}))+'\n');
 const s=m.readTranscript(p,'codex');assert.equal(s.state,'finished');assert.equal(s.eventId,'complete:new');assert.equal(s.meta.id,'root');
 fs.appendFileSync(p,JSON.stringify(event('task_started',{turn_id:'next'}))+'\n');assert.equal(m.readTranscript(p,'codex').state,'working');
});
test('restart preserves async question pending across task completion',()=>{
 const p=path.join(root,'async-restart.jsonl');fs.writeFileSync(p,[event('task_started'),response({type:'function_call',name:'functions.request_user_input_async',call_id:'waiting'}),response({type:'function_call_output',call_id:'waiting',output:'{"question_id":"q"}'}),event('task_complete',{turn_id:'done'})].map(x=>JSON.stringify(x)).join('\n')+'\n');assert.equal(m.readTranscript(p,'codex').state,'decision');
});
test('initial incomplete UTF8 bytes are preserved until appended JSON finishes',()=>{
 const p=path.join(root,'utf8.jsonl');const start=JSON.stringify(event('task_started'))+'\n';const complete=Buffer.from(JSON.stringify(event('task_complete',{turn_id:'café'}))+'\n');const cut=complete.indexOf(Buffer.from('é'))+1;
 fs.writeFileSync(p,Buffer.concat([Buffer.from(start),complete.subarray(0,cut)]));assert.equal(m.readTranscript(p,'codex').state,'working');fs.appendFileSync(p,complete.subarray(cut));assert.equal(m.readTranscript(p,'codex').eventId,'complete:café');
});
test('initial unfinished JSON larger than a reverse chunk survives append',()=>{
 const p=path.join(root,'long-partial.jsonl');const end=JSON.stringify(event('task_complete',{turn_id:'long',last_agent_message:'x'.repeat(300*1024)}))+'\n';fs.writeFileSync(p,JSON.stringify(event('task_started'))+'\n'+end.slice(0,-4));assert.equal(m.readTranscript(p,'codex').state,'working');fs.appendFileSync(p,end.slice(-4));assert.equal(m.readTranscript(p,'codex').eventId,'complete:long');
});
test('an initially incomplete metadata line becomes discoverable after append',()=>{
 const p=path.join(root,'new-meta.jsonl');const meta=JSON.stringify({type:'session_meta',payload:{id:'new',originator:'Codex Desktop',source:'vscode'}})+'\n';fs.writeFileSync(p,meta.slice(0,25));assert.deepEqual(m.readMeta(p,fs.statSync(p)),{});fs.appendFileSync(p,meta.slice(25));assert.equal(m.readMeta(p,fs.statSync(p)).id,'new');
});

test('all four states can hide with persisted identity and return on changed state or evidence',()=>{
 const id='codex:hidden',tracked={agent:'codex',sessionId:'hidden'},store={startedAt:0,dismissed:{}};
 const source={...m.blank(),lastActivity:100,lifecycleId:'start:one'};
 for(const state of ['unknown','working','decision','finished']) {
  const s={...source,state,eventId:state==='decision'?'question:one':state==='finished'?'complete:one':null};
  const row=()=>m.rowFrom(id,tracked,s,{},[],true,store);
  const before=row();assert.match(before.dismissId,new RegExp('^'+state+':'));assert.equal(before.dismissed,false);
  m.dismiss(before,before.dismissId,store.dismissed);const p=path.join(root,'hide-'+state+'.json');fs.writeFileSync(p,JSON.stringify(store.dismissed));store.dismissed=JSON.parse(fs.readFileSync(p));
  assert.equal(row().dismissed,true);assert.equal(row().dismissId,before.dismissId);
  s.lifecycleId='start:two';if(s.eventId)s.eventId+=':two';const changed=row();assert.equal(changed.dismissed,false);assert.notEqual(changed.dismissId,before.dismissId);assert.throws(()=>m.dismiss(changed,before.dismissId,store.dismissed));
  assert.throws(()=>m.dismiss(changed,null,store.dismissed));
  for(const next of ['unknown','working','decision','finished'].filter(x=>x!==state)) assert.equal(m.rowFrom(id,tracked,{...source,state:next,eventId:s.eventId},{},[],true,store).dismissed,false);
  store.dismissed={};
 }
});
test('hidden working item returns for question and completion with same conversation',()=>{
 const id='codex:lifecycle',tracked={agent:'codex',sessionId:'lifecycle'},store={startedAt:0,dismissed:{}};const s=m.blank();const row=()=>m.rowFrom(id,tracked,s,{},[],true,store);
 m.applyCodex(s,event('task_started',{turn_id:'one'}));m.dismiss(row(),row().dismissId,store.dismissed);assert.equal(row().dismissed,true);
 m.applyCodex(s,response({type:'function_call',name:'functions.request_user_input',call_id:'q'}));assert.equal(row().state,'decision');assert.equal(row().dismissed,false);m.dismiss(row(),row().dismissId,store.dismissed);
 m.applyCodex(s,response({type:'function_call_output',call_id:'q',output:'{}'}));assert.equal(row().dismissed,false);
 m.applyCodex(s,event('task_complete',{turn_id:'one'}));assert.equal(row().dismissed,false);assert.equal(row().state,'finished');
});
test('bounded unknown retains last completion evidence across reload and new lifecycle',()=>{
 const p=path.join(root,'unclear-history.jsonl');fs.writeFileSync(p,JSON.stringify({type:'padding',text:'x'.repeat(17*1024*1024)})+'\n'+JSON.stringify(event('task_complete',{turn_id:'old'}))+'\n');
 const tracked={agent:'codex',sessionId:'old'},store={startedAt:0,dismissed:{}};
 const row=()=>m.rowFrom('codex:old',tracked,m.readTranscript(p,'codex'),{},[],true,store);
 const first=row();assert.equal(first.state,'unknown');assert.match(first.dismissId,/^unknown:/);m.dismiss(first,first.dismissId,store.dismissed);
 assert.equal(row().dismissed,true);fs.appendFileSync(p,JSON.stringify(event('token_count'))+'\n');assert.equal(row().dismissId,first.dismissId);
 fs.appendFileSync(p,JSON.stringify(event('turn_aborted',{turn_id:'later'}))+'\n');assert.equal(row().dismissed,false);assert.notEqual(row().dismissId,first.dismissId);
 const copy=path.join(root,'unclear-history-copy.jsonl');fs.copyFileSync(p,copy);assert.equal(m.rowFrom('codex:old',tracked,m.readTranscript(copy,'codex'),{},[],true,store).dismissId,row().dismissId);
});

test('hidden Claude working stays hidden through ordinary output and returns for final result',()=>{
 const s=m.blank(),id='claude:live',tracked={agent:'claude',sessionId:'live'},store={startedAt:0,dismissed:{}};
 const row=()=>m.rowFrom(id,tracked,s,{},[{hostSessionId:'live'}],true,store);
 const put=(type,uuid,content,stop_reason)=>m.applyClaude(s,{type,uuid,timestamp:'2026-10-09T13:00:00Z',message:{content,stop_reason}});
 put('user','user-one','Start');const first=row();m.dismiss(first,first.dismissId,store.dismissed);
 put('assistant','output-one',[{type:'text',text:'Working on it'}]);assert.equal(row().dismissId,first.dismissId);assert.equal(row().dismissed,true);
 put('assistant','output-two',[{type:'tool_use',name:'Read',id:'read-one'}]);put('user','tool-result',[{type:'tool_result',tool_use_id:'read-one'}]);assert.equal(row().dismissId,first.dismissId);assert.equal(row().dismissed,true);
 put('assistant','final',[{type:'text',text:'Done.'}],'end_turn');assert.equal(row().state,'finished');assert.equal(row().dismissed,false);
 put('user','user-two','Continue');assert.equal(row().state,'working');assert.notEqual(row().dismissId,first.dismissId);assert.equal(row().dismissed,false);
});
test('Claude registry resume hide identity survives cold read and advances on new resume',()=>{
 const p=path.join(root,'claude-registry-warm.jsonl'),copy=path.join(root,'claude-registry-cold.jsonl');
 const user={type:'user',uuid:'u1',timestamp:'2026-10-09T13:00:00Z',message:{content:'Start'}};
 const final={type:'assistant',uuid:'a1',timestamp:'2026-10-09T13:01:00Z',message:{content:[{type:'text',text:'Done.'}],stop_reason:'end_turn'}};
 fs.writeFileSync(p,JSON.stringify(user)+'\n');m.readTranscript(p,'claude');fs.appendFileSync(p,JSON.stringify(final)+'\n');
 const id='claude:resume',tracked={agent:'claude',sessionId:'resume'},store={startedAt:0,dismissed:{}};
 const registry=[{hostSessionId:'resume',status:'busy',statusUpdatedAt:Date.parse('2026-10-09T13:02:00Z')}];
 const row=file=>m.rowFrom(id,tracked,m.readTranscript(file,'claude'),{},registry,true,store);
 const warm=row(p);assert.equal(warm.state,'working');m.dismiss(warm,warm.dismissId,store.dismissed);
 fs.copyFileSync(p,copy);const cold=row(copy);assert.equal(cold.dismissId,warm.dismissId);assert.equal(cold.dismissed,true);
 registry[0].statusUpdatedAt=Date.parse('2026-10-09T13:03:00Z');const newer=row(copy);assert.notEqual(newer.dismissId,warm.dismissId);assert.equal(newer.dismissed,false);assert.throws(()=>m.dismiss(newer,warm.dismissId,store.dismissed));
});

const imported=(type='task_started',extra={})=>event(type,{turn_id:'external-import-turn-1',...extra},new Date().toISOString());
test('import lifecycle and question records cannot create working finished or decision evidence',()=>{
 const s=m.blank();m.applyCodex(s,imported());m.applyCodex(s,response({type:'function_call',name:'functions.request_user_input_async',call_id:'imported-q'}));
 m.applyCodex(s,response({type:'function_call_output',call_id:'imported-q',output:'{"question_id":"q"}'}));
 m.applyCodex(s,imported('task_complete',{last_agent_message:'Can I deploy now?'}));assert.equal(s.state,'unknown');assert.equal(s.eventId,null);assert.equal(s.lastActivity,0);assert.deepEqual(s.pending,{});
});
test('imported history resumes natively and later imports do not replace real state',()=>{
 const s=m.blank();m.applyCodex(s,imported());m.applyCodex(s,imported('task_complete'));m.applyCodex(s,event('task_started',{turn_id:'native'}));assert.equal(s.state,'working');
 m.applyCodex(s,response({type:'function_call',name:'functions.request_user_input',call_id:'real-q'}));assert.equal(s.state,'decision');m.applyCodex(s,response({type:'function_call_output',call_id:'real-q',output:'{}'}));
 m.applyCodex(s,event('task_complete',{turn_id:'native'}));const before={state:s.state,eventId:s.eventId,lastActivity:s.lastActivity};
 m.applyCodex(s,imported());m.applyCodex(s,response({type:'function_call',name:'functions.request_user_input',call_id:'old-q'}));m.applyCodex(s,imported('task_complete'));assert.deepEqual({state:s.state,eventId:s.eventId,lastActivity:s.lastActivity},before);
});
test('cold incremental and restarted import replay agree before and after native resume',()=>{
 const p=path.join(root,'import-replay.jsonl');fs.writeFileSync(p,JSON.stringify(imported())+'\n');assert.equal(m.readTranscript(p,'codex').state,'unknown');
 fs.appendFileSync(p,[response({type:'function_call',name:'functions.request_user_input',call_id:'import-q'}),imported('task_complete',{last_agent_message:'Can I deploy now?'})].map(x=>JSON.stringify(x)).join('\n')+'\n');assert.equal(m.readTranscript(p,'codex').state,'unknown');
 const cold=path.join(root,'import-cold.jsonl');fs.copyFileSync(p,cold);assert.equal(m.readTranscript(cold,'codex').state,'unknown');
 fs.appendFileSync(p,JSON.stringify(event('task_started',{turn_id:'real'}))+'\n'+JSON.stringify(event('task_complete',{turn_id:'real'}))+'\n');assert.equal(m.readTranscript(p,'codex').eventId,'complete:real');
 const resumed=path.join(root,'import-resumed.jsonl');fs.copyFileSync(p,resumed);assert.equal(m.readTranscript(resumed,'codex').eventId,'complete:real');
});
test('import-only discovery and retained rows stay absent; duplicate task titles get no numbers',()=>{
 const {execFileSync}=require('child_process');const home=fs.mkdtempSync(path.join(root,'import-integration-'));const dir=path.join(home,'.codex','sessions','2020','01','01');fs.mkdirSync(dir,{recursive:true});
 const ids=['import-only','native-one','native-two'];const tracked={};const now=new Date().toISOString();
 for(const id of ids){const file=path.join(dir,id+'.jsonl');const head={type:'session_meta',payload:{id,originator:'Codex Desktop',source:'vscode',cwd:'/x/Atlas'}};const records=id==='import-only'?[imported(),response({type:'function_call',name:'functions.request_user_input',call_id:'old'}),imported('task_complete',{last_agent_message:'Can I deploy now?'})]:[event('task_started',{turn_id:id},now),event('task_complete',{turn_id:id},now)];fs.writeFileSync(file,[head,...records].map(x=>JSON.stringify(x)).join('\n')+'\n');tracked['codex:'+id]={file,agent:'codex',sessionId:id,cwd:'/x/Atlas',title:'Listings'};}
 fs.writeFileSync(path.join(home,'.codex','session_index.jsonl'),ids.map(id=>JSON.stringify({id,thread_name:'Listings'})).join('\n')+'\n');
 const run=()=>JSON.parse(execFileSync(process.execPath,['-e',`const cp=require('child_process');cp.execFileSync=()=> 'pid ppid comm\\n1 0 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\\n'.replace(/\\n/g,'\\n');const m=require(${JSON.stringify(path.join(__dirname,'server.js'))});console.log(JSON.stringify(m.collect()));`],{env:{...process.env,TOWER_HOME:home,TOWER_DATA_DIR:home},encoding:'utf8'}));
 fs.writeFileSync(path.join(home,'notifications.json'),JSON.stringify({startedAt:1,tracked:{},dismissed:{},labels:{}}));let result=run();assert.deepEqual(result.sessions.map(x=>x.id).sort(),['codex:native-one','codex:native-two']);assert.equal(JSON.parse(fs.readFileSync(path.join(home,'notifications.json'))).tracked['codex:import-only'],undefined);
 fs.writeFileSync(path.join(home,'notifications.json'),JSON.stringify({startedAt:1,tracked,dismissed:{},labels:{'codex:native-one':{base:'Atlas',ordinal:3}}}));result=run();assert.deepEqual(result.sessions.map(x=>x.id).sort(),['codex:native-one','codex:native-two']);assert.deepEqual(result.sessions.map(x=>x.title),['Listings','Listings']);
 fs.appendFileSync(tracked['codex:import-only'].file,JSON.stringify(event('task_started',{turn_id:'real-resume'},now))+'\n');result=run();assert.equal(result.sessions.find(x=>x.id==='codex:import-only').state,'working');
});

const claudeEvent=(type,uuid,content,stop_reason,extra={})=>({type,uuid,timestamp:'2026-10-10T14:04:00Z',message:{content,stop_reason},...extra});
const launchTask=(id,tool='tool-'+id)=>claudeEvent('user','launch-'+id,[{type:'tool_result',tool_use_id:tool}],null,{toolUseResult:{isAsync:true,status:'async_launched',agentId:id}});
const taskNotice=(id,tool='tool-'+id,status='completed')=>claudeEvent('user','notice-'+id,'<task-notification><task-id>'+id+'</task-id><tool-use-id>'+tool+'</tool-use-id><status>'+status+'</status></task-notification>',null,{origin:{kind:'task-notification'},turnOrigin:'task_notification'});
const parentEnd=id=>claudeEvent('assistant',id,[{type:'text',text:'An update.'}],'end_turn');
const peerHandback=id=>claudeEvent('user','peer-'+id,'A helper report, not a user instruction.',null,{isMeta:true,turnOrigin:'peer',origin:{kind:'peer',from:id,senderTaskId:id,handback:true}});
test('structured Claude peer handbacks close only their launched task and await parent synthesis',()=>{
 const s=m.blank();m.applyClaude(s,launchTask('a'));m.applyClaude(s,launchTask('b'));m.applyClaude(s,parentEnd('early'));
 m.applyClaude(s,peerHandback('a'));assert.deepEqual(Object.keys(s.backgroundTasks),['b']);assert.equal(s.state,'working');
 m.applyClaude(s,parentEnd('one-left'));assert.equal(s.state,'working');
 m.applyClaude(s,peerHandback('b'));assert.deepEqual(Object.keys(s.backgroundTasks),[]);assert.equal(s.state,'working');assert.equal(s.eventId,null);
 m.applyClaude(s,parentEnd('synthesized'));assert.equal(s.state,'finished');
});
test('Claude peer reports require structured provenance and preserve outstanding questions',()=>{
 const s=m.blank();m.applyClaude(s,launchTask('a'));
 m.applyClaude(s,claudeEvent('assistant','q',[{type:'tool_use',name:'AskUserQuestion',id:'question',input:{questions:[{question:'May I publish this?'}]}}],'tool_use'));
 const bad=[{...peerHandback('a'),isMeta:false},{...peerHandback('a'),turnOrigin:'user'},
 {...peerHandback('a'),origin:{kind:'peer',from:'wrong',senderTaskId:'a',handback:true}},
 {...peerHandback('a'),origin:{kind:'peer',from:'a',senderTaskId:'a',handback:false}},peerHandback('unlaunched')];
 for(const record of bad){m.applyClaude(s,record);assert.deepEqual(Object.keys(s.backgroundTasks),['a']);assert.equal(s.state,'decision');assert.equal(s.eventId,'question:question');}
 // Matching words in ordinary user text cannot close a launched helper.
 const fake=peerHandback('a');delete fake.origin;delete fake.turnOrigin;delete fake.isMeta;
 m.applyClaude(s,fake);assert.deepEqual(Object.keys(s.backgroundTasks),['a']);
 m.applyClaude(s,claudeEvent('assistant','q2',[{type:'tool_use',name:'AskUserQuestion',id:'question2'}],'tool_use'));
 m.applyClaude(s,peerHandback('a'));assert.equal(s.state,'decision');assert.equal(s.eventId,'question:question2');assert.ok(s.pending.question2);
 m.applyClaude(s,parentEnd('still-question'));assert.equal(s.state,'decision');
});
test('Claude peer completion agrees on cold reads, incremental appends and duplicate handbacks',()=>{
 const p=path.join(root,'peer-warm.jsonl'),cold=path.join(root,'peer-cold.jsonl');
 fs.writeFileSync(p,[launchTask('a'),parentEnd('early')].map(JSON.stringify).join('\n')+'\n');assert.equal(m.readTranscript(p,'claude').state,'working');
 fs.appendFileSync(p,JSON.stringify(peerHandback('a'))+'\n');assert.deepEqual(m.readTranscript(p,'claude').backgroundTasks,{});
 fs.appendFileSync(p,JSON.stringify(parentEnd('last'))+'\n');const warm=m.readTranscript(p,'claude');assert.equal(warm.state,'finished');
 fs.copyFileSync(p,cold);assert.deepEqual(m.readTranscript(cold,'claude'),warm);
 const finalId=warm.eventId;fs.appendFileSync(p,JSON.stringify(peerHandback('a'))+'\n');assert.equal(m.readTranscript(p,'claude').state,'finished');assert.equal(m.readTranscript(p,'claude').eventId,finalId);
});
test('Claude background children outlive parent turns and finish only after parent synthesis',()=>{
 const s=m.blank();m.applyClaude(s,launchTask('a'));m.applyClaude(s,launchTask('b'));m.applyClaude(s,parentEnd('end-one'));assert.equal(s.state,'working');assert.equal(s.eventId,null);
 m.applyClaude(s,claudeEvent('user','continue','Continue'));m.applyClaude(s,parentEnd('end-two'));assert.equal(s.state,'working');
 m.applyClaude(s,taskNotice('a'));m.applyClaude(s,parentEnd('end-three'));assert.equal(s.state,'working');assert.deepEqual(Object.keys(s.backgroundTasks),['b']);
 m.applyClaude(s,taskNotice('b'));assert.equal(s.state,'working');assert.deepEqual(s.backgroundTasks,{});m.applyClaude(s,parentEnd('end-four'));assert.equal(s.state,'finished');
});
test('Claude background completion needs provenance and matching task and tool identities',()=>{
 const s=m.blank();m.applyClaude(s,launchTask('a'));const fake=taskNotice('a');delete fake.origin;delete fake.turnOrigin;m.applyClaude(s,fake);m.applyClaude(s,parentEnd('quoted'));assert.equal(s.state,'working');
 m.applyClaude(s,taskNotice('a','wrong-tool'));m.applyClaude(s,taskNotice('wrong-task'));m.applyClaude(s,taskNotice('a','tool-a','running'));assert.deepEqual(Object.keys(s.backgroundTasks),['a']);
 m.applyClaude(s,claudeEvent('assistant','question',[{type:'tool_use',name:'AskUserQuestion',id:'q'}],'tool_use'));m.applyClaude(s,taskNotice('a'));assert.equal(s.state,'decision');assert.equal(s.eventId,'question:q');
 m.applyClaude(s,parentEnd('question-end'));assert.equal(s.state,'decision');
});
test('Claude background cold warm restart and dismissal identities agree across parent turns',()=>{
 const p=path.join(root,'claude-background.jsonl');const records=[claudeEvent('user','initial','Start'),launchTask('a'),parentEnd('early'),claudeEvent('user','second','Continue'),parentEnd('later')];
 fs.writeFileSync(p,records.slice(0,2).map(JSON.stringify).join('\n')+'\n');m.readTranscript(p,'claude');fs.appendFileSync(p,records.slice(2).map(JSON.stringify).join('\n')+'\n');
 const tracked={agent:'claude',sessionId:'background',cliSessionId:'cli'},store={startedAt:0,dismissed:{}};const live=[{hostSessionId:'background',sessionId:'cli'}];
 const row=file=>m.rowFrom('claude:background',tracked,m.readTranscript(file,'claude'),{},live,true,store);
 const warm=row(p);assert.equal(warm.state,'working');m.dismiss(warm,warm.dismissId,store.dismissed);const copy=path.join(root,'claude-background-copy.jsonl');fs.copyFileSync(p,copy);assert.equal(row(copy).dismissId,warm.dismissId);assert.equal(row(copy).dismissed,true);
 fs.appendFileSync(p,JSON.stringify(parentEnd('ordinary-update'))+'\n');assert.equal(row(p).dismissed,true);
 fs.appendFileSync(p,JSON.stringify(taskNotice('a'))+'\n');assert.equal(row(p).state,'working');assert.equal(row(p).dismissed,false);fs.appendFileSync(p,JSON.stringify(parentEnd('final'))+'\n');assert.equal(row(p).state,'finished');
 fs.copyFileSync(p,copy);assert.equal(row(copy).dismissId,row(p).dismissId);assert.equal(m.rowFrom('claude:background',tracked,m.readTranscript(p,'claude'),{},[],true,store).state,'finished');
});
test('Claude background incomplete bounded history stays unknown at later parent endings',()=>{
 const p=path.join(root,'claude-background-bounded.jsonl');fs.writeFileSync(p,JSON.stringify(launchTask('hidden'))+'\n'+JSON.stringify({type:'padding',text:'x'.repeat(17*1024*1024)})+'\n'+JSON.stringify(parentEnd('tail'))+'\n');
 assert.equal(m.readTranscript(p,'claude').state,'unknown');fs.appendFileSync(p,JSON.stringify(parentEnd('later'))+'\n');assert.equal(m.readTranscript(p,'claude').state,'unknown');
});
test('Claude permission waiting requires current live root registry and clears without stale alerts',()=>{
 const id='claude:permission',tracked={agent:'claude',sessionId:'host',cliSessionId:'current'},store={startedAt:0,dismissed:{}};const s=m.blank();m.applyClaude(s,parentEnd('before-prompt'));
 const wait={hostSessionId:'host',sessionId:'current',status:'waiting',waitingFor:'permission prompt',statusUpdatedAt:s.lastActivity+1000};
 const row=(registry=[wait],app=true)=>m.rowFrom(id,tracked,s,{},registry,app,store);const first=row();assert.equal(first.state,'decision');assert.equal(first.decisionSource,'permission-prompt');m.dismiss(first,first.dismissId,store.dismissed);assert.equal(row().dismissed,true);
 assert.equal(row([{...wait,updatedAt:wait.statusUpdatedAt+1000}]).dismissId,first.dismissId);assert.equal(row([{...wait,statusUpdatedAt:wait.statusUpdatedAt+1000}]).dismissed,false);
 for(const registry of [[],[{...wait,sessionId:'old'}],[{...wait,statusUpdatedAt:s.lastActivity-1}],[{...wait,status:'idle',waitingFor:undefined}],[{...wait,status:'waiting',waitingFor:'unrecognized'}]])assert.equal(row(registry).state,'finished');
 assert.equal(row([wait],false).state,'finished');assert.equal(row([{...wait,status:'busy',waitingFor:undefined}]).state,'working');
 m.applyClaude(s,launchTask('a'));assert.equal(row().state,'decision');assert.equal(row([]).state,'unknown');
});

test('organization HTTP actions persist, reject invalid requests, and survive a fresh process',async()=>{
 const id='codex:http-organized',dir=path.join(root,'.codex','sessions','2026','10','21');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'http-organized.jsonl'),now=new Date().toISOString();
 fs.writeFileSync(file,[{type:'session_meta',payload:{id:'http-organized',originator:'Codex Desktop',source:'vscode'}},event('task_started',{turn_id:'http'},now),event('task_complete',{turn_id:'http',last_agent_message:'Can I deploy now?'},now)].map(JSON.stringify).join('\n')+'\n');
 m.discover(Date.now()+20000);
 await new Promise(resolve=>m.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+m.server.address().port;
 // The server validates its configured host, even when this test binds an ephemeral port.
 const host='127.0.0.1:4433';
 const call=(method,route,body,origin='http://'+host)=>new Promise((resolve,reject)=>{
  const req=require('http').request(base+route,{method,headers:{Host:host,'Content-Type':'application/json',Origin:origin}},res=>{
   let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));
  });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });
 const post=(body,origin)=>call('POST','/api/organize',body,origin);
 try {
  assert.equal((await post({id,parked:true})).status,200);
  let rows=(await call('GET','/api/sessions')).data.sessions;
  assert.equal(rows.find(row=>row.id===id).parked,true);
  assert.equal(rows.find(row=>row.id===id).state,'decision');
  assert.equal((await post({id,pinned:'yes'})).status,409);
  assert.equal((await post({id:'codex:missing',pinned:true})).status,404);
  assert.equal((await post({id,pinned:true},'https://unrelated.example')).status,403);
  assert.equal((await post({id,pinned:true})).status,200);
  const stored=JSON.parse(fs.readFileSync(path.join(root,'notifications.json')));
  assert.deepEqual(stored.organization[id],{pinned:true,parked:false});
  const {execFileSync}=require('child_process');
  const restart=JSON.parse(execFileSync(process.execPath,['-e',`const m=require(${JSON.stringify(path.join(__dirname,'server.js'))});console.log(JSON.stringify(m.collect().sessions.find(row=>row.id===${JSON.stringify(id)})));`],{env:process.env,encoding:'utf8'}));
  assert.equal(restart.pinned,true);assert.equal(restart.parked,false);assert.equal(restart.state,'decision');
 } finally {await new Promise(resolve=>{m.server.close(resolve);m.server.closeAllConnections();});}
});
test('project HTTP actions persist without a chat, observe before resolving, and reject invalid or foreign mutations',async t=>{
 const id='codex:project-attention-http',projectId='attention-http',at=Date.now(),now=new Date(at).toISOString();
 const home=fs.mkdtempSync(path.join(root,'project-http-')),dir=path.join(home,'.codex','sessions','2026','10','28');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'project-attention-http.jsonl'),boardFile=path.join(home,'project-board.json');
 const board={source:{updatedAt:'Oct 26, 2:18 PM ET',importedAt:'2026-10-26T21:16:00Z'},projects:[{id:projectId,title:'Cloudflare trial',stage:'wait',freshness:'Source notes',notes:[],next:'Approve the next check',sessionIds:[id]},{id:'no-chat',title:'No current chat',stage:'wait',freshness:'',notes:[],next:'Pick the next action',sessionIds:[]}]};
 fs.writeFileSync(boardFile,JSON.stringify(board));t.after(()=>fs.rmSync(boardFile,{force:true}));
 fs.writeFileSync(file,[{type:'session_meta',payload:{id:'project-attention-http',originator:'Codex Desktop',source:'vscode'}},event('task_started',{turn_id:'first'},now),event('task_complete',{turn_id:'first',last_agent_message:'May I run the next check?'},now)].map(JSON.stringify).join('\n')+'\n');
 const {spawn,execFileSync}=require('child_process'),env={...process.env,TOWER_HOME:home,TOWER_DATA_DIR:home};
 const child=spawn(process.execPath,['-e',`const m=require(${JSON.stringify(path.join(__dirname,'server.js'))});m.server.listen(0,'127.0.0.1',()=>console.log(m.server.address().port));`],{env,stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}});
 const port=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('Project fixture server did not start')),5000);child.stdout.on('data',chunk=>{text+=chunk;const port=Number(text.trim());if(port){clearTimeout(timer);resolve(port);}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Project fixture server exited '+code));});});
 const host='127.0.0.1:4433';
 const call=(method,route,body,headers={})=>new Promise((resolve,reject)=>{
  const request=require('http').request({hostname:'127.0.0.1',port,path:route,method,headers:{Host:host,Origin:'http://'+host,'Content-Type':'application/json',...headers}},response=>{
   let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(text)}));
  });request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
 });
 const post=(body,headers)=>call('POST','/api/project',body,headers),feed=async()=> (await call('GET','/api/sessions')).data;
 // Resolve before the first poll. The already-present request must be observed
 // before this deliberate choice, otherwise the next poll immediately undoes it.
 assert.equal((await post({id:projectId,attention:'resolved'})).status,200);
 let data=await feed();assert.equal(data.projectBoard.projects[0].attention.state,'resolved');
 assert.equal(data.projectBoard.projects[1].attention.state,'waiting');
 assert.equal((await post({id:'no-chat',attention:'later'})).status,200);
 assert.equal((await post({id:projectId,title:'Cloudflare'})).status,200);
 data=await feed();assert.equal(data.projectBoard.projects[0].title,'Cloudflare');assert.equal(data.projectBoard.projects[0].sourceTitle,'Cloudflare trial');
 assert.equal(data.projectBoard.projects[1].attention.state,'later');
 const snapshot=fs.readFileSync(path.join(home,'notifications.json'),'utf8');
 for(const body of [[],null,{id:'missing',attention:'waiting'},{id:projectId,attention:'bad'},{id:projectId,attention:'later',title:'Both'},{id:projectId,title:'bad\nname'},{id:projectId,title:'x'.repeat(201)},{id:projectId,attention:'later',extra:true}])assert.equal((await post(body)).status,409);
 for(const headers of [{Origin:'https://unrelated.example'},{Host:'unrelated.example'},{'X-Forwarded-For':'100.64.0.1'},{'Tailscale-User-Login':'someone'}])assert.equal((await post({id:projectId,attention:'waiting'},headers)).status,403);
 assert.equal((await post({id:projectId,attention:'waiting'},{'Content-Type':'text/plain'})).status,415);
 assert.equal(fs.readFileSync(path.join(home,'notifications.json'),'utf8'),snapshot);
 const restart=JSON.parse(execFileSync(process.execPath,['-e',`const m=require(${JSON.stringify(path.join(__dirname,'server.js'))});console.log(JSON.stringify(m.sessionsResponse(false).projectBoard));`],{env,encoding:'utf8'}));
 assert.equal(restart.projects[0].title,'Cloudflare');assert.equal(restart.projects[0].attention.state,'resolved');assert.equal(restart.projects[1].attention.state,'later');
 fs.appendFileSync(file,[event('task_started',{turn_id:'second'},new Date(at+1).toISOString()),event('task_complete',{turn_id:'second',last_agent_message:'May I try the new check?'},new Date(at+1).toISOString())].map(JSON.stringify).join('\n')+'\n');
 data=await feed();assert.equal(data.projectBoard.projects[0].attention.state,'waiting');assert.match(data.projectBoard.projects[0].attention.reason,/new check/);
 assert.equal(data.projectBoard.projects[0].attention.origin,'request');assert.equal(data.projectBoard.projects[1].attention.state,'later');
 assert.deepEqual(JSON.parse(fs.readFileSync(boardFile,'utf8')),board);
});

test('dashboard preserves full native titles and dated Claude recaps without inferring lifecycle',()=>{
 const metadata={sessionId:'local_child',title:'Wake word into the live app (4/7)',lastAssistantUuid:'reply',lastTurnEdgeAt:100,
  postTurnSummary:{summarizes_uuid:'reply',status_detail:'Ready on the testing link; awaiting the phone test',status_category:'completed',needs_action:'Please deploy'},
  spawnedFrom:{sessionId:'local_parent',sideSession:true}};
 const tracked={agent:'claude',sessionId:metadata.sessionId,title:metadata.title,cwd:'/project',metadata};
 const state={...m.blank(),state:'finished',lastActivity:100,lastAssistantUuid:'reply',lastFinal:{uuid:'reply',updatedAt:90}};
 const row=m.rowFrom('claude:local_child',tracked,state,{'claude:local_child':'Old custom'},[],true,{startedAt:0,dismissed:{}});
 assert.equal(row.fullTitle,metadata.title);assert.equal(row.summary.text,metadata.postTurnSummary.status_detail);
 assert.equal(row.summary.updatedAt,90);assert.equal(row.state,'finished');assert.equal(row.question,'');
 const current={...state,lastActivity:90};
 assert.equal(m.presentation(tracked,current,'decision','explicit-request-text').question,'Please deploy');
 assert.match(m.presentation(tracked,state,'decision','explicit-request-text').question,/Open the conversation/);
 assert.deepEqual(row.relationship,{parentId:'claude:local_parent',kind:'side-session'});
 metadata.postTurnSummary.summarizes_uuid='obsolete';
 const outdated=m.presentation(tracked,state,'decision','question-tool');
 assert.equal(outdated.summary.text,'');assert.equal(outdated.summary.stale,true);assert.match(outdated.question,/Open the conversation/);
 assert.equal(outdated.question.includes('deploy'),false);
 metadata.title='Renamed exact title / with punctuation';tracked.title=metadata.title;
 assert.equal(m.presentation(tracked,state,'finished',null).fullTitle,metadata.title);
});
test('explicit lineage distinguishes handoffs forks and missing parents and breaks cycles',()=>{
 assert.deepEqual(m.claudeRelationship({sessionId:'local_b',spawnedFrom:{sessionId:'local_a',sideSession:true,handOff:true}}),{parentId:'claude:local_a',kind:'handoff'});
 assert.deepEqual(m.claudeRelationship({sessionId:'local_b',forkedFromSessionId:'local_missing'}),{parentId:'claude:local_missing',kind:'fork'});
 assert.equal(m.claudeRelationship({sessionId:'local_a',spawnedFrom:{sessionId:'local_a'}}),null);
 assert.equal(m.claudeRelationship({sessionId:'local_b',lineageDetached:true,spawnedFrom:{sessionId:'local_a'}}),null);
 const rows=[{id:'a',relationship:{parentId:'b'}},{id:'b',relationship:{parentId:'a'}},{id:'c',relationship:{parentId:'missing'}}];
 m.normalizeRelationships(rows);assert.equal(rows[0].relationship,null);assert.equal(rows[1].relationship.parentId,'a');assert.equal(rows[2].relationship.parentId,'missing');
});
test('Claude context follows newer public assistant progress without exposing thinking or tool output',()=>{
 const s=m.blank(),tracked={agent:'claude',metadata:{lastAssistantUuid:'old',lastTurnEdgeAt:1000,postTurnSummary:{summarizes_uuid:'old',status_detail:'The old preview is ready.'}}};
 m.applyClaude(s,{...claudeEvent('assistant','old',[{type:'text',text:'The old preview is ready.'}],'end_turn'),timestamp:'2026-10-21T10:00:00Z'});
 m.applyClaude(s,{...claudeEvent('user','continue','Private user prompt'),timestamp:'2026-10-21T10:01:00Z'});
 const before=m.presentation(tracked,s,s.state,s.decisionSource).summary;assert.equal(before.text,'The old preview is ready.');assert.equal(before.stale,true);
 m.applyClaude(s,{...claudeEvent('assistant','progress',[{type:'thinking',thinking:'Private reasoning must not appear.'},{type:'text',text:'I am checking the new preview on the phone.'},{type:'tool_use',name:'Bash',input:{command:'secret tool payload'}}],null),timestamp:'2026-10-21T10:02:00Z'});
 let summary=m.presentation(tracked,s,s.state,s.decisionSource).summary;assert.equal(summary.text,'I am checking the new preview on the phone.');assert.equal(summary.source,'Claude progress');assert.equal(summary.updatedAt,Date.parse('2026-10-21T10:02:00Z'));assert.equal(summary.stale,false);
 m.applyClaude(s,{...claudeEvent('assistant','thinking',[{type:'thinking',thinking:'Do not show this.'}],null),timestamp:'2026-10-21T10:03:00Z'});
 summary=m.presentation(tracked,s,s.state,s.decisionSource).summary;assert.equal(summary.text,'I am checking the new preview on the phone.');assert.equal(summary.stale,true);
});
test('Claude useful native recap wins for the same reply, generic recap falls back to final text',()=>{
 const s=m.blank();m.applyClaude(s,claudeEvent('assistant','final',[{type:'text',text:'The workshop has three sections ready, including the editing tools. Want to do one of those now?'}],'end_turn'));
 const metadata={lastAssistantUuid:'final',postTurnSummary:{summarizes_uuid:'final',status_detail:'Want to do one of those now?'}},tracked={agent:'claude',metadata};
 let summary=m.presentation(tracked,s,s.state,s.decisionSource).summary;assert.equal(summary.text,s.lastFinal.text);assert.equal(summary.source,'Claude final reply');
 metadata.postTurnSummary.status_detail='Workshop editing tools are ready to try.';summary=m.presentation(tracked,s,s.state,s.decisionSource).summary;assert.equal(summary.text,metadata.postTurnSummary.status_detail);assert.equal(summary.source,'Claude recap');
 m.applyClaude(s,{...claudeEvent('assistant','new-final',[{type:'text',text:'The phone test found a missing save button.'}],'end_turn'),timestamp:'2026-10-21T11:00:00Z'});
 summary=m.presentation(tracked,s,s.state,s.decisionSource).summary;assert.equal(summary.text,'The phone test found a missing save button.');assert.equal(summary.source,'Claude final reply');
 const noEvidence=m.presentation({agent:'claude'},m.blank(),'unknown',null);assert.equal(noEvidence.summary.text,'');assert.equal(noEvidence.summary.updatedAt,null);
});
const wrapEvent=(id,input,extra={})=>claudeEvent('assistant',id,[{type:'tool_use',id,name:'mcp__ccd_turn__wrap_up',input}],null,extra);
const wrapInput={recap:'Railway deploys are still paused by their outage.',ask:'Tell me when the Limited Access box is gone.',actions:[{label:"It is back",message:'Check the deploy.'}]};
test('Claude typed wrap-up waits for end_turn, keeps its action through acknowledgement and gives concise context',()=>{
 const s=m.blank(),tracked={agent:'claude'};
 m.applyClaude(s,wrapEvent('wrap',wrapInput));assert.equal(s.state,'working');
 m.applyClaude(s,claudeEvent('user','ack',[{type:'tool_result',tool_use_id:'wrap',content:'Shown in the next-step box.'}]));
 m.applyClaude(s,claudeEvent('assistant','end',[{type:'text',text:'The backend remains on yesterday\'s version. There is nothing to click until the outage lifts.'}],'end_turn'));
 const row=m.presentation(tracked,s,s.state,s.decisionSource);
 assert.equal(s.state,'decision');assert.equal(s.decisionSource,'wrap-up');assert.equal(row.question,wrapInput.ask);
 assert.equal(row.summary.text,wrapInput.recap);assert.equal(row.summary.source,'Claude wrap-up');
});
test('Claude typed wrap-up cannot resurrect an answered request or replace newer public progress',()=>{
 const s=m.blank(),tracked={agent:'claude'};
 m.applyClaude(s,wrapEvent('wrap',wrapInput));m.applyClaude(s,claudeEvent('assistant','end',[{type:'text',text:'Nothing to click until the outage lifts.'}],'end_turn'));
 m.applyClaude(s,claudeEvent('user','next','The outage is over.',null,{timestamp:'2026-10-10T14:05:00Z'}));
 assert.equal(m.presentation(tracked,s,s.state,s.decisionSource).question,'');
 m.applyClaude(s,claudeEvent('assistant','progress',[{type:'text',text:'Checking the new backend deployment now.'}],null,{timestamp:'2026-10-10T14:05:01Z'}));
 assert.equal(m.presentation(tracked,s,s.state,s.decisionSource).summary.text,'Checking the new backend deployment now.');
 m.applyClaude(s,claudeEvent('assistant','new-end',[{type:'text',text:'The new backend build is now ready.'}],'end_turn',{timestamp:'2026-10-10T14:05:02Z'}));
 assert.equal(s.state,'finished');assert.equal(m.presentation(tracked,s,s.state,s.decisionSource).question,'');
 assert.equal(m.presentation(tracked,s,s.state,s.decisionSource).summary.text,'The new backend build is now ready.');
});
test('Claude typed wrap-up rejects malformed, failed, sidechain and peer inputs and respects question precedence',()=>{
 for(const event of [wrapEvent('bad',{recap:42,ask:'A question'}),wrapEvent('bad',{...wrapInput,ask:{text:'A question'}}),wrapEvent('side',wrapInput,{isSidechain:true}),wrapEvent('peer',wrapInput,{origin:{kind:'peer'},turnOrigin:'peer'})]){
  const s=m.blank();m.applyClaude(s,event);m.applyClaude(s,claudeEvent('assistant','end',[{type:'text',text:'The assistant finished this turn.'}],'end_turn'));
  assert.equal(s.state,'finished');assert.notEqual(m.presentation({agent:'claude'},s,s.state,s.decisionSource).summary.source,'Claude wrap-up');
 }
 const failed=m.blank();m.applyClaude(failed,wrapEvent('failed',wrapInput));m.applyClaude(failed,claudeEvent('user','failure',[{type:'tool_result',tool_use_id:'failed',is_error:true,content:'Invalid input'}]));m.applyClaude(failed,claudeEvent('assistant','end',[{type:'text',text:'The assistant finished this turn.'}],'end_turn'));assert.equal(failed.state,'finished');
 const s=m.blank();m.applyClaude(s,wrapEvent('wrap',wrapInput));m.applyClaude(s,claudeEvent('assistant','question',[{type:'tool_use',id:'q',name:'AskUserQuestion',input:{questions:[{question:'Which preview should I use?'}]}}],null));m.applyClaude(s,claudeEvent('assistant','end',[{type:'text',text:'Waiting for the selected preview.'}],'end_turn'));
 assert.equal(s.decisionSource,'question-tool');assert.equal(m.presentation({agent:'claude'},s,s.state,s.decisionSource).question,'Which preview should I use?');assert.match(m.presentation({agent:'claude'},s,'decision','permission-prompt').question,/Permission requested/);
});
test('Claude typed wrap-up cold and incremental replay agree, including a later box without an ask',()=>{
 const file=path.join(root,'claude-wrap-up.jsonl'),copy=file+'.copy';
 const records=[claudeEvent('user','start','Check the deployment.'),wrapEvent('wrap',wrapInput),claudeEvent('user','ack',[{type:'tool_result',tool_use_id:'wrap',content:'Shown in the next-step box.'}]),claudeEvent('assistant','end',[{type:'text',text:'Nothing to click until the outage lifts.'}],'end_turn')];
 fs.writeFileSync(file,records.map(JSON.stringify).join('\n')+'\n');
 assert.equal(m.readTranscript(file,'claude').state,'decision');
 const updated=[claudeEvent('user','next','Check it again.',null,{timestamp:'2026-10-10T14:05:00Z'}),wrapEvent('new-wrap',{recap:'The backend deployment has now completed.',ask:''},{timestamp:'2026-10-10T14:06:00Z'}),claudeEvent('assistant','new-end',[{type:'text',text:'The backend deployment has completed and the endpoint is responding.'}],'end_turn',{timestamp:'2026-10-10T14:06:01Z'})];
 fs.appendFileSync(file,updated.map(JSON.stringify).join('\n')+'\n');fs.copyFileSync(file,copy);
 const warm=m.readTranscript(file,'claude'),cold=m.readTranscript(copy,'claude');
 for(const s of [warm,cold]){const row=m.presentation({agent:'claude'},s,s.state,s.decisionSource);assert.equal(s.state,'finished');assert.equal(row.question,'');assert.equal(row.summary.text,'The backend deployment has now completed.');}
 assert.deepEqual(warm,cold);
});
test('public progress selection stays consistent through cold reads and appends for both apps',()=>{
 for(const agent of ['claude','codex']){
  const file=path.join(root,agent+'-progress.jsonl'),copy=file+'.copy';
  const initial=agent==='claude'?[claudeEvent('assistant','final',[{type:'text',text:'The previous test completed successfully.'}],'end_turn')]:[event('task_started'),event('task_complete',{last_agent_message:'The previous test completed successfully.'})];
  const progress=agent==='claude'?claudeEvent('assistant','progress',[{type:'text',text:'Now checking the new saving behavior.'}],null):{timestamp:'2026-10-21T10:00:00Z',type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Now checking the new saving behavior.'}]}};
  fs.writeFileSync(file,initial.map(JSON.stringify).join('\n')+'\n');m.readTranscript(file,agent);
  if(agent==='codex')fs.appendFileSync(file,JSON.stringify(event('task_started',{},'2026-10-21T09:59:00Z'))+'\n');
  fs.appendFileSync(file,JSON.stringify(progress)+'\n');const row=()=>m.presentation({agent},m.readTranscript(file,agent),'working',null);
  const warm=row();assert.equal(warm.summary.text,'Now checking the new saving behavior.');assert.equal(warm.summary.source,agent==='claude'?'Claude progress':'Codex progress');
  fs.copyFileSync(file,copy);assert.deepEqual(m.presentation({agent},m.readTranscript(copy,agent),'working',null).summary,warm.summary);
  assert.deepEqual(row().summary,warm.summary);
 }
});
test('progress excludes imported Codex turns, analysis, tool output, and Claude sidechains',()=>{
 const s=m.blank();m.applyCodex(s,event('task_started'));m.applyCodex(s,response({type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Checking the current preview rendering.'}]}));
 const show=()=>m.presentation({agent:'codex'},s,s.state,s.decisionSource).summary.text;
 assert.equal(show(),'Checking the current preview rendering.');
 for(const payload of [{type:'message',role:'assistant',phase:'analysis',content:[{type:'output_text',text:'Private analysis should not appear.'}]},{type:'function_call_output',output:'Private tool output should not appear.'},{type:'message',role:'user',phase:'commentary',content:[{type:'output_text',text:'Private prompt should not appear.'}]}])m.applyCodex(s,response(payload));
 m.applyCodex(s,event('task_started',{turn_id:'external-import-turn-1'}));m.applyCodex(s,response({type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'This replay must not appear.'}]}));assert.equal(show(),'Checking the current preview rendering.');
 const c=m.blank();m.applyClaude(c,claudeEvent('assistant','main',[{type:'text',text:'Checking the current preview rendering.'}],null));m.applyClaude(c,claudeEvent('assistant','side',[{type:'text',text:'Internal helper text should not appear.'}],null,{isSidechain:true}));
 assert.equal(m.presentation({agent:'claude'},c,c.state,c.decisionSource).summary.text,'Checking the current preview rendering.');
});
test('old explicit ancestors and siblings are discovered without merging by title or repository',()=>{
 const now=Date.now(),record=(sessionId,lastActivityAt,spawnedFrom)=>({metadata:{sessionId,lastActivityAt,spawnedFrom,title:'Same title',cwd:'/same'}});
 const records=new Map([
  ['old-parent',record('old-parent',1)],['new-child',record('new-child',now,{sessionId:'old-parent',sideSession:true})],
  ['old-sibling',record('old-sibling',1,{sessionId:'old-parent',sideSession:true})],['unrelated',record('unrelated',1)],
  ['cycle-a',record('cycle-a',1,{sessionId:'cycle-b'})],['cycle-b',record('cycle-b',1,{sessionId:'cycle-a'})]
 ]);
 assert.deepEqual([...m.selectClaudeSessions(records,now,new Set(),new Set())].sort(),['new-child','old-parent','old-sibling']);
 assert.equal(m.selectClaudeSessions(records,now,new Set(['cycle-a']),new Set()).size,5);
});
test('dashboard question text comes from pending questions or the current final request and clears on resume',()=>{
 const s=m.blank();m.applyCodex(s,event('task_started'));
 m.applyCodex(s,response({type:'function_call',name:'request_user_input_async',call_id:'q',arguments:JSON.stringify({questions:[{question:'Which preview should I use?'}]})}));
 assert.equal(m.presentation({agent:'codex'},s,s.state,s.decisionSource).question,'Which preview should I use?');
 m.applyCodex(s,response({type:'function_call_output',call_id:'q',output:JSON.stringify({question_id:'waiting'})}));
 assert.equal(s.state,'decision');assert.equal(s.pendingQuestions.q,'Which preview should I use?');
 assert.equal(m.questionText({questions:[{title:'May I use the staging project?'}]}),'May I use the staging project?');
 m.applyCodex(s,response({type:'function_call_output',call_id:'q',output:JSON.stringify({answers:{q:'Preview'}})}));
 assert.equal(m.presentation({agent:'codex'},s,s.state,s.decisionSource).question,'');
 m.applyCodex(s,event('task_complete',{last_agent_message:'The checks passed.\n\nMay I deploy the preview?'}));
 assert.equal(m.presentation({agent:'codex'},s,s.state,s.decisionSource).question,'May I deploy the preview?');
 m.applyCodex(s,event('task_started'));assert.equal(s.finalQuestion,'');
 const c=m.blank();m.applyClaude(c,{type:'assistant',uuid:'q',message:{content:[{type:'tool_use',id:'q',name:'AskUserQuestion',input:{questions:[{question:'Which artwork is current?'}]}}]}});
 assert.equal(m.presentation({agent:'claude'},c,c.state,c.decisionSource).question,'Which artwork is current?');
 m.applyClaude(c,{type:'user',message:{content:[{type:'tool_result',tool_use_id:'q',content:'Second one'}]}});
 assert.equal(m.presentation({agent:'claude'},c,c.state,c.decisionSource).question,'');
 assert.match(m.presentation({agent:'claude'},c,'decision','permission-prompt').question,/exact action/);
});
test('Codex context reads current renamed SQLite names read-only and gracefully falls back to index',()=>{
 const {execFileSync}=require('child_process'),home=fs.mkdtempSync(path.join(root,'title-source-')),dir=path.join(home,'.codex');fs.mkdirSync(dir);
 fs.writeFileSync(path.join(dir,'session_index.jsonl'),JSON.stringify({id:'one',thread_name:'Old title'})+'\n');
 assert.equal(m.readCodexDetails(home).one.title,'Old title');
 const database=path.join(dir,'state_5.sqlite');
 execFileSync('sqlite3',[database,"CREATE TABLE threads(id TEXT,name TEXT,cwd TEXT,git_branch TEXT,archived INTEGER);INSERT INTO threads VALUES('one','Current native name','/project','preview',0);"]);
 const before=fs.statSync(database).mtimeMs;
 assert.deepEqual(m.readCodexDetails(home).one,{title:'Current native name',cwd:'/project',branch:'preview',archived:false});
 assert.equal(fs.statSync(database).mtimeMs,before);
 execFileSync('sqlite3',[database,"UPDATE threads SET name='Renamed again';"]);
 assert.equal(m.readCodexDetails(home).one.title,'Renamed again');
 fs.writeFileSync(database,'invalid database');assert.equal(m.readCodexDetails(home).one.title,'Old title');
});
test('Codex meaningful final context survives cold working turns, excludes prompts and code, and marks age',()=>{
 const file=path.join(root,'context-final.jsonl');
 const old='2026-10-09T12:00:00Z';
 fs.writeFileSync(file,[{type:'session_meta',payload:{id:'context',originator:'Codex Desktop'}},event('task_started',{},old),
  event('task_complete',{last_agent_message:'The memory lookup now preserves the artist correction.\n```secret code```'},old),event('task_started'),
  response({type:'message',role:'user',content:[{type:'input_text',text:'PRIVATE USER PROMPT'}]})].map(JSON.stringify).join('\n')+'\n');
 const s=m.readTranscript(file,'codex'),row=m.presentation({agent:'codex'},s,'working',null);
 assert.equal(s.state,'working');assert.equal(row.summary.text,'The memory lookup now preserves the artist correction.');
 assert.equal(row.summary.updatedAt,Date.parse(old));assert.equal(row.summary.stale,true);
 assert.equal(row.summary.text.includes('PRIVATE'),false);
 fs.appendFileSync(file,JSON.stringify(event('task_complete',{last_agent_message:'Paused.'}))+'\n');
 assert.equal(m.readTranscript(file,'codex').lastFinal.text,row.summary.text);
});
test('collect refreshes Claude title and recap every poll and retains related chats without transcript evidence',()=>{
 const {execFileSync}=require('child_process'),home=fs.mkdtempSync(path.join(root,'context-refresh-'));
 const dir=path.join(home,'Library','Application Support','Claude','claude-code-sessions');fs.mkdirSync(dir,{recursive:true});
 const filename=path.join(dir,'local_current.json'),old=path.join(dir,'local_parent.json');
 const record={sessionId:'local_current',cliSessionId:'current',title:'Original native title',cwd:'/project',lastActivityAt:Date.now(),lastAssistantUuid:'one',postTurnSummary:{summarizes_uuid:'one',status_detail:'Earlier result from the assistant.'},spawnedFrom:{sessionId:'local_parent',handOff:true}};
 fs.writeFileSync(filename,JSON.stringify(record));fs.writeFileSync(old,JSON.stringify({sessionId:'local_parent',cliSessionId:'parent',title:'Older parent',lastActivityAt:1}));
 const renamed={...record,title:'Renamed in Claude',lastAssistantUuid:'two',postTurnSummary:{summarizes_uuid:'two',status_detail:'The newer result from Claude.'}};
 const program=`const cp=require('child_process');cp.execFileSync=()=>'';const fs=require('fs'),m=require(${JSON.stringify(path.join(__dirname,'server.js'))});const first=m.collect();fs.writeFileSync(${JSON.stringify(filename)},JSON.stringify(${JSON.stringify(renamed)}));console.log(JSON.stringify({first,second:m.collect()}));`;
 const {first,second}=JSON.parse(execFileSync(process.execPath,['-e',program],{env:{...process.env,TOWER_HOME:home,TOWER_DATA_DIR:home},encoding:'utf8'}));
 assert.equal(first.sessions.length,2);assert.equal(first.sessions.find(x=>x.sessionId==='local_current').fullTitle,'Original native title');
 const current=second.sessions.find(x=>x.sessionId==='local_current');assert.equal(current.fullTitle,'Renamed in Claude');assert.equal(current.summary.text,renamed.postTurnSummary.status_detail);assert.equal(current.state,'unknown');
 assert.deepEqual(current.relationship,{parentId:'claude:local_parent',kind:'handoff'});
});

test('bringing an older Later item back retains it on the desk across restart without pinning',()=>{
 const tracked={agent:'codex',sessionId:'older',title:'Older work'},id='codex:older',state={...m.blank(),state:'finished',lastActivity:1};
 let store={startedAt:100,dismissed:{},organization:{[id]:{parked:true,pinned:false}}};
 const row=()=>m.rowFrom(id,tracked,state,{},[],true,store);
 assert.equal(row().onDesk,false);store=m.organize(row(),{id,parked:false},store);store=JSON.parse(JSON.stringify(store));
 assert.equal(row().parked,false);assert.equal(row().pinned,false);assert.equal(row().onDesk,true);assert.equal(row().dismissed,false);
});

test('dashboard final excerpts remove voice and visual framing and keep file locations in Details',()=>{
 const value='[COMPLETE] **The preview is ready.** Open `/Users/someone/tower/HANDOFF.md` for context.\n\n::codex-realtime-inline{}\nvisualize{"path":"/Users/someone/.codex/visualizations/desk.html","mode":"wide"}';
 assert.equal(m.displayText(value),'The preview is ready. Open working file for context.');
 assert.equal(m.displayText('[STATUS] The __memory repair__ passed *two checks*. The `preview` is ready.'),'The memory repair passed two checks. The preview is ready.');
 assert.equal(m.displayText('The handoff is at /private/tmp/tower-handoff.md. Production is unchanged.'),'The handoff is at working file. Production is unchanged.');
 assert.equal(m.displayText('Open "/Users/someone/Project Notes/final.md" for the recorded result.'),'Open working file for the recorded result.');
 assert.equal(m.displayText('The [handoff](/Users/someone/tower/HANDOFF.md) records the completed checks.'),'The handoff records the completed checks.');
 assert.equal(m.displayText('::artifact{path="/private/tmp/result.html"}\nThe latest result is ready.'),'The latest result is ready.');
 const s=m.blank();m.applyCodex(s,event('task_started'));m.applyCodex(s,event('task_complete',{last_agent_message:value}));
 const row=m.presentation({agent:'codex',cwd:'/Users/someone/tower'},s,s.state,s.decisionSource);
 assert.equal(row.summary.text,'The preview is ready. Open working file for context.');assert.equal(row.summary.source,'Codex final reply');
 assert.equal(row.context.cwd,'/Users/someone/tower');assert.equal(s.state,'finished');
});

test('session locations resolve real repository roots and existing folders without guessing VM mappings',()=>{
 const {execFileSync}=require('child_process'),workspace=fs.mkdtempSync(path.join(root,'location-'));
 const repository=path.join(workspace,'repository'),nested=path.join(repository,'nested'),folder=path.join(workspace,'ordinary folder');
 fs.mkdirSync(nested,{recursive:true});fs.mkdirSync(folder);execFileSync('/usr/bin/git',['init','-q',repository]);
 const realRepository=fs.realpathSync(repository),realFolder=fs.realpathSync(folder);
 assert.deepEqual(m.sessionLocation(nested),{repositoryPath:realRepository,finderPath:realRepository});
 assert.deepEqual(m.sessionLocation(folder),{repositoryPath:'',finderPath:realFolder});
 assert.deepEqual(m.sessionLocation('/sessions/does-not-exist/workspace'),{repositoryPath:'',finderPath:''});
 assert.deepEqual(m.sessionLocation('https://untrusted.example'),{repositoryPath:'',finderPath:''});
 const state=m.blank(),data=m.presentation({agent:'claude',cwd:nested},state,'unknown',null);
 assert.equal(data.context.cwd,nested);assert.equal(data.context.repositoryPath,realRepository);
 const row={id:'claude:location',context:{cwd:nested,workPath:nested,finderPath:'/untrusted-stale-path'}};
 assert.deepEqual(m.revealArgs(row,{id:row.id}),['-a','Finder',nested]);
 for(const body of [{id:row.id,path:folder},{id:row.id,url:'https://example.org'},{key:row.id},{id:'other'}])assert.throws(()=>m.revealArgs(row,body),/Choose a conversation/);
 fs.rmSync(folder,{recursive:true});
 // API metadata is briefly cached, but the actual click must revalidate the folder.
 assert.equal(m.sessionLocation(folder).finderPath,realFolder);
 assert.throws(()=>m.revealArgs({id:'missing',context:{cwd:folder,workPath:folder}},{id:'missing'}),/no longer available/);
});
test('Finder HTTP action uses only the selected session folder and rejects overrides and foreign origins',async()=>{
 const {spawn}=require('child_process'),home=fs.mkdtempSync(path.join(root,'finder-http-'));
 const dir=path.join(home,'.codex','sessions','2026','10','21'),folder=path.join(home,'working folder');fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(folder);
 const now=new Date().toISOString(),workingFile=path.join(folder,'actual-work.md');fs.writeFileSync(workingFile,'current work');
 for(const [id,cwd] of [['finder-local',folder],['finder-file',folder],['finder-remote','/sessions/not-local/workspace']]) {
  fs.writeFileSync(path.join(dir,id+'.jsonl'),[{type:'session_meta',payload:{id,cwd,originator:'Codex Desktop',source:'vscode'}},event('task_started',{turn_id:id},now),...(id==='finder-file'?[response({type:'custom_tool_call',name:'apply_patch',input:'*** Begin Patch\n*** Update File: '+workingFile+'\n@@\n-old\n+new\n*** End Patch'})]:[]),event('task_complete',{turn_id:id,last_agent_message:'The current turn has finished.'},now)].map(JSON.stringify).join('\n')+'\n');
 }
 const calls=path.join(home,'open-calls.jsonl');
 const program=`const fs=require('fs'),cp=require('child_process'),original=cp.execFileSync;cp.execFileSync=(file,...args)=>file==='ps'?'':original(file,...args);cp.execFile=(file,args,options,callback)=>{fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({file,args})+'\\n');callback(null);};const m=require(${JSON.stringify(path.join(__dirname,'server.js'))});m.server.listen(0,'127.0.0.1',()=>console.log(m.server.address().port));`;
 const child=spawn(process.execPath,['-e',program],{env:{...process.env,TOWER_HOME:home,TOWER_DATA_DIR:home},stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',chunk=>errors+=chunk);
 const port=await new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(new Error('Test server did not start: '+errors)),5000);child.stdout.on('data',chunk=>{data+=chunk;if(data.includes('\n')){clearTimeout(timer);resolve(Number(data.trim()));}});child.once('error',error=>{clearTimeout(timer);reject(error);});});
 const host='127.0.0.1:4433';
 const post=(body,origin='http://'+host,requestHost=host)=>new Promise((resolve,reject)=>{
  const request=require('http').request({hostname:'127.0.0.1',port,path:'/api/reveal',method:'POST',headers:{Host:requestHost,Origin:origin,'Content-Type':'application/json'}},response=>{let data='';response.on('data',chunk=>data+=chunk);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(data)}));});request.on('error',reject);request.end(JSON.stringify(body));
 });
 try {
  assert.equal((await post({id:'codex:finder-local'})).status,200);
  assert.equal((await post({id:'codex:finder-file'})).status,200);
  assert.equal((await post({id:'codex:finder-remote'})).status,409);
  assert.equal((await post({id:'codex:unknown'})).status,404);
  assert.equal((await post({id:'codex:finder-local',path:'/Users/other'})).status,409);
  assert.equal((await post({key:'codex:finder-local'})).status,409);
  assert.equal((await post({id:'codex:finder-local'},'https://foreign.example')).status,403);
  assert.equal((await post({id:'codex:finder-local'},'http://evil.example','evil.example')).status,403);
  assert.deepEqual(fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse),[{file:'/usr/bin/open',args:['-a','Finder',fs.realpathSync(folder)]},{file:'/usr/bin/open',args:['-R',workingFile]}]);
 } finally {const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}
});

test('working file context comes from structured Claude tool activity and ignores prompts and agent files',()=>{
 const project=fs.mkdtempSync(path.join(root,'active-code-')),file=path.join(project,'implementation.md'),other=path.join(project,'other.md');
 fs.writeFileSync(file,'actual work');fs.writeFileSync(other,'reference');
 const internal=path.join(root,'.agents','skills','read-me.md');fs.mkdirSync(path.dirname(internal),{recursive:true});fs.writeFileSync(internal,'skill');
 const s=m.blank(),at='2026-10-21T15:00:00Z';
 m.applyClaude(s,{type:'user',timestamp:at,cwd:root,message:{content:'Work on '+file}});
 assert.equal(m.workLocation(root,s).workPath,'');
 m.applyClaude(s,{type:'assistant',timestamp:at,cwd:project,message:{content:[{type:'tool_use',name:'Edit',input:{file_path:file}}]}});
 m.applyClaude(s,{type:'assistant',timestamp:at,cwd:project,message:{content:[{type:'tool_use',name:'Read',input:{file_path:other}},{type:'tool_use',name:'Read',input:{file_path:internal}}]}});
 const location=m.workLocation(root,s);assert.equal(location.workPath,other);assert.equal(location.workPathKind,'file');assert.equal(location.workPathSource,'Claude Read');assert.equal(location.workPathUpdatedAt,Date.parse(at));
 assert.deepEqual(m.revealArgs({id:'one',context:location},{id:'one'}),['-R',other]);
 fs.unlinkSync(file);assert.equal(m.workLocation(project,s).workPath,other);
 fs.unlinkSync(other);assert.equal(m.workLocation(project,s).workPath,fs.realpathSync(project));
 assert.equal(m.workLocation(root,s).workPath,'');
 assert.equal(m.workLocation('/sessions/remote-only/workspace',s).workPath,'');
});
test('Codex work paths support explicit patch targets and tool folders and exclude imported history',()=>{
 const project=fs.mkdtempSync(path.join(root,'codex-active-')),file=path.join(project,'source.js');fs.writeFileSync(file,'real code');
 const s=m.blank();s.meta.cwd=root;m.applyCodex(s,event('task_started',{turn_id:'external-import-turn-22'}));
 const patch={type:'custom_tool_call',name:'apply_patch',input:'*** Begin Patch\n*** Update File: '+file+'\n@@\n-old\n+new\n*** End Patch'};
 m.applyCodex(s,response(patch));assert.equal(m.workLocation(root,s).workPath,'');
 m.applyCodex(s,event('task_started',{turn_id:'native'}));
 m.applyCodex(s,response({type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:'pwd',workdir:project})}));
 assert.equal(m.workLocation(root,s).workPath,project);
 s.meta.cwd=project;
 m.applyCodex(s,response({...patch,input:patch.input.replace(file,'source.js')}));assert.equal(m.workLocation(root,s).workPath,file);
 assert.equal(m.workLocation(root,s).workPathSource,'Codex patch');
 assert.deepEqual(m.revealArgs({id:'file',context:m.workLocation(root,s)},{id:'file'}),['-R',file]);
 fs.unlinkSync(file);assert.equal(m.workLocation(root,s).workPath,project);
});
test('Codex wrapper extraction accepts static tool fields without evaluating strings expressions or comments',()=>{
 const project=fs.mkdtempSync(path.join(root,'wrapper-active-')),file=path.join(project,'work.md');fs.writeFileSync(file,'written');
 const wrap=code=>{const state=m.blank();state.meta.cwd=root;m.applyCodex(state,event('task_started'));m.applyCodex(state,response({type:'custom_tool_call',name:'exec',input:code}));return m.workLocation(root,state);};
 assert.equal(wrap('text(await tools.exec_command({cmd:"pwd",workdir:'+JSON.stringify(project)+'}));').workPath,project);
 const patch='*** Begin Patch\n*** Add File: '+file+'\n+work\n*** End Patch';
 assert.equal(wrap('await tools.apply_patch('+JSON.stringify(patch)+');').workPath,file);
 assert.equal(wrap('const x='+JSON.stringify('tools.exec_command({workdir:'+JSON.stringify(project)+'})')+';').workPath,'');
 assert.equal(wrap('// tools.exec_command({workdir:'+JSON.stringify(project)+'})').workPath,'');
 assert.equal(wrap('await tools.exec_command({workdir:'+JSON.stringify(project)+' + suffix});').workPath,'');
 assert.equal(wrap('await tools.exec_command({workdir:'+JSON.stringify(project)+',...other});').workPath,'');
 assert.equal(wrap('await tools.exec_command({workdir:process.cwd()});').workPath,'');
 assert.equal(wrap('await tools.exec_command({cmd:'+JSON.stringify('echo "workdir: '+project+'"')+'});').workPath,'');
});
test('cold and incremental Codex context retain bounded prior actual work without imported or user paths',()=>{
 const project=fs.mkdtempSync(path.join(root,'prior-work-')),first=path.join(project,'first.md'),second=path.join(project,'second.md'),transcript=path.join(project,'history.jsonl');
 fs.writeFileSync(first,'first');fs.writeFileSync(second,'second');
 const tool=file=>response({type:'custom_tool_call',name:'apply_patch',input:'*** Begin Patch\n*** Update File: '+file+'\n@@\n-old\n+new\n*** End Patch'});
 const records=[{type:'session_meta',payload:{id:'work',originator:'Codex Desktop',cwd:root}},event('task_started',{turn_id:'one'}),tool(first),event('task_complete',{turn_id:'one',last_agent_message:'The implementation notes are ready.'}),event('task_started',{turn_id:'two'}),response({type:'message',role:'user',content:[{type:'input_text',text:'Please examine '+second}]})];
 fs.writeFileSync(transcript,records.map(JSON.stringify).join('\n')+'\n');
 assert.equal(m.workLocation(root,m.readTranscript(transcript,'codex')).workPath,first);
 fs.appendFileSync(transcript,JSON.stringify(tool(second))+'\n');assert.equal(m.workLocation(root,m.readTranscript(transcript,'codex')).workPath,second);
 fs.appendFileSync(transcript,[event('task_started',{turn_id:'external-import-turn-9'}),tool(first)].map(JSON.stringify).join('\n')+'\n');assert.equal(m.workLocation(root,m.readTranscript(transcript,'codex')).workPath,second);
});

test('new unrelated tool folder supersedes old file while files stay preferred within their current folder',()=>{
 const base=fs.mkdtempSync(path.join(root,'context-switch-')),a=path.join(base,'a'),b=path.join(base,'b'),file=path.join(a,'work.md');fs.mkdirSync(a);fs.mkdirSync(b);fs.writeFileSync(file,'work');
 const s=m.blank();s.meta.cwd=base;
 m.applyCodex(s,response({type:'custom_tool_call',name:'apply_patch',input:'*** Begin Patch\n*** Update File: '+file+'\n*** End Patch'}));
 m.applyCodex(s,response({type:'function_call',name:'exec_command',arguments:JSON.stringify({workdir:a,cmd:'pwd'})}));
 assert.equal(m.workLocation(base,s).workPath,file);
 m.applyCodex(s,response({type:'function_call',name:'exec_command',arguments:JSON.stringify({workdir:b,cmd:'pwd'})}));
 assert.equal(m.workLocation(base,s).workPath,b);
});
test('relative patch targets resolve against session cwd rather than a previous shell command folder',()=>{
 const base=fs.mkdtempSync(path.join(root,'patch-base-')),other=path.join(base,'other'),actual=path.join(base,'work.md'),wrong=path.join(other,'work.md');fs.mkdirSync(other);fs.writeFileSync(actual,'actual');fs.writeFileSync(wrong,'wrong');
 const s=m.blank();s.meta.cwd=base;
 m.applyCodex(s,response({type:'function_call',name:'exec_command',arguments:JSON.stringify({workdir:other,cmd:'pwd'})}));
 m.applyCodex(s,response({type:'custom_tool_call',name:'apply_patch',input:'*** Begin Patch\n*** Update File: work.md\n*** End Patch'}));
 assert.equal(m.workLocation(base,s).workPath,actual);
});

test('Claude leading cd supports only static literal folders and rejects dynamic paths',()=>{
 const folder=fs.mkdtempSync(path.join(root,'GTM folder '));
 const run=command=>{const s=m.blank();s.meta.cwd=root;m.applyClaude(s,{type:'assistant',timestamp:'2026-10-21T15:00:00Z',cwd:root,message:{content:[{type:'tool_use',name:'Bash',input:{command}}]}});return m.workLocation(root,s);};
 assert.equal(run('cd "'+folder+'" && git status').workPath,folder);
 assert.equal(run("cd '"+folder+"' && ls strategy/outreach-plan.md").workPath,folder);
 const simple=fs.mkdtempSync(path.join(root,'gtm-'));
 assert.equal(run('cd '+simple+' && git status').workPath,simple);
 for(const command of ['cd "$(pwd)" && ls','cd $HOME/project && ls','cd `pwd` && ls','echo cd '+simple,'cd "'+simple+'"/other && ls','cd '+simple+' > output','cd "'+simple+'${suffix}" && ls'])assert.equal(run(command).workPath,'',command);
 assert.equal(run('cd /sessions/unavailable/project && ls').workPath,'');
});

test('a newer file read supersedes an older edit in another project',()=>{
 const base=fs.mkdtempSync(path.join(root,'file-context-')),a=path.join(base,'a'),b=path.join(base,'b');fs.mkdirSync(a);fs.mkdirSync(b);
 const first=path.join(a,'work.md'),current=path.join(b,'work.md');fs.writeFileSync(first,'old');fs.writeFileSync(current,'current');
 const s=m.blank();
 for(const [name,file] of [['Edit',first],['Read',current]])m.applyClaude(s,{type:'assistant',cwd:base,message:{content:[{type:'tool_use',name,input:{file_path:file}}]}});
 assert.equal(m.workLocation(base,s).workPath,current);
});
