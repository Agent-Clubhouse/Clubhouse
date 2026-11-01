// Enrolled-user telemetry for Node/Electron main processes, sent as OTLP/HTTP JSON through
// the Framebriar gateway (docs/telemetry.md). Reuses the browser SDK's pure helpers
// (scrubbing, attributes, exponential histograms); the export loop is the browser's with
// Node timers (unref'd), no page lifecycle, and the correlation additions of
// docs/correlation.md: an in-memory diagnostics ring and `mode:'excerpt-only'`.
//
// mode 'continuous' (default): batches flush every 60 s / 200 items / 64 KiB.
// mode 'excerpt-only': nothing is sent continuously. Spans and logs only enter the local
// ring; feedbackSubmitted({includeDiagnostics:true}) sends that report's excerpt.
// Memory only: nothing is written to disk and nothing survives a restart.
import {TELEMETRY_LIMITS,scrubTelemetryText,telemetryAttributes,createExponentialHistogram} from '../browser/telemetry.mjs';
import {randomFillSync,randomUUID} from 'node:crypto';
import {unrefTimer} from './access.mjs';

export {TELEMETRY_LIMITS,scrubTelemetryText,telemetryAttributes};
export const NODE_TELEMETRY_SDK_VERSION='0.1.0';
export const EXCERPT_LIMITS=Object.freeze({windowMs:5*60000,logs:200,spans:200});
const L=TELEMETRY_LIMITS;
const SEVERITY={trace:1,debug:5,info:9,warn:13,error:17,fatal:21};
const KIND={internal:1,server:2,client:3,producer:4,consumer:5};
const SECRET_KEY=/pass(word|phrase)?|secret|token|auth|cookie|session[_-]?key|api[_-]?key|credential|invitation|e-?mail/i;
const METRIC_NAME=/^[A-Za-z][A-Za-z0-9_.\-/]{0,127}$/;
const bytesOf=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value));
const nanos=ms=>(BigInt(Math.round(ms*1000))*1000n).toString();
const anyValue=v=>telemetryAttributes({v})[0]?.value;
const setAttribute=(list,key,raw)=>{
  if(!key||key.length>L.keyChars||SECRET_KEY.test(key))return;
  const value=anyValue(raw);if(!value)return;
  const i=list.findIndex(x=>x.key===key);
  if(i>=0)list[i]={key,value};else if(list.length<L.attributes)list.push({key,value});
};
const attrKey=list=>JSON.stringify(list.map(x=>[x.key,x.value]).sort((a,b)=>a[0]<b[0]?-1:1));
const name=(x,fallback)=>scrubTelemetryText(typeof x==='string'&&x?x:fallback,L.nameChars)||fallback;
const NOOP_SPAN=Object.freeze({traceId:'',spanId:'',recording:false,context:Object.freeze({traceId:'',spanId:''}),
  setAttribute(){return this;},setAttributes(){return this;},addEvent(){return this;},recordException(){return this;},setStatus(){return this;},end(){}});
const NOOP_INSTRUMENT=Object.freeze({add(){},record(){}});
export const randomHex=n=>{const b=Buffer.alloc(n);do randomFillSync(b);while(b.every(x=>x===0));return b.toString('hex');};

