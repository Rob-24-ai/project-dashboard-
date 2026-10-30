'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {validateBoard,readProjectBoard,attachProjectBoard,applyProjectPreferences,updateProjectPreference,MAX_BYTES} = require('./project-board');
const sample = () => ({source:{updatedAt:'Oct 26, 2:18 PM ET',importedAt:'2026-10-26T21:16:00Z',url:'javascript:untrusted()'},projects:[{id:'tagging',title:'Reference image tagging',stage:'built',freshness:'Not rechecked',description:'A source report',notes:[{status:'stuck',text:'Not proven with real images.'}],next:'Try by voice',sessionIds:['claude:local_123']}]});
function fixture(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tower-project-board-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }
test('project copy preserves source dates and stages without accepting arbitrary fields or source destinations',()=>{
  const raw=sample();raw.secret='private';raw.projects[0].working=true;
  const board=validateBoard(raw);
  assert.equal(board.source.url,'');assert.equal(validateBoard({...raw,source:{...raw.source,url:'https://example.com/map'}}).source.url,'https://example.com/map');assert.equal(board.source.updatedAt,raw.source.updatedAt);
  assert.equal(board.projects[0].stage,'built');assert.equal(board.projects[0].notes[0].status,'stuck');
  assert.equal('secret' in board,false);assert.equal('working' in board.projects[0],false);
  assert.notEqual(board.projects[0],raw.projects[0]);
  raw.projects[0].sessionIds=['Mac mini:claude:local_123'];
  assert.deepEqual(validateBoard(raw).projects[0].sessionIds,raw.projects[0].sessionIds);
});
test('ambiguous assignments, duplicate projects, invalid stages and oversized text are refused',()=>{
  for (const edit of [b=>b.projects.push({...b.projects[0]}),b=>b.projects.push({...b.projects[0],id:'other'}),b=>b.projects[0].sessionIds.push('claude:local_123'),b=>b.projects[0].stage='finished',b=>b.projects[0].notes[0].status='working',b=>b.projects[0].title='x'.repeat(201),b=>b.projects[0].sessionIds.push('../path'),b=>b.source.importedAt='not a date']) {
    const board=sample();edit(board);assert.throws(()=>validateBoard(board));
  }
});
test('missing, partial and oversized imports cannot replace the session feed or claim a current map',t=>{
  const dir=fixture(t), payload={sessions:[{id:'one',state:'working'}]};
  assert.equal(attachProjectBoard(payload,dir,false),payload);
  fs.writeFileSync(path.join(dir,'project-board.json'),'{');
  assert.deepEqual(readProjectBoard(dir),{status:'unavailable'});
  assert.deepEqual(attachProjectBoard(payload,dir,false),{...payload,projectBoardStatus:'unavailable'});
  fs.writeFileSync(path.join(dir,'project-board.json'),' '.repeat(MAX_BYTES+1));
  assert.deepEqual(readProjectBoard(dir),{status:'unavailable'});
});
test('private map copy and associations are returned locally only, never in remote or peer feeds',t=>{
  const dir=fixture(t),payload={sessions:[{id:'one',state:'working'}]};
  fs.writeFileSync(path.join(dir,'project-board.json'),JSON.stringify(sample()));
  assert.equal(attachProjectBoard(payload,dir,true),payload);
  assert.equal(attachProjectBoard(payload,'/does/not/exist',true),payload);
  const local=attachProjectBoard(payload,dir,false);assert.equal(local.projectBoard.projects.length,1);
  assert.equal(payload.projectBoard,undefined);
  const preferences={tagging:{title:'PRIVATE TITLE',attention:{state:'waiting',reason:'PRIVATE REASON',origin:'manual'}}};
  let observed=false;
  assert.equal(attachProjectBoard(payload,dir,true,preferences,()=>{observed=true;}),payload);
  assert.equal(observed,false);
  assert.equal(JSON.stringify(attachProjectBoard(payload,dir,true,preferences)).includes('PRIVATE'),false);
});
test('project attention defaults from the source and manual choices survive missing chats and imports',()=>{
  const raw=sample();raw.projects[0].stage='wait';
  const board=validateBoard(raw),at=Date.parse('2026-10-28T18:00:00Z');
  let result=applyProjectPreferences(board,[],{},at);
  assert.deepEqual(result.board.projects[0].attention,{state:'waiting',reason:'Try by voice',origin:'source'});
  assert.equal(result.changed,true);
  let preferences=updateProjectPreference(result.board,{}, {id:'tagging',attention:'later'},at);
  preferences=JSON.parse(JSON.stringify(preferences));
  result=applyProjectPreferences(board,[],preferences,at+1000);
  assert.equal(result.board.projects[0].attention.state,'later');assert.equal(result.board.projects[0].attention.origin,'manual');
  assert.equal(result.board.projects[0].attention.reason,'Try by voice');assert.equal(board.projects[0].attention,undefined);
  preferences=updateProjectPreference(result.board,preferences,{id:'tagging',attention:'waiting'},at+2000);
  assert.equal(applyProjectPreferences(board,[],preferences,at+3000).board.projects[0].attention.state,'waiting');
  assert.equal(applyProjectPreferences(validateBoard(sample()),[],{},at).board.projects[0].attention.state,'resolved');
});
test('a source waiting need survives a later board refresh and restart until an explicit choice',()=>{
  const raw=sample();raw.projects[0].stage='wait';
  const board=validateBoard(raw),at=123;
  const initial=applyProjectPreferences(board,[],{},at);
  assert.equal(initial.preferences.tagging.attention.state,'waiting');
  assert.equal(initial.preferences.tagging.attention.origin,'source');
  let preferences=JSON.parse(JSON.stringify(initial.preferences));
  const refreshed=validateBoard(sample());refreshed.projects[0].next='Different source next step';
  let result=applyProjectPreferences(refreshed,[],preferences,at+1);
  assert.equal(result.board.projects[0].attention.state,'waiting');
  assert.equal(result.board.projects[0].attention.reason,'Try by voice');
  assert.equal(result.changed,false);
  for(const state of ['later','resolved']) {
    preferences=updateProjectPreference(result.board,result.preferences,{id:'tagging',attention:state},at+2);
    result=applyProjectPreferences(board,[],JSON.parse(JSON.stringify(preferences)),at+3);
    assert.equal(result.board.projects[0].attention.state,state);
    assert.equal(result.board.projects[0].attention.origin,'manual');
    assert.equal(result.changed,false);
  }
});
test('new mapped requests latch, survive a missing chat, and only a new event reopens a resolved project',()=>{
  const board=validateBoard(sample()),at=Date.parse('2026-10-28T18:00:00Z');
  const request={id:'claude:local_123',state:'decision',eventId:'question:first',dismissId:'decision:first',question:'May I proceed?',lastActivity:at};
  let result=applyProjectPreferences(board,[request],{},at);
  assert.equal(result.changed,true);assert.deepEqual(result.board.projects[0].attention,{state:'waiting',reason:'May I proceed?',sessionId:request.id,updatedAt:at,origin:'request'});
  let preferences=JSON.parse(JSON.stringify(result.preferences));
  for(const sessions of [[],[{...request,lastActivity:at-2*86400000}]])
    assert.equal(applyProjectPreferences(board,sessions,preferences,at+3*86400000).board.projects[0].attention.state,'waiting');
  preferences=updateProjectPreference(result.board,preferences,{id:'tagging',attention:'resolved'},at+1);
  result=applyProjectPreferences(board,[request],preferences,at+2);
  assert.equal(result.board.projects[0].attention.state,'resolved');assert.equal(result.changed,false);
  result=applyProjectPreferences(board,[{...request,eventId:'question:second',question:'Approve the next step?'}],result.preferences,at+3);
  assert.equal(result.board.projects[0].attention.state,'waiting');assert.equal(result.board.projects[0].attention.reason,'Approve the next step?');
  assert.deepEqual(preferences.tagging.attention.state,'resolved');
});
test('a chat request clears once that chat stops asking, and only request needs follow their chat',()=>{
  const board=validateBoard(sample()),at=Date.parse('2026-10-28T18:00:00Z');
  const request={id:'claude:local_123',state:'decision',eventId:'question:first',dismissId:'decision:first',question:'May I proceed?',lastActivity:at};
  const latched=JSON.parse(JSON.stringify(applyProjectPreferences(board,[request],{},at).preferences));
  for(const [row,state] of [[request,'waiting'],[{...request,state:'working'},'resolved'],[{...request,state:'finished'},'resolved'],[{...request,dismissed:true},'resolved']]) {
    const result=applyProjectPreferences(board,[row],latched,at+1);
    assert.equal(result.board.projects[0].attention.state,state);assert.equal(result.changed,state==='resolved');
    if(state==='resolved'){assert.equal(result.board.projects[0].attention.origin,'request');assert.equal(result.board.projects[0].attention.updatedAt,at+1);}
  }
  const later=updateProjectPreference(applyProjectPreferences(board,[request],latched,at).board,latched,{id:'tagging',attention:'later'},at+1);
  assert.equal(applyProjectPreferences(board,[{...request,state:'working'}],later,at+2).board.projects[0].attention.state,'later','a manual choice is yours, not the chat\'s');
  const requestLater={tagging:{...latched.tagging,attention:{...latched.tagging.attention,state:'later'}}};
  assert.equal(applyProjectPreferences(board,[{...request,state:'working'}],requestLater,at+2).board.projects[0].attention.state,'resolved');
  const answered=applyProjectPreferences(board,[{...request,state:'working'}],latched,at+2);
  const again=applyProjectPreferences(board,[{...request,state:'working'}],answered.preferences,at+3);assert.equal(again.changed,false);
  assert.equal(applyProjectPreferences(board,[{...request,eventId:'question:second',question:'And this?'}],answered.preferences,at+4).board.projects[0].attention.state,'waiting');
});
test('project request inheritance uses the nearest explicit mapping, rejects cycles, and skips old or dismissed requests',()=>{
  const raw=sample();raw.projects.push({...raw.projects[0],id:'other',title:'Other',sessionIds:['codex:direct']});
  const board=validateBoard(raw),at=Date.parse('2026-10-28T18:00:00Z');
  const decision=(id,extra={})=>({id,state:'decision',eventId:'q:'+id,question:'May I proceed?',lastActivity:at,...extra});
  const base={id:'claude:local_123',state:'finished'};
  for(const [row,expected] of [[decision('codex:child',{relationship:{parentId:base.id}}),'tagging'],[decision('codex:direct',{relationship:{parentId:base.id}}),'other']]) {
    const result=applyProjectPreferences(board,[base,row],{},at);
    assert.equal(result.board.projects.find(p=>p.id===expected).attention.state,'waiting');
    assert.equal(result.board.projects.find(p=>p.id!==expected).attention.state,'resolved');
  }
  const nearest=applyProjectPreferences(board,[base,{id:'codex:direct',state:'finished',relationship:{parentId:base.id}},decision('codex:grandchild',{relationship:{parentId:'codex:direct'}})],{},at);
  assert.equal(nearest.board.projects[0].attention.state,'resolved');assert.equal(nearest.board.projects[1].attention.state,'waiting');
  const skipped=[decision('codex:old',{lastActivity:at-86400001,relationship:{parentId:base.id}}),decision('codex:dismissed',{dismissed:true,relationship:{parentId:base.id}}),decision('codex:orphan',{relationship:{parentId:'missing'}})];
  let result=applyProjectPreferences(board,[base,...skipped],{},at);assert.equal(result.board.projects.every(p=>p.attention.state==='resolved'),true);
  result=applyProjectPreferences(board,[base,decision('codex:permission',{lastActivity:at-2*86400000,decisionSource:'permission-prompt',relationship:{parentId:base.id}})],{},at);
  assert.equal(result.board.projects[0].attention.state,'waiting');
  result=applyProjectPreferences(board,[{...base,relationship:{parentId:'codex:cycle'}},decision('codex:cycle',{relationship:{parentId:base.id}})],{},at);
  assert.equal(result.board.projects.every(p=>p.attention.state==='resolved'),true);
});
test('a mapped parent with an unavailable older ancestor still passes its project to a present child',()=>{
  const board=validateBoard(sample()),at=123;
  const parent={id:'claude:local_123',state:'finished',relationship:{parentId:'claude:unavailable-older-parent'}};
  const child={id:'codex:child',state:'decision',eventId:'question:child',question:'May I continue?',lastActivity:at,relationship:{parentId:parent.id}};
  const result=applyProjectPreferences(board,[parent,child],{},at);
  assert.equal(result.board.projects[0].attention.state,'waiting');
  assert.equal(result.board.projects[0].attention.sessionId,child.id);
});
test('dismissal-only event tokens latch once and an explicit later choice survives repeated polls',()=>{
  const board=validateBoard(sample()),at=Date.now(),row={id:'claude:local_123',state:'decision',dismissId:'decision:first',question:'Please approve this.',lastActivity:at};
  let result=applyProjectPreferences(board,[row],{},at);
  const preferences=updateProjectPreference(result.board,result.preferences,{id:'tagging',attention:'later'},at+1);
  result=applyProjectPreferences(board,[row],preferences,at+2);assert.equal(result.board.projects[0].attention.state,'later');assert.equal(result.changed,false);
  result=applyProjectPreferences(board,[{...row,dismissId:'decision:second'}],preferences,at+3);assert.equal(result.board.projects[0].attention.state,'waiting');
  const old={...row,lastActivity:at-86400001};
  result=applyProjectPreferences(board,[old],{},at);assert.equal(result.board.projects[0].attention.state,'resolved');
  assert.equal(applyProjectPreferences(board,[{...old,lastActivity:at}],result.preferences,at).board.projects[0].attention.state,'resolved');
});
test('project preferences validate exact actions and title overrides preserve source provenance and isolation',()=>{
  const board=validateBoard(sample()),at=123;
  let preferences=updateProjectPreference(board,{}, {id:'tagging',title:'  Cloudflare  '},at);
  const result=applyProjectPreferences(board,[],preferences,at);
  assert.equal(result.board.projects[0].title,'Cloudflare');assert.equal(result.board.projects[0].sourceTitle,'Reference image tagging');
  preferences=updateProjectPreference(result.board,preferences,{id:'tagging',attention:'waiting'},at);
  assert.equal(preferences.tagging.title,'Cloudflare');assert.equal(board.projects[0].title,'Reference image tagging');
  for(const patch of [null,[],{id:'missing',attention:'waiting'},{id:'tagging',attention:'bad'},{id:'tagging',attention:'later',title:'Both'},{id:'tagging',title:''},{id:'tagging',title:'x'.repeat(201)},{id:'tagging',title:'bad\nname'},{id:'tagging',attention:'later',extra:true}])
    assert.throws(()=>updateProjectPreference(board,preferences,patch,at));
});
