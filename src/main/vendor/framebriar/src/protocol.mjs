// Dependency-free v1 wire contract, shared by browsers and the service.
export const LIMITS = Object.freeze({media:8*1024*1024, json:16*1024, notes:2000,
  breadcrumbs:40, dailyReports:20, testerDailyReports:6, dailyBytes:64*1024*1024,
  retainedReports:200, mediaDays:7, contextDays:7, ticketMs:5*60*1000,
  dailyRequests:2000, testerDailyRequests:500, ownerReservedRequests:500, dailyDownloadBytes:64*1024*1024,
  queueItems:10, queueBytes:32*1024*1024, queueDays:null,
  // Authenticated POST /v1/reports body: room to trim an oversize diagnostics field instead of rejecting.
  reportRequest:256*1024});
export const MIME = ['image/png','image/jpeg','video/webm','video/mp4'];
export const DAY = 86400000;
export function redact(value, max=300) {
  return String(value??'').replace(/\b(?:https?:\/\/|www\.)\S+/gi,'[url]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[email]')
    .replace(/\b(?:Bearer\s+\S+|(?:token|password|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+)/gi,'[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]{20,})\b/g,'[credential]')
    .replace(/(?:[A-Z]:\\|\/(?:Users|home)\/)[^\s]+/g,'[path]').slice(0,max);
}
export class Fault extends Error { constructor(status,message){super(message);this.status=status;} }
export function check(test,message,status=400){if(!test)throw new Fault(status,message);}
function str(v,max,pattern){check(typeof v==='string'&&v.length>0&&v.length<=max&&(!pattern||pattern.test(v)),'Invalid report field');return v;}
// References into an independently configured telemetry backend, never telemetry payloads.
// Rebuild in fixed order so wire key order cannot change an immutable report fingerprint.
function incidentTime(value){
  str(value,24,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
  const ms=Date.parse(value),canonical=value.slice(0,19)+'.'+(value.slice(19,-1).replace(/^\./,'')||'0').padEnd(3,'0')+'Z';
  check(Number.isFinite(ms)&&new Date(ms).toISOString()===canonical,'Invalid incident timestamp');
  return value;
}
function opaqueId(value){
  return str(value,36,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}
export function normalizeIncident(x){
  check(x&&typeof x==='object'&&!Array.isArray(x)&&x.version===1,'Unsupported incident version');
  const out={version:1,id:opaqueId(x.id),capturedAt:incidentTime(x.capturedAt),
    windowStart:incidentTime(x.windowStart),windowEnd:incidentTime(x.windowEnd),
    availability:str(x.availability,14,/^(recorded|unavailable|collection_off)$/),phoneInstanceId:opaqueId(x.phoneInstanceId)};
  const start=Date.parse(out.windowStart),end=Date.parse(out.windowEnd),at=Date.parse(out.capturedAt);
  check(start<=end&&end===at&&end-start<=300000,'Invalid incident window');
  for(const key of ['hostInstanceIds','connectionIds']){
    check(Array.isArray(x[key])&&x[key].length<=4,'Invalid incident identifiers');
    out[key]=x[key].map(opaqueId);
  }
  check(Array.isArray(x.traces)&&x.traces.length<=8,'Invalid incident traces');
  out.traces=x.traces.map(t=>{
    check(t&&typeof t==='object'&&!Array.isArray(t),'Invalid incident trace');
    const ref={traceId:str(t.traceId,32,/^[0-9a-f]{32}$/),spanId:str(t.spanId,16,/^[0-9a-f]{16}$/)};
    check(ref.traceId!=='0'.repeat(32)&&ref.spanId!=='0'.repeat(16),'Invalid incident trace');
    return ref;
  });
  check(out.availability==='recorded'?out.traces.length>0:out.traces.length===0,'Invalid incident availability');
  if(x.backendRef!=null)out.backendRef=opaqueId(x.backendRef);
  check(new TextEncoder().encode(JSON.stringify(out)).length<=4096,'Incident too large',413);
  return out;
}
// Report diagnostics v1 (docs/feedback-diagnostics-v1.md): the single source of the schema, limits and
// closed attribute allowlist for the server, browser and Node. Swift mirrors DIAGNOSTICS_CONTRACT;
// tests/fixtures/report-diagnostics-v1.json keeps them from drifting.
export const DIAGNOSTICS_LIMITS=Object.freeze({totalBytes:64*1024,entries:500,stringBytes:4*1024,attrsPerEntry:32});
const DIAG_FAILURES=['timeout','tls','dns','refused','closed','oversize','overflow','busy','storage','auth','protocol','cancelled','server','offline','unknown'];
export const DIAGNOSTICS_CONTRACT=Object.freeze({v:1,limits:DIAGNOSTICS_LIMITS,tokenPattern:'^[A-Za-z0-9_.:+-]{1,64}$',
  states:Object.freeze(['attached','none','left_out','unavailable']),levels:Object.freeze(['debug','info','warn','error']),
  deliveryResults:Object.freeze(['ok','none',...DIAG_FAILURES]),
  reasons:Object.freeze({none:Object.freeze(['empty','no-provider']),unavailable:Object.freeze(['provider-failed','invalid'])}),
  serverReasons:Object.freeze({unavailable:Object.freeze(['storage-failed'])}),
  attrs:Object.freeze({
    numbers:Object.freeze(['attempt','backoffMs','snapshotBytes','webSocketMessageLimitBytes','transportFrameLimitBytes','durationMs','count','bytes','responseBytes','requestBytes','connectMs','tlsMs','firstByteMs']),
    integerRanges:Object.freeze({statusCode:Object.freeze([100,599]),closeCode:Object.freeze([1000,4999]),exitCode:Object.freeze([0,255])}),
    enums:Object.freeze({failure:Object.freeze(DIAG_FAILURES),link:Object.freeze(['mtls','bearer','unknown'])}),
    tokens:Object.freeze(['operation']),
    // From a closed enum in the client's code, never user or path data; the server enforces only the shape.
    shortTokens:Object.freeze(['fromState','toState','reason','provider','driver']),shortTokenPattern:'^[a-z0-9][a-z0-9_.-]{0,31}$',
    ids:Object.freeze({connectionId:'uuid',attemptId:'uuid',traceId:'trace',spanId:'span'}),
    // Pseudonyms keyed per run: lowercase only, so unlike ids they are never case-normalized.
    refs:Object.freeze(['peerRef','agentRef']),refPattern:'^[0-9a-f]{16}$',
  })});
const DIAG_TOKEN=new RegExp(DIAGNOSTICS_CONTRACT.tokenPattern);
const DIAG_SHORT_TOKEN=new RegExp(DIAGNOSTICS_CONTRACT.attrs.shortTokenPattern),DIAG_REF=new RegExp(DIAGNOSTICS_CONTRACT.attrs.refPattern);
const DIAG_TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const DIAG_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIAG_IDS={uuid:v=>DIAG_UUID.test(v),trace:v=>/^[0-9a-f]{32}$/i.test(v)||DIAG_UUID.test(v),span:v=>/^[0-9a-f]{16}$/i.test(v)};
const utf8=text=>new TextEncoder().encode(text).length;
const diagObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const diagCount=v=>Number.isSafeInteger(v)&&v>=0?v:0;
const diagTime=v=>typeof v==='string'&&DIAG_TIME.test(v)&&Number.isFinite(Date.parse(v));
// A malformed token is undefined; a well-formed one that redact() would rewrite becomes `redacted`.
const diagToken=v=>typeof v==='string'&&DIAG_TOKEN.test(v)?(redact(v,64)===v?v:'redacted'):undefined;
// undefined drops the attribute (counted in droppedAttrs).
function diagAttr(key,value){
  const {numbers,integerRanges,enums,tokens,shortTokens,ids,refs}=DIAGNOSTICS_CONTRACT.attrs;
  if(numbers.includes(key))return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:undefined;
  if(Object.hasOwn(integerRanges,key))return Number.isInteger(value)&&value>=integerRanges[key][0]&&value<=integerRanges[key][1]?value:undefined;
  if(Object.hasOwn(enums,key))return enums[key].includes(value)?value:'unknown';
  if(tokens.includes(key))return diagToken(value);
  if(shortTokens.includes(key))return typeof value==='string'&&DIAG_SHORT_TOKEN.test(value)?diagToken(value):undefined;
  if(refs.includes(key))return typeof value==='string'&&DIAG_REF.test(value)?value:undefined;
  if(Object.hasOwn(ids,key))return typeof value==='string'&&DIAG_IDS[ids[key]](value)?value.toLowerCase():undefined;
}
function diagEntry(raw,count){
  if(!diagObject(raw)||!diagTime(raw.at)||!DIAGNOSTICS_CONTRACT.levels.includes(raw.level))return;
  const ns=diagToken(raw.ns),event=diagToken(raw.event);
  if(!ns||!event)return;
  const entry={at:raw.at,level:raw.level,ns,event};
  if(raw.attrs===undefined)return entry;
  if(!diagObject(raw.attrs)){count(1);return entry;}
  const attrs={};let kept=0;
  for(const [key,value] of Object.entries(raw.attrs)){
    const clean=kept<DIAGNOSTICS_LIMITS.attrsPerEntry?diagAttr(key,value):undefined;
    if(clean===undefined)count(1);else{attrs[key]=clean;kept++;}
  }
  if(kept)entry.attrs=attrs;
  return entry;
}
function diagResult(state,{reason,window={},entries=[],bytes=entries.length?utf8(JSON.stringify(entries)):0,lines=entries.length,dropped=0,droppedAttrs=0,delivery}){
  return {v:1,state,...(reason?{reason}:{}),...window,lines,bytes,dropped,droppedAttrs,entries,...(delivery?{delivery}:{})};
}
function shapeDiagnostics(raw,maxBytes,maxEntries){
  const invalid=(extra={})=>diagResult('unavailable',{reason:'invalid',...extra});
  if(!diagObject(raw)||raw.v!==1||!DIAGNOSTICS_CONTRACT.states.includes(raw.state))return invalid();
  const start=raw.windowStart,end=raw.windowEnd,window=diagTime(start)&&diagTime(end)&&Date.parse(start)<=Date.parse(end)?{windowStart:start,windowEnd:end}:{};
  const delivery=diagObject(raw.delivery)&&Number.isSafeInteger(raw.delivery.queued)&&raw.delivery.queued>=0?
    {queued:raw.delivery.queued,lastResult:DIAGNOSTICS_CONTRACT.deliveryResults.includes(raw.delivery.lastResult)?raw.delivery.lastResult:'unknown'}:undefined;
  let dropped=diagCount(raw.dropped),droppedAttrs=diagCount(raw.droppedAttrs);
  const closed=DIAGNOSTICS_CONTRACT.reasons[raw.state];
  // Never keep entries outside `attached`; left_out is the user's explicit choice, so no delivery either.
  if(raw.state==='left_out')return diagResult('left_out',{window});
  if(raw.state==='none')return diagResult('none',{reason:closed.includes(raw.reason)?raw.reason:'empty',window,dropped,droppedAttrs,delivery});
  if(raw.state==='unavailable')return diagResult('unavailable',{reason:closed.includes(raw.reason)?raw.reason:'provider-failed',window,dropped,droppedAttrs,delivery});
  if(!Array.isArray(raw.entries)||!window.windowStart)return invalid({dropped,droppedAttrs});
  const valid=[];
  for(const item of raw.entries){const entry=diagEntry(item,n=>{droppedAttrs+=n;});if(entry)valid.push(entry);else dropped++;}
  if(!valid.length)return invalid({window,dropped,droppedAttrs});
  // Oldest first, so trimming to fit always removes the oldest. Stable, so a second pass changes nothing.
  valid.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const sizes=valid.map(e=>utf8(JSON.stringify(e)));
  let first=Math.max(0,valid.length-maxEntries),sum=sizes.slice(first).reduce((n,x)=>n+x,0);
  const total=()=>{
    const lines=valid.length-first,bytes=lines?sum+lines+1:0;
    return utf8(JSON.stringify(diagResult('attached',{window,lines,bytes,dropped:dropped+first,droppedAttrs,delivery})))-2+(lines?bytes:2);
  };
  while(first<valid.length&&total()>maxBytes){sum-=sizes[first];first++;}
  dropped+=first;
  if(first===valid.length)return invalid({window,dropped,droppedAttrs});
  return diagResult('attached',{window,entries:valid.slice(first),dropped,droppedAttrs,delivery});
}
// Graceful by contract: bad input degrades to `unavailable`/`invalid`, never a thrown rejection.
// Idempotent: normalizing a normalized value is byte-identical, so a durable outbox can re-check it.
export function normalizeDiagnostics(raw,{maxBytes=DIAGNOSTICS_LIMITS.totalBytes,maxEntries=DIAGNOSTICS_LIMITS.entries}={}){
  try{return shapeDiagnostics(raw,Math.min(maxBytes,DIAGNOSTICS_LIMITS.totalBytes),Math.min(maxEntries,DIAGNOSTICS_LIMITS.entries));}
  catch{return diagResult('unavailable',{reason:'invalid'});}
}
// Call once when the composer opens; the result is frozen across offline retries. The provider is
// synchronous with no I/O and returns entries, or {entries,dropped,droppedAttrs,windowStart,windowEnd,delivery}.
export function captureDiagnostics({provider,include=true,now=()=>Date.now(),windowMs=30*60000,maxBytes,maxEntries}={}){
  const at=now(),window={windowStart:new Date(at-windowMs).toISOString(),windowEnd:new Date(at).toISOString()};
  const shape=value=>normalizeDiagnostics({v:1,...window,...value},{maxBytes,maxEntries});
  if(!include)return shape({state:'left_out'});
  if(typeof provider!=='function')return shape({state:'none',reason:'no-provider'});
  let value;
  try{value=provider();}catch{return shape({state:'unavailable',reason:'provider-failed'});}
  if(value==null)return shape({state:'none',reason:'empty'});
  if(typeof value.then==='function'||typeof value!=='object')return shape({state:'unavailable',reason:'provider-failed'});
  const fields=Array.isArray(value)?{entries:value}:value;
  if(!Array.isArray(fields.entries)||fields.entries.length)return shape({state:'attached',...fields});
  return shape({state:'none',reason:'empty',...fields,entries:[]});
}
// The user's opt-out wins over an earlier capture: keep only the window, never the entries.
export function leaveOutDiagnostics(diagnostics){
  return normalizeDiagnostics({v:1,state:'left_out',windowStart:diagnostics?.windowStart,windowEnd:diagnostics?.windowEnd});
}
export function normalizeReport(x) {
  check(x&&x.v===1,'Unsupported report version');
  const media=x.media;
  check(media===null||(media&&MIME.includes(media.type)&&Number.isSafeInteger(media.bytes)&&media.bytes>0&&media.bytes<=LIMITS.media),'Invalid media');
  if(media!==null)str(media.sha256,64,/^[a-f0-9]{64}$/);
  check(Array.isArray(x.breadcrumbs)&&x.breadcrumbs.length<=LIMITS.breadcrumbs,'Invalid breadcrumbs');
  const out={v:1,id:str(x.id,36,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    gameId:str(x.gameId,60,/^[a-z0-9-]+$/),buildSha:x.buildSha==null?null:str(x.buildSha,40,/^[a-f0-9]{7,40}$/),
    scene:redact(str(x.scene,120),120),sessionId:str(x.sessionId,64,/^[a-zA-Z0-9_-]+$/),
    seed:x.seed==null?null:redact(str(String(x.seed),80),80),platform:redact(str(x.platform,80),80),
    input:str(x.input,20,/^(mouse|keyboard|touch|gamepad|mixed|unknown)$/),
    capturedAt:str(x.capturedAt,30),notes:redact(x.notes,LIMITS.notes),
    breadcrumbs:x.breadcrumbs.map(b=>{
      check(['error','performance','event'].includes(b.kind)&&Number.isFinite(b.atMs)&&b.atMs>=0,'Invalid breadcrumb');
      return {kind:b.kind,atMs:Math.round(b.atMs),code:redact(b.code,100),
        ...(Number.isFinite(b.value)?{value:Math.round(b.value*100)/100}:{})};
    }),media:media===null?null:{type:media.type,bytes:media.bytes,sha256:media.sha256}};
  check(media!==null||out.notes.trim().length>0,'Text-only feedback requires notes');
  check(Number.isFinite(Date.parse(out.capturedAt)),'Invalid timestamp');
  if(x.callCorrelationId)out.callCorrelationId=str(x.callCorrelationId,64,/^[A-Za-z0-9_-]+$/);
  // Correlation with telemetry (docs/correlation.md): active trace/span at feedback open.
  if(x.traceId!=null||x.spanId!=null){out.traceId=str(x.traceId,32,/^[0-9a-f]{32}$/);out.spanId=str(x.spanId,16,/^[0-9a-f]{16}$/);}
  if(x.appVersion!=null)out.appVersion=str(x.appVersion,40,/^[A-Za-z0-9._+-]+$/);
  // Multiplayer match (SDK 0.5.0): the UUID shared by every seat's telemetry, feedback and replay.
  if(x.matchId!=null)out.matchId=str(x.matchId,36,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  if(x.incident!=null){
    out.incident=normalizeIncident(x.incident);
    check(out.incident.id!==out.id.toLowerCase(),'Incident and report identifiers must differ');
    const first=out.incident.traces[0];
    check(first?out.traceId===first.traceId&&out.spanId===first.spanId:out.traceId==null&&out.spanId==null,'Incident trace references must match report');
  }
  check(new TextEncoder().encode(JSON.stringify(out)).length<=LIMITS.json,'Report too large',413);
  // After the size check: diagnostics have their own limit, and a bad field never rejects the report.
  if(x.diagnostics!=null)out.diagnostics=normalizeDiagnostics(x.diagnostics);
  return out;
}
