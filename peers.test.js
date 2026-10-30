'use strict';
// Multi-Mac viewing: config, socket-based trust, path stripping, peer polling and merge.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const http=require('http');
const net=require('net');
const {spawn,execFileSync}=require('child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'tower-peers-'));
process.env.TOWER_DATA_DIR=root;
process.env.TOWER_HOME=root;
const m=require('./server');

const SERVER=path.join(__dirname,'server.js');
const TAILNET='imac-test.tail0000.ts.net';
const LOGIN='owner@github';
const CONFIG={label:'iMac',tailnetHost:TAILNET,allowedLogin:LOGIN,peers:[{label:'Mac mini',url:'https://mini-test.tail0000.ts.net'}]};
const POST_ROUTES=['/api/reveal','/api/organize','/api/dismiss','/api/name','/api/focus'];
const GET_ROUTES=['/','/index.html','/api/sessions','/api/local'];
const ACTION_BODY={id:'codex:multi-local',parked:true,pinned:true,name:'Renamed',dismissId:'x'};
const event=(type,extra={},time=new Date().toISOString())=>({timestamp:time,type:'event_msg',payload:{type,...extra}});
const response=payload=>({timestamp:new Date().toISOString(),type:'response_item',payload});
// What `tailscale serve` adds when it forwards a request. The client's own Host
// is passed through unchanged (X-Forwarded-Host repeats it); a login header is
// added only for a signed-in personal device, so a forged request may have none.
const serveHeaders=host=>({'X-Forwarded-Host':host,'X-Forwarded-Proto':'https','X-Forwarded-For':'100.64.0.7'});

function peerRow(id,extra={}) {
  return {id,sessionId:id.split(':')[1],agent:id.split(':')[0],title:'Mini',fullTitle:'Mini work '+id,state:'working',lastActivity:Date.now(),
    summary:{text:'Mini progress',updatedAt:Date.now(),source:'Codex progress',stale:false},relationship:null,focusable:true,...extra};
}
const PEER_BODY={machine:'Mac mini',sessions:[
  peerRow('codex:mini-one',{context:{workPath:'/Users/mini/secret/file.md',cwd:'/Users/mini/secret',finderPath:'/Users/mini/secret'}}),
  peerRow('claude:mini-child',{relationship:{parentId:'codex:mini-one',kind:'spawn'},fullTitle:'Child at /Users/mini/secret/notes.md'})]};

// One home per server process: transcripts, a working folder and optional peers.json.
function makeHome(name,peers) {
  const home=fs.mkdtempSync(path.join(root,name+'-'));
  const dir=path.join(home,'.codex','sessions','2026','10','21'),folder=path.join(home,'secret project');
  fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(folder);
  const file=path.join(folder,'plan.md');fs.writeFileSync(file,'plan');
  fs.writeFileSync(path.join(home,'.codex','session_index.jsonl'),JSON.stringify({id:'multi-local',thread_name:'Review /Users/someone/private-project/plan.md'})+'\n');
  fs.writeFileSync(path.join(dir,'multi-local.jsonl'),[
    {type:'session_meta',payload:{id:'multi-local',cwd:folder,originator:'Codex Desktop',source:'vscode'}},
    event('task_started',{turn_id:'one'}),
    response({type:'custom_tool_call',name:'apply_patch',input:'*** Begin Patch\n*** Update File: '+file+'\n@@\n-a\n+b\n*** End Patch'}),
    event('task_complete',{turn_id:'one',last_agent_message:'Updated '+file+'.\n\nCan I ship the change?'})].map(JSON.stringify).join('\n')+'\n');
  if(peers!==undefined)fs.writeFileSync(path.join(home,'peers.json'),typeof peers==='string'?peers:JSON.stringify(peers));
  return {home,folder,file};
}

// Test-only stand-ins loaded before the real entry point: no Finder, desktop
// apps or network. Everything else is the server exactly as the login service runs it.
const PRELOAD=path.join(root,'test-preload.js');
fs.writeFileSync(PRELOAD,`'use strict';
const fs=require('fs'),cp=require('child_process'),original=cp.execFileSync;
cp.execFileSync=(file,...args)=>file==='ps'?'':original(file,...args);
cp.execFile=(file,args,options,callback)=>{fs.appendFileSync(process.env.TOWER_TEST_CALLS,JSON.stringify({file,args})+'\\n');callback(null);};
globalThis.fetch=async url=>{fs.appendFileSync(process.env.TOWER_TEST_FETCHES,String(url)+'\\n');return new Response(process.env.TOWER_TEST_PEER_BODY,{status:200,headers:{'content-type':'application/json'}});};
`);
// Free loopback ports, all held open together while they are picked, so the
// operating system can never hand the same port back twice.
async function freePorts(count) {
  const probes=[];
  try {
    for(let i=0;i<count;i++){
      const probe=net.createServer();probes.push(probe);
      await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
    }
    return probes.map(probe=>probe.address().port);
  } finally {await Promise.all(probes.map(probe=>new Promise(resolve=>probe.close(()=>resolve()))));}
}
async function freePort() { return (await freePorts(1))[0]; }
function spawnServer(home,port) {
  const env={...process.env,TOWER_HOME:home,TOWER_DATA_DIR:home,TOWER_PORT:String(port),
    TOWER_TEST_CALLS:path.join(home,'open-calls.jsonl'),TOWER_TEST_FETCHES:path.join(home,'fetch-calls.txt'),TOWER_TEST_PEER_BODY:JSON.stringify(PEER_BODY)};
  const child=spawn(process.execPath,['-r',PRELOAD,SERVER],{env,stdio:['ignore','ignore','pipe']});
  child.errors='';child.stderr.on('data',chunk=>child.errors+=chunk);
  return child;
}
// TCP ports this process is listening on, as the operating system reports them.
function listeningPorts(pid) {
  let out='';
  try {out=execFileSync('/usr/sbin/lsof',['-nP','-a','-p',String(pid),'-iTCP','-sTCP:LISTEN','-Fn'],{encoding:'utf8'});}
  catch(error){out=error.stdout || '';} // lsof exits 1 when nothing matches
  return [...out.matchAll(/^n.*:(\d+)$/gm)].map(match=>Number(match[1])).sort((a,b)=>a-b);
}

// The real server entry point on free ports. A peers.json that parses as an
// object is given this run's Tailscale view port, as a Mac's own file would name it.
async function startServer(t,home,options={}) {
  const [freeLocal,freeRemote]=await freePorts(2);
  const port=options.port ?? freeLocal,remotePort=options.remotePort ?? (freeRemote===port?freeLocal:freeRemote);
  if(port===remotePort)throw new Error('Test harness picked the same port twice ('+port+') for both listeners; refusing to start');
  const peersFile=path.join(home,'peers.json');
  let config=null;try{config=JSON.parse(fs.readFileSync(peersFile,'utf8'));}catch{}
  if(config && typeof config==='object' && !Array.isArray(config))fs.writeFileSync(peersFile,JSON.stringify({...config,remotePort}));
  const child=spawnServer(home,port);
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Test server did not start: '+child.errors)),8000);
    const check=()=>{if(/listening on/.test(child.errors)){clearTimeout(timer);resolve();}};
    child.stderr.on('data',check);check();
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Test server exited '+code+': '+child.errors));});
  });
  const call=({listener='local',method='GET',route='/api/sessions',host,headers={},body}={})=>new Promise((resolve,reject)=>{
    const target=listener==='remote'?remotePort:port;
    const request=http.request({hostname:'127.0.0.1',port:target,path:route,method,agent:false,
      headers:{Host:host ?? (listener==='remote'?TAILNET:'127.0.0.1:'+port),...(method==='POST'?{'Content-Type':'application/json'}:{}),...headers}},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{let json=null;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,text,json});});
    });request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
  });
  const recorded=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean):[];
  return {call,port,remotePort,listening:()=>listeningPorts(child.pid),
    alive:()=>child.exitCode===null && child.signalCode===null,errors:()=>child.errors,
    openCalls:()=>recorded(path.join(home,'open-calls.jsonl')),fetchCalls:()=>recorded(path.join(home,'fetch-calls.txt'))};
}
// A request as tailscale serve delivers it from your own signed-in device.
const remote=(headers={})=>({listener:'remote',host:TAILNET,headers:{...serveHeaders(TAILNET),'Tailscale-User-Login':LOGIN,...headers}});
function stateOf(home) { return JSON.parse(fs.readFileSync(path.join(home,'notifications.json'),'utf8')); }
function assertUntouched(server,home,before) {
  assert.deepEqual(server.openCalls(),[]);
  assert.equal(fs.existsSync(path.join(home,'names.json')),false);
  const after=stateOf(home);
  assert.deepEqual(after.organization,before.organization);assert.deepEqual(after.dismissed,before.dismissed);
}