export function createTelemetry({access,endpoint=access?.endpoint,appId=access?.gameId,gameId=appId,buildSha=null,sessionId,
  mode='continuous',now=()=>Date.now(),fetchImpl=(...a)=>fetch(...a),setTimer=unrefTimer,clearTimer=clearTimeout,
  random=()=>Math.random(),captureErrors=false,processEvents=process,onDiagnostic=()=>{}}={}){
  if(!access||typeof access.status!=='function'||typeof access.getToken!=='function')throw Error('Framebriar access controller required');
  if(typeof endpoint!=='string'||!/^https?:\/\//.test(endpoint))throw Error('Telemetry endpoint required');
  if(!/^[a-z0-9-]{1,60}$/.test(gameId??''))throw Error('Invalid telemetry app');
  if(buildSha!==null&&!/^[a-f0-9]{7,40}$/.test(buildSha))throw Error('Invalid telemetry build');
  if(!['continuous','excerpt-only'].includes(mode))throw Error('Invalid telemetry mode');
  sessionId??=randomUUID();
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId))throw Error('Invalid telemetry session');
  const continuous=mode==='continuous';
  const url=`${endpoint.replace(/\/$/,'')}/v1/telemetry`;
  const resource={attributes:telemetryAttributes({'service.name':gameId,...(buildSha?{'service.version':buildSha}:{}),
    'telemetry.sdk.name':'framebriar','telemetry.sdk.language':'nodejs','telemetry.sdk.version':NODE_TELEMETRY_SDK_VERSION})};
  const scope={name:'framebriar.node',version:NODE_TELEMETRY_SDK_VERSION};

  let queue=[],queuedBytes=0,epoch=0,forbidden=false,disposed=false,timer,timerAt=Infinity,soon=false,inflight;
  let blockedUntil=0,failures=0,splitting=false,batchLimit=L.bodyBytes-8*1024,seriesTotal=0,windowStart=now();
  const instruments=new Map(),stack=[],ring={log:[],span:[]};
  const stats={sent:0,dropped:0,requests:0,excerpts:0};
  const diag=(kind,detail)=>{try{onDiagnostic({kind,...detail});}catch{/* diagnostics never break the app */}};
  const statusOk=v=>v?.enrolled===true&&v.notice==null&&!['disconnected','disconnecting','connecting'].includes(v.state);
  const enabled=()=>{if(disposed||forbidden)return false;try{return statusOk(access.status());}catch{return false;}};
  function clearAll(){
    epoch++;queue=[];queuedBytes=0;stack.length=0;ring.log.length=0;ring.span.length=0;
    for(const inst of instruments.values())inst.series.clear();
    seriesTotal=0;blockedUntil=0;failures=0;splitting=false;batchLimit=L.bodyBytes-8*1024;windowStart=now();
    clearTimer(timer);timer=undefined;timerAt=Infinity;
  }
  const unsubscribe=access.subscribe?.(view=>{
    // Re-entering an invitation (or disconnecting) lifts a 403 stop; disconnect forgets everything.
    if(view?.state==='connecting'||!view?.enrolled)forbidden=false;
    if(!statusOk(view))clearAll();
  });

  function arm(at){
    if(disposed||at>=timerAt)return;
    clearTimer(timer);timerAt=at;
    timer=setTimer(()=>{timer=undefined;timerAt=Infinity;void flush();},Math.max(0,at-now()));
  }
  const idle=()=>!queue.length&&!seriesTotal;
  function trim(signal){
    const list=ring[signal],cutoff=now()-EXCERPT_LIMITS.windowMs,max=EXCERPT_LIMITS[signal==='log'?'logs':'spans'];
    while(list.length&&(list.length>max||list[0].at<cutoff))list.shift();
  }
  // Every item is {signal, record, size, state: 'local'|'queued'|'inflight'|'sent'|'dropped'}.
  function push(item){
    if(item.size>L.itemBytes){stats.dropped++;diag('oversize',{signal:item.signal});return;}
    if(item.signal!=='metric'&&idle())windowStart=now();
    item.state='queued';queue.push(item);queuedBytes+=item.size;
    while(queuedBytes>L.bufferBytes&&queue.length){const old=queue.shift();old.state='dropped';queuedBytes-=old.size;stats.dropped++;}
    pressure();
  }
  function record(signal,rec,extra){
    const item={signal,record:rec,size:bytesOf(rec),at:now(),state:'local',...extra};
    if(signal!=='metric'){ring[signal].push(item);trim(signal);}
    if(continuous||signal==='metric')push(item);
  }
  function pressure(){
    arm(Math.max(blockedUntil,windowStart+L.flushMs));
    if(now()<blockedUntil||soon)return;
    if(queue.length+seriesTotal>=L.flushItems||queuedBytes>=L.flushBytes){soon=true;queueMicrotask(()=>{soon=false;void flush();});}
  }

  // ---- traces ----
  const parentOf=parent=>{
    if(parent===null)return undefined;
    const p=parent?.context??parent??stack.at(-1)?.context;
    return p&&/^[a-f0-9]{32}$/.test(p.traceId)&&/^[a-f0-9]{16}$/.test(p.spanId)&&!/^0+$/.test(p.traceId)?p:undefined;
  };
  function span(spanName,attrs,options={}){
    if(!enabled())return NOOP_SPAN;
    const parent=parentOf(options.parent),born=epoch;
    const traceId=parent?.traceId??randomHex(16),spanId=randomHex(8);
    const rec={traceId,spanId,...(parent?{parentSpanId:parent.spanId}:{}),name:name(spanName,'span'),
      kind:KIND[options.kind]??KIND.internal,startTimeUnixNano:nanos(options.startTime??now()),endTimeUnixNano:'',
      attributes:telemetryAttributes(attrs),events:[],status:{code:0}};
    let ended=false;
    const handle={traceId,spanId,recording:true,context:Object.freeze({traceId,spanId}),
      setAttribute(key,value){if(!ended)setAttribute(rec.attributes,key,value);return handle;},
      setAttributes(values){for(const [k,v] of Object.entries(values??{}))handle.setAttribute(k,v);return handle;},
      addEvent(eventName,eventAttrs,time){
        if(!ended&&rec.events.length<L.events)rec.events.push({timeUnixNano:nanos(time??now()),name:name(eventName,'event'),attributes:telemetryAttributes(eventAttrs,L.eventAttributes)});
        return handle;
      },
      recordException(error,extra){if(!ended)handle.addEvent('exception',{...exceptionAttributes(error),...extra});return handle;},
      setStatus(code,message){
        if(ended)return handle;
        const c=code==='error'||code===2?2:code==='ok'||code===1?1:0;
        rec.status=c===2&&message?{code:c,message:scrubTelemetryText(message,L.valueChars)}:{code:c};
        return handle;
      },
      end(time){
        if(ended)return;ended=true;handle.recording=false;
        const i=stack.lastIndexOf(handle);if(i>=0)stack.splice(i,1);
        if(born!==epoch||!enabled())return;
        rec.endTimeUnixNano=nanos(Math.max(time??now(),Number(BigInt(rec.startTimeUnixNano)/1000000n)));
        if(!rec.events.length)delete rec.events;
        record('span',rec);
      },
    };
    return handle;
  }
  function withSpan(spanName,attrsOrFn,maybeFn,options){
    const fn=typeof attrsOrFn==='function'?attrsOrFn:maybeFn;
    const attrs=typeof attrsOrFn==='function'?undefined:attrsOrFn;
    const s=span(spanName,attrs,options);
    if(s===NOOP_SPAN)return fn(s);
    // Active-span stack is synchronous; concurrent async work should pass {parent} explicitly.
    stack.push(s);
    const fail=e=>{s.recordException(e).setStatus('error',e?.message);s.end();throw e;};
    let result;
    try{result=fn(s);}catch(e){fail(e);}
    if(result&&typeof result.then==='function'){
      const i=stack.lastIndexOf(s);if(i>=0)stack.splice(i,1);
      return result.then(v=>{s.end();return v;},fail);
    }
    s.end();return result;
  }

  // ---- logs ----
  function exceptionAttributes(error){
    const e=error instanceof Error?error:{name:typeof error,message:String(error)};
    return {'exception.type':String(e.name||'Error').slice(0,L.nameChars),'exception.message':e.message??'',
      ...(typeof e.stack==='string'?{'exception.stacktrace':e.stack}:{})};
  }
  function logRecord(severity,body,attrs,options={}){
    const level=typeof severity==='string'?severity.toLowerCase():'info';
    const number=SEVERITY[level]??(Number.isInteger(severity)&&severity>=1&&severity<=24?severity:SEVERITY.info);
    const text=Object.keys(SEVERITY).find(k=>SEVERITY[k]===number)?.toUpperCase()??String(number);
    const ctx=parentOf(options.parent),t=nanos(options.time??now());
    return {timeUnixNano:t,observedTimeUnixNano:t,severityNumber:number,severityText:text,
      body:{stringValue:scrubTelemetryText(body,L.bodyChars)},attributes:telemetryAttributes(attrs),
      ...(ctx?{traceId:ctx.traceId,spanId:ctx.spanId}:{})};
  }
  function log(severity,body,attrs,options){if(enabled())record('log',logRecord(severity,body,attrs,options));}
  function exception(error,attrs,options){
    if(!enabled())return;
    const details=exceptionAttributes(error);
    log('error',details['exception.message']||details['exception.type'],{...details,...attrs},options);
  }

  // ---- metrics (delta temporality; continuous mode only) ----
  function instrument(kind,metricName,{unit='',description=''}={}){
    if(!continuous||typeof metricName!=='string'||!METRIC_NAME.test(metricName))return NOOP_INSTRUMENT;
    let inst=instruments.get(metricName);
    if(!inst&&instruments.size>=L.instruments){diag('instrument-limit',{name:metricName});return NOOP_INSTRUMENT;}
    if(!inst){inst={kind,name:metricName,unit:String(unit).slice(0,63),description:scrubTelemetryText(description,L.valueChars),series:new Map()};instruments.set(metricName,inst);}
    if(inst.kind!==kind){diag('instrument-conflict',{name:metricName});return NOOP_INSTRUMENT;}
    const seriesFor=attrs=>{
      let list=telemetryAttributes(attrs),key=attrKey(list),entry=inst.series.get(key);
      if(entry)return entry;
      if(inst.series.size>=L.series-1||seriesTotal>=L.totalSeries){
        list=[{key:'otel.metric.overflow',value:{boolValue:true}}];key=attrKey(list);entry=inst.series.get(key);
        if(entry)return entry;
      }
      if(idle())windowStart=now();
      entry={attributes:list,value:0,histogram:kind==='histogram'?createExponentialHistogram():undefined};
      inst.series.set(key,entry);seriesTotal++;pressure();
      return entry;
    };
    const live=()=>instruments.get(metricName)===inst&&enabled();
    if(kind==='counter')return Object.freeze({add(n,attrs){if(!live()||!Number.isFinite(n)||n<0)return;seriesFor(attrs).value+=n;}});
    if(kind==='gauge')return Object.freeze({record(v,attrs){if(!live()||!Number.isFinite(v))return;seriesFor(attrs).value=v;}});
    return Object.freeze({record(v,attrs){if(!live()||!Number.isFinite(v))return;seriesFor(attrs).histogram.record(v);}});
  }
  function collectMetrics(){
    const start=nanos(windowStart),end=now(),time=nanos(end);
    windowStart=end;
    for(const inst of instruments.values()){
      for(const s of inst.series.values()){
        const point={attributes:s.attributes,startTimeUnixNano:start,timeUnixNano:time};
        if(inst.kind==='histogram'){if(!s.histogram.count)continue;Object.assign(point,s.histogram.snapshot());}
        else point.asDouble=s.value;
        record('metric',point,{metric:inst});
      }
      inst.series.clear();
    }
    seriesTotal=0;
  }

  // ---- diagnostics excerpt (docs/correlation.md) ----
  // Marks the moment and, with consent, sends the last five minutes of this SDK's own
  // already-sanitized spans/logs tagged with the report id, then flushes immediately.
  // Items that already went out continuously are not re-sent; queued ones gain the tags.
  function feedbackSubmitted({reportId,traceId,spanId,includeDiagnostics=true}={}){
    if(!/^[0-9a-f-]{36}$/i.test(reportId??'')||!enabled())return Promise.resolve({marked:false,excerpt:0});
    // Excerpt-only apps send nothing at all without this report's diagnostics consent.
    if(!continuous&&!includeDiagnostics)return Promise.resolve({marked:false,excerpt:0});
    const ctx=/^[0-9a-f]{32}$/.test(traceId??'')&&/^[0-9a-f]{16}$/.test(spanId??'')?{traceId,spanId}:undefined;
    let excerpt=0;
    if(includeDiagnostics){
      trim('log');trim('span');
      for(const item of [...ring.span,...ring.log]){
        if(['sent','inflight','excerpted'].includes(item.state))continue;
        const tag=rec=>{setAttribute(rec.attributes,'feedback.report.id',reportId);setAttribute(rec.attributes,'feedback.excerpt',true);};
        if(item.state==='queued'){const before=bytesOf(item.record);tag(item.record);const grown=bytesOf(item.record)-before;item.size+=grown;queuedBytes+=grown;}
        else{const copy=structuredClone(item.record);tag(copy);item.state='excerpted';push({signal:item.signal,record:copy,size:bytesOf(copy),at:item.at});}
        excerpt++;
      }
      stats.excerpts++;
    }
    const marker=logRecord('info','feedback.submitted',{'feedback.report.id':reportId},{parent:ctx??null});
    push({signal:'log',record:marker,size:bytesOf(marker),at:now()});
    // Flush now; a server-requested backoff (429/503) still holds and the excerpt waits in memory.
    return flush().then(sent=>({marked:true,excerpt,sent}));
  }

  // ---- export ----
  function encode(items){
    const spans=[],logs=[],metrics=new Map();
    for(const item of items){
      if(item.signal==='span')spans.push(item.record);
      else if(item.signal==='log')logs.push(item.record);
      else{
        const m=item.metric;let out=metrics.get(m.name);
        if(!out){
          const data={dataPoints:[]};
          if(m.kind==='counter')Object.assign(data,{aggregationTemporality:1,isMonotonic:true});
          if(m.kind==='histogram')data.aggregationTemporality=1;
          out={name:m.name,...(m.unit?{unit:m.unit}:{}),...(m.description?{description:m.description}:{}),
            [m.kind==='counter'?'sum':m.kind==='gauge'?'gauge':'exponentialHistogram']:data};
          metrics.set(m.name,out);
        }
        (out.sum??out.gauge??out.exponentialHistogram).dataPoints.push(item.record);
      }
    }
    const body={v:1,gameId,...(buildSha?{buildSha}:{}),sessionId};
    if(spans.length)body.traces={resourceSpans:[{resource,scopeSpans:[{scope,spans}]}]};
    if(logs.length)body.logs={resourceLogs:[{resource,scopeLogs:[{scope,logRecords:logs}]}]};
    if(metrics.size)body.metrics={resourceMetrics:[{resource,scopeMetrics:[{scope,metrics:[...metrics.values()]}]}]};
    return JSON.stringify(body);
  }
  function take(limit,maxBody){
    const batch=[];let size=0;
    while(queue.length&&(batch.length===0||size+queue[0].size<=limit)){const item=queue.shift();queuedBytes-=item.size;size+=item.size;batch.push(item);}
    let json=encode(batch);
    while(batch.length>1&&bytesOf(json)>maxBody){
      const back=batch.splice(Math.ceil(batch.length/2));
      for(const item of back)queuedBytes+=item.size;
      queue.unshift(...back);json=encode(batch);
    }
    for(const item of batch)item.state='inflight';
    return {batch,json};
  }
  function requeue(batch){
    for(const item of batch)item.state='queued';
    queue=batch.concat(queue);
    for(const item of batch)queuedBytes+=item.size;
    while(queuedBytes>L.bufferBytes&&queue.length){const old=queue.shift();old.state='dropped';queuedBytes-=old.size;stats.dropped++;}
  }
  const drop=batch=>{for(const item of batch)item.state='dropped';stats.dropped+=batch.length;};
  const backoff=ms=>{blockedUntil=now()+ms;arm(blockedUntil);};
  const post=(json,token)=>{stats.requests++;return fetchImpl(url,{method:'POST',redirect:'error',
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:json,signal:AbortSignal.timeout(30000)});};
  function flush(){
    if(inflight)return inflight;
    if(!enabled()){if(!disposed&&!forbidden)clearAll();return Promise.resolve(false);}
    if(now()<blockedUntil)return Promise.resolve(false);
    const ticket=epoch;
    if(continuous)collectMetrics();
    clearTimer(timer);timer=undefined;timerAt=Infinity;
    if(!queue.length)return Promise.resolve(true);
    const work=(async()=>{
      const {batch,json}=take(batchLimit,L.bodyBytes);
      const settle=()=>{if(queue.length||seriesTotal)arm(Math.max(blockedUntil,windowStart+L.flushMs));};
      let token;try{token=await access.getToken();}catch{token=undefined;}
      if(ticket!==epoch)return false;
      if(!token){requeue(batch);backoff(Math.min(L.maxBackoffMs,5000*2**Math.min(failures++,7)));return false;}
      let response;
      try{
        response=await post(json,token);
        if(response.status===401&&ticket===epoch){
          await response.body?.cancel?.();
          let fresh;try{fresh=await access.getToken();}catch{fresh=undefined;}
          if(ticket!==epoch)return false;
          if(fresh)response=await post(json,fresh);
        }
      }catch{response=undefined;}
      if(ticket!==epoch)return false;
      const status=response?.status??0;
      await response?.body?.cancel?.().catch?.(()=>{});
      if(status>=200&&status<300){
        for(const item of batch)item.state='sent';
        stats.sent+=batch.length;failures=0;
        if(splitting&&queue.length){arm(now());return true;}
        splitting=false;batchLimit=L.bodyBytes-8*1024;
        if(queue.length>=L.flushItems||queuedBytes>=L.flushBytes)arm(now());else settle();
        return true;
      }
      if(status===401){drop(batch);diag('unauthorized',{});backoff(Math.min(L.maxBackoffMs,5000*2**Math.min(failures++,7)));return false;}
      if(status===403){forbidden=true;drop(batch);clearAll();diag('forbidden',{});return false;}
      if(status===413){
        if(batch.length>1){splitting=true;batchLimit=Math.max(1,Math.floor(batch.reduce((n,x)=>n+x.size,0)/2));requeue(batch);arm(now());}
        else{drop(batch);settle();}
        return false;
      }
      if(status===429){
        const header=Number(response.headers?.get?.('retry-after'));
        requeue(batch);backoff(Math.min(L.maxRetryAfterMs,Number.isFinite(header)&&header>=0?header*1000:L.flushMs));return false;
      }
      if(status===0||status===408||status>=500){
        requeue(batch);
        const base=Math.min(L.maxBackoffMs,5000*2**Math.min(failures++,7));
        backoff(Math.min(L.maxBackoffMs,Math.round(base*(1+0.2*random()))));return false;
      }
      drop(batch);settle();return false; // 400 and other 4xx: never retry
    })();
    const done=work.catch(()=>false).finally(()=>{if(inflight===done)inflight=undefined;});
    inflight=done;return done;
  }

  // ---- optional auto-instrumentation ----
  // uncaughtExceptionMonitor observes without changing Node's crash behaviour.
  const onUncaught=(error,origin)=>exception(error,{'exception.escaped':true,'error.origin':String(origin??'uncaughtException')});
  if(captureErrors)processEvents?.on?.('uncaughtExceptionMonitor',onUncaught);

  function dispose(){
    if(disposed)return;
    processEvents?.off?.('uncaughtExceptionMonitor',onUncaught);
    unsubscribe?.();clearAll();disposed=true;
  }
  return Object.freeze({sessionId,mode,
    get enabled(){return enabled();},
    span,withSpan,log,exception,feedbackSubmitted,
    activeContext(){return stack.at(-1)?.context;},
    counter:(n,o)=>instrument('counter',n,o),
    gauge:(n,o)=>instrument('gauge',n,o),
    histogram:(n,o)=>instrument('histogram',n,o),
    flush:()=>flush(),
    stats:()=>({...stats,buffered:queue.length,bufferedBytes:queuedBytes,ring:{logs:ring.log.length,spans:ring.span.length},series:seriesTotal,forbidden,blockedUntil}),
    // Call before quit; awaits one bounded flush in continuous mode.
    async shutdown({timeoutMs=2000}={}){
      if(disposed)return;
      if(continuous)await Promise.race([flush(),new Promise(r=>unrefTimer(r,timeoutMs))]);
      dispose();
    },
    dispose,
  });
}
