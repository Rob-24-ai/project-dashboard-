'use strict';
// Optional, installation-local project notes kept by hand or copied from your own
// project map. Never a writer to that map, a model-generated summary, or an input
// to session lifecycle.
const fs = require('node:fs');
const path = require('node:path');
const STAGES = new Set(['live','built','prog','wait','pause','stuck','park']);
const MAX_BYTES = 512 * 1024;
const ATTENTION_STATES = new Set(['waiting','later','resolved']);
const object = value => value && typeof value==='object' && !Array.isArray(value);
const own = (value,key) => object(value) && Object.hasOwn(value,key) ? value[key] : undefined;
// Only a plain https link may become the source link on the page.
const sourceUrl = value => { try { const url=new URL(value);return typeof value==='string'&&value.length<=2000&&url.protocol==='https:'&&!url.username&&!url.password?url.href:''; } catch { return ''; } };
const reasonText = value => typeof value==='string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,4000) : '';
function validateBoard(value) {
  const fail = () => { throw new Error('Invalid project notes'); };
  const text = (value, max, optional=false) => {
    if (optional && value === undefined) return '';
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return fail();
    return value;
  };
  if (!value || typeof value !== 'object' || !value.source || !Array.isArray(value.projects) || value.projects.length > 100) return fail();
  const source = {title:text(value.source.title,120,true),url:sourceUrl(value.source.url),updatedAt:text(value.source.updatedAt,160),importedAt:text(value.source.importedAt,160,true)};
  if (!source.updatedAt.trim() || (source.importedAt && !Number.isFinite(Date.parse(source.importedAt)))) return fail();
  const projectIds = new Set(), assignedIds = new Set();
  const projects = value.projects.map(project => {
    if (!project || typeof project !== 'object' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(project.id) || projectIds.has(project.id) || !STAGES.has(project.stage)) return fail();
    projectIds.add(project.id);
    if (!Array.isArray(project.notes) || project.notes.length > 100 || !Array.isArray(project.sessionIds) || project.sessionIds.length > 200) return fail();
    const sessionIds = project.sessionIds.map(id => {
      if (typeof id !== 'string' || !id.trim() || id.length > 240 || /[\u0000-\u001f\u007f/\\]/.test(id) || assignedIds.has(id)) return fail();
      assignedIds.add(id); return id;
    });
    const title = text(project.title,200);
    if (!title.trim()) return fail();
    return {id:project.id,title,stage:project.stage,freshness:text(project.freshness,1500),description:text(project.description,2000,true),
      notes:project.notes.map(note => {
        if (!note || !STAGES.has(note.status)) return fail();
        return {status:note.status,text:text(note.text,12000)};
      }), next:text(project.next,4000,true),sessionIds};
  });
  return {source,projects};
}
function readProjectBoard(directory) {
  const filename = path.join(directory,'project-board.json');
  try {
    if (fs.statSync(filename).size > MAX_BYTES) throw new Error('Project notes too large');
    return {board:validateBoard(JSON.parse(fs.readFileSync(filename,'utf8')))};
  } catch (error) {
    return error.code === 'ENOENT' ? {} : {status:'unavailable'};
  }
}
// Project needs are durable local preferences, not a session lifecycle or a map edit.
// Only exact assignments and verified acyclic parent edges may supply a request.
function projectAssignments(board,sessions) {
  const byId=new Map(sessions.filter(row=>row && typeof row.id==='string').map(row=>[row.id,row]));
  const explicit=new Map(),assignments=new Map();
  for(const project of board.projects)for(const id of project.sessionIds)if(byId.has(id)&&!explicit.has(id))explicit.set(id,project.id);
  for(const row of byId.values()) {
    if(explicit.has(row.id)){assignments.set(row.id,explicit.get(row.id));continue;}
    const seen=new Set([row.id]);let cursor=row.relationship?.parentId,nearest=null,valid=true;
    // Missing older rows end the known forest. They do not invalidate a present
    // child's verified edge to an explicitly mapped parent. Cycles still do.
    while(cursor&&byId.has(cursor)) {
      if(seen.has(cursor)){valid=false;break;}
      seen.add(cursor);if(nearest===null&&explicit.has(cursor))nearest=explicit.get(cursor);
      cursor=byId.get(cursor).relationship?.parentId;
    }
    if(valid&&nearest!==null)assignments.set(row.id,nearest);
  }
  return assignments;
}
function sourceAttention(project) { return {state:project.stage==='wait'?'waiting':'resolved',reason:project.stage==='wait'?reasonText(project.next):'',origin:'source'}; }
function storedAttention(project,preference) {
  const value=preference?.attention;
  if(!object(value)||!ATTENTION_STATES.has(value.state))return sourceAttention(project);
  const attention={state:value.state,reason:reasonText(value.reason),origin:['source','request','manual'].includes(value.origin)?value.origin:'manual'};
  if(typeof value.sessionId==='string'&&value.sessionId.length<=240)attention.sessionId=value.sessionId;
  if(Number.isFinite(value.updatedAt))attention.updatedAt=value.updatedAt;
  return attention;
}
function validTitle(value) { return typeof value==='string' && value.trim().length>0 && value.trim().length<=200 && !/[\u0000-\u001f\u007f]/.test(value); }
function applyProjectPreferences(board,sessions,preferences={},at=Date.now()) {
  const original=object(preferences)?preferences:{},assignments=projectAssignments(board,sessions);
  let next=original;
  // A copied waiting stage is the initial need, not a live source of truth for
  // clearing it. Once observed, only an explicit choice or a new request changes it.
  for(const project of board.projects) {
    const previous=own(next,project.id)||{};
    if(project.stage==='wait'&&(!object(previous.attention)||!ATTENTION_STATES.has(previous.attention.state)))
      next={...next,[project.id]:{...previous,attention:sourceAttention(project)}};
  }
  // Chronological order makes the newest newly observed request the displayed reason.
  const requests=sessions.filter(row=>row?.state==='decision'&&assignments.has(row.id)).sort((a,b)=>Number(a.lastActivity||0)-Number(b.lastActivity||0));
  for(const row of requests) {
    const projectId=assignments.get(row.id),previous=own(next,projectId)||{};
    const token=typeof row.eventId==='string'&&row.eventId ? row.eventId : typeof row.dismissId==='string'&&row.dismissId ? row.dismissId : '';
    if(!token || token.length>600 || own(previous.seenRequests,row.id)===token)continue;
    const seenRequests={...(object(previous.seenRequests)?previous.seenRequests:{}),[row.id]:token};
    const preference={...previous,seenRequests};
    // Remember skipped events too. An old or dismissed request must not replay
    // because the clock or another session's organization later changes.
    const aged=row.decisionSource!=='permission-prompt'&&Number(row.lastActivity)>0&&Number(row.lastActivity)<at-86400000;
    if(!row.dismissed&&!aged)preference.attention={state:'waiting',reason:reasonText(row.question),sessionId:row.id,updatedAt:at,origin:'request'};
    next={...next,[projectId]:preference};
  }
  // A request raised by a chat clears once that chat stops asking: you answered it,
  // or dismissed the request. A chat that drops out of the feed keeps the need.
  const rows=new Map(sessions.filter(row=>typeof row?.id==='string').map(row=>[row.id,row]));
  for(const project of board.projects) {
    const previous=own(next,project.id),attention=previous?.attention;
    if(!object(attention)||attention.origin!=='request'||!['waiting','later'].includes(attention.state))continue;
    const row=rows.get(attention.sessionId);
    if(!row||(row.state==='decision'&&!row.dismissed))continue;
    next={...next,[project.id]:{...previous,attention:{...attention,state:'resolved',updatedAt:at}}};
  }
  const projects=board.projects.map(project=>{
    const preference=own(next,project.id),title=validTitle(preference?.title)?preference.title.trim():project.title;
    return {...project,title,...(title!==project.title?{sourceTitle:project.title}:{}),attention:storedAttention(project,preference)};
  });
  return {board:{...board,projects},preferences:next,changed:next!==original};
}
function validateProjectAction(board,patch) {
  const fail=()=>{throw new Error('Choose one project attention or title action.');};
  if(!object(patch)||Object.keys(patch).length!==2||typeof patch.id!=='string'||!board.projects.some(project=>project.id===patch.id))return fail();
  const attention=Object.hasOwn(patch,'attention'),title=Object.hasOwn(patch,'title');
  if(attention===title || (attention&&!ATTENTION_STATES.has(patch.attention)) || (title&&!validTitle(patch.title)))return fail();
  if(Object.keys(patch).some(key=>!['id',attention?'attention':'title'].includes(key)))return fail();
}
function updateProjectPreference(board,preferences,patch,at=Date.now()) {
  validateProjectAction(board,patch);
  const original=object(preferences)?preferences:{},previous=own(original,patch.id)||{};
  const project=board.projects.find(project=>project.id===patch.id);
  const preference=Object.hasOwn(patch,'title') ? {...previous,title:patch.title.trim()} :
    {...previous,attention:{...(project.attention || storedAttention(project,previous)),state:patch.attention,updatedAt:at,origin:'manual'}};
  return {...original,[patch.id]:preference};
}
function attachProjectBoard(payload, directory, remote, preferences={},onPreferences) {
  // The tailnet feed must not acquire private project notes or associations.
  if (remote) return payload;
  const result = readProjectBoard(directory);
  if (result.board) {
    const local=applyProjectPreferences(result.board,payload.sessions || [],preferences,Number(payload.now)||Date.now());
    if(local.changed&&typeof onPreferences==='function')onPreferences(local.preferences);
    return {...payload,projectBoard:local.board};
  }
  if (result.status) return {...payload,projectBoardStatus:result.status};
  return payload;
}
module.exports = {validateBoard,readProjectBoard,attachProjectBoard,applyProjectPreferences,validateProjectAction,updateProjectPreference,MAX_BYTES};