test('peer config parses the shipped example and rejects anything ambiguous',()=>{
  const example=m.parsePeerConfig(JSON.parse(fs.readFileSync(path.join(__dirname,'peers.example.json'),'utf8')));
  assert.equal(example.label,'MacBook');assert.equal(example.tailnetHost,'macbook.tail1234.ts.net');assert.equal(example.allowedLogin,'your-login@github');
  assert.equal(example.remotePort,4434);
  assert.deepEqual(example.peers.map(peer=>peer.label),['Mac mini']);assert.match(example.peers[0].url,/^https:\/\/[^/]+\.tail1234\.ts\.net$/);
  assert.equal(m.parsePeerConfig({...CONFIG,tailnetHost:'IMAC-Test.tail0000.ts.net'}).tailnetHost,TAILNET);
  assert.deepEqual(m.parsePeerConfig({label:'iMac'}).peers,[]);
  assert.equal(m.parsePeerConfig(CONFIG).remotePort,4434,'the Tailscale view port defaults to 4434');
  assert.equal(m.parsePeerConfig({...CONFIG,remotePort:5555}).remotePort,5555);
  for(const bad of [null,[],'text',{},{...CONFIG,label:''},{...CONFIG,label:'Mac: one'},{...CONFIG,allowedLogin:undefined},{...CONFIG,tailnetHost:undefined},
    {...CONFIG,tailnetHost:'127.0.0.1'},{...CONFIG,tailnetHost:'localhost'},{...CONFIG,allowedLogin:'two words'},{...CONFIG,peers:{}},
    {...CONFIG,peers:[{label:'Mac mini',url:'http://mini-test.tail0000.ts.net'}]},{...CONFIG,peers:[{label:'Mac mini',url:'https://mini-test.tail0000.ts.net/api'}]},
    {...CONFIG,peers:[{label:'Mac mini',url:'https://user:pass@mini-test.tail0000.ts.net'}]},{...CONFIG,peers:[{label:'Mac mini',url:'https://'+TAILNET}]},
    {...CONFIG,peers:[{label:'iMac',url:'https://mini-test.tail0000.ts.net'}]},{...CONFIG,peers:[{label:'Mac mini',url:'not a url'}]},
    {...CONFIG,remotePort:4433},{...CONFIG,remotePort:'4434'},{...CONFIG,remotePort:80},{...CONFIG,remotePort:70000},{...CONFIG,remotePort:4434.5}])
    assert.throws(()=>m.parsePeerConfig(bad),undefined,JSON.stringify(bad));
  assert.equal(m.loadPeerConfig(path.join(root,'missing-peers.json')),null);
  const invalid=path.join(root,'invalid-peers.json');fs.writeFileSync(invalid,'{');assert.equal(m.loadPeerConfig(invalid),null);
});

