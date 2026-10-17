// Dependency-free v1 wire contract, shared by browsers and the service.
export const LIMITS = Object.freeze({media:8*1024*1024, json:16*1024, notes:2000,
  breadcrumbs:40, dailyReports:20, testerDailyReports:6, dailyBytes:64*1024*1024,
  retainedReports:200, mediaDays:7, contextDays:7, ticketMs:5*60*1000,
  dailyRequests:2000, testerDailyRequests:500, ownerReservedRequests:500, dailyDownloadBytes:64*1024*1024,
  queueItems:10, queueBytes:32*1024*1024, queueDays:null});
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
  check(new TextEncoder().encode(JSON.stringify(out)).length<=LIMITS.json,'Report too large',413);
  return out;
}
