// Durable local feedback queue for Node/Electron. Capacity matches the browser outbox: ten
// reports / 32 MiB of PNG bytes. Each report is committed by one directory rename and is
// immutable afterwards (report.json + media.png); only state.json (retry bookkeeping) changes.
// Nothing expires: a matching delivery receipt or an explicit clear() removes a report, and
// disconnecting access never purges the queue.
//
//   <dir>/reports/<uuid>/report.json   {v:1, report, queuedAt}
//   <dir>/reports/<uuid>/media.png     reviewed PNG (absent for text-only)
//   <dir>/reports/<uuid>/state.json    {attempts, nextAttemptAt, code}
import {mkdir,readdir,readFile,rm,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DAY,LIMITS,normalizeReport} from '../../src/protocol.mjs';
import {createFileLock,writeFileDurable,renameDurable,removeTree} from './files.mjs';
import {sendReport,sha256,isPng} from './transport.mjs';
import {unrefTimer} from './access.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminal=new Set(['conflict','invalid-input','invalid-media','permanent']);
const retryable=['access-required','quota','network','invalid-ack','unavailable','correlation-unsupported'];
const storageError=(code,message)=>Object.assign(Error(message),{code});

export function createOutbox({dir,access,appId=access?.gameId,gameId=appId,endpoint=access?.endpoint,getToken=()=>access?.getToken(),
  getAuthorization=()=>access?.getFeedbackAuthorization?.(),fetchImpl=(...a)=>fetch(...a),send=sendReport,now=()=>Date.now(),setTimer=unrefTimer,clearTimer=clearTimeout,random=Math.random,
  isOnline=()=>true,onReceipt=()=>{},onChange=()=>{},lock:lockOptions}={}){
  if(typeof dir!=='string'||!dir||!/^[a-z0-9-]{1,60}$/.test(gameId??''))throw Error('Invalid outbox configuration');
  const reportsDir=join(dir,'reports'),lock=createFileLock(join(dir,'outbox.lock'),lockOptions);
  let running=false,timer,inflight,controller,clearing=false,generation=0,prepared;
  let view=Object.freeze({state:'checking',items:0,bytes:0,maxItems:LIMITS.queueItems,maxBytes:LIMITS.queueBytes,blocked:0,correlationWaiting:0,retention:'until-delivered-or-cleared'});
  const listeners=new Set([onChange]),receiptListeners=new Set([onReceipt]);
  const safeReceipt=ack=>{for(const fn of receiptListeners)try{fn(ack);}catch{/* host callbacks cannot alter delivery */}};

  function ready(){
    // Recover from a crash mid-commit/removal: staging and trash dirs are never live reports.
    prepared??=(async()=>{
      await mkdir(reportsDir,{recursive:true,mode:0o700});
      for(const name of await readdir(dir))if(/^\.(staging|trash)-/.test(name))await rm(join(dir,name),{recursive:true,force:true});
      for(const name of await readdir(reportsDir))if(/^\.(staging|trash)-/.test(name))await rm(join(reportsDir,name),{recursive:true,force:true});
    })().catch(e=>{prepared=undefined;throw e;});
    return prepared;
  }
  async function readItem(id){
    const base=join(reportsDir,id);
    let report,queuedAt=0,invalid=false,bytes=0;
    try{
      const saved=JSON.parse(await readFile(join(base,'report.json'),'utf8'));
      report=normalizeReport(saved.report);queuedAt=Number.isFinite(saved.queuedAt)?saved.queuedAt:0;
      if(report.id!==id||JSON.stringify(report)!==JSON.stringify(saved.report))invalid=true;
    }catch{invalid=true;}
    try{bytes=(await stat(join(base,'media.png'))).size;}catch{bytes=0;}
    if(report&&(report.media===null?bytes!==0:bytes!==report.media.bytes))invalid=true;
    let state={attempts:0,nextAttemptAt:0};
    try{const s=JSON.parse(await readFile(join(base,'state.json'),'utf8'));
      state={attempts:Number.isInteger(s.attempts)?Math.max(0,Math.min(32,s.attempts)):0,nextAttemptAt:Number.isFinite(s.nextAttemptAt)?s.nextAttemptAt:0,
        ...(terminal.has(s.code)||retryable.includes(s.code)?{code:terminal.has(s.code)?'permanent':s.code}:{})};}catch{/* fresh */}
    // Corrupt or foreign records are kept for recovery but never delivered.
    if(invalid||report.gameId!==gameId)state={...state,code:'permanent'};
    return {id,report,queuedAt,bytes,...state};
  }
  async function all(){
    await ready();
    const ids=(await readdir(reportsDir)).filter(n=>UUID.test(n));
    const rows=await Promise.all(ids.map(readItem));
    return rows.sort((a,b)=>a.queuedAt-b.queuedAt||a.id.localeCompare(b.id));
  }
  async function changed(){
    try{const rows=await all();view=Object.freeze({state:'available',items:rows.length,bytes:rows.reduce((n,x)=>n+x.bytes,0),
      maxItems:LIMITS.queueItems,maxBytes:LIMITS.queueBytes,blocked:rows.filter(x=>x.code==='permanent').length,
      correlationWaiting:rows.filter(x=>x.report?.incident&&access?.status?.().feedbackCorrelationVersion!==1).length,retention:'until-delivered-or-cleared'});}
    catch{view=Object.freeze({...view,state:'storage-unavailable'});}
    for(const fn of listeners)try{fn(view);}catch{}
    return view;
  }
  const defer=(id,state)=>lock.run(async()=>{
    try{await stat(join(reportsDir,id));}catch{return;} // delivered or cleared meanwhile
    await writeFileDurable(join(reportsDir,id,'state.json'),JSON.stringify(state));
  });
  const remove=id=>lock.run(()=>removeTree(join(reportsDir,id),dir));

  async function schedule(){
    clearTimer(timer);timer=undefined;if(!running)return;
    try{
      const rows=(await all()).filter(x=>x.code!=='permanent');await changed();
      if(!running||!rows.length)return;
      const at=Math.min(...rows.map(x=>x.nextAttemptAt||0));
      timer=setTimer(()=>{void wake();},Math.max(isOnline()?1000:60000,at-now()));
    }catch{if(running)timer=setTimer(()=>{void wake();},60000);}
  }
  async function drain(ticket){
    if(!isOnline()||typeof endpoint!=='string')return;
    for(const item of await all()){
      if(!running||ticket!==generation)return;
      if(item.code==='permanent'||((item.nextAttemptAt||0)>now()&&
        !(item.code==='correlation-unsupported'&&access?.status?.().feedbackCorrelationVersion===1)))continue;
      const abort=new AbortController();controller=abort;
      try{
        let authorization;
        if(item.report.incident){
          authorization=await getAuthorization();
          if(!running||ticket!==generation)return;
          if(authorization?.feedbackCorrelationVersion!==1||typeof authorization.token!=='string')
            throw Object.assign(Error('Incident service support required'),{code:'correlation-unsupported'});
        }
        const png=item.report.media===null?null:await readFile(join(reportsDir,item.id,'media.png'));
        const ack=await send({report:item.report,png,endpoint,getToken,getAuthorization:()=>authorization,fetchImpl,signal:abort.signal});
        if(!running||ticket!==generation)return;
        if(ack?.id!==item.id||ack.gameId!==gameId||!['ready','processed'].includes(ack.status))throw Object.assign(Error(),{code:'invalid-ack'});
        await remove(item.id);safeReceipt(Object.freeze({id:ack.id,gameId,status:ack.status}));
      }catch(e){
        if(!running||ticket!==generation)return;
        const code=typeof e?.code==='string'?e.code:'network';
        // Capability hold is not a failed upload. Keep the reviewed report byte-for-byte,
        // do not consume attempts, and avoid a tight polling loop while ordinary work flows.
        if(code==='correlation-unsupported'){
          await defer(item.id,{attempts:item.attempts||0,code,nextAttemptAt:now()+300000}).catch(()=>{});
          continue;
        }
        const attempts=Math.min(32,(item.attempts||0)+1);
        const backoff=Math.min(300000,2000*2**Math.min(attempts,8))+Math.floor(random()*1000);
        // Access may refresh/reconnect later; never mint new access here.
        const delay=code==='access-required'?300000:Math.max(backoff,e?.retryAfterMs||0,code==='quota'?60000:0);
        await defer(item.id,{attempts,code:terminal.has(code)?'permanent':retryable.includes(code)?code:'network',
          nextAttemptAt:terminal.has(code)?0:now()+Math.min(delay,DAY)}).catch(()=>{});
      }finally{if(controller===abort)controller=undefined;}
    }
  }
  function wake(){
    clearTimer(timer);timer=undefined;if(!running)return Promise.resolve();
    if(inflight)return inflight;
    const ticket=generation;
    const work=drain(ticket).catch(()=>{/* persistence failure retains work; never claim delivery */});
    const result=work.finally(async()=>{if(inflight===result)inflight=undefined;await schedule();});
    inflight=result;return result;
  }
  // Resume on a successful (re)connection without bypassing persisted backoff.
  const unsubscribe=access?.subscribe?.(v=>{if(v?.state==='connected'&&running)void wake();});
  function stop(){running=false;generation++;clearTimer(timer);timer=undefined;controller?.abort();controller=undefined;}

  return Object.freeze({dir,gameId,
    status:()=>view,
    subscribe(fn){listeners.add(fn);try{fn(view);}catch{}return()=>listeners.delete(fn);},
    onReceipt(fn){receiptListeners.add(fn);return()=>receiptListeners.delete(fn);},
    list:async()=>(await all()).map(({id,report,queuedAt,bytes,attempts,nextAttemptAt,code})=>({id,gameId:report?.gameId??null,queuedAt,bytes,attempts,nextAttemptAt,code:code??null})),
    // Resolves only after the report is durably committed; then delivery is the worker's job.
    async enqueue({report,png=null}){
      if(clearing)throw storageError('storage-unavailable','Local storage is being cleared');
      const frozen=normalizeReport(structuredClone(report));
      if(frozen.gameId!==gameId||(frozen.media===null?png!==null:!(isPng(png)&&png.length===frozen.media.bytes&&frozen.media.type==='image/png'&&png.length<=LIMITS.media)))
        throw storageError('invalid-input','Invalid reviewed feedback');
      if(frozen.media!==null&&frozen.media.sha256!==sha256(png))throw storageError('invalid-input','Reviewed feedback hash mismatch');
      await ready();
      try{
        await lock.run(async()=>{
          const rows=await all(),existing=rows.find(x=>x.id===frozen.id);
          if(existing){if(JSON.stringify(existing.report)!==JSON.stringify(frozen))throw storageError('conflict','Local feedback identity conflict');return;}
          if(rows.length>=LIMITS.queueItems||rows.reduce((n,x)=>n+x.bytes,0)+(png?.length??0)>LIMITS.queueBytes)
            throw storageError('storage-full','Local feedback storage is full');
          const staging=join(reportsDir,`.staging-${randomUUID()}`);
          await mkdir(staging,{mode:0o700});
          try{
            if(png)await writeFileDurable(join(staging,'media.png'),png);
            await writeFileDurable(join(staging,'report.json'),JSON.stringify({v:1,report:frozen,queuedAt:now()}));
            await renameDurable(staging,join(reportsDir,frozen.id));
          }catch(e){await rm(staging,{recursive:true,force:true}).catch(()=>{});throw e;}
        });
      }catch(e){void changed();throw typeof e?.code==='string'&&['conflict','storage-full','invalid-input'].includes(e.code)?e:storageError('storage-unavailable','Local feedback storage is unavailable');}
      void changed();
      if(running)void wake();
      return Object.freeze({id:frozen.id,gameId,status:'saved-local',sent:false});
    },
    // Delivery continues in the background; await flush() to wait for the current attempt.
    async start(){if(clearing)return view;if(!running){running=true;generation++;}const v=await changed();void wake();return v;},
    resume:()=>wake(),
    // Waits for any in-flight delivery attempt to settle.
    async flush(){if(inflight)await inflight;},
    stop,
    // Explicit storage API, never a side effect of disconnect.
    async clear(){
      stop();clearing=true;
      try{await inflight;await ready();await lock.run(async()=>{for(const n of await readdir(reportsDir))if(UUID.test(n))await removeTree(join(reportsDir,n),dir);});return await changed();}
      finally{clearing=false;}
    },
    dispose(){stop();unsubscribe?.();listeners.clear();receiptListeners.clear();},
  });
}