test('trust comes from the listener: local needs a loopback Host and no proxy headers; the Tailscale view needs the tailnet name and login',()=>{
  const config=m.parsePeerConfig(CONFIG);
  const local=headers=>m.localAccess(headers).allowed;
  const view=(method,route,headers,peerConfig=config)=>m.remoteAccess(method,route,headers,peerConfig).allowed;
  assert.equal(local({host:'127.0.0.1:4433'}),true);assert.equal(local({host:'localhost:4433'}),true);
  for(const header of ['x-forwarded-for','x-forwarded-host','x-forwarded-proto','forwarded','tailscale-user-login','tailscale-user-name','tailscale-headers-info'])
    assert.equal(local({host:'127.0.0.1:4433',[header]:'x'}),false,header);
  assert.equal(local({host:TAILNET,'tailscale-user-login':LOGIN}),false,'the tailnet name grants nothing on the local listener');
  assert.equal(local({host:'evil.example'}),false);assert.equal(local({}),false);
  for(const route of GET_ROUTES) {
    assert.equal(view('GET',route,{host:TAILNET}),false);
    assert.equal(view('GET',route,{host:TAILNET,'tailscale-user-login':'someone@github'}),false);
    assert.equal(view('GET',route,{host:TAILNET,'tailscale-user-login':LOGIN}),true);
    assert.equal(view('GET',route,{host:TAILNET+':443','tailscale-user-login':LOGIN}),true);
    assert.equal(view('GET',route,{host:TAILNET,'tailscale-user-login':LOGIN},null),false);
    for(const host of ['127.0.0.1:4433','localhost:4433'])assert.equal(view('GET',route,{host,'tailscale-user-login':LOGIN}),false,'a loopback Host is never local on the Tailscale view');
  }
  for(const route of POST_ROUTES)for(const host of [TAILNET,'127.0.0.1:4433'])assert.equal(view('POST',route,{host,'tailscale-user-login':LOGIN}),false);
  assert.equal(view('GET','/favicon.ico',{host:TAILNET,'tailscale-user-login':LOGIN}),false);
  assert.equal(view('HEAD','/',{host:TAILNET,'tailscale-user-login':LOGIN}),false);
  assert.equal(view('GET','/api/sessions',{host:'evil.example','tailscale-user-login':LOGIN}),false);
  assert.equal(view('GET','/api/sessions',{}),false);
});

test('Tailscale listener: a forged loopback Host with proxy headers and no login is refused on every route',async t=>{
  const {home}=makeHome('forged',CONFIG);
  const server=await startServer(t,home);
  const before=stateOf(home);
  for(const host of ['127.0.0.1:4433','localhost:4433','127.0.0.1:'+server.port,'localhost:'+server.port]) {
    const headers=serveHeaders(host);
    for(const route of GET_ROUTES)assert.equal((await server.call({listener:'remote',route,host,headers})).status,403,host+' GET '+route);
    for(const route of POST_ROUTES)assert.equal((await server.call({listener:'remote',method:'POST',route,host,headers:{...headers,Origin:'http://'+host},body:ACTION_BODY})).status,403,host+' POST '+route);
  }
  assertUntouched(server,home,before);
});

test('Tailscale listener: the allowed login gets scrubbed views only; every POST and any forged loopback Host stay refused',async t=>{
  const {home,folder,file}=makeHome('allowed',CONFIG);
  const server=await startServer(t,home);
  const before=stateOf(home);
  assert.deepEqual(server.listening(),[server.port,server.remotePort].sort((a,b)=>a-b),'exactly the local and Tailscale view ports');
  for(const route of GET_ROUTES)assert.equal((await server.call({route,...remote()})).status,200,route);
  for(const route of ['/api/sessions','/api/local']) {
    const result=await server.call({route,...remote()});
    for(const secret of [home,fs.realpathSync(home),folder,file,'/Users/','/private/'])assert.equal(result.text.includes(secret),false,route+' leaked '+secret);
    assert.equal(result.json.sessions.length>0 && result.json.sessions.every(row=>row.viewOnly===true && !Object.hasOwn(row,'context')),true,route);
  }
  for(const host of ['127.0.0.1:4433','localhost:4433','127.0.0.1:'+server.port])
    for(const route of GET_ROUTES)assert.equal((await server.call({route,...remote({'X-Forwarded-Host':host}),host})).status,403,host+' '+route);
  for(const route of POST_ROUTES)for(const host of [TAILNET,'127.0.0.1:4433','127.0.0.1:'+server.port])
    assert.equal((await server.call({method:'POST',route,...remote({'X-Forwarded-Host':host,Origin:'http://'+host}),host,body:ACTION_BODY})).status,403,host+' POST '+route);
  assertUntouched(server,home,before);
});

