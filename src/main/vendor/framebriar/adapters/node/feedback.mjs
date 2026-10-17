// Feedback flow for Node/Electron: capture → review → prepare → submit.
// capture is host-provided, e.g. () => win.webContents.capturePage().then(i => i.toPNG()).
// The prepared report (UUID, notes, context, PNG hash, trace) is immutable from then on;
// submit() commits it to the durable outbox and then marks it in telemetry.
import {randomUUID} from 'node:crypto';
import {LIMITS,normalizeReport} from '../../src/protocol.mjs';
import {isPng,sha256} from './transport.mjs';
import {randomHex} from './telemetry.mjs';

const fault=(code,message)=>Object.assign(Error(message),{code});
const traceOf=x=>/^[0-9a-f]{32}$/.test(x?.traceId??'')&&/^[0-9a-f]{16}$/.test(x?.spanId??'')?{traceId:x.traceId,spanId:x.spanId}:{};

export function createFeedback({access,outbox,telemetry,capture,appId=access?.gameId,gameId=appId,buildSha=null,appVersion,
  sessionId=telemetry?.sessionId??`s-${randomHex(12)}`,platform=`${process.platform}-${process.arch}`,now=()=>Date.now()}={}){
  if(!access||!outbox||typeof outbox.enqueue!=='function')throw Error('createFeedback requires access and outbox');
  if(!/^[a-z0-9-]{1,60}$/.test(gameId??'')||(buildSha!==null&&!/^[a-f0-9]{7,40}$/.test(buildSha))||
    (appVersion!=null&&!/^[A-Za-z0-9._+-]{1,40}$/.test(appVersion))||!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId))throw Error('Invalid feedback configuration');
  const eligible=()=>{try{return access.status().canCapture===true;}catch{return false;}};
  async function grab(){
    if(typeof capture!=='function')return null;
    let png;try{png=await capture();}catch{throw fault('capture-failed','Screenshot capture failed');}
    if(png==null)return null;
    png=Buffer.isBuffer(png)?png:Buffer.from(png);
    if(!isPng(png)||png.length>LIMITS.media)throw fault('invalid-media','Capture must return a PNG up to 8 MiB');
    return png;
  }
  // Snapshot at the moment feedback opens: screenshot plus the active trace/span.
  async function open(){
    if(!eligible())throw fault('feedback-unavailable','Feedback needs an enrollment');
    const at=new Date(now()).toISOString(),ctx=traceOf(telemetry?.activeContext?.());
    return Object.freeze({png:await grab(),capturedAt:at,...ctx});
  }
  async function prepare({notes='',context={},png,capturedAt,traceId,spanId}={}){
    if(!eligible())throw fault('feedback-unavailable','Feedback needs an enrollment');
    let snapshot={png,capturedAt,traceId,spanId};
    if(png===undefined)snapshot={...(await open()),...(capturedAt?{capturedAt}:{}),...(traceId?{traceId,spanId}:{})};
    png=snapshot.png==null?null:Buffer.isBuffer(snapshot.png)?snapshot.png:Buffer.from(snapshot.png);
    if(png!==null&&(!isPng(png)||png.length>LIMITS.media))throw fault('invalid-media','A PNG up to 8 MiB is required');
    const ctx=traceOf(snapshot)??{};const fallback=traceOf(telemetry?.activeContext?.());
    const report=normalizeReport({v:1,id:randomUUID(),gameId,buildSha,scene:String(context.scene||'app'),sessionId,
      seed:context.seed??null,platform:String(context.platform||platform),input:context.input||'unknown',
      capturedAt:snapshot.capturedAt??new Date(now()).toISOString(),notes:String(notes??''),
      breadcrumbs:Array.isArray(context.breadcrumbs)?context.breadcrumbs:[],
      media:png?{type:'image/png',bytes:png.length,sha256:sha256(png)}:null,
      ...(context.callCorrelationId?{callCorrelationId:context.callCorrelationId}:{}),
      ...(ctx.traceId?ctx:fallback),...(appVersion!=null?{appVersion}:{})});
    return Object.freeze({report:Object.freeze(report),png});
  }
  // includeDiagnostics mirrors the review screen's "Include recent app diagnostics" box.
  async function submit(prepared,{includeDiagnostics=true}={}){
    const ack=await outbox.enqueue({report:prepared.report,png:prepared.png});
    let diagnostics='unavailable';
    if(telemetry?.feedbackSubmitted&&telemetry.enabled){
      diagnostics=includeDiagnostics?'included':'skipped';
      void telemetry.feedbackSubmitted({reportId:ack.id,traceId:prepared.report.traceId,spanId:prepared.report.spanId,includeDiagnostics}).catch(()=>{});
    }
    return Object.freeze({...ack,diagnostics});
  }
  return Object.freeze({sessionId,eligible,open,prepare,submit});
}
