// Feedback flow for Node/Electron: capture → review → prepare → submit.
// capture is host-provided, e.g. () => win.webContents.capturePage().then(i => i.toPNG()).
// The prepared report (UUID, notes, context, PNG hash, trace) is immutable from then on;
// submit() commits it to the durable outbox and then marks it in telemetry.
import {randomUUID} from 'node:crypto';
import {LIMITS,captureDiagnostics,leaveOutDiagnostics,normalizeReport,normalizeIncident} from '../../src/protocol.mjs';
import {isPng,sha256} from './transport.mjs';

const fault=(code,message)=>Object.assign(Error(message),{code});
const freeze=value=>{if(value&&typeof value==='object'&&!Buffer.isBuffer(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const traceOf=x=>/^[0-9a-f]{32}$/.test(x?.traceId??'')&&/^[0-9a-f]{16}$/.test(x?.spanId??'')?{traceId:x.traceId,spanId:x.spanId}:{};

// diagnosticsProvider (optional, synchronous, no I/O): the report's own bounded diagnostics, snapshotted
// at open() (docs/feedback-diagnostics-v1.md). Without one, reports omit the field exactly as before.
export function createFeedback({access,outbox,telemetry,capture,incidentProvider,diagnosticsProvider,diagnosticsLimits,appId=access?.gameId,gameId=appId,buildSha=null,appVersion,
  sessionId=telemetry?.sessionId??randomUUID(),platform=`${process.platform}-${process.arch}`,now=()=>Date.now()}={}){
  if(!access||!outbox||typeof outbox.enqueue!=='function')throw Error('createFeedback requires access and outbox');
  if(!/^[a-z0-9-]{1,60}$/.test(gameId??'')||(buildSha!==null&&!/^[a-f0-9]{7,40}$/.test(buildSha))||
    (appVersion!=null&&!/^[A-Za-z0-9._+-]{1,40}$/.test(appVersion))||!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId))throw Error('Invalid feedback configuration');
  const eligible=()=>{try{return access.status().canCapture===true;}catch{return false;}};
  const currentRef=async()=>{try{return (await access.enrollmentState()).enrollmentRef??null;}catch{return null;}};
  let enrollmentChanges=0;access.onEnrollmentChange?.(()=>{enrollmentChanges++;});
  async function grab(){
    if(typeof capture!=='function')return null;
    let png;try{png=await capture();}catch{throw fault('capture-failed','Screenshot capture failed');}
    if(png==null)return null;
    png=Buffer.isBuffer(png)?png:Buffer.from(png);
    if(!isPng(png)||png.length>LIMITS.media)throw fault('invalid-media','Capture must return a PNG up to 8 MiB');
    return png;
  }
  function snapshotIncident(){
    if(incidentProvider==null)return undefined;
    try{const value=incidentProvider();return value==null?null:freeze(normalizeIncident(value));}
    catch{throw fault('invalid-input','Invalid incident snapshot');}
  }
  const snapshotDiagnostics=()=>diagnosticsProvider===undefined?undefined:freeze(captureDiagnostics({provider:diagnosticsProvider,now,...diagnosticsLimits}));
  // Explicit host action: snapshot references before any asynchronous screenshot work.
  // An independent provider does not enable Framebriar telemetry or query its backend.
  async function open(){
    if(!eligible())throw fault('feedback-unavailable','Feedback needs an enrollment');
    const seen=enrollmentChanges,at=new Date(now()).toISOString(),incident=snapshotIncident(),diagnostics=snapshotDiagnostics();
    const ctx=incident===undefined?traceOf(telemetry?.activeContext?.()):traceOf(incident?.traces[0]);
    // The captures above must stay synchronous for the active span, so the ref is read after them.
    // A change in that gap must not label them with the new ref. (Another process's change isn't
    // seen here; the gap is one storage read.)
    const enrollmentRef=await currentRef();
    if(seen!==enrollmentChanges)throw fault('enrollment-changed','The enrollment changed while feedback was opening');
    return Object.freeze({png:await grab(),capturedAt:at,...ctx,...(incident===undefined?{}:{incident}),...(diagnostics===undefined?{}:{diagnostics}),enrollmentRef});
  }
  // A prepared object is bound to its ref for good (see submit). Anything supplied, including
  // png:null, must arrive with the ref from the open() that captured it: pass that result through,
  // replacing png or notes if the user edited them. With png undefined and nothing else supplied,
  // prepare opens here as usual.
  async function prepare({notes='',context={},png,capturedAt,traceId,spanId,incident,diagnostics,enrollmentRef}={}){
    if(!eligible())throw fault('feedback-unavailable','Feedback needs an enrollment');
    const supplied=png!==undefined||capturedAt!==undefined||traceId!==undefined||spanId!==undefined||incident!==undefined||diagnostics!==undefined;
    if(supplied&&enrollmentRef===undefined)throw fault('invalid-input','prepare() needs enrollmentRef from open() with a supplied capture');
    if(enrollmentRef!==undefined&&enrollmentRef!==await currentRef())throw fault('enrollment-changed','The enrollment changed after this report was opened');
    let snapshot={png,capturedAt,traceId,spanId,incident,diagnostics,enrollmentRef};
    if(png===undefined)snapshot={...(await open()),...(capturedAt?{capturedAt}:{}),...(traceId?{traceId,spanId}:{}),...(incident===undefined?{}:{incident}),...(diagnostics===undefined?{}:{diagnostics}),...(enrollmentRef===undefined?{}:{enrollmentRef})};
    png=snapshot.png==null?null:Buffer.isBuffer(snapshot.png)?snapshot.png:Buffer.from(snapshot.png);
    if(png!==null&&(!isPng(png)||png.length>LIMITS.media))throw fault('invalid-media','A PNG up to 8 MiB is required');
    // Explicit null removes incident correlation including the legacy mirror. Never
    // replace a reviewed incident with the active span at submit or upload time.
    const metadata=snapshot.incident==null?snapshot.incident:normalizeIncident(snapshot.incident);
    const ctx=metadata!==undefined?traceOf(metadata?.traces[0]):traceOf(snapshot);
    const fallback=metadata===undefined&&!snapshot.capturedAt?traceOf(telemetry?.activeContext?.()):{};
    const report=normalizeReport({v:1,id:randomUUID(),gameId,buildSha,scene:String(context.scene||'app'),sessionId,
      seed:context.seed??null,platform:String(context.platform||platform),input:context.input||'unknown',
      capturedAt:snapshot.capturedAt??new Date(now()).toISOString(),notes:String(notes??''),
      breadcrumbs:Array.isArray(context.breadcrumbs)?context.breadcrumbs:[],
      media:png?{type:'image/png',bytes:png.length,sha256:sha256(png)}:null,
      ...(context.callCorrelationId?{callCorrelationId:context.callCorrelationId}:{}),
      ...(ctx.traceId?ctx:fallback),...(metadata?{incident:metadata}:{}),...(appVersion!=null?{appVersion}:{}),
      ...(snapshot.diagnostics==null?{}:{diagnostics:snapshot.diagnostics})});
    // The ref stays beside the report, never inside it: the body and fingerprint are unaffected.
    return Object.freeze({report:freeze(report),png,enrollmentRef:snapshot.enrollmentRef??null});
  }
  // includeDiagnostics mirrors the review screen's "Include recent app diagnostics" box.
  // Rejects with code 'enrollment-changed', saving nothing, when the enrollment isn't the one this
  // was prepared under. That object can never send: open and prepare again for a new report ID
  // and new captures. The same object under the same enrollment retries idempotently.
  async function submit(prepared,{includeDiagnostics=true}={}){
    // Unchecking the box after prepare still wins: nothing has left the process before enqueue.
    const carried=prepared.report.diagnostics;
    const report=carried&&!includeDiagnostics?{...prepared.report,diagnostics:leaveOutDiagnostics(carried)}:prepared.report;
    const ack=await outbox.enqueue({report,png:prepared.png,enrollmentRef:prepared.enrollmentRef});
    let diagnostics='unavailable';
    if(telemetry?.feedbackSubmitted&&telemetry.enabled){
      diagnostics=includeDiagnostics?'included':'skipped';
      void telemetry.feedbackSubmitted({reportId:ack.id,traceId:prepared.report.traceId,spanId:prepared.report.spanId,includeDiagnostics}).catch(()=>{});
    }
    // diagnostics describes the telemetry excerpt; reportDiagnostics is what this report itself carries.
    return Object.freeze({...ack,diagnostics,reportDiagnostics:report.diagnostics?.state??null});
  }
  return Object.freeze({sessionId,eligible,open,prepare,submit});
}