test('dated project notes are available only on this Mac, never on remote or peer endpoints',async t=>{
  const {home}=makeHome('private-board',CONFIG);
  const privateNote='PRIVATE PROJECT NOTE '+Date.now();
  const board={source:{updatedAt:'Oct 26, 2:18 PM ET',importedAt:'2026-10-26T21:16:00Z'},projects:[{
    id:'local-proof',title:'Local project',stage:'built',freshness:'Source snapshot only',description:'',
    notes:[{status:'stuck',text:privateNote}],next:'',sessionIds:['codex:multi-local']
  }]};
  fs.writeFileSync(path.join(home,'project-board.json'),JSON.stringify(board));
  const server=await startServer(t,home);
  const local=await server.call();
  assert.equal(local.status,200);
  assert.equal(local.json.projectBoard.projects[0].notes[0].text,privateNote);
  assert.equal(local.json.sessions.some(row=>row.id==='codex:multi-local'),true);
  for(const options of [remote(),{route:'/api/local'},{route:'/api/local',...remote()},{route:'/',...remote()}]) {
    const result=await server.call(options);
    assert.equal(result.status,200);
    assert.equal(result.text.includes(privateNote),false);
    assert.equal(Boolean(result.json && Object.hasOwn(result.json,'projectBoard')),false);
  }
});

test('local listener refuses any request carrying proxy or Tailscale headers, even with its own loopback Host',async t=>{
  const {home}=makeHome('proxied',CONFIG);
  const server=await startServer(t,home);
  const before=stateOf(home),host='127.0.0.1:'+server.port;
  const variants=[{'X-Forwarded-For':'100.64.0.7'},{'X-Forwarded-Host':host},{'X-Forwarded-Proto':'https'},{Forwarded:'for=100.64.0.7;proto=https'},
    {'Tailscale-User-Login':LOGIN},{'Tailscale-User-Name':'Someone'},{'Tailscale-Headers-Info':'https://tailscale.com/s/serve-headers'},
    serveHeaders(host),{...serveHeaders(host),'Tailscale-User-Login':LOGIN}];
  for(const headers of variants) {
    for(const route of GET_ROUTES)assert.equal((await server.call({route,host,headers})).status,403,JSON.stringify(headers)+' GET '+route);
    for(const route of POST_ROUTES)assert.equal((await server.call({method:'POST',route,host,headers:{...headers,Origin:'http://'+host},body:ACTION_BODY})).status,403,JSON.stringify(headers)+' POST '+route);
  }
  assertUntouched(server,home,before);
  // The same Host without proxy headers is this Mac's own page and still works.
  assert.equal((await server.call({route:'/api/sessions',host})).status,200);
  assert.equal((await server.call({method:'POST',route:'/api/organize',host,headers:{Origin:'http://'+host},body:{id:'codex:multi-local',parked:true}})).status,200);
});

test('every POST is refused on the Tailscale listener before any action, with or without a login',async t=>{
  const {home}=makeHome('posts',CONFIG);
  const server=await startServer(t,home);
  const before=stateOf(home);
  for(const route of POST_ROUTES) {
    assert.equal((await server.call({method:'POST',route,listener:'remote',headers:serveHeaders(TAILNET),body:ACTION_BODY})).status,403,route+' without login');
    assert.equal((await server.call({method:'POST',route,...remote(),body:ACTION_BODY})).status,403,route+' with login');
    assert.equal((await server.call({method:'POST',route,...remote({Origin:'https://'+TAILNET}),body:ACTION_BODY})).status,403,route+' with same-site origin');
    assert.equal((await server.call({method:'POST',route,...remote(),host:'evil.example',body:ACTION_BODY})).status,403,route+' unknown host');
    assert.equal((await server.call({method:'POST',route,host:TAILNET,body:ACTION_BODY})).status,403,route+' tailnet name on the local listener');
  }
  assertUntouched(server,home,before);
});

test('GET on the Tailscale listener needs the tailnet name and the exact allowed login',async t=>{
  const {home}=makeHome('gets',CONFIG);
  const server=await startServer(t,home);
  for(const route of GET_ROUTES) {
    assert.equal((await server.call({route,listener:'remote',headers:serveHeaders(TAILNET)})).status,403,route+' without login');
    assert.equal((await server.call({route,...remote({'Tailscale-User-Login':'intruder@github'})})).status,403,route+' wrong login');
    assert.equal((await server.call({route,...remote()})).status,200,route+' right login');
    assert.equal((await server.call({route,...remote(),host:TAILNET+':443'})).status,200,route+' right login, explicit port');
    assert.equal((await server.call({route,...remote(),host:'evil.example'})).status,403,route+' unknown host');
    assert.equal((await server.call({route})).status,200,route+' loopback');
    assert.equal((await server.call({route,host:TAILNET,headers:{}})).status,403,route+' tailnet name on the local listener');
  }
  assert.equal((await server.call({route:'/favicon.ico',...remote()})).status,403);
  assert.match((await server.call({route:'/',...remote()})).text,/<title>Tower/);
});

