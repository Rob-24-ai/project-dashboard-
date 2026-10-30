'use strict';
// Tower reads desktop session files. It only writes its own local monitor state.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { execFile, execFileSync } = require('child_process');
const { attachProjectBoard, readProjectBoard, applyProjectPreferences, validateProjectAction, updateProjectPreference } = require('./project-board');
const HOME = process.env.TOWER_HOME || os.homedir();
const HOST = '127.0.0.1';
const PORT = Number(process.env.TOWER_PORT || 4433);
const DATA_DIR = process.env.TOWER_DATA_DIR || __dirname;
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const CLAUDE_DESKTOP = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const DISCOVERY_MS = 24 * 60 * 60 * 1000;
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const log = error => console.error('[tower]', new Date().toISOString(), String(error));
function loadJson(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
// Native app pins are read-only input, never copied into Tower organization.
// A partial settings write must not briefly erase the user's working set.
function createNativePinReader(home) {
  const sources = {
    codex:{file:path.join(home,'.codex','.codex-global-state.json'),select:value=>value?.['pinned-thread-ids']},
    claude:{file:path.join(home,'Library','Application Support','Claude','claude_desktop_config.json'),select:value=>value?.preferences?.epitaxyPrefs?.['starred-local-code-sessions']}
  };
  const lastKnown = {};
  return () => {
    const ids = {}, status = {};
    for (const [agent, source] of Object.entries(sources)) {
      try {
        const values=source.select(JSON.parse(fs.readFileSync(source.file,'utf8')));
        if (!Array.isArray(values) || values.some(id=>typeof id!=='string' || !id || id.length>128 || /[\s/\\]/.test(id))) throw new Error('Invalid pin list');
        lastKnown[agent]=new Set(values);
        status[agent]={available:true,status:'available',stale:false,count:lastKnown[agent].size};
      } catch (error) {
        const stale=Object.hasOwn(lastKnown,agent);
        status[agent]={available:false,status:stale?'stale':'unavailable',stale,count:lastKnown[agent]?.size || 0,reason:error.code==='ENOENT'?'missing-settings':'invalid-settings'};
      }
      ids[agent]=lastKnown[agent] || new Set();
    }
    return {ids,status};
  };
}
const readNativePins = createNativePinReader(HOME);
let nativePins = {ids:{codex:new Set(),claude:new Set()},status:{}};
function saveJson(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
const stateFile = path.join(DATA_DIR, 'notifications.json');
const namesFile = path.join(DATA_DIR, 'names.json');
let saved = loadJson(stateFile);
if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
saved.dismissed ||= {};
saved.tracked ||= {};
saved.labels ||= {};
if (!saved.organization || typeof saved.organization !== 'object' || Array.isArray(saved.organization)) saved.organization = {};
if (!saved.projectPreferences || typeof saved.projectPreferences !== 'object' || Array.isArray(saved.projectPreferences)) saved.projectPreferences = {};
// Establish a one-time baseline, not a stream of old recently-active conversations.
if (!saved.startedAt) { saved.startedAt = Date.now(); saveJson(stateFile, saved); }
function lines(text) { return text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function stamp(o) { const n = Date.parse(o.timestamp); return Number.isFinite(n) ? n : 0; }
function token(o, prefix) { return prefix + ':' + (o.uuid || o.payload?.turn_id || o.timestamp || crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 20)); }
// Conservative cue from the current final answer only, never prior prompt text.
// This is a request detector, not proof every human decision can be recognized.
// Bound final-answer inspection, skipping fenced code, blockquotes and picture-only paragraphs.
function decisionParagraphs(text) {
  const clean=String(text || '').slice(0,64*1024).replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'')
    .split('\n').filter(l=>!/^\s*>/.test(l)).join('\n').trim();
  return clean.split(/\n\s*\n/).filter(p=>p.replace(/!\[[^\]]*\]\([^)]*\)/g,'').trim());
}
function requestEvidence(paragraph) {
  if(/^\s*(?:For example|Example(?: request| wording)?|Sample(?: request| wording| output)?|Test case)\s*:/i.test(paragraph))return '';
  return paragraph.replace(/`[^`\n]*`|[“"][^”"\n]*[”"]|‘[^’\n]*’/g,'')
    .replace(/(^|\s)'[^'\n]*'(?=\s|[.,;:!?]|$)/g,'$1').replace(/[*_]/g,'');
}
function directRequest(paragraph) {
  return paragraph.match(/(?:^|[.!?]\s+|\n|:\s+)((?:Can|May|Should|Shall) (?:I|we) [^?\n]{2,220}\?)(?:\s|$)/i)?.[1]
    || paragraph.match(/(?:^|[.!?]\s+|\n|:\s+)((?:Would you like me to|Do you want me to|Do you (?:approve|agree to|confirm)) [^?\n]{2,220}\?)(?:\s|$)/i)?.[1]
    || paragraph.match(/(?:^|[.!?]\s+|\n|:\s+)((?:Please (?:approve|confirm|choose|decide)|(?:I need|Awaiting|Waiting for) your (?:approval|decision|confirmation))\b[^\n]{0,220}[.?]?)\s*$/i)?.[1] || '';
}
function requestParagraph(text) {
  const paragraphs=decisionParagraphs(text),last=paragraphs.at(-1) || '';
  const current=(p,index)=>!/^\s*(?:For example|Example(?: request| wording)?|Sample(?: request| wording| output)?|Test case)\s*:\s*$/i.test(paragraphs[index-1] || '')
    && !/^(?:Yes|No)[.!,:](?:\s|$)|^(?:The answer is|Answer:)\s|^No\s+[^.!?\n]{1,100}\s+(?:is|are)\s+(?:needed|required|necessary)\b|^That question is (?:now )?resolved\b/i.test(requestEvidence(paragraphs[index+1] || '').trim());
  // Preserve generic closing questions. Earlier paragraphs require a direct request,
  // so an answered factual question does not become a request merely by containing '?'.
  if(String(text || '').length<=64*1024 && current(last,paragraphs.length-1) && /\?(?:\s|$)/.test(requestEvidence(last).slice(-700)))return last;
  return paragraphs.findLast((p,index)=>directRequest(requestEvidence(p))
    && current(p,index)) || '';
}
function asksDecision(text) { return !!requestParagraph(text); }
// Presentation extracts only explicit assistant text, never prompts or tool payloads.
function displayText(value, limit = 420) {
  if (typeof value !== 'string') return '';
  return value.replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*\[(?:STATUS|COMPLETE)\]\s*/gm, '')
    .replace(/\uE200visualize\uE202[\s\S]*?\uE201/g, '')
    .replace(/^\s*::(?:codex-realtime-inline|artifact|visualize)\{[^\n]*\}\s*$/gm, '')
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/([`"'])\/(?:Users|private)\/[^\n]*?\1/g, 'working file')
    .replace(/\/(?:Users|private)\/[^\s<>"'`)\]}]+/g, token=>'working file'+(token.match(/[.,;:!?]+$/)?.[0] || ''))
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_,bold,underlined)=>bold || underlined)
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function questionText(input) {
  if (typeof input === 'string') { try { input=JSON.parse(input); } catch { return ''; } }
  const questions=Array.isArray(input?.questions) ? input.questions : [];
  return questions.map(q=>displayText(q.question || q.title, 500)).filter(Boolean).join(' · ').slice(0, 1000);
}
function finalQuestion(text) {
  const evidence=requestEvidence(requestParagraph(text)),request=directRequest(evidence);
  if(request)return displayText(request,700);
  const end=evidence.lastIndexOf('?')+1;
  return displayText(evidence.slice(Math.max(0,end-700),end),700);
}
function usefulContext(text) {
  return text.length >= 16 && !/^(?:okay|ok|done|paused|thanks|thank you|understood|got it)[.! ]*$/i.test(text)
    && !/^(?:(?:Do you )?want to (?:do|try) (?:one of )?(?:those|these|that|this)(?: now)?|(?:Shall|Should) (?:I|we) (?:continue|proceed)|Let me know(?: what you think| if you want to continue)?)[.!? ]*$/i.test(text);
}
function rememberFinal(s, text, o) {
  const excerpt=displayText(text);
  // A bare acknowledgement is not a useful context summary.
  if (usefulContext(excerpt)) {
    s.lastFinal={text:excerpt,updatedAt:stamp(o),uuid:o.uuid || null};
    s.lastProgress=null;
  }
}
function rememberProgress(s, text, o) {
  const excerpt=displayText(text);
  if(usefulContext(excerpt))s.lastProgress={text:excerpt,updatedAt:stamp(o),uuid:o.uuid || null};
}
function nativeTitle(title, agent) {
  return typeof title==='string' && title.trim() ? title.trim().slice(0,1000) : (agent==='claude'?'Claude conversation':'Codex conversation');
}
function claudeRelationship(metadata) {
  if (!metadata || metadata.lineageDetached) return null;
  const spawn=metadata.spawnedFrom;
  const parent=spawn?.sessionId || metadata.forkedFromSessionId || metadata.forkedFrom?.sessionId;
  if (typeof parent!=='string' || !parent || parent===metadata.sessionId || /[\s/\\]/.test(parent)) return null;
  return {parentId:'claude:'+parent,kind:spawn?.sessionId ? (spawn.handOff ? 'handoff' : spawn.sideSession ? 'side-session' : 'spawn') : 'fork'};
}
function readCodexDetails(home = HOME) {
  const result={};
  try { for (const e of lines(fs.readFileSync(path.join(home,'.codex','session_index.jsonl'),'utf8'))) if(e.id && e.thread_name)result[e.id]={title:e.thread_name}; } catch {}
  const database=path.join(home,'.codex','state_5.sqlite');
  if (!fs.existsSync(database)) return result;
  try {
    const records=JSON.parse(execFileSync('sqlite3',['-readonly','-json',database,'SELECT id, name, cwd, git_branch, archived FROM threads;'],{encoding:'utf8',timeout:2000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','ignore']}));
    for (const row of records) result[row.id]={...result[row.id],...(typeof row.name==='string' && row.name.trim()?{title:row.name}:{}),cwd:row.cwd || '',branch:row.git_branch || '',archived:!!row.archived};
  } catch { /* Older schema, absent sqlite, or a busy database: use the native index. */ }
  return result;
}
const locationCache=new Map();
function localDirectory(value) {
  if(typeof value!=='string' || !path.isAbsolute(value) || /[\u0000\r\n]/.test(value))return '';
  try {const directory=fs.realpathSync(value);return fs.statSync(directory).isDirectory()?directory:'';} catch {return '';}
}
function sessionLocation(cwd, refresh=false) {
  const now=Date.now(),cached=locationCache.get(cwd);
  if(!refresh && cached && now-cached.checkedAt<30000)return cached.location;
  const directory=localDirectory(cwd);let repositoryPath='';
  if(directory) {
    try {
      // Inherited Git overrides must not redirect discovery outside this folder.
      const env={...process.env,GIT_OPTIONAL_LOCKS:'0'};
      for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES'])delete env[key];
      const result=execFileSync('/usr/bin/git',['-C',directory,'rev-parse','--show-toplevel'],{encoding:'utf8',timeout:1500,maxBuffer:8192,stdio:['ignore','pipe','ignore'],env}).trim();
      const root=localDirectory(result),relative=root?path.relative(root,directory):'..';
      if(root && relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative))repositoryPath=root;
    } catch { /* An existing nonrepository folder can still be opened in Finder. */ }
  }
  const location={repositoryPath,finderPath:repositoryPath || directory};
  if(locationCache.size>=256)locationCache.clear();
  locationCache.set(cwd,{checkedAt:now,location});return location;
}
// Only structured tool inputs provide activity locations. No prompt/prose scanning.
function usefulWorkPath(value) {
  if(typeof value!=='string' || !path.isAbsolute(value) || /[\u0000\r\n]/.test(value))return false;
  const normalized=path.resolve(value);
  if([HOME,os.homedir(),'/'].some(home=>normalized===path.resolve(home)))return false;
  for(const home of [HOME,os.homedir()])for(const name of ['.codex','.claude','.agents']) {
    const internal=path.join(home,name);
    if(normalized===internal || normalized.startsWith(internal+path.sep))return false;
  }
  if(/^\/(?:private\/)?(?:tmp|var\/folders)\//.test(normalized) && /\.(?:log|jsonl)$/i.test(normalized))return false;
  return true;
}
function recordWork(s,value,kind,source,o,operation='read',cwd='') {
  if(typeof value!=='string' || !value || value.length>4096)return;
  const base=cwd || s.meta.cwd;
  const resolved=path.isAbsolute(value)?path.normalize(value):base && path.isAbsolute(base)?path.resolve(base,value):'';
  if(!usefulWorkPath(resolved))return;
  const candidate={path:resolved,kind,source,updatedAt:stamp(o) || null,operation};
  s.workEvidence=[candidate,...(s.workEvidence || []).filter(item=>item.path!==resolved)].slice(0,24);

}
function leadingShellFolder(s,command,o,cwd='') {
  if(typeof command!=='string' || command.length>1024*1024)return;
  // Only a literal leading cd is supported; no shell expansion or later commands.
  const match=command.match(/^\s*cd\s+(?:"([^"$`\\\r\n]+)"|'([^'\r\n]+)'|([^\s;&|<>`$\\]+))\s*(?:&&|;|$)/);
  const folder=match && (match[1] || match[2] || match[3]);
  if(folder && !folder.startsWith('-') && !/[\u0000]/.test(folder))recordWork(s,folder,'directory','Claude command starting folder',o,'directory',cwd);
}
function patchWork(s,patch,o,source,cwd='') {
  if(typeof patch!=='string' || patch.length>1024*1024)return;
  for(const match of patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm))recordWork(s,match[1].trim(),'file',source,o,'write',cwd);
}
// Tokenize static literals only. Strings/comments are never searched as code,
// expressions are not evaluated, and interpolated templates are unsupported.
function staticTokens(code) {
  if(typeof code!=='string' || code.length>1024*1024)return [];
  const tokens=[];let i=0;
  while(i<code.length && tokens.length<20000) {
    const ch=code[i];
    if(/\s/.test(ch)){i++;continue;}
    if(code.startsWith('//',i)){const end=code.indexOf('\n',i+2);i=end<0?code.length:end+1;continue;}
    if(code.startsWith('/*',i)){const end=code.indexOf('*/',i+2);if(end<0)return [];i=end+2;continue;}
    if(ch==='"' || ch==="'" || ch==='`') {
      const quote=ch;let value='',closed=false;i++;
      while(i<code.length) {
        let c=code[i++];if(c===quote){closed=true;break;}
        if(quote==='`' && c==='$' && code[i]==='{')return [];
        if(c==='\\') {
          if(i>=code.length)return [];c=code[i++];
          if(c==='u' || c==='x') {const count=c==='u'?4:2,hex=code.slice(i,i+count);if(!new RegExp('^[0-9a-fA-F]{'+count+'}$').test(hex))return [];value+=String.fromCharCode(parseInt(hex,16));i+=count;continue;}
          if(c==='\n')continue;
          value+=({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0'})[c] ?? c;
        } else value+=c;
      }
      if(!closed)return [];tokens.push({type:'string',value});continue;
    }
    // Conservatively skip slash-delimited regexes; unsupported division may
    // hide a call, but cannot invent a location from regex source text.
    if(ch==='/') {i++;let escaped=false,inClass=false;while(i<code.length){const c=code[i++];if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c==='[')inClass=true;if(c===']')inClass=false;if(c==='/' && !inClass)break;}continue;}
    const identifier=code.slice(i).match(/^[A-Za-z_$][\w$]*/);
    if(identifier){tokens.push({type:'identifier',value:identifier[0]});i+=identifier[0].length;continue;}
    tokens.push({type:'punctuation',value:ch});i++;
  }
  return i<code.length?[]:tokens;
}
function wrapperWork(s,code,o) {
  const tokens=staticTokens(code);
  for(let i=0;i<tokens.length-4;i++) {
    if(tokens[i].type!=='identifier' || tokens[i].value!=='tools' || tokens[i+1].value!=='.' || tokens[i+3].value!=='(')continue;
    const name=tokens[i+2].value,arg=tokens[i+4];
    if(name==='apply_patch' && arg.type==='string' && tokens[i+5]?.value===')')patchWork(s,arg.value,o,'Codex patch');
    if(name!=='exec_command' || arg.value!=='{')continue;
    let depth=1,workdir='',invalid=false;
    for(let j=i+5;j<tokens.length && depth;j++) {
      const token=tokens[j];
      if(depth===1 && token.value==='.' && tokens[j+1]?.value==='.')invalid=true;
      if(depth===1 && token.value==='workdir' && tokens[j+1]?.value===':') {
        const value=tokens[j+2],after=tokens[j+3];
        if(workdir || value?.type!=='string' || ![',','}'].includes(after?.value))invalid=true;
        else workdir=value.value;
      }
      if(token.type==='punctuation' && ['{','[','('].includes(token.value))depth++;
      if(token.type==='punctuation' && ['}',']',')'].includes(token.value))depth--;
    }
    if(workdir && !invalid)recordWork(s,workdir,'directory','Codex tool working folder',o,'directory');
  }
}
function codexWork(s,p,o) {
  if(!['function_call','custom_tool_call'].includes(p.type))return;
  const name=String(p.name || '').replace(/^functions\./,'');
  let input=p.arguments ?? p.input;
  if(name==='exec'){wrapperWork(s,input,o);return;}
  if(name==='apply_patch'){patchWork(s,input,o,'Codex patch');return;}
  if(typeof input==='string'){try{input=JSON.parse(input);}catch{return;}}
  if(!input || typeof input!=='object')return;
  if(name==='exec_command' && typeof input.workdir==='string')recordWork(s,input.workdir,'directory','Codex tool working folder',o,'directory');
  if(['read_file','write_file','edit_file'].includes(name))recordWork(s,input.file_path || input.path,'file','Codex '+name,o,name==='read_file'?'read':'write',input.workdir);
}
function workLocation(cwd,s) {
  const evidence=s.workEvidence || [];
  const directoryIndex=evidence.findIndex(item=>item.kind==='directory'),latestDirectory=directoryIndex<0?null:evidence[directoryIndex];
  const files=evidence.filter((item,index)=>{
    if(item.kind!=='file')return false;
    if(!latestDirectory || index<directoryIndex)return true;
    const relative=path.relative(latestDirectory.path,item.path);
    return relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
  });
  const candidates=[...files,...(latestDirectory?[latestDirectory]:[])];
  for(const item of candidates) {
    if(!usefulWorkPath(item.path))continue;
    try {
      if(!usefulWorkPath(fs.realpathSync(item.path)))continue;
      const stat=fs.statSync(item.path);
      if((item.kind==='file' && !stat.isFile()) || (item.kind==='directory' && !stat.isDirectory()))continue;
      return {workPath:item.path,workPathKind:item.kind,workPathSource:item.source,workPathUpdatedAt:item.updatedAt,finderPath:item.path};
    } catch { /* Retired or VM-only tool paths are unavailable locally. */ }
  }
  const resolved=usefulWorkPath(cwd)?localDirectory(cwd):'';
  const directory=usefulWorkPath(resolved)?resolved:'';
  return {workPath:directory,workPathKind:directory?'directory':'',workPathSource:directory?'Session working folder':'',workPathUpdatedAt:null,finderPath:directory};
}
function revealArgs(row, body) {
  if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length!==1 || typeof body.id!=='string' || body.id!==row?.id)throw new Error('Choose a conversation to open its local folder.');
  // Resolve again from server-owned cwd at click time, never accept client paths.
  const target=row.context?.workPath;
  if(!usefulWorkPath(target))throw new Error('No local working file or folder is available for this conversation.');
  let stat;try{stat=fs.statSync(target);}catch{throw new Error('The working file or folder is no longer available.');}
  if(stat.isFile())return ['-R',target];
  if(stat.isDirectory())return ['-a','Finder',target];
  throw new Error('No local working file or folder is available for this conversation.');
}
function presentation(tracked, s, state, decisionSource) {
  const metadata=tracked.metadata;
  let summary={text:'',updatedAt:null,source:tracked.agent==='claude'?'Claude recap':'Codex final reply',stale:false};
  if (tracked.agent==='claude' && metadata) {
    const recap=metadata.postTurnSummary;
    const valid=!!recap?.summarizes_uuid && recap.summarizes_uuid===metadata.lastAssistantUuid;
    const date=s.lastFinal && s.lastFinal.uuid===recap?.summarizes_uuid ? s.lastFinal.updatedAt : Number(metadata.lastTurnEdgeAt || metadata.lastActivityAt) || null;
    summary={text:valid?displayText(recap.status_detail):'',updatedAt:valid?date:null,source:'Claude recap',stale:!!recap && (!valid || !!s.lastAssistantUuid && s.lastAssistantUuid!==recap.summarizes_uuid || s.lastActivity>date)};
  } else if (tracked.agent==='codex' && s.lastFinal) {
    summary={...s.lastFinal,source:'Codex final reply',stale:s.lastActivity>s.lastFinal.updatedAt};
    delete summary.uuid;
  }
  // Recaps lag active turns. Prefer newer, public assistant text when present;
  // keep a useful native recap for the same reply. Never synthesize a new claim.
  const latest=s.lastProgress && (!s.lastFinal || s.lastProgress.updatedAt>=s.lastFinal.updatedAt) ? s.lastProgress : s.lastFinal;
  const sameReply=tracked.agent==='claude' && latest?.uuid && metadata?.postTurnSummary?.summarizes_uuid===latest.uuid;
  if(latest?.text && (!summary.text || !usefulContext(summary.text) || !sameReply && latest.updatedAt>=(summary.updatedAt || 0))) {
    summary={text:latest.text,updatedAt:latest.updatedAt,source:(tracked.agent==='claude'?'Claude':'Codex')+(latest===s.lastProgress?' progress':' final reply'),stale:s.lastActivity>latest.updatedAt};
  }
  // The typed next-step box summarizes its own completed turn. A later public
  // update wins; its action is kept separately and never revived by this recap.
  const wrap=s.lastWrapUp;
  if(tracked.agent==='claude' && wrap?.text && (!latest || latest.updatedAt<=wrap.completedAt) && (!summary.text || Number(summary.updatedAt)<=wrap.completedAt)) {
    summary={text:wrap.text,updatedAt:wrap.updatedAt,source:'Claude wrap-up',stale:s.lastActivity>wrap.completedAt};
  }
  let question='';
  if (state==='decision') {
    question=decisionSource==='permission-prompt' ? 'Permission requested in Claude. Open Claude to review the exact action.' : Object.values(s.pendingQuestions || {}).filter(Boolean).join(' · ').slice(0,1000) || s.finalQuestion || '';
    if(!question && tracked.agent==='claude' && !summary.stale && metadata?.postTurnSummary?.summarizes_uuid===s.lastAssistantUuid)question=displayText(metadata.postTurnSummary.needs_action,700);
    if (!question) question='Input requested. Open the conversation to review the question.';
  }
  return {fullTitle:nativeTitle(tracked.title || s.meta.title,tracked.agent),summary,question,
    context:{cwd:tracked.cwd || s.meta.cwd || '',...sessionLocation(tracked.cwd || s.meta.cwd || ''),...workLocation(tracked.cwd || s.meta.cwd || '',s),branch:tracked.branch || s.meta.git?.branch || s.meta.gitBranch || ''},
    relationship:claudeRelationship(metadata)};
}
// Emit a safe forest even if local relationship metadata contains a cycle.
function normalizeRelationships(sessions) {
  const byId=new Map(sessions.map(row=>[row.id,row]));
  for (const row of sessions) {
    const seen=new Set([row.id]);let next=row.relationship?.parentId;
    while(next) {
      if(seen.has(next)){row.relationship=null;break;}
      seen.add(next);next=byId.get(next)?.relationship?.parentId;
    }
  }
  return sessions;
}
function blank() { return { state: 'unknown', eventId: null, lastActivity: 0, pending: {}, pendingQuestions: {}, backgroundTasks: {}, backgroundCoverage: true, meta: {}, hasNativeLifecycle: false, importing: false }; }
function isImportedTurn(payload) { return /^external-import-turn-\d+$/.test(String(payload?.turn_id || '')); }
function monitorable(agent, state) { return agent !== 'codex' || state.hasNativeLifecycle === true; }
// Only explicit lifecycle events count. Silence, CPU and file age never mean done.
function applyCodex(s, o) {
  const p = o.payload || {};
  if (o.type === 'session_meta') { s.meta = p; return; }
  // Imported records replay old work with fresh timestamps. Their whole turn,
  // including question/tool records, stays outside live notification evidence.
  const lifecycle = o.type === 'event_msg' && ['task_started','task_complete','turn_aborted','task_failed'].includes(p.type);
  if (isImportedTurn(p)) { s.importing = true; return; }
  if (lifecycle) { s.importing = false; s.hasNativeLifecycle = true; }
  if (s.importing) return;
  if(o.type==='turn_context' && typeof p.cwd==='string')s.meta.cwd=p.cwd;
  if(o.type==='response_item')codexWork(s,p,o);
  if (o.type === 'event_msg') {
    if (['task_started','task_complete','turn_aborted','task_failed'].includes(p.type)) s.lifecycleId = token(o, p.type);
    if (p.type === 'task_started') { s.workingId = token(o, 'start'); s.state = 'working'; s.eventId = null; s.pending = {}; s.pendingQuestions = {}; s.finalQuestion = ''; s.decisionSource = null; s.lastActivity = stamp(o); }
    if (p.type === 'task_complete') {
      const pendingIds=Object.keys(s.pending),pending=pendingIds.length; const request=asksDecision(p.last_agent_message);
      rememberFinal(s,p.last_agent_message,o);s.finalQuestion=request?finalQuestion(p.last_agent_message):'';
      // Completing the agent turn does not replace an unanswered tool question.
      s.state = pending || request ? 'decision' : 'finished'; s.eventId = pending ? 'question:'+pendingIds[pending-1] : token(o, 'complete');
      s.decisionSource = pending ? 'question-tool' : request ? 'explicit-request-text' : null; s.lastActivity = stamp(o);
    }
    if (p.type === 'turn_aborted' || p.type === 'task_failed') { s.state = 'unknown'; s.eventId = null; s.pending = {}; s.pendingQuestions = {}; s.finalQuestion=''; s.lastActivity = stamp(o); }
  }
  if (o.type !== 'response_item') return;
  if (p.type==='message' && p.role==='assistant' && p.phase==='final_answer') rememberFinal(s,(p.content || []).filter(x=>x.type==='output_text').map(x=>x.text).join('\n'),o);
  if (p.type==='message' && p.role==='assistant' && p.phase==='commentary') {
    rememberProgress(s,(p.content || []).filter(x=>x.type==='output_text').map(x=>x.text).join('\n'),o);
    s.lastActivity=stamp(o) || s.lastActivity;
  }
  if (p.type === 'function_call' && /(?:^|[_.])request_user_input(?:_async)?$/.test(p.name || '')) {
    s.lifecycleId = token(o, 'question');
    s.pendingQuestions[p.call_id]=questionText(p.arguments);
    s.pending[p.call_id] = /_async$/.test(p.name) ? 'async' : 'sync'; s.decisionSource = 'question-tool'; s.state = 'decision'; s.eventId = 'question:' + p.call_id; s.lastActivity = stamp(o);
  }
  if (p.type === 'function_call_output' && s.pending[p.call_id]) {
    // Async tools can return a question handle while the question is still open.
    if (s.pending[p.call_id] === 'async') { let reply; try {reply=typeof p.output==='string'?JSON.parse(p.output):p.output;}catch{} if(!reply?.answers || !Object.keys(reply.answers).length)return; }
    s.lifecycleId = token(o, 'answer'); s.workingId = s.lifecycleId;
    delete s.pending[p.call_id]; delete s.pendingQuestions[p.call_id]; s.state = Object.keys(s.pending).length ? 'decision' : 'working'; s.eventId = null; s.lastActivity = stamp(o);
  }
  // Codex delivers async answers as a user message that opens with this tag and names each answered call.
  if (p.type === 'message' && p.role === 'user') {
    const reply=/^\s*<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/.exec((p.content || []).map(x=>x.text || '').join('\n'));
    let items=[];try{items=reply?JSON.parse(reply[1]):[];}catch{}
    const answered=(Array.isArray(items)?items:[]).map(item=>{try{return JSON.parse(item.questionItemId)[1];}catch{return null;}}).filter(id=>typeof id==='string'&&s.pending[id]);
    if(!answered.length)return;
    s.lifecycleId = token(o, 'answer'); s.workingId = s.lifecycleId;
    for(const id of answered){delete s.pending[id];delete s.pendingQuestions[id];}
    s.state = Object.keys(s.pending).length ? 'decision' : 'working'; s.eventId = null; s.lastActivity = stamp(o);
  }
}
function applyClaude(s, o) {
  if (o.isSidechain) return;
  if(typeof o.cwd==='string')s.meta.cwd=o.cwd;
  if (o.type === 'custom-title' || o.type === 'ai-title') s.meta.title = o.customTitle || o.aiTitle || s.meta.title;
  const m = o.message;
  if (!m) return;
  const content = Array.isArray(m.content) ? m.content : [];
  // Newer Claude runtimes deliver helper finals as structured peer handbacks.
  // The body is model output, never a user turn or evidence of its own identity.
  if(o.type==='user' && (o.origin?.kind==='peer' || o.turnOrigin==='peer')) {
    const id=o.origin?.senderTaskId;
    if(o.isMeta===true && o.turnOrigin==='peer' && o.origin?.kind==='peer' && o.origin.handback===true && typeof id==='string' && o.origin.from===id && Object.hasOwn(s.backgroundTasks,id)) {
      delete s.backgroundTasks[id];s.lifecycleId=token(o,'task-complete');s.workingId=s.lifecycleId;
      s.lastActivity=stamp(o) || s.lastActivity;
      if(s.state!=='decision'){s.state='working';s.eventId=null;}
    }
    return;
  }
  // A task notification is internal lifecycle evidence only with both provenance
  // markers and matching task/tool identities. User text with tags is not one.
  if (o.type === 'user' && o.origin?.kind === 'task-notification' && o.turnOrigin === 'task_notification') {
    const text = typeof m.content === 'string' ? m.content : content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
    const tag = name => text.match(new RegExp('<'+name+'>([^<]+)</'+name+'>'))?.[1];
    const id=tag('task-id'), tool=tag('tool-use-id'), status=tag('status');
    if (id && Object.hasOwn(s.backgroundTasks,id) && s.backgroundTasks[id] === tool && ['completed','failed','killed','stopped'].includes(status)) {
      delete s.backgroundTasks[id]; s.lifecycleId=token(o,'task-complete'); s.workingId=s.lifecycleId;
      s.lastActivity=stamp(o) || s.lastActivity;
      if (s.state !== 'decision') {s.state='working';s.eventId=null;}
    }
    return;
  }
  if (o.type === 'user' || o.type === 'assistant') s.lifecycleId = token(o, o.type);
  if (o.type === 'user') {
    const results = content.filter(x => x.type === 'tool_result');
    const launch=o.toolUseResult;
    if (launch?.isAsync === true && launch.status === 'async_launched' && typeof launch.agentId === 'string' && results.length === 1 && results[0].tool_use_id && !Object.hasOwn(s.backgroundTasks,launch.agentId)) {
      Object.defineProperty(s.backgroundTasks,launch.agentId,{value:results[0].tool_use_id,enumerable:true,configurable:true});
      s.lifecycleId=token(o,'task-start');s.workingId=s.lifecycleId;
      if (s.state !== 'decision') {s.state='working';s.eventId=null;}
    }
    if (!results.length) { s.workingId = token(o, 'start'); s.state = 'working'; s.pending = {}; s.pendingQuestions = {}; s.finalQuestion=''; s.eventId = null; s.decisionSource = null; }
    for (const result of results) {
      if(result.tool_use_id===s.turnWrapUp?.toolId && result.is_error===true)s.turnWrapUp=null;
      if (s.pending[result.tool_use_id]) { s.workingId = token(o, 'answer'); delete s.pending[result.tool_use_id]; delete s.pendingQuestions[result.tool_use_id]; s.state = Object.keys(s.pending).length ? 'decision' : 'working'; s.eventId = null; }
    }
    if(!results.length && o.isMeta!==true)s.turnWrapUp=null;
    s.lastActivity = stamp(o) || s.lastActivity;
  }
  if (o.type === 'assistant') {
    s.lastAssistantUuid=o.uuid || null;
    if(o.gitBranch)s.meta.gitBranch=o.gitBranch;
    s.lastActivity = stamp(o) || s.lastActivity;
    if(m.stop_reason!=='end_turn')rememberProgress(s,content.filter(x=>x.type==='text').map(x=>x.text).join('\n'),o);
    for (const item of content) {
      if(item.type==='tool_use' && item.name==='mcp__ccd_turn__wrap_up' && o.isMeta!==true && o.origin?.kind!=='peer' && o.turnOrigin!=='peer' && (!item.caller || item.caller.type==='direct')) {
        const input=item.input;
        // Only the supported, structured user-facing box is evidence. A malformed
        // replacement also invalidates an earlier box from this same turn.
        s.turnWrapUp=null;
        if(typeof item.id==='string' && item.id && input && typeof input==='object' && !Array.isArray(input) && typeof input.recap==='string' && (input.ask===undefined || typeof input.ask==='string') && (input.actions===undefined || Array.isArray(input.actions))) {
          const text=displayText(input.recap),ask=displayText(input.ask,700);
          if(usefulContext(text))s.turnWrapUp={text,ask,toolId:item.id,updatedAt:stamp(o)};
        }
      }
      if(item.type==='tool_use' && ['Read','Edit','Write'].includes(item.name))recordWork(s,item.input?.file_path,'file','Claude '+item.name,o,item.name==='Read'?'read':'write',o.cwd);
      if(item.type==='tool_use' && item.name==='Bash') {
        if(typeof item.input?.workdir==='string')recordWork(s,item.input.workdir,'directory','Claude tool working folder',o,'directory');
        leadingShellFolder(s,item.input?.command,o,item.input?.workdir || o.cwd);
      }
      if (item.type === 'tool_use' && /^(AskUserQuestion|ExitPlanMode)$/.test(item.name || '')) {
        s.pendingQuestions[item.id]=questionText(item.input) || (item.name==='ExitPlanMode'?'Review and approve the plan in Claude.':'');
        s.pending[item.id] = true; s.decisionSource = 'question-tool'; s.state = 'decision'; s.eventId = 'question:' + item.id;
      }
    }
    if (m.stop_reason === 'end_turn') {
      const text=content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
      const wrap=s.turnWrapUp;s.turnWrapUp=null;
      const request=!!wrap?.ask || asksDecision(text);rememberFinal(s,text,o);s.finalQuestion=wrap?.ask || (request?finalQuestion(text):'');
      if(wrap)s.lastWrapUp={text:wrap.text,updatedAt:wrap.updatedAt,completedAt:stamp(o)};
      const pending=Object.keys(s.pending).length;
      s.state = pending || request ? 'decision' : Object.keys(s.backgroundTasks).length ? 'working' : s.backgroundCoverage ? 'finished' : 'unknown';
      s.decisionSource=pending?'question-tool':wrap?.ask?'wrap-up':request?'explicit-request-text':null;
      s.eventId = s.state === 'finished' || s.state === 'decision' ? (pending ? s.eventId : token(o,'complete')) : null;
    }
    else if (!Object.keys(s.pending).length) { s.state = 'working'; s.eventId = null; }
  }
}
const transcriptCache = new Map();
const headCache = new Map();
function readMeta(file, stat) {
  const hit=headCache.get(file);if(hit?.ino===stat.ino && stat.size>=hit.size)return hit.meta;
  const fd=fs.openSync(file,'r');let buffer=Buffer.alloc(0),meta={};
  try {
    while(buffer.length<Math.min(stat.size,512*1024)) {
      const next=Buffer.alloc(Math.min(8192,stat.size-buffer.length));const n=fs.readSync(fd,next,0,next.length,buffer.length);if(!n)break;
      buffer=Buffer.concat([buffer,next.subarray(0,n)]);const end=buffer.indexOf(10);if(end<0)continue;
      try{meta=JSON.parse(buffer.subarray(0,end).toString('utf8')).payload||{};}catch{}break;
    }
  }finally{fs.closeSync(fd);}
  if(meta.id || meta.session_id)headCache.set(file,{ino:stat.ino,size:stat.size,meta});else headCache.delete(file);return meta;
}
function isBoundary(o,agent) {
  if(agent==='codex')return o.type==='event_msg' && !isImportedTurn(o.payload) && ['task_started','turn_aborted','task_failed'].includes(o.payload?.type);
  // Background Claude tasks can span multiple parent turns. Only the beginning
  // of the bounded transcript provides a complete task ledger.
  return false;
}
function previousCodexFinal(file,stat) {
  const fd=fs.openSync(file,'r');let end=stat.size,carry=Buffer.alloc(0);
  const floor=Math.max(0,stat.size-16*1024*1024);
  try {
    while(end>floor) {
      const start=Math.max(floor,end-256*1024),buf=Buffer.alloc(end-start);
      fs.readSync(fd,buf,0,buf.length,start);const data=Buffer.concat([buf,carry]);
      const first=start>0?data.indexOf(10):-1;
      if(start>0 && first<0){carry=data;end=start;continue;}
      carry=first>=0?data.subarray(0,first+1):Buffer.alloc(0);
      const records=lines(data.subarray(first+1).toString('utf8'));
      for(let i=records.length-1;i>=0;i--) {
        const o=records[i];
        if(o.type==='event_msg' && o.payload?.type==='task_complete' && !isImportedTurn(o.payload)) {
          const state={};rememberFinal(state,o.payload.last_agent_message,o);if(state.lastFinal)return state.lastFinal;
        }
      }
      end=start;
    }
  } finally {fs.closeSync(fd);}
  return null;
}
function previousCodexWork(file,stat,meta) {
  // A cold read can resume after a new-turn boundary. Keep a small, bounded
  // activity context from prior turns; warm reads still process only appends.
  const size=Math.min(stat.size,2*1024*1024),start=stat.size-size,buffer=Buffer.alloc(size),fd=fs.openSync(file,'r');
  try {fs.readSync(fd,buffer,0,size,start);}finally{fs.closeSync(fd);}
  let text=buffer.toString('utf8');if(start>0)text=text.slice(text.indexOf('\n')+1);text=text.slice(0,text.lastIndexOf('\n')+1);
  const state={meta:{...meta},importing:start>0};
  for(const o of lines(text)) {
    const p=o.payload || {};
    if(isImportedTurn(p)){state.importing=true;continue;}
    if(o.type==='event_msg' && ['task_started','task_complete','turn_aborted','task_failed'].includes(p.type))state.importing=false;
    if(state.importing)continue;
    if(o.type==='turn_context' && typeof p.cwd==='string')state.meta.cwd=p.cwd;
    if(o.type==='response_item')codexWork(state,p,o);
  }
  return {workEvidence:state.workEvidence || []};
}
function initialTranscript(file,stat,agent) {
  const state=blank();if(agent==='codex')state.meta=readMeta(file,stat);
  const fd=fs.openSync(file,'r');let end=stat.size,carry=Buffer.alloc(0),remainder='',events=[],done=false,tailPending=null;const decoder=new StringDecoder('utf8');
  // Locate the latest explicit boundary backwards; never parse gigabytes of history.
  // If an unusually large turn hides its boundary beyond 16MB, report unknown.
  const floor=Math.max(0,stat.size-16*1024*1024);
  if(agent==='claude' && floor>0)state.backgroundCoverage=false;
  try {
    while(end>floor && !done) {
      const start=Math.max(floor,end-256*1024);const buf=Buffer.alloc(end-start);fs.readSync(fd,buf,0,buf.length,start);
      let data=Buffer.concat([buf,tailPending || carry]);
      if(end===stat.size || tailPending){
        const last=data.lastIndexOf(10);
        if(last<0){tailPending=data;end=start;continue;}
        remainder=decoder.write(data.subarray(last+1));data=data.subarray(0,last+1);tailPending=null;
      }
      const first=data.indexOf(10);let complete;
      if(start>0){if(first<0){carry=data;end=start;continue;}carry=data.subarray(0,first+1);complete=data.subarray(first+1);}
      else{complete=data;carry=Buffer.alloc(0);}
      const parsed=lines(complete.toString('utf8'));
      for(let i=parsed.length-1;i>=0;i--){events.push(parsed[i]);if(isBoundary(parsed[i],agent)){done=true;break;}}
      end=start;
    }
  }finally{fs.closeSync(fd);}
  if(agent==='codex'){state.lastFinal=previousCodexFinal(file,stat);Object.assign(state,previousCodexWork(file,stat,state.meta));}
  for(const o of events.reverse())(agent==='codex'?applyCodex:applyClaude)(state,o);
  if(!done && floor>0 && !(agent==='claude' && state.state==='decision')){state.state='unknown';state.eventId=null;}
  return {ino:stat.ino,offset:stat.size,remainder,decoder,state,mtime:stat.mtimeMs,skipPartial:!!tailPending};
}
function readTranscript(file, agent) {
  const stat = fs.statSync(file);
  let cached = transcriptCache.get(file);
  if (!cached || cached.ino !== stat.ino || stat.size < cached.offset || (stat.size === cached.offset && stat.mtimeMs !== cached.mtime)) {
    cached = initialTranscript(file,stat,agent);
  }
  if (stat.size > cached.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      while (cached.offset < stat.size) {
        const buffer = Buffer.alloc(Math.min(256 * 1024, stat.size - cached.offset));
        const n = fs.readSync(fd, buffer, 0, buffer.length, cached.offset);
        if (!n) break;
        cached.offset += n;
        let decoded=cached.decoder.write(buffer.subarray(0,n));
        if(cached.skipPartial){const newline=decoded.indexOf('\n');if(newline<0)continue;decoded=decoded.slice(newline+1);cached.skipPartial=false;}
        const text = cached.remainder + decoded;
        const last = text.lastIndexOf('\n');
        if (last < 0) { if(text.length>16*1024*1024){cached.remainder='';cached.skipPartial=true;cached.state.state='unknown';cached.state.eventId=null;}else cached.remainder = text; continue; }
        for (const o of lines(text.slice(0, last))) (agent === 'codex' ? applyCodex : applyClaude)(cached.state, o);
        cached.remainder = text.slice(last + 1);
      }
    } finally { fs.closeSync(fd); }
  }
  cached.mtime = stat.mtimeMs;
  transcriptCache.set(file, cached);
  return cached.state;
}
function walk(dir, depth, visit) {
  if (depth < 0) return;
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, depth - 1, visit);
    else if (entry.isFile()) visit(file, entry.name);
  }
}
function psTable() {
  try {
    const out = execFileSync('ps', ['-Ao', 'pid,ppid,comm'], { encoding: 'utf8', timeout: 3000 });
    return out.split('\n').flatMap(line => { const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/); return m ? [{pid: +m[1], ppid: +m[2], command: m[3]}] : []; });
  } catch (e) { log(e.message); return []; }
}
function isRootDesktop(meta) {
  return /desktop/i.test(meta.originator || '') && !(meta.source && typeof meta.source === 'object') && !/subagent|guardian/.test(meta.thread_source || '');
}
function shortName(cwd, title, custom, agent) {
  if (custom) return String(custom).replace(/\s+/g, ' ').trim().slice(0, 24);
  // Saved task titles are authoritative. Reduce generic task framing, not the
  // user's subject, and never substitute a whole prompt or filesystem path.
  let t = String(title || '').trim();
  if (t && t.length <= 160 && !/[\/<>\n]/.test(t)) {
    t = t.replace(/^(?:clarify|simplify|fix|implement|investigate|update|improve|review|check|create|build)\s+/i, '')
      .replace(/\b\d+(?:\.\d+)?[- ](?:pounds?|lbs?|kilograms?|kg|ounces?|oz)\s+/gi, '')
      .replace(/(?:\s+(?:activity|monitoring|tests?))+$/i, '').trim();
    const words = t.split(/\s+/);
    const metric = words.find(w => /^(?:latency|throughput|performance|usage|cost)$/i.test(w));
    if (/^[A-Z]{2,}$/.test(words[0]) && metric && (words[0] + ' ' + metric).length <= 24) return words[0] + ' ' + metric.toLowerCase();
    const compact=[];
    for (const word of words) {
      if (/^(?:the|a|an|for|of|to|and|in|with|on)$/i.test(word)) continue;
      if (compact.length === 3 || [...compact,word].join(' ').length > 24) break;
      compact.push(word);
    }
    if (compact.length) { const label=compact.join(' ');return label[0].toUpperCase()+label.slice(1); }
  }
  return agent === 'claude' ? 'Claude' : 'Codex';
}
// Discover both directions of explicit lineage, including older related chats.
function selectClaudeSessions(records,now,pins,retained) {
  const selected=new Set(),neighbors=new Map();
  for(const [id,{metadata}] of records) {
    if(pins.has(id) || retained.has(id) || now-Number(metadata.lastActivityAt || 0)<=DISCOVERY_MS)selected.add(id);
    const parent=claudeRelationship(metadata)?.parentId.slice(7);
    if(parent && records.has(parent)) {
      if(!neighbors.has(id))neighbors.set(id,[]);if(!neighbors.has(parent))neighbors.set(parent,[]);
      neighbors.get(id).push(parent);neighbors.get(parent).push(id);
    }
  }
  const queue=[...selected];
  for(let i=0;i<queue.length;i++)for(const neighbor of neighbors.get(queue[i]) || [])if(!selected.has(neighbor)){selected.add(neighbor);queue.push(neighbor);}
  return selected;
}
let lastDiscovery = 0;
function discover(now) {
  if (now - lastDiscovery < 10000) return;
  lastDiscovery = now;
  nativePins = readNativePins();
  let changed = false;
  // Old threads can resume in their original date directory. Check mtimes across
  // the shallow tree, then read only recently written root desktop transcripts.
  const titles = {};
  try { for (const e of lines(fs.readFileSync(path.join(HOME,'.codex','session_index.jsonl'),'utf8'))) if(e.id && e.thread_name)titles[e.id]=e.thread_name; } catch {}
    walk(CODEX_DIR, 3, (file, name) => {
      if (!name.endsWith('.jsonl')) return;
      try {
        const stat=fs.statSync(file);
        // Check source before reading a transcript so crew/guardian work stays out.
        const m = readMeta(file,stat);
        const sid = m.session_id || m.id;
        if (!sid || !isRootDesktop(m)) return;
        const nativePinned=nativePins.ids.codex.has(sid);
        if (!nativePinned && now - stat.mtimeMs > DISCOVERY_MS) return;
        const state = readTranscript(file,'codex');
        if (!nativePinned && (!monitorable('codex',state) || !state.lastActivity || now - state.lastActivity > DISCOVERY_MS)) return;
        const id = 'codex:' + sid;
        const candidate = {file, agent:'codex', sessionId:sid, cwd:m.cwd || '',title:titles[sid] || ''};
        if (JSON.stringify(saved.tracked[id]) !== JSON.stringify(candidate)) { saved.tracked[id] = candidate; changed = true; }
      } catch { /* append/rename race */ }
    });
  const records=new Map();
  walk(CLAUDE_DESKTOP, 2, (file, name) => {
    if (!/^local_.*\.json$/.test(name)) return;
    const metadata=loadJson(file,null);
    if(metadata && !metadata.isArchived && metadata.sessionId && metadata.cliSessionId) records.set(metadata.sessionId,{metadata,file});
  });
  const selected=selectClaudeSessions(records,now,nativePins.ids.claude,new Set(Object.values(saved.tracked).filter(x=>x.agent==='claude').map(x=>x.sessionId)));
  for (const sid of selected) {
    const {metadata:s,file}=records.get(sid);
    const id='claude:'+sid;
    const candidate={agent:'claude',sessionId:sid,cliSessionId:s.cliSessionId,cwd:s.cwd || '',title:s.title || '',sessionFile:file,lastActivity:Number(s.lastActivityAt) || 0};
    candidate.file=path.join(CLAUDE_DIR,String(s.cwd || '').replace(/[^a-zA-Z0-9]/g,'-'),s.cliSessionId+'.jsonl');
    if (!fs.existsSync(candidate.file)) {
      try { for (const project of fs.readdirSync(CLAUDE_DIR)) { const p=path.join(CLAUDE_DIR,project,s.cliSessionId+'.jsonl');if(fs.existsSync(p)){candidate.file=p;break;} } } catch {}
    }
    if (JSON.stringify(saved.tracked[id])!==JSON.stringify(candidate)) {saved.tracked[id]=candidate;changed=true;}
  }
  if (changed) saveJson(stateFile, saved);
}
function rowFrom(id, tracked, s, names, liveClaude, appLive, store = saved) {
  const entry = names[id] || names['codex-sid:' + tracked.sessionId];
  const custom = typeof entry === 'string' ? entry : entry?.name;
  let state = s.state, eventId = s.eventId, workingId = s.workingId, decisionSource=s.decisionSource || null;
  if (tracked.agent === 'claude') {
    // collect already filters registry entries by live PID. A resumed desktop
    // conversation must also match its current CLI session, not an older runner.
    const live = liveClaude.find(x => tracked.cliSessionId
      ? x.sessionId === tracked.cliSessionId && (!x.hostSessionId || x.hostSessionId === tracked.sessionId)
      : x.hostSessionId === tracked.sessionId);
    // A stopped runner cannot be called working just because its last turn started.
    if (state === 'working' && !live) { state = 'unknown'; eventId = null; }
    if (appLive && live?.status === 'waiting' && live.waitingFor === 'permission prompt' && Number(live.statusUpdatedAt) >= s.lastActivity) {
      state='decision';eventId='permission:'+tracked.sessionId+':'+Number(live.statusUpdatedAt);decisionSource='permission-prompt';
    }
    // Explicit busy registry status supersedes the last finished turn at resume.
    if (live?.status === 'busy' && Number(live.statusUpdatedAt) > s.lastActivity && state !== 'decision') {
      state = 'working'; eventId = null;
      workingId = 'registry:' + tracked.sessionId + ':' + Number(live.statusUpdatedAt);
    }
  }
  if (state === 'working' && !appLive) { state = 'unknown'; eventId = null; }
  // Hide only this state and its evidence, never the conversation or later activity.
  const dismissId = state + ':' + crypto.createHash('sha256').update(String((state === 'working' ? workingId : null) || eventId || s.lifecycleId || s.lastActivity || 'no-evidence')).digest('hex').slice(0, 20);
  const title = shortName(tracked.cwd, tracked.title || s.meta.title, custom, tracked.agent);
  const originalTitle = String(tracked.title || s.meta.title || '').trim();
  const searchTitle = originalTitle.length <= 160 && !/[\/<>\r\n]/.test(originalTitle) ? originalTitle || title : title;
  const organization = store.organization?.[id];
  const nativePinned = tracked.nativePinned === true;
  return {id, sessionId:tracked.sessionId, agent:tracked.agent, title, displayName:title, topic:title, customName:custom || '',nameKey:id,
    ...presentation(tracked,s,state,decisionSource),searchTitle, nativePinned, pinned:nativePinned || organization?.pinned === true, parked:organization?.parked === true,onDesk:store.baselineVisible?.[id] === true,
    state,eventId,dismissId,decisionSource,dismissed:store.dismissed[id] === dismissId || (state === 'finished' && (store.dismissed[id] === eventId || (s.lastActivity < store.startedAt && !store.baselineVisible?.[id]))), lastActivity:s.lastActivity, focusable:appLive,
    focusLabel:tracked.agent === 'codex' ? 'Open conversation in Codex' : 'Open Claude app', focusMode:tracked.agent === 'codex' ? 'conversation' : 'app'};
}
function collect() {
  const now = Date.now();
  discover(now);
  const names = loadJson(namesFile);
  const codexDetails=readCodexDetails();
  const ps = psTable();
  const codexLive = ps.some(p => /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)$/.test(p.command));
  const claudeLive = ps.some(p => /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(p.command));
  const liveClaude = [];
  walk(path.join(HOME,'.claude','sessions'),0,(file,name)=> { if(name.endsWith('.json')) { const s=loadJson(file);if(ps.some(p=>p.pid===s.pid))liveClaude.push(s); } });
  const sessions = [];
  for (const [id, tracked] of Object.entries(saved.tracked)) {
    const nativePinned=nativePins.ids[tracked.agent]?.has(tracked.sessionId) === true;
    try {
      let state;
      const codexDetail=tracked.agent==='codex'?codexDetails[tracked.sessionId]:null;
      if(codexDetail?.archived)continue;
      // Retained transcript data cannot override desktop archival or a changed
      // runner identity. A temporarily unreadable metadata file proves no state.
      const metadata=tracked.agent==='claude' ? loadJson(tracked.sessionFile,null) : null;
      const metadataMissing=tracked.agent==='claude' && !metadata;
      if (metadata && (metadata.isArchived || metadata.sessionId!==tracked.sessionId || metadata.cliSessionId!==tracked.cliSessionId)) continue;
      try { state=metadataMissing ? {...blank(),lastActivity:tracked.lastActivity || 0} : readTranscript(tracked.file,tracked.agent); }
      catch (error) {
        // Claude desktop metadata proves identity even when its runner history
        // has been retired. A pin can stay available with an honest unknown state.
        if (!metadata) throw error;
        state={...blank(),lastActivity:Number(metadata.lastActivityAt) || 0};
      }
      // Recheck retained entries too: old versions saved imported history here.
      if (tracked.agent==='codex' && !isRootDesktop(state.meta)) continue;
      if (!monitorable(tracked.agent,state)) {
        if (!nativePinned) continue;
        // Being pinned proves selection, never that replayed history is live.
        state={...blank(),meta:state.meta};
      }
      sessions.push(rowFrom(id, {...tracked,...(codexDetail || {}),...(metadata?{title:metadata.title || '',cwd:metadata.cwd || ''}:{}),metadata,nativePinned}, state, names, metadataMissing?[]:liveClaude, tracked.agent === 'codex' ? codexLive : claudeLive));
    } catch { /* missing retired transcript */ }
  }
  normalizeRelationships(sessions);
  const rank = {decision:0,finished:1,working:2,unknown:3};
  sessions.sort((a,b)=>rank[a.state]-rank[b.state] || b.lastActivity-a.lastActivity);
  const nativePinStatus={};
  for (const agent of ['codex','claude']) {
    const matched=new Set(sessions.filter(s=>s.agent===agent && s.nativePinned).map(s=>s.sessionId));
    const unmatchedCount=[...nativePins.ids[agent]].filter(id=>!matched.has(id)).length;
    const source=nativePins.status[agent];
    nativePinStatus[agent]={...source,unmatchedCount,incomplete:unmatchedCount>0};
    if (source?.available && unmatchedCount) nativePinStatus[agent].status='partial';
  }
  return {sessions, nativePinStatus, now, updatedAt:now, count:sessions.length, workingCount:sessions.filter(s=>s.state==='working').length, unknownCount:sessions.filter(s=>s.state==='unknown').length};
}
function focusArgs(row) {
  if (row.agent === 'codex' && /^[a-f0-9-]{36}$/i.test(row.sessionId)) return ['-b','com.openai.codex','codex://threads/'+row.sessionId];
  if (row.agent === 'claude') return ['-b','com.anthropic.claudefordesktop'];
  throw new Error('No desktop destination');
}
function dismiss(row, dismissId, store) {
  if (!row || !['finished','unknown','working','decision'].includes(row.state) || !dismissId || row.dismissId !== dismissId) throw new Error('This notification has changed. Refresh and try again.');
  store[row.id] = dismissId;
}
function organize(row, patch, store) {
  const fields = ['pinned', 'parked'].filter(key => Object.hasOwn(patch, key));
  if (!row || fields.length !== 1 || typeof patch[fields[0]] !== 'boolean' ||
      Object.keys(patch).some(key => !['id', 'pinned', 'parked'].includes(key))) {
    throw new Error('Choose one pin or park action.');
  }
  const previous = store.organization?.[row.id];
  const preference = {pinned:previous?.pinned === true, parked:previous?.parked === true};
  const field = fields[0], value = patch[field];
  if (field==='pinned' && value===false && row.nativePinned) throw new Error('Pinned in '+(row.agent==='claude'?'Claude':'Codex')+'. Unpin it there, or Park it here.');
  preference[field] = value;
  if (value) preference[field === 'pinned' ? 'parked' : 'pinned'] = false;
  const dismissed = {...store.dismissed};
  const baselineVisible = {...store.baselineVisible};
  if ((field === 'pinned' && value) || (field === 'parked' && !value)) {
    delete dismissed[row.id];
    baselineVisible[row.id] = true;
  }
  return {...store, dismissed, baselineVisible, organization:{...store.organization, [row.id]:preference}};
}
// Multi-Mac viewing. peers.json is optional; a missing or invalid file keeps
// Tower loopback-only, exactly as before. Other devices can only view.
//
// Trust is decided by WHICH SOCKET accepted a request, never by anything the
// client sends. tailscale serve forwards the client's own Host unchanged, so a
// Host header proves nothing. The local listener (PORT) is this Mac only; the
// Tailscale view listener (remotePort, default 4434) is always remote and view
// only, and runs only when peers.json names this Mac's tailnet address.
const PEERS_FILE = path.join(DATA_DIR, 'peers.json');
const DEFAULT_REMOTE_PORT = 4434;
const LOOPBACK_HOSTS = [HOST + ':' + PORT, 'localhost:' + PORT];
// Headers a proxy adds. Their presence on the local listener means something is
// forwarding outside traffic to it (for example tailscale serve aimed at 4433).
const PROXY_HEADER = /^(?:forwarded|x-forwarded-.+|x-real-ip|tailscale-.+)$/;
const REMOTE_GET_ROUTES = new Set(['/', '/index.html', '/api/sessions', '/api/local']);
const STATE_RANK = {decision:0, finished:1, working:2, unknown:3};
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function cleanLabel(value) { return typeof value === 'string' && value === value.trim() && /^[^\u0000-\u001f\u007f:]{1,40}$/.test(value) ? value : null; }
function parsePeerConfig(value, localPort = PORT) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  const label = cleanLabel(value.label);
  if (!label) throw new Error('label must be a short name without colons');
  if ((value.tailnetHost === undefined) !== (value.allowedLogin === undefined)) throw new Error('tailnetHost and allowedLogin go together');
  let tailnetHost = null, allowedLogin = null;
  if (value.tailnetHost !== undefined) {
    const host = typeof value.tailnetHost === 'string' ? value.tailnetHost.toLowerCase() : '';
    // A full DNS name with a letter in its last label: never an IP or a bare name.
    if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) throw new Error('tailnetHost must be the full Tailscale machine name');
    if (typeof value.allowedLogin !== 'string' || !/^[^\s\u0000-\u001f\u007f,]{1,254}$/.test(value.allowedLogin)) throw new Error('allowedLogin must be one Tailscale login');
    tailnetHost = host; allowedLogin = value.allowedLogin;
  }
  const remotePort = value.remotePort === undefined ? DEFAULT_REMOTE_PORT : value.remotePort;
  if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) throw new Error('remotePort must be a port number from 1024 to 65535');
  if (remotePort === localPort) throw new Error('remotePort must differ from Tower\'s own port');
  const list = value.peers === undefined ? [] : value.peers;
  if (!Array.isArray(list) || list.length > 8) throw new Error('peers must be a list of up to 8 Macs');
  const labels = new Set([label.toLowerCase()]), peers = [];
  for (const peer of list) {
    const peerLabel = cleanLabel(peer?.label);
    if (!peerLabel || labels.has(peerLabel.toLowerCase())) throw new Error('each peer needs its own short label');
    let url;
    try { url = new URL(peer.url); } catch { throw new Error('peer url is not a URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.hostname === tailnetHost) throw new Error('peer url must be another Mac\'s plain https address');
    labels.add(peerLabel.toLowerCase());
    peers.push({label:peerLabel, url:url.origin});
  }
  return {label, tailnetHost, allowedLogin, remotePort, peers};
}
function loadPeerConfig(file = PEERS_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') log('peers.json unreadable; staying local only'); return null; }
  try { return parsePeerConfig(JSON.parse(text)); }
  catch (error) { log('peers.json ignored (' + error.message + '); staying local only'); return null; }
}
// Local listener: this Mac's own page, window and actions. The loopback Host
// check guards against DNS rebinding; any proxy header means outside traffic.
function localAccess(headers) {
  if (Object.keys(headers || {}).some(name => PROXY_HEADER.test(name.toLowerCase()))) return {allowed:false, remote:false, error:'Forwarded requests are not accepted here'};
  if (!LOOPBACK_HOSTS.includes(headers?.host)) return {allowed:false, remote:false, error:'Local requests only'};
  return {allowed:true, remote:false};
}
// Tailscale view listener: always remote, whatever Host it carries. The Host
// check is secondary; the login is the one tailscale serve itself attaches.
function remoteAccess(method, pathname, headers, config) {
  const host = headers?.host;
  const tailnet = !!config?.tailnetHost && typeof host === 'string' && [config.tailnetHost, config.tailnetHost + ':443'].includes(host.toLowerCase());
  if (!tailnet) return {allowed:false, remote:true, error:'Unknown address'};
  // Every mutation stays on this Mac. Refused here, before any body is read.
  if (method !== 'GET' || !REMOTE_GET_ROUTES.has(pathname)) return {allowed:false, remote:true, error:'View only from other devices'};
  const login = headers['tailscale-user-login'];
  if (typeof login !== 'string' || login.toLowerCase() !== config.allowedLogin.toLowerCase()) return {allowed:false, remote:true, error:'Not the allowed Tailscale account'};
  return {allowed:true, remote:true};
}
// Anything shaped like a local absolute path is replaced before leaving this Mac.
function scrubPaths(value) {
  if (typeof value !== 'string') return '';
  // Folder names with spaces continue while the next word still contains a slash.
  return value.replace(/(?<![\w])(?:~|\/(?:Users|Volumes|private|var|tmp|opt|home|Library|Applications|System|usr|etc))\/[^\s<>"'`)\]}]*(?:\s+[^\s<>"'`)\]}\/]*\/[^\s<>"'`)\]}]*)*/g, token => 'a local path' + (token.match(/[.,;:!?]+$/)?.[0] || ''));
}
const textField = (value, max) => scrubPaths(value).slice(0, max);
const ROW_ID = /^[A-Za-z0-9_.@-]{1,40}:[A-Za-z0-9_.@-]{1,200}$/;
const timeField = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
// An allowlist, not a denylist: new row fields stay home until added here.
function viewOnlyRow(row, prefix = '') {
  return {
    id:prefix + row.id, sessionId:textField(row.sessionId, 200), agent:['claude','codex'].includes(row.agent) ? row.agent : 'unknown',
    title:textField(row.title, 200), displayName:textField(row.displayName, 200), topic:textField(row.topic, 200),
    fullTitle:textField(row.fullTitle, 1000), searchTitle:textField(row.searchTitle, 200),
    summary:row.summary && typeof row.summary === 'object' ? {text:textField(row.summary.text, 2000), updatedAt:timeField(row.summary.updatedAt), source:textField(row.summary.source, 80), stale:row.summary.stale === true} : {text:'', updatedAt:null, source:'', stale:false},
    question:textField(row.question, 1000),
    relationship:ROW_ID.test(row.relationship?.parentId) ? {parentId:prefix + row.relationship.parentId, kind:textField(row.relationship.kind, 40)} : null,
    nativePinned:row.nativePinned === true, pinned:row.pinned === true, parked:row.parked === true, onDesk:row.onDesk === true,
    state:Object.hasOwn(STATE_RANK, row.state) ? row.state : 'unknown',
    eventId:typeof row.eventId === 'string' ? textField(row.eventId, 300) : null, dismissId:typeof row.dismissId === 'string' ? textField(row.dismissId, 300) : null,
    decisionSource:typeof row.decisionSource === 'string' ? textField(row.decisionSource, 40) : null, dismissed:row.dismissed === true,
    lastActivity:timeField(row.lastActivity) || 0, focusable:false, viewOnly:true
  };
}
function remoteRow(row) { return viewOnlyRow(row); }
// Peer data is untrusted input: re-validated and re-stripped here, whatever the peer sent.
function sanitizePeerRow(row, label) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !ROW_ID.test(row.id)) return null;
  return {...viewOnlyRow(row, label + ':'), peer:true, machine:label};
}
function formatClock(ms, now = Date.now()) {
  const date = new Date(ms), hours = date.getHours();
  const time = (hours % 12 || 12) + ':' + String(date.getMinutes()).padStart(2, '0') + ' ' + (hours < 12 ? 'AM' : 'PM');
  return date.toDateString() === new Date(now).toDateString() ? time : MONTHS[date.getMonth()] + ' ' + date.getDate() + ', ' + time;
}
function peerMessage(label, lastSeen, now = Date.now()) { return label + ' not reachable' + (lastSeen ? ', last seen ' + formatClock(lastSeen, now) : ''); }
// A peer body is read as a stream with a running byte count, never buffered
// whole first. A declared length over the cap is refused before reading.
async function readCappedBody(response, maxBytes, onReader) {
  const declared = response.headers?.get?.('content-length');
  if (declared != null && declared !== '' && !(Number(declared) <= maxBytes)) throw new Error('Response too large');
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('Empty response');
  const reader = response.body.getReader();
  onReader(reader);
  const chunks = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { reader.cancel().catch(() => {}); throw new Error('Response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
// Background polling, never on the request path. Each peer keeps its last good
// result; after 15 seconds without one its rows are hidden and a status line shows.
// Freshness uses a monotonic clock; the wall clock only names "last seen".
function createPeerPoller({peers, fetch: fetchImpl, now = () => Date.now(), monotonic = () => performance.now(), intervalMs = 5000, timeoutMs = 2000, staleMs = 15000, maxBytes = 4 * 1024 * 1024}) {
  const states = peers.map(peer => ({label:peer.label, url:peer.url, rows:[], lastSeen:null, lastGoodAt:null, failed:false, busy:false}));
  let timer = null;
  async function pollPeer(state) {
    if (state.busy) return;
    state.busy = true;
    const controller = new AbortController();
    let timeout, reader = null;
    try {
      const work = (async () => {
        const response = await (fetchImpl || globalThis.fetch)(new URL('/api/local', state.url).href, {signal:controller.signal, redirect:'error', cache:'no-store', headers:{accept:'application/json'}});
        if (!response?.ok) throw new Error('HTTP ' + response?.status);
        const text = await readCappedBody(response, maxBytes, value => { reader = value; });
        const data = JSON.parse(text);
        if (!data || !Array.isArray(data.sessions)) throw new Error('Not a Tower feed');
        return data.sessions.slice(0, 1000).map(row => sanitizePeerRow(row, state.label)).filter(Boolean);
      })();
      work.catch(() => { controller.abort(); });
      const expired = new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reader?.cancel().catch(() => {}); reject(new Error('Timed out')); }, timeoutMs); });
      state.rows = await Promise.race([work, expired]);
      if (state.failed) log(state.label + ' reachable again');
      state.lastSeen = now(); state.lastGoodAt = monotonic(); state.failed = false;
    } catch (error) {
      if (!state.failed) log(state.label + ' not reachable: ' + error.message);
      state.failed = true;
    } finally { clearTimeout(timeout); state.busy = false; }
  }
  return {
    pollOnce:() => Promise.all(states.map(pollPeer)).then(() => {}),
    start() { if (timer) return; this.pollOnce(); timer = setInterval(() => this.pollOnce(), intervalMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
    snapshot() {
      const at = now(), tick = monotonic(), rows = [], status = [];
      for (const state of states) {
        const fresh = state.lastGoodAt !== null && tick - state.lastGoodAt <= staleMs;
        if (fresh) rows.push(...state.rows);
        const entry = {label:state.label, reachable:fresh, lastSeen:state.lastSeen};
        if (!fresh && (state.lastSeen !== null || state.failed)) entry.message = peerMessage(state.label, state.lastSeen, at);
        status.push(entry);
      }
      return {rows, status};
    }
  };
}
function orderSessions(sessions) { return sessions.sort((a,b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.lastActivity - a.lastActivity); }
function mergeSessions(local, snapshot, config, remote) {
  const own = local.sessions.map(row => ({...(remote ? remoteRow(row) : row), machine:config.label}));
  const sessions = orderSessions([...own, ...snapshot.rows]);
  return {...local, sessions, count:sessions.length, workingCount:sessions.filter(s => s.state === 'working').length, unknownCount:sessions.filter(s => s.state === 'unknown').length,
    machine:config.label, peers:snapshot.status, viewer:remote ? 'remote' : 'local'};
}
const peerConfig = loadPeerConfig();
const peerPoller = peerConfig?.peers.length ? createPeerPoller({peers:peerConfig.peers}) : null;
function sessionPayload(remote) {
  const local = collect();
  // Without peers.json the feed is exactly today's.
  const response = !peerConfig ? local : mergeSessions(local, peerPoller ? peerPoller.snapshot() : {rows:[], status:[]}, peerConfig, remote);
  return response;
}
function sessionsResponse(remote) {
  return attachProjectBoard(sessionPayload(remote), DATA_DIR, remote, saved.projectPreferences, preferences=>{
    const next={...saved,projectPreferences:preferences};saveJson(stateFile,next);saved=next;
  });
}
// This Mac's own rows only, so peers never re-merge each other.
function localResponse(remote) {
  const local = collect();
  return {sessions:local.sessions.map(row => ({...(remote ? remoteRow(row) : row), machine:peerConfig.label})), machine:peerConfig.label, now:local.now, updatedAt:local.updatedAt};
}
function send(res,status,value) {res.writeHead(status,JSON_HEADERS);res.end(JSON.stringify(value));}
function sendPage(res) {
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  res.end(fs.readFileSync(path.join(__dirname,'page.html'),'utf8'));
}
function requestPath(req) { try { return new URL(req.url,'http://'+HOST+':'+PORT).pathname; } catch { return ''; } }
function readBody(req, callback) {
  let body = '';
  req.on('data', chunk => {body += chunk;if(body.length>8192)req.destroy();});
  req.on('end',()=> {try{callback(null,JSON.parse(body || '{}'));}catch(e){callback(e);}});
}
// The local listener: this Mac's page, desktop window and every action.
const server = http.createServer((req,res)=> {
  try {
    // Only the local Tower page may invoke mutations; no cross-origin webpage actions.
    const access = localAccess(req.headers);
    if (!access.allowed) return send(res,403,{ok:false,error:access.error});
    const host = req.headers.host;
    const url = new URL(req.url,'http://'+host);
    if (req.method === 'GET' && ['/', '/index.html'].includes(url.pathname)) return sendPage(res);
    if (req.method === 'GET' && url.pathname === '/api/sessions') return send(res,200,sessionsResponse(false));
    if (req.method === 'GET' && url.pathname === '/api/local' && peerConfig) return send(res,200,localResponse(false));
    if (req.method !== 'POST') return send(res,404,{ok:false});
    if (req.headers.origin && req.headers.origin !== 'http://'+host) return send(res,403,{ok:false,error:'Local requests only'});
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send(res,415,{ok:false,error:'JSON required'});
    readBody(req,(err,body)=> {
      if (err) return send(res,400,{ok:false,error:'Invalid request'});
      try {
        if (url.pathname === '/api/project') {
          const imported=readProjectBoard(DATA_DIR);
          if(!imported.board)throw new Error('Project notes are unavailable. Refresh and try again.');
          // Validate before observing or writing anything. Unlike a chat action,
          // this deliberate project choice must also work with no current chat.
          validateProjectAction(imported.board,body);
          const payload=sessionPayload(false),at=Number(payload.now)||Date.now();
          const observed=applyProjectPreferences(imported.board,payload.sessions,saved.projectPreferences,at);
          const preferences=updateProjectPreference(observed.board,observed.preferences,body,at);
          const next={...saved,projectPreferences:preferences};saveJson(stateFile,next);saved=next;
          return send(res,200,{ok:true});
        }
        const id = body.id || body.key;
        const row = collect().sessions.find(s=>s.id===id);
        if (!row) return send(res,404,{ok:false,error:'Conversation unavailable'});
        if (url.pathname === '/api/reveal') {
          const args=revealArgs(row,body);
          return execFile('/usr/bin/open',args,{timeout:5000},err=>send(res,err?500:200,err?{ok:false,error:'Could not open the local folder in Finder'}:{ok:true,result:'Folder opened in Finder'}));
        }
        if (url.pathname === '/api/organize') {
          const next = organize(row,body,saved);
          saveJson(stateFile,next);saved=next;return send(res,200,{ok:true});
        }
        if (url.pathname === '/api/dismiss') {
          dismiss(row,body.dismissId,saved.dismissed);saveJson(stateFile,saved);return send(res,200,{ok:true});
        }
        if (url.pathname === '/api/name') {
          const names=loadJson(namesFile); const name=String(body.name || '').replace(/\s+/g,' ').trim().slice(0,24);
          if(name)names[id]={name,sessionId:row.sessionId};else delete names[id];saveJson(namesFile,names);return send(res,200,{ok:true});
        }
        if (url.pathname === '/api/focus') {
          if(!row.focusable)return send(res,409,{ok:false,error:'Desktop app is closed'});
          return execFile('open',focusArgs(row),{timeout:5000},err=>send(res,err?500:200,err?{ok:false,error:'Could not open desktop app'}:{ok:true,mode:row.focusMode,result:row.agent==='claude'?'Claude opened. Choose the conversation.':'Conversation link sent to Codex'}));
        }
        send(res,404,{ok:false});
      } catch(e) {send(res,409,{ok:false,error:e.message});}
    });
  } catch(e) {log(e);send(res,500,{ok:false,error:'Tower could not read session status'});}
});
// The Tailscale view listener: everything arriving here is remote. View-only
// GETs, never a body read, never an action. Exists only with a tailnet address.
const remoteServer = peerConfig?.tailnetHost ? http.createServer((req,res)=> {
  try {
    const pathname = requestPath(req);
    const access = remoteAccess(req.method,pathname,req.headers,peerConfig);
    if (!access.allowed) return send(res,403,{ok:false,error:access.error});
    if (pathname === '/' || pathname === '/index.html') return sendPage(res);
    if (pathname === '/api/sessions') return send(res,200,sessionsResponse(true));
    if (pathname === '/api/local') return send(res,200,localResponse(true));
    send(res,403,{ok:false});
  } catch(e) {log(e);send(res,500,{ok:false,error:'Tower could not read session status'});}
}) : null;
// A failure on this Mac's own port is written synchronously as one line, then
// the process exits non-zero (the login service restarts it). No stack trace.
function exitWith(message) {
  try { fs.writeSync(2, '[tower] ' + new Date().toISOString() + ' ' + message + '\n'); } catch { /* nowhere to report */ }
  process.exit(1);
}
// Only the local listener is required. The Tailscale view is optional: if its
// port is taken, Tower says so once and keeps running local only, so the login
// service never restarts it into the same failure forever.
function start() {
  let pending = remoteServer ? 2 : 1, remoteUp = false;
  const ready = () => {
    if (--pending) return;
    log('listening on http://'+HOST+':'+PORT+(remoteUp?' and, for Tailscale, http://'+HOST+':'+peerConfig.remotePort:'')+(peerConfig?' as '+peerConfig.label+(peerConfig.peers.length?' with '+peerConfig.peers.map(peer=>peer.label).join(', '):''):''));
    peerPoller?.start();
  };
  server.on('error', error => {
    if (server.listening) return log(error);
    exitWith(error.code === 'EADDRINUSE' ? 'port ' + PORT + ' is already in use (is another Tower running?); exiting' : 'could not listen on port ' + PORT + ' (' + (error.code || error.message) + '); exiting');
  });
  server.listen(PORT, HOST, ready);
  if (!remoteServer) return;
  const remotePort = peerConfig.remotePort;
  remoteServer.on('error', error => {
    if (remoteServer.listening) return log(error);
    log(error.code === 'EADDRINUSE' ? 'Tailscale view port ' + remotePort + ' in use; running local only' : 'Tailscale view port ' + remotePort + ' unavailable (' + (error.code || error.message) + '); running local only');
    ready();
  });
  remoteServer.listen(remotePort, HOST, () => { remoteUp = true; ready(); });
}
if (require.main === module) start();
module.exports={parsePeerConfig,loadPeerConfig,localAccess,remoteAccess,remoteRow,sanitizePeerRow,createPeerPoller,mergeSessions,peerMessage,formatClock,peerConfig,peerPoller,workLocation,staticTokens,codexWork,sessionLocation,revealArgs,displayText,questionText,claudeRelationship,selectClaudeSessions,readCodexDetails,presentation,normalizeRelationships,createNativePinReader,readMeta,discover,asksDecision,applyCodex,applyClaude,blank,readTranscript,isRootDesktop,shortName,rowFrom,focusArgs,dismiss,organize,collect,sessionsResponse,server,remoteServer};
