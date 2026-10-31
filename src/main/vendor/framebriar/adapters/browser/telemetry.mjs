// Enrolled-player telemetry (traces, logs, metrics) sent as OTLP/HTTP JSON through the
// Framebriar gateway. Contract: docs/telemetry.md. Zero dependencies, memory only: nothing
// is written to storage and nothing survives a reload. Not enrolled => every call is a no-op.
// Feedback correlation (docs/correlation.md): the shared page session ID, an in-memory ring of
// recent spans and logs, and on submit a `feedback.submitted` marker plus a consented excerpt.
export const TELEMETRY_SDK_VERSION='0.1.0';
export const TELEMETRY_LIMITS=Object.freeze({
  flushMs:60000,flushItems:200,flushBytes:64*1024,bufferBytes:1024*1024,bodyBytes:256*1024,
  keepaliveBytes:60*1024,itemBytes:32*1024,attributes:32,keyChars:128,valueChars:1024,arrayItems:32,
  bodyChars:4096,nameChars:128,events:32,eventAttributes:16,series:100,totalSeries:1000,
  instruments:200,histogramScale:8,histogramBuckets:160,maxBackoffMs:600000,maxRetryAfterMs:3600000,
  ringMs:5*60000,ringLogs:200,ringSpans:200,consoleRepeatMs:10000,consolePerMinute:60,
});
const L=TELEMETRY_LIMITS;
const SEVERITY={trace:1,debug:5,info:9,warn:13,error:17,fatal:21};
const KIND={internal:1,server:2,client:3,producer:4,consumer:5};
const SECRET_KEY=/pass(word|phrase)?|secret|token|auth|cookie|session[_-]?key|api[_-]?key|credential|invitation|e-?mail/i;
const METRIC_NAME=/^[A-Za-z][A-Za-z0-9_.\-/]{0,127}$/;
const encoder=new TextEncoder();
const bytesOf=value=>encoder.encode(typeof value==='string'?value:JSON.stringify(value)).length;
const nanos=ms=>(BigInt(Math.round(ms*1000))*1000n).toString();