test('remote feeds carry no filesystem paths, and /api/local never carries peer rows',async t=>{
  const {home,folder,file}=makeHome('paths',CONFIG);
  const server=await startServer(t,home);
  const secrets=[home,fs.realpathSync(home),folder,file,'/Users/','/private/','/var/folders','/Users/mini','private-project','project/plan.md'];
  for(const route of ['/api/sessions','/api/local']) {
    const result=await server.call({route,...remote()});
    assert.equal(result.status,200);
    for(const secret of secrets)assert.equal(result.text.includes(secret),false,route+' leaked '+secret);
    for(const row of result.json.sessions) {
      for(const key of ['context','workPath','finderPath','cwd','repositoryPath'])assert.equal(Object.hasOwn(row,key),false,route+' kept '+key);
      assert.equal(row.viewOnly,true);assert.equal(row.focusable,false);
    }
    assert.equal(result.json.sessions.some(row=>row.id==='codex:multi-local'),true);
  }
  for(const request of [{route:'/api/local'},{route:'/api/local',...remote()}]) {
    const rows=(await server.call(request)).json.sessions;
    assert.equal(rows.some(row=>row.id.startsWith('Mac mini:') || row.machine!=='iMac'),false);
    assert.deepEqual(rows.map(row=>row.id),['codex:multi-local']);
  }
  // Loopback viewing on this Mac keeps its own working location; only peer rows are stripped.
  const local=(await server.call()).json;
  const own=local.sessions.find(row=>row.id==='codex:multi-local');
  assert.equal(own.context.workPath,file);assert.equal(own.machine,'iMac');assert.notEqual(own.viewOnly,true);
  assert.equal(local.viewer,'local');assert.equal((await server.call(remote())).json.viewer,'remote');
});

test('loopback sessions merge prefixed, labeled peer rows; peer ids never reach local actions',async t=>{
  const {home}=makeHome('merge',CONFIG);
  const server=await startServer(t,home);
  let data;
  // The first peer poll runs in the background at startup.
  for(let i=0;i<40;i++){data=(await server.call()).json;if(data.peers?.[0]?.reachable)break;await new Promise(resolve=>setTimeout(resolve,50));}
  const fetchesBefore=server.fetchCalls().length;
  assert.equal(data.machine,'iMac');
  assert.deepEqual(data.peers.map(peer=>({label:peer.label,reachable:peer.reachable,message:peer.message})),[{label:'Mac mini',reachable:true,message:undefined}]);
  const ids=data.sessions.map(row=>row.id);
  assert.deepEqual(ids.filter(id=>id.startsWith('Mac mini:')).sort(),['Mac mini:claude:mini-child','Mac mini:codex:mini-one']);
  const peer=data.sessions.find(row=>row.id==='Mac mini:codex:mini-one'),child=data.sessions.find(row=>row.id==='Mac mini:claude:mini-child');
  assert.equal(peer.machine,'Mac mini');assert.equal(peer.viewOnly,true);assert.equal(peer.focusable,false);assert.equal(Object.hasOwn(peer,'context'),false);
  assert.equal(child.relationship.parentId,'Mac mini:codex:mini-one');assert.equal(child.fullTitle.includes('/Users/'),false);
  assert.equal(data.sessions.find(row=>row.id==='codex:multi-local').machine,'iMac');
  assert.equal(data.count,3);
  for(const route of POST_ROUTES)assert.equal((await server.call({method:'POST',route,body:{id:'Mac mini:codex:mini-one',parked:true,dismissId:'x',name:'x'}})).status,404,route);
  assert.equal((await server.call({method:'POST',route:'/api/focus',body:{id:'codex:mini-one'}})).status,404);
  assert.deepEqual(server.openCalls(),[]);
  // Peer polling is off the request path: serving pages and feeds fetches nothing.
  for(let i=0;i<3;i++)await server.call();
  assert.equal(server.fetchCalls().length,fetchesBefore);
  assert.deepEqual(server.fetchCalls(),['https://mini-test.tail0000.ts.net/api/local']);
});

test('no peers.json, or an invalid one, keeps the server loopback-only as today, with nothing listening for Tailscale',async t=>{
  for(const [name,peers] of [['missing',undefined],['broken','{'],['incomplete',JSON.stringify({label:'iMac',tailnetHost:TAILNET})]]) {
    const {home,file}=makeHome('noconfig-'+name,peers);
    const server=await startServer(t,home);
    assert.deepEqual(server.listening(),[server.port],name+' opened another port');
    await assert.rejects(server.call({route:'/api/sessions',...remote()}),/ECONNREFUSED/,name);
    const data=(await server.call()).json;
    assert.deepEqual(Object.keys(data).sort(),['count','nativePinStatus','now','sessions','unknownCount','updatedAt','workingCount'],name);
    const row=data.sessions.find(item=>item.id==='codex:multi-local');
    assert.equal(row.context.workPath,file);
    for(const key of ['machine','viewOnly','peer'])assert.equal(Object.hasOwn(row,key),false,name+' added '+key);
    assert.equal(row.focusable,false);
    assert.equal((await server.call({route:'/api/local'})).status,404,name);
    for(const route of GET_ROUTES)assert.equal((await server.call({route,host:TAILNET,headers:{'Tailscale-User-Login':LOGIN}})).status,403,name+' '+route);
    assert.equal((await server.call({method:'POST',route:'/api/organize',host:TAILNET,headers:{'Tailscale-User-Login':LOGIN},body:{id:'codex:multi-local',parked:true}})).status,403,name);
    assert.equal((await server.call({method:'POST',route:'/api/organize',body:{id:'codex:multi-local',parked:true}})).status,200,name);
    assert.deepEqual(server.fetchCalls(),[],name);
  }
});

test('this Mac\'s port already in use writes one log line and exits non-zero',async t=>{
  const blocker=net.createServer();
  await new Promise(resolve=>blocker.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>blocker.close(resolve)));
  const taken=blocker.address().port;
  for(const [name,peers] of [['no peers.json',undefined],['with peers.json',CONFIG]]) {
    const child=spawnServer(makeHome('busy-local',peers).home,taken);
    const code=await new Promise(resolve=>{
      const timer=setTimeout(()=>{child.kill();resolve('still running');},4000);
      child.once('exit',code=>{clearTimeout(timer);resolve(code);});
    });
    assert.equal(typeof code,'number',name+' kept running: '+child.errors);assert.notEqual(code,0,name);
    const lines=child.errors.trim().split('\n');
    assert.equal(lines.length,1,name+' wrote more than one line: '+child.errors);
    assert.match(lines[0],new RegExp('port '+taken+' is already in use'),name);
    assert.doesNotMatch(child.errors,/^\s+at /m,name+' printed a stack trace');
  }
});

// The Tailscale view is optional. Losing its port must never take down this
// Mac's own page, or the login service would restart into the same failure forever.
test('the Tailscale view port already in use writes one line and keeps this Mac\'s page and the peer poller running',async t=>{
  const blocker=net.createServer();
  await new Promise(resolve=>blocker.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>blocker.close(resolve)));
  const taken=blocker.address().port;
  const {home}=makeHome('busy-remote',CONFIG);
  const server=await startServer(t,home,{remotePort:taken});
  assert.deepEqual(server.listening(),[server.port],'only this Mac\'s port should be open');
  assert.equal((await server.call({route:'/'})).status,200);
  const feed=await server.call();
  assert.equal(feed.status,200);assert.equal(feed.json.machine,'iMac');assert.equal(feed.json.viewer,'local');
  assert.equal((await server.call({method:'POST',route:'/api/organize',body:{id:'codex:multi-local',parked:true}})).status,200);
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal(server.alive(),true,'exited: '+server.errors());
  assert.ok(server.fetchCalls().includes('https://mini-test.tail0000.ts.net/api/local'),'peer poller did not run');
  const lines=server.errors().trim().split('\n').filter(line=>!/listening on/.test(line));
  assert.equal(lines.length,1,'expected one line about the Tailscale port: '+server.errors());
  assert.match(lines[0],new RegExp('Tailscale view port '+taken+' in use; running local only$'));
  assert.doesNotMatch(server.errors(),/^\s+at /m,'printed a stack trace');
});

// Two free ports picked one after the other can be the same port; the harness
// must never run both listeners on one, or tests flake.
test('the test harness gives the two listeners distinct ports and refuses to start on one port twice',async t=>{
  const {home}=makeHome('harness-ports',CONFIG);
  const one=await freePort();
  await assert.rejects(startServer(t,home,{port:one,remotePort:one}),/same port twice/);
  const ports=await freePorts(4);
  assert.equal(new Set(ports).size,4,'free ports repeated: '+ports);
  const server=await startServer(t,home);
  assert.notEqual(server.port,server.remotePort);
  assert.deepEqual(server.listening(),[server.port,server.remotePort].sort((a,b)=>a-b));
});