// Light client-side pass; the gateway redacts again but the SDK must not rely on it.
export function scrubTelemetryText(value,max=L.valueChars){
  return String(value??'')
    .replace(/\bfile:\/\/\S+/gi,'[path]')
    .replace(/\b(https?|wss?):\/\/[^\s?#"'<>]+[?#][^\s"'<>)]*/gi,m=>m.replace(/[?#].*?(?=(?::\d+){1,2}$|$)/,''))
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[email]')
    .replace(/\b(?:Bearer\s+\S+|(?:token|password|passwd|secret|api[_-]?key|authorization|cookie|invitation)\s*[:=]\s*[^\s,;&]+)/gi,'[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]{20,})/g,'[credential]')
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,'[credential]')
    .replace(/(?:\b[A-Za-z]:\\|\/(?:Users|home|private|var\/folders)\/)[^\s:)]+/g,'[path]')
    .slice(0,max);
}
function anyValue(v,depth=0){
  if(typeof v==='string')return {stringValue:scrubTelemetryText(v)};
  if(typeof v==='boolean')return {boolValue:v};
  if(typeof v==='bigint')return {intValue:v.toString()};
  if(typeof v==='number'){if(!Number.isFinite(v))return undefined;return Number.isSafeInteger(v)?{intValue:String(v)}:{doubleValue:v};}
  if(Array.isArray(v)&&depth===0){
    const values=v.slice(0,L.arrayItems).map(x=>anyValue(x,1)).filter(Boolean);
    return {arrayValue:{values}};
  }
  return undefined;
}
// Returns OTLP KeyValue[]: ≤32 attributes, keys ≤128 chars, strings ≤1 KiB, secrets dropped.
export function telemetryAttributes(attrs,max=L.attributes){
  const out=[];
  if(!attrs||typeof attrs!=='object')return out;
  for(const [key,raw] of Object.entries(attrs)){
    if(out.length>=max)break;
    if(!key||key.length>L.keyChars||SECRET_KEY.test(key))continue;
    const value=anyValue(raw);
    if(value)out.push({key,value});
  }
  return out;
}
const setAttribute=(list,key,raw)=>{
  if(!key||key.length>L.keyChars||SECRET_KEY.test(key))return;
  const value=anyValue(raw);if(!value)return;
  const i=list.findIndex(x=>x.key===key);
  if(i>=0)list[i]={key,value};else if(list.length<L.attributes)list.push({key,value});
};
const attrKey=list=>JSON.stringify(list.map(x=>[x.key,x.value]).sort((a,b)=>a[0]<b[0]?-1:1));
const name=(x,fallback)=>{const s=scrubTelemetryText(typeof x==='string'&&x?x:fallback,L.nameChars);return s||fallback;};

// Exponential histogram bucket index for |value| > 0 at `scale` (OTel definition: bucket i
// covers (base^i, base^(i+1)], base = 2^(2^-scale)). Exact powers of two use the exponent.
export function exponentialBucketIndex(value,scale){
  const v=Math.abs(value);
  const exp=Math.log2(v);
  if(Number.isInteger(exp))return scale>=0?exp*2**scale-1:((exp-1)>>-scale);
  return scale>=0?Math.ceil(exp*2**scale)-1:(Math.floor(exp)>>-scale);
}
export function createExponentialHistogram({maxScale=L.histogramScale,maxSize=L.histogramBuckets}={}){
  let scale,count,sum,zero,min,max,pos,neg;
  const reset=()=>{scale=maxScale;count=0;sum=0;zero=0;min=Infinity;max=-Infinity;pos=new Map();neg=new Map();};
  reset();
  const span=(map,extra)=>{let lo=extra,hi=extra;for(const k of map.keys()){if(lo===undefined||k<lo)lo=k;if(hi===undefined||k>hi)hi=k;}return [lo,hi];};
  const rescale=shift=>{
    if(shift<=0)return;
    for(const side of ['pos','neg']){
      const old=side==='pos'?pos:neg,next=new Map();
      for(const [k,c] of old){const j=k>>shift;next.set(j,(next.get(j)??0)+c);}
      if(side==='pos')pos=next;else neg=next;
    }
    scale-=shift;
  };
  return {
    record(value){
      if(!Number.isFinite(value))return;
      count++;sum+=value;if(value<min)min=value;if(value>max)max=value;
      if(value===0){zero++;return;}
      const map=value>0?pos:neg;
      let index=exponentialBucketIndex(value,scale);
      let [lo,hi]=span(map,index),shift=0;
      while(hi-lo+1>maxSize){shift++;lo>>=1;hi>>=1;}
      if(shift){rescale(shift);index=exponentialBucketIndex(value,scale);}
      const target=value>0?pos:neg;target.set(index,(target.get(index)??0)+1);
    },
    get scale(){return scale;},get count(){return count;},
    snapshot(){
      const dense=map=>{
        if(!map.size)return undefined;
        const [lo,hi]=span(map);
        const bucketCounts=Array.from({length:hi-lo+1},(_,i)=>String(map.get(lo+i)??0));
        return {offset:lo,bucketCounts};
      };
      const out={count:String(count),sum,scale,zeroCount:String(zero)};
      const p=dense(pos),n=dense(neg);
      if(p)out.positive=p;if(n)out.negative=n;
      if(count){out.min=min;out.max=max;}
      return out;
    },
    reset,
  };
}

// One session ID per page run, shared with feedback reports and replay manifests. It lives in a
// global symbol slot so local-export.mjs (protocol-only imports) and duplicate bundles agree on one
// value. Since 0.5.0 the default is a UUID v4 (replay requires one); older `s-<24 hex>` IDs and
// host-adopted IDs stay valid everywhere they were accepted before.
const SESSION=/^[A-Za-z0-9_-]{1,64}$/,SESSION_SLOT=Symbol.for('framebriar.page-session');
export function uuidV4(getRandomValues=a=>crypto.getRandomValues(a)){
  const b=new Uint8Array(16);getRandomValues(b);b[6]=b[6]&0x0f|0x40;b[8]=b[8]&0x3f|0x80;
  const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function pageSessionId(){
  if(SESSION.test(globalThis[SESSION_SLOT]??''))return globalThis[SESSION_SLOT];
  return globalThis[SESSION_SLOT]=uuidV4();
}
// Hosts that already have a run ID may adopt it; call before creating telemetry or reports.
export function setPageSessionId(id){
  if(typeof id!=='string'||!SESSION.test(id))throw Error('Invalid session id');
  return globalThis[SESSION_SLOT]=id;
}

const NOOP_SPAN=Object.freeze({traceId:'',spanId:'',recording:false,context:Object.freeze({traceId:'',spanId:''}),
  setAttribute(){return this;},setAttributes(){return this;},addEvent(){return this;},recordException(){return this;},setStatus(){return this;},end(){}});
const NOOP_INSTRUMENT=Object.freeze({add(){},record(){}});
const REPORT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Console arguments become text without dumping objects (they may hold private app state).
const consoleText=a=>typeof a==='string'?a:a instanceof Error?`${a.name||'Error'}: ${a.message}`:
  a===null||['number','boolean','bigint','undefined'].includes(typeof a)?String(a):`[${Array.isArray(a)?'array':typeof a}]`;

export function createTelemetry({access,endpoint=access?.endpoint,gameId,buildSha=null,sessionId,
  now=()=>Date.now(),fetchImpl=(...a)=>fetch(...a),setTimer=setTimeout,clearTimer=clearTimeout,
  random=()=>Math.random(),getRandomValues=a=>crypto.getRandomValues(a),
  document=globalThis.document,window=globalThis.window,requestFrame=globalThis.requestAnimationFrame?.bind(globalThis),
  captureErrors=false,captureConsole=false,console:consoleImpl=globalThis.console,frameTime=false,
  maxQueueAgeMs=Infinity,
  telemetry:mode='continuous',onDiagnostic=()=>{}}={}){
  if(!access||typeof access.status!=='function'||typeof access.getToken!=='function')throw Error('Playtest access controller required');
  if(typeof endpoint!=='string'||!/^https?:\/\//.test(endpoint))throw Error('Telemetry endpoint required');
  if(!/^[a-z0-9-]{1,60}$/.test(gameId??''))throw Error('Invalid telemetry game');
  if(buildSha!==null&&!/^[a-f0-9]{7,40}$/.test(buildSha))throw Error('Invalid telemetry build');
  if(!['continuous','excerpt-only'].includes(mode))throw Error('Invalid telemetry mode');
  const hex=n=>{const b=new Uint8Array(n);do getRandomValues(b);while(b.every(x=>x===0));return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');};
  sessionId??=pageSessionId();
  if(!SESSION.test(sessionId))throw Error('Invalid telemetry session');
  const url=`${endpoint.replace(/\/$/,'')}/v1/telemetry`;
  const resource={attributes:telemetryAttributes({'service.name':gameId,...(buildSha?{'service.version':buildSha}:{}),
    'telemetry.sdk.name':'framebriar','telemetry.sdk.language':'webjs','telemetry.sdk.version':TELEMETRY_SDK_VERSION})};
  const scope={name:'framebriar.browser',version:TELEMETRY_SDK_VERSION};

  let queue=[],queuedBytes=0,lastToken,epoch=0,forbidden=false,disposed=false,timer,timerAt=Infinity,soon=false,inflight,requestAbort;
  let blockedUntil=0,failures=0,splitting=false,batchLimit=L.bodyBytes-8*1024,seriesTotal=0,windowStart=now(),urgent=false;
  // Diagnostics ring: already-sanitized spans/logs, last 5 min, never persisted. Entry state is
  // 'local' (never handed to the gateway), 'queued', 'inflight', 'sent' or 'rejected'.
  let ring=[];
  const instruments=new Map(),stack=[];
  const stats={sent:0,dropped:0,requests:0};
  const diag=(kind,detail)=>{try{onDiagnostic({kind,...detail});}catch{/* diagnostics never break the game */}};
  const statusOk=v=>v?.enrolled===true&&v.notice==null&&!['disconnected','unsupported-origin','disconnecting','connecting','telemetry-disabled'].includes(v.state);
  const enabled=()=>{if(disposed||forbidden)return false;try{return statusOk(access.status());}catch{return false;}};
  function clearAll(){
    requestAbort?.abort();requestAbort=undefined;
    epoch++;queue=[];queuedBytes=0;stack.length=0;ring=[];urgent=false;
    for(const inst of instruments.values())inst.series.clear();
    seriesTotal=0;blockedUntil=0;failures=0;lastToken=undefined;splitting=false;batchLimit=L.bodyBytes-8*1024;windowStart=now();
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
  const liveSeries=()=>seriesTotal,idle=()=>!queue.length&&!seriesTotal;
  const mark=(items,state)=>{for(const item of items)if(item.entry)item.entry.state=state;};
  const evict=()=>{while(queuedBytes>L.bufferBytes&&queue.length){const old=queue.shift();queuedBytes-=old.size;stats.dropped++;mark([old],'local');}};
  function enqueue(signal,record,extra,size=bytesOf(record)){
    if(size>L.itemBytes){stats.dropped++;diag('oversize',{signal});return;}
    if(signal!=='metric'&&idle())windowStart=now();
    const item={signal,record,size,at:now(),...extra};mark([item],'queued');
    queue.push(item);queuedBytes+=size;
    evict();
    pressure();
  }
  function prune(){
    const cutoff=now()-L.ringMs;let logs=0,spans=0;
    for(const e of ring)if(e.signal==='log')logs++;else spans++;
    ring=ring.filter(e=>{
      if(e.at>=cutoff&&(e.signal==='log'?logs:spans)<=(e.signal==='log'?L.ringLogs:L.ringSpans))return true;
      if(e.signal==='log')logs--;else spans--;return false;
    });
  }
  function remember(signal,record){
    const entry={signal,record,at:now(),state:'local'};
    ring.push(entry);prune();return entry;
  }
  // Every span/log is remembered; continuous mode also queues it for the next flush.
  function emit(signal,record,{send=mode==='continuous'}={}){
    const size=bytesOf(record);
    if(size>L.itemBytes){stats.dropped++;diag('oversize',{signal});return;}
    const entry=remember(signal,record);
    if(send)enqueue(signal,record,{entry},size);
  }
  function pressure(){
    arm(Math.max(blockedUntil,windowStart+L.flushMs));
    if(now()<blockedUntil||soon)return;
    if(queue.length+liveSeries()>=L.flushItems||queuedBytes>=L.flushBytes){
      soon=true;queueMicrotask(()=>{soon=false;void flush();});
    }
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
    const traceId=parent?.traceId??hex(16),spanId=hex(8);
    const record={traceId,spanId,...(parent?{parentSpanId:parent.spanId}:{}),name:name(spanName,'span'),
      kind:KIND[options.kind]??KIND.internal,startTimeUnixNano:nanos(options.startTime??now()),endTimeUnixNano:'',
      attributes:telemetryAttributes(attrs),events:[],status:{code:0}};
    let ended=false;
    const handle={traceId,spanId,recording:true,context:Object.freeze({traceId,spanId}),
      setAttribute(key,value){if(!ended)setAttribute(record.attributes,key,value);return handle;},
      setAttributes(values){for(const [k,v] of Object.entries(values??{}))handle.setAttribute(k,v);return handle;},
      addEvent(eventName,eventAttrs,time){
        if(!ended&&record.events.length<L.events)record.events.push({timeUnixNano:nanos(time??now()),name:name(eventName,'event'),attributes:telemetryAttributes(eventAttrs,L.eventAttributes)});
        return handle;
      },
      recordException(error,extra){
        if(!ended)handle.addEvent('exception',{...exceptionAttributes(error),...extra});
        return handle;
      },
      setStatus(code,message){
        if(ended)return handle;
        const c=code==='error'||code===2?2:code==='ok'||code===1?1:0;
        record.status=c===2&&message?{code:c,message:scrubTelemetryText(message,L.valueChars)}:{code:c};
        return handle;
      },
      end(time){
        if(ended)return;ended=true;handle.recording=false;
        const i=stack.lastIndexOf(handle);if(i>=0)stack.splice(i,1);
        if(born!==epoch||!enabled())return;
        record.endTimeUnixNano=nanos(Math.max(time??now(),Number(BigInt(record.startTimeUnixNano)/1000000n)));
        if(!record.events.length)delete record.events;
        emit('span',record);
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
  function log(severity,body,attrs,options={}){
    if(!enabled())return;
    emit('log',logRecord(severity,body,attrs,options),options);
  }
  function logRecord(severity,body,attrs,options){
    const level=typeof severity==='string'?severity.toLowerCase():'info';
    const number=SEVERITY[level]??(Number.isInteger(severity)&&severity>=1&&severity<=24?severity:SEVERITY.info);
    const text=Object.keys(SEVERITY).find(k=>SEVERITY[k]===number)?.toUpperCase()??String(number);
    const ctx=parentOf(options.parent),t=nanos(options.time??now());
    return {timeUnixNano:t,observedTimeUnixNano:t,severityNumber:number,severityText:text,
      body:{stringValue:scrubTelemetryText(body,L.bodyChars)},attributes:telemetryAttributes(attrs),
      ...(ctx?{traceId:ctx.traceId,spanId:ctx.spanId}:{})};
  }
  function exception(error,attrs,options){
    if(!enabled())return;
    const details=exceptionAttributes(error);
    log('error',details['exception.message']||details['exception.type'],{...details,...attrs},options);
  }

  // ---- feedback correlation ----
  const tag=(list,reportId)=>{
    const keep=list.filter(x=>x.key!=='feedback.report.id'&&x.key!=='feedback.excerpt').slice(0,L.attributes-2);
    list.length=0;list.push(...keep,{key:'feedback.report.id',value:{stringValue:reportId}},{key:'feedback.excerpt',value:{boolValue:true}});
  };
  // Call after the report commits locally. Marks the moment, sends the excerpt only when the
  // user left diagnostics included, and flushes now instead of on the 60 s timer.
  function feedbackSubmitted({reportId,traceId,spanId,includeDiagnostics=true}={}){
    if(!enabled()||typeof reportId!=='string'||!REPORT_ID.test(reportId))return Promise.resolve(false);
    reportId=reportId.toLowerCase();
    const result={marker:true,excerpt:0};
    if(includeDiagnostics!==false){
      prune();
      const picked=ring.filter(e=>e.state==='local'||e.state==='queued');
      const replaced=new Set(picked);
      // A still-queued original is replaced by its tagged copy, so nothing goes out twice.
      queue=queue.filter(item=>{if(!replaced.has(item.entry))return true;queuedBytes-=item.size;return false;});
      for(const entry of picked){
        const record=structuredClone(entry.record);tag(record.attributes,reportId);
        enqueue(entry.signal,record,{entry});
        if(entry.state==='queued')result.excerpt++;else entry.state='local';
      }
    }
    const parent=/^[a-f0-9]{32}$/.test(traceId??'')&&/^[a-f0-9]{16}$/.test(spanId??'')?{traceId,spanId}:null;
    emit('log',logRecord('info','feedback.submitted',{'feedback.report.id':reportId},{parent}),{send:true});
    urgent=true;
    return flush().then(()=>result,()=>result);
  }

  // ---- metrics (delta temporality) ----
  function instrument(kind,metricName,{unit='',description=''}={}){
    // Metrics are continuous by nature and not part of the diagnostics excerpt.
    if(mode==='excerpt-only')return NOOP_INSTRUMENT;
    if(typeof metricName!=='string'||!METRIC_NAME.test(metricName))return NOOP_INSTRUMENT;
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
    if(kind==='counter')return Object.freeze({add(n,attrs){if(!live()||!Number.isFinite(n)||n<0)return;const s=seriesFor(attrs);if(s)s.value+=n;}});
    if(kind==='gauge')return Object.freeze({record(v,attrs){if(!live()||!Number.isFinite(v))return;const s=seriesFor(attrs);if(s)s.value=v;}});
    return Object.freeze({record(v,attrs){if(!live()||!Number.isFinite(v))return;seriesFor(attrs)?.histogram.record(v);}});
  }
  function collectMetrics(){
    const start=nanos(windowStart),end=now(),time=nanos(end);
    windowStart=end;
    for(const inst of instruments.values()){
      for(const s of inst.series.values()){
        const point={attributes:s.attributes,startTimeUnixNano:start,timeUnixNano:time};
        if(inst.kind==='histogram'){if(!s.histogram.count)continue;Object.assign(point,s.histogram.snapshot());}
        else point.asDouble=s.value;
        enqueue('metric',point,{metric:inst});
      }
      inst.series.clear();
    }
    seriesTotal=0;
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
    mark(batch,'inflight');
    return {batch,json,size};
  }
  function requeue(batch){
    queue=batch.concat(queue);mark(batch,'queued');
    for(const item of batch)queuedBytes+=item.size;
    evict();
  }
  function backoff(ms){
    blockedUntil=now()+ms;arm(blockedUntil);
  }
  async function post(json,token,keepalive){
    stats.requests++;
    const controller=new AbortController();requestAbort=controller;
    try{return await fetchImpl(url,{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',keepalive,
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:json,
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});}
    finally{if(requestAbort===controller)requestAbort=undefined;}
  }
  function flush({keepalive=false}={}){
    if(inflight)return inflight;
    if(!enabled()){if(!disposed&&!forbidden)clearAll();return Promise.resolve(false);}
    if(now()<blockedUntil)return Promise.resolve(false);
    const ticket=epoch;
    // Offline retries are memory-only and expire, even when the page stays open for days.
    const cutoff=now()-Math.max(1000,Number(maxQueueAgeMs)||300000);
    queue=queue.filter(item=>{if(item.at>=cutoff)return true;queuedBytes-=item.size;stats.dropped++;mark([item],'rejected');return false;});
    collectMetrics();
    clearTimer(timer);timer=undefined;timerAt=Infinity;
    if(!queue.length){return Promise.resolve(true);}
    const work=(async()=>{
      const {batch,json}=keepalive?take(Math.min(L.keepaliveBytes-6*1024,batchLimit),L.keepaliveBytes):take(batchLimit,L.bodyBytes);
      const settle=()=>{if(queue.length||seriesTotal)arm(Math.max(blockedUntil,windowStart+L.flushMs));};
      // Page hide: the game may stop access first, and awaiting storage risks unload. Reuse the
      // in-memory access token so the keepalive request starts synchronously.
      let token=keepalive?lastToken:undefined;
      if(!token){try{token=await access.getToken();}catch{token=undefined;}}
      if(token&&ticket===epoch)lastToken=token;
      if(ticket!==epoch)return false;
      if(!token){requeue(batch);backoff(Math.min(L.maxBackoffMs,5000*2**Math.min(failures++,7)));return false;}
      let response;
      try{
        response=await post(json,token,keepalive);
        if(response.status===401&&ticket===epoch){
          await response.body?.cancel?.();
          let fresh;try{fresh=await access.getToken();}catch{fresh=undefined;}
          if(ticket!==epoch)return false;
          if(fresh){lastToken=fresh;response=await post(json,fresh,keepalive);}
        }
      }catch{response=undefined;}
      if(ticket!==epoch)return false;
      const status=response?.status??0;
      await response?.body?.cancel?.().catch?.(()=>{});
      if(status>=200&&status<300){
        stats.sent+=batch.length;failures=0;mark(batch,'sent');
        // A feedback submit drains its marker and excerpt now rather than on the timer.
        if(urgent&&queue.length){arm(now());return true;}
        urgent=false;
        // After a 413 split keep the smaller batches until the backlog drains, then restore.
        if(splitting&&queue.length){arm(now());return true;}
        splitting=false;batchLimit=L.bodyBytes-8*1024;
        if(queue.length>=L.flushItems||queuedBytes>=L.flushBytes)arm(now());else settle();
        return true;
      }
      if(status===401){stats.dropped+=batch.length;mark(batch,'rejected');diag('unauthorized',{});backoff(Math.min(L.maxBackoffMs,5000*2**Math.min(failures++,7)));return false;}
      if(status===403){forbidden=true;stats.dropped+=batch.length;clearAll();diag('forbidden',{});return false;}
      if(status===413){
        if(batch.length>1){splitting=true;batchLimit=Math.max(1,Math.floor(batch.reduce((n,x)=>n+x.size,0)/2));requeue(batch);arm(now());}
        else{stats.dropped++;mark(batch,'rejected');settle();}
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
      stats.dropped+=batch.length;mark(batch,'rejected');settle();return false; // 400 and other 4xx: never retry
    })();
    const done=work.catch(()=>false).finally(()=>{if(inflight===done)inflight=undefined;});
    inflight=done;return done;
  }

  // ---- lifecycle and optional auto-instrumentation ----
  const hidden=()=>{if(document?.visibilityState==='hidden')void flush({keepalive:true});};
  const pagehide=()=>{void flush({keepalive:true});};
  document?.addEventListener?.('visibilitychange',hidden);
  window?.addEventListener?.('pagehide',pagehide);
  const onError=event=>exception(event?.error??event?.message??'Uncaught error',{'exception.escaped':true,'framebriar.source':'window.error'});
  const onRejection=event=>exception(event?.reason??'Unhandled rejection',{'exception.escaped':true,'framebriar.source':'unhandledrejection'});
  if(captureErrors){window?.addEventListener?.('error',onError);window?.addEventListener?.('unhandledrejection',onRejection);}
  // Opt-in console.error/console.warn capture: redacted like every log, one record per identical
  // message per 10 s (the next one reports how many were suppressed), at most 60 per minute.
  const consoleRestore=[];
  if(captureConsole&&consoleImpl){
    const seen=new Map();let minuteStart=now(),inMinute=0,inside=false;
    const capture=(level,args)=>{
      if(!enabled())return;
      const t=now(),body=args.map(consoleText).join(' ');
      const key=`${level}\0${scrubTelemetryText(body,256)}`,prior=seen.get(key);
      if(prior&&t-prior.at<L.consoleRepeatMs){prior.suppressed++;return;}
      if(t-minuteStart>=60000){minuteStart=t;inMinute=0;}
      if(inMinute>=L.consolePerMinute){diag('console-rate-limit',{});return;}
      inMinute++;
      seen.delete(key);seen.set(key,{at:t,suppressed:0});
      if(seen.size>256)seen.delete(seen.keys().next().value);
      const error=args.find(a=>a instanceof Error);
      log(level,body,{...(error?exceptionAttributes(error):{}),'console.method':level==='error'?'error':'warn',
        ...(prior?.suppressed?{'log.suppressed_count':prior.suppressed}:{})});
    };
    for(const [method,level] of [['error','error'],['warn','warn']]){
      const original=consoleImpl[method];
      if(typeof original!=='function')continue;
      const wrapped=function(...args){
        if(!inside){inside=true;try{capture(level,args);}catch{/* capture never breaks the app */}finally{inside=false;}}
        return original.apply(this,args);
      };
      consoleImpl[method]=wrapped;
      consoleRestore.push(()=>{if(consoleImpl[method]===wrapped)consoleImpl[method]=original;});
    }
  }
  let frameHandle=0,frameStop=false;
  if(frameTime&&requestFrame){
    const frames=instrument('histogram','framebriar.frame_time',{unit:'ms',description:'Mean frame time, sampled at most once per second'});
    let last,sampleStart,sum=0,n=0;
    const tick=t=>{
      if(frameStop)return;
      if(last!==undefined&&t>last){sum+=t-last;n++;}
      last=t;sampleStart??=t;
      if(t-sampleStart>=1000&&n){frames.record(sum/n);sum=0;n=0;sampleStart=t;}
      frameHandle=requestFrame(tick);
    };
    frameHandle=requestFrame(tick);
  }

  return Object.freeze({sessionId,mode,
    get enabled(){return enabled();},
    span,withSpan,log,exception,feedbackSubmitted,
    activeContext(){return stack.at(-1)?.context;},
    counter:(n,o)=>instrument('counter',n,o),
    gauge:(n,o)=>instrument('gauge',n,o),
    histogram:(n,o)=>instrument('histogram',n,o),
    flush:options=>flush(options),
    stats:()=>({...stats,buffered:queue.length,bufferedBytes:queuedBytes,series:seriesTotal,forbidden,blockedUntil,
      ring:{logs:ring.filter(e=>e.signal==='log').length,spans:ring.filter(e=>e.signal==='span').length}}),
    dispose(){
      if(disposed)return;
      frameStop=true;
      document?.removeEventListener?.('visibilitychange',hidden);
      window?.removeEventListener?.('pagehide',pagehide);
      window?.removeEventListener?.('error',onError);window?.removeEventListener?.('unhandledrejection',onRejection);
      for(const restore of consoleRestore)restore();
      unsubscribe?.();clearAll();disposed=true;
    },
  });
}