const fakeClock=()=>{const start=new Date();start.setHours(16,12,0,0);return start.getTime();};
const json=value=>new Response(typeof value==='string'?value:JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
test('peer poller keeps the last good rows, hides them after 15 seconds and names the last seen time',async()=>{
  let now=fakeClock(),tick=0,mode='ok';const urls=[];
  const fetch=async(url)=>{urls.push(String(url));if(mode==='fail')throw new Error('offline');return json(PEER_BODY);};
  const poller=m.createPeerPoller({peers:[{label:'Mac mini',url:'https://mini-test.tail0000.ts.net'}],fetch,now:()=>now,monotonic:()=>tick});
  const advance=ms=>{now+=ms;tick+=ms;};
  assert.deepEqual(poller.snapshot(),{rows:[],status:[{label:'Mac mini',reachable:false,lastSeen:null}]});
  await poller.pollOnce();
  assert.deepEqual(urls,['https://mini-test.tail0000.ts.net/api/local']);
  let snapshot=poller.snapshot();
  assert.deepEqual(snapshot.rows.map(row=>row.id),['Mac mini:codex:mini-one','Mac mini:claude:mini-child']);
  assert.equal(snapshot.rows.every(row=>row.machine==='Mac mini' && row.viewOnly && row.peer && !row.focusable && !Object.hasOwn(row,'context')),true);
  assert.deepEqual(snapshot.status,[{label:'Mac mini',reachable:true,lastSeen:now}]);
  const seen=now;mode='fail';
  for(let i=0;i<3;i++){advance(5000);await poller.pollOnce();}
  assert.equal(poller.snapshot().rows.length,2,'exactly 15 seconds keeps the last good result');
  advance(1);snapshot=poller.snapshot();
  assert.deepEqual(snapshot.rows,[]);
  assert.deepEqual(snapshot.status,[{label:'Mac mini',reachable:false,lastSeen:seen,message:'Mac mini not reachable, last seen 4:12 PM'}]);
  mode='ok';await poller.pollOnce();
  assert.equal(poller.snapshot().rows.length,2);assert.equal(poller.snapshot().status[0].message,undefined);
});

test('peer freshness uses a monotonic clock; wall-clock jumps only change the last-seen wording',async()=>{
  let wall=fakeClock(),tick=1000,mode='ok';
  const fetch=async()=>{if(mode==='fail')throw new Error('offline');return json(PEER_BODY);};
  const poller=m.createPeerPoller({peers:[{label:'Mac mini',url:'https://mini-test.tail0000.ts.net'}],fetch,now:()=>wall,monotonic:()=>tick});
  await poller.pollOnce();
  const seen=wall;
  // The wall clock jumps forward an hour while one real second passes: still fresh.
  wall+=3600000;tick+=1000;
  assert.equal(poller.snapshot().rows.length,2);assert.equal(poller.snapshot().status[0].reachable,true);
  // It jumps back two hours while 16 real seconds pass without a good poll: hidden.
  mode='fail';wall-=7200000;tick+=16000;await poller.pollOnce();
  const snapshot=poller.snapshot();
  assert.deepEqual(snapshot.rows,[]);
  assert.deepEqual(snapshot.status,[{label:'Mac mini',reachable:false,lastSeen:seen,message:'Mac mini not reachable, last seen 4:12 PM'}]);
});

test('peer bodies are read as a byte-counted stream and refused past the size cap',async()=>{
  const peers=[{label:'Mac mini',url:'https://mini-test.tail0000.ts.net'}],cap=64*1024,chunk=16*1024;
  // A declared length over the cap is refused before the body is touched.
  let touched=false;
  const declared=async()=>({ok:true,status:200,headers:new Headers({'content-length':String(cap+1)}),
    body:{getReader(){touched=true;throw new Error('read');}},text:async()=>{touched=true;return '{"sessions":[]}';}});
  let poller=m.createPeerPoller({peers,fetch:declared,maxBytes:cap});
  await poller.pollOnce();
  assert.equal(touched,false,'body was read despite its declared size');assert.equal(poller.snapshot().status[0].reachable,false);
  // An undeclared, long body stops being read just past the cap and is cancelled.
  let pulls=0,cancelled=false;
  const long=async()=>new Response(new ReadableStream({pull(controller){pulls++;if(pulls>200)return controller.close();controller.enqueue(new Uint8Array(chunk).fill(32));},cancel(){cancelled=true;}},{highWaterMark:0}));
  poller=m.createPeerPoller({peers,fetch:long,maxBytes:cap,timeoutMs:1000});
  await poller.pollOnce();
  assert.equal(cancelled,true,'stream was not cancelled');assert.ok(pulls<=cap/chunk+2,'read '+pulls+' chunks');
  assert.equal(poller.snapshot().status[0].reachable,false);
  // The cap counts bytes, not characters.
  const wide=JSON.stringify({sessions:[],pad:'é'.repeat(cap/2)});
  assert.ok(wide.length<=cap && Buffer.byteLength(wide)>cap);
  poller=m.createPeerPoller({peers,fetch:async()=>json(wide),maxBytes:cap});
  await poller.pollOnce();assert.equal(poller.snapshot().status[0].reachable,false,'multibyte body over the byte cap was accepted');
  // A body of exactly the cap, declared or not, is accepted.
  const exact=JSON.stringify(PEER_BODY),padded=exact+' '.repeat(cap-Buffer.byteLength(exact));
  for(const headers of [{'content-length':String(cap)},{}]) {
    poller=m.createPeerPoller({peers,fetch:async()=>new Response(padded,{status:200,headers}),maxBytes:cap});
    await poller.pollOnce();assert.equal(poller.snapshot().rows.length,2,JSON.stringify(headers));
  }
});

test('never-reached, slow, refused and malformed peers count as unreachable within the time bound',async()=>{
  const peers=[{label:'Mac mini',url:'https://mini-test.tail0000.ts.net'}];
  const cases={
    offline:async()=>{throw new Error('offline');},
    abortable:(url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))),
    ignoresAbort:()=>new Promise(()=>{}),
    slowBody:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});}})),
    refused:async()=>new Response('{"ok":false}',{status:403}),
    malformed:async()=>json('{"nope":true}'),
    notJson:async()=>json('<html>'),
    empty:async()=>new Response(null,{status:200}),
  };
  for(const [name,fetch] of Object.entries(cases)) {
    const poller=m.createPeerPoller({peers,fetch,timeoutMs:40});
    const started=Date.now();await poller.pollOnce();
    assert.ok(Date.now()-started<1500,name+' exceeded its bound');
    const snapshot=poller.snapshot();
    assert.deepEqual(snapshot.rows,[],name);
    assert.deepEqual(snapshot.status,[{label:'Mac mini',reachable:false,lastSeen:null,message:'Mac mini not reachable'}],name);
  }
});

test('poller runs immediately and then every 5 seconds until stopped',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  let count=0;
  const poller=m.createPeerPoller({peers:[{label:'Mac mini',url:'https://mini-test.tail0000.ts.net'}],fetch:async()=>{count++;return json('{"sessions":[]}');}});
  poller.start();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(count,1);
  t.mock.timers.tick(4999);await new Promise(resolve=>setImmediate(resolve));assert.equal(count,1);
  t.mock.timers.tick(1);await new Promise(resolve=>setImmediate(resolve));assert.equal(count,2);
  t.mock.timers.tick(5000);await new Promise(resolve=>setImmediate(resolve));assert.equal(count,3);
  poller.stop();t.mock.timers.tick(20000);await new Promise(resolve=>setImmediate(resolve));assert.equal(count,3);
});

test('peer rows are sanitized: prefixed ids, safe types, no paths, and broken rows dropped',()=>{
  assert.equal(m.sanitizePeerRow(null,'Mac mini'),null);
  assert.equal(m.sanitizePeerRow({state:'working'},'Mac mini'),null);
  for(const id of ['/Users/someone/x','codex:/Users/someone','no-colon','codex:a b','x'.repeat(50)+':y'])assert.equal(m.sanitizePeerRow({id},'Mac mini'),null,id);
  assert.equal(m.sanitizePeerRow({id:'codex:a',relationship:{parentId:'/Users/someone'}},'Mac mini').relationship,null);
  const row=m.sanitizePeerRow({id:'codex:x',agent:'codex',state:'exploded',fullTitle:'Plan in ~/Projects/secret/a.md',question:'Ship /Volumes/Data/x?',lastActivity:'soon',pinned:'yes',
    summary:{text:'Edited /private/tmp/y.txt',updatedAt:5,source:'Codex final reply',stale:'no'},context:{workPath:'/Users/x'},relationship:{parentId:'codex:y',kind:'fork'},focusable:true,extra:'/Users/x'},'Mac mini');
  assert.equal(row.id,'Mac mini:codex:x');assert.equal(row.state,'unknown');assert.equal(row.lastActivity,0);assert.equal(row.pinned,false);
  assert.equal(row.summary.stale,false);assert.equal(row.relationship.parentId,'Mac mini:codex:y');
  assert.equal(row.focusable,false);assert.equal(row.viewOnly,true);assert.equal(row.machine,'Mac mini');
  assert.equal(Object.hasOwn(row,'context'),false);assert.equal(Object.hasOwn(row,'extra'),false);
  assert.doesNotMatch(JSON.stringify(row),/~\/Projects|\/Volumes\/|\/private\/|\/Users\//);
  const local=m.remoteRow({id:'claude:z',state:'finished',fullTitle:'At /Users/rob/tower/server.js',summary:{text:'ok',updatedAt:1,source:'Claude recap',stale:false},context:{workPath:'/Users/someone'},focusable:true,focusLabel:'Open Claude app'});
  assert.equal(Object.hasOwn(local,'context'),false);assert.equal(local.focusable,false);assert.equal(local.viewOnly,true);assert.doesNotMatch(local.fullTitle,/\/Users\//);
});

test('merge orders local and peer rows together and recounts them',()=>{
  const local={sessions:[{id:'codex:a',state:'finished',lastActivity:3,context:{workPath:'/Users/someone/a'}},{id:'claude:b',state:'working',lastActivity:9,context:{}}],nativePinStatus:{},now:10,updatedAt:10,count:2,workingCount:1,unknownCount:0};
  const snapshot={rows:[m.sanitizePeerRow({id:'codex:c',state:'decision',lastActivity:1},'Mac mini'),m.sanitizePeerRow({id:'codex:d',state:'unknown',lastActivity:2},'Mac mini')],status:[{label:'Mac mini',reachable:true,lastSeen:9}]};
  const config=m.parsePeerConfig(CONFIG);
  const merged=m.mergeSessions(local,snapshot,config,false);
  assert.deepEqual(merged.sessions.map(row=>row.id),['Mac mini:codex:c','codex:a','claude:b','Mac mini:codex:d']);
  assert.deepEqual(merged.sessions.map(row=>row.machine),['Mac mini','iMac','iMac','Mac mini']);
  assert.equal(merged.count,4);assert.equal(merged.workingCount,1);assert.equal(merged.unknownCount,1);
  assert.equal(merged.sessions[1].context.workPath,'/Users/someone/a');
  const remoteMerged=m.mergeSessions(local,snapshot,config,true);
  assert.equal(remoteMerged.viewer,'remote');assert.equal(remoteMerged.sessions.some(row=>Object.hasOwn(row,'context')),false);
  assert.equal(m.peerMessage('Mac mini',null,10),'Mac mini not reachable');
});
