// Durable local feedback queue for Node/Electron. Capacity matches the browser outbox: ten
// reports / 32 MiB of PNG bytes. Each report is committed by one directory rename and is
// immutable afterwards (report.json + media.png); only state.json (retry bookkeeping) changes.
// Nothing expires: a matching delivery receipt or an explicit clear() removes a report, and
// disconnecting access never purges the queue.
//
// Each report is bound to the enrollment it was saved under. Only reports bound to the current
// enrollment are sent. Others are held: never sent, never removed, no retries spent and no token
// taken, until the host calls releaseHeldReports() or a clear (docs/general-feedback-v2.md).
//
//   <dir>/reports/<uuid>/report.json   {v:1, report, queuedAt}
//   <dir>/reports/<uuid>/media.png     reviewed PNG (absent for text-only)
//   <dir>/reports/<uuid>/state.json    {attempts, nextAttemptAt, code}. Absent means fresh. Present but
//                                      unreadable may hide a fence, so the report is held meanwhile.
//   <dir>/reports/<uuid>/binding.json  {enrollmentRef}: a ref, or 'unbound'. Absent means saved by
//                                      an older SDK; settled once on load. Never sent to the service.
import {mkdir,readdir,readFile,stat} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {DAY,LIMITS,normalizeReport} from '../../src/protocol.mjs';
import {createFileLock,durableFiles,LOCK_LIMITS} from './files.mjs';
import {sendReport,sha256,isPng} from './transport.mjs';
import {unrefTimer} from './access.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminal=new Set(['conflict','invalid-input','invalid-media','permanent']);
const retryable=['access-required','quota','network','invalid-ack','unavailable','correlation-unsupported'];
const UNBOUND='unbound';
const REF=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Changes with the current enrollment or the set of held reports; can't be reversed to the ref.
const heldToken=(label,ref,held)=>createHash('sha256').update([label,ref,...held.map(x=>x.id).sort()].join('\n')).digest('hex');
const releaseTokenFor=(ref,held)=>heldToken('framebriar-release-v1',ref,held);
// Exists while unenrolled too, when releaseToken is null. Neither works in place of the other.
const clearTokenFor=(ref,held)=>heldToken('framebriar-clear-v1',ref,held);
const storageError=(code,message)=>Object.assign(Error(message),{code});
const STATUS_WAIT_MS=1000,UNREADABLE_FIRST_MS=5000,UNREADABLE_MAX_MS=60000;
const backoffFor=(attempts,random)=>Math.min(300000,2000*2**Math.min(attempts,8))+Math.floor(random()*1000);

export function createOutbox({dir,access,appId=access?.gameId,gameId=appId,endpoint=access?.endpoint,fetchImpl=(...a)=>fetch(...a),send=sendReport,now=()=>Date.now(),setTimer=unrefTimer,clearTimer=clearTimeout,random=Math.random,
  isOnline=()=>true,onReceipt=()=>{},onChange=()=>{},lock:lockOptions,files=durableFiles}={}){
  if(typeof dir!=='string'||!dir||!/^[a-z0-9-]{1,60}$/.test(gameId??'')||typeof access?.enrollmentState!=='function'||typeof access.getTokenFor!=='function')throw Error('Invalid outbox configuration');
  const {writeFileDurable,renameDurable,removeTree,removeDir}=files;
  const reportsDir=join(dir,'reports'),lock=createFileLock(join(dir,'outbox.lock'),lockOptions);
  let running=false,timer,inflight,controller,clearing=false,generation=0,prepared;
  let view=Object.freeze({state:'checking',items:0,bytes:0,maxItems:LIMITS.queueItems,maxBytes:LIMITS.queueBytes,blocked:0,correlationWaiting:0,heldForEnrollment:0,heldBytes:0,releaseToken:null,clearToken:null,retention:'until-delivered-or-cleared'});
  const listeners=new Set([onChange]),receiptListeners=new Set([onReceipt]);
  // Retry bookkeeping state.json refused. It holds for this process, or a stuck file would mean a
  // POST on every pass. A restart forgets it and retries once, which the service answers idempotently.
  const unsaved=new Map(),withUnsaved=x=>({...x,...unsaved.get(x.id)});
  // Acks for delivered reports whose removal failed. Only the removal is left, which needs no service,
  // token or enrollment, so this process doesn't POST them again. A restart forgets this and POSTs
  // once, which the service answers idempotently while it still has the record.
  const delivered=new Map();
  // A delivered row is never offered for release or held clear, whatever its fence says. Status, release
  // and clear all use this, so their tokens agree.
  const heldIn=(rows,ref)=>rows.filter(x=>!delivered.has(x.id)&&isHeld(x,ref));
  let unreadableWait=UNREADABLE_FIRST_MS;
  const safeReceipt=ack=>{for(const fn of receiptListeners)try{fn(ack);}catch{/* host callbacks cannot alter delivery */}};
  const receipt=ack=>safeReceipt(Object.freeze({id:ack.id,gameId,status:ack.status}));

  function ready(){
    // Recover from a crash mid-commit/removal: staging and trash dirs are never live reports, so one
    // that can't be deleted yet waits for the next start and doesn't take the queue down with it.
    prepared??=(async()=>{
      await mkdir(reportsDir,{recursive:true,mode:0o700});
      // This runs outside the lock, and another process's enqueue may be filling a young staging dir.
      // It holds the lock meanwhile, so one older than staleMs is dead. Deleting a trash dir twice is harmless.
      const staleMs=lockOptions?.limits?.staleMs??LOCK_LIMITS.staleMs;
      const dead=path=>stat(path).then(x=>Date.now()-x.mtimeMs>staleMs,()=>false);
      for(const base of [dir,reportsDir])for(const name of await readdir(base)){
        if(name.startsWith('.trash-')||(name.startsWith('.staging-')&&await dead(join(base,name))))await removeDir(join(base,name)).catch(()=>{});
      }
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
    const s=await readState(id);
    if(s)state={attempts:Number.isInteger(s.attempts)?Math.max(0,Math.min(32,s.attempts)):0,nextAttemptAt:Number.isFinite(s.nextAttemptAt)?s.nextAttemptAt:0,
      ...(terminal.has(s.code)||retryable.includes(s.code)?{code:terminal.has(s.code)?'permanent':s.code}:{}),...(s.held===true?{held:true}:{})};
    // Corrupt or foreign records are kept for recovery but never delivered.
    if(invalid||report.gameId!==gameId)state={...state,code:'permanent'};
    else if(!s)state={...state,held:true,unreadable:true};
    return {id,report,queuedAt,bytes,enrollmentRef:await readBinding(id),...state};
  }
  // {} when there's no file. null when one is present but can't be read or understood: it may hold
  // a fence, so the report stays held until a read succeeds or a release rewrites it. Fails closed.
  async function readState(id){
    let raw;
    try{raw=await readFile(join(reportsDir,id,'state.json'),'utf8');}catch(e){return e?.code==='ENOENT'?{}:null;}
    try{const s=JSON.parse(raw);return s!==null&&typeof s==='object'&&!Array.isArray(s)?s:null;}catch{return null;}
  }
  // undefined: no binding yet (older SDK). An unreadable binding can only ever be held.
  async function readBinding(id){
    let raw;
    try{raw=await readFile(join(reportsDir,id,'binding.json'),'utf8');}
    catch(e){return e?.code==='ENOENT'?undefined:UNBOUND;}
    try{const ref=JSON.parse(raw).enrollmentRef;return REF.test(ref)?ref:UNBOUND;}catch{return UNBOUND;}
  }
  const fenceAbsent=async id=>{const s=await readState(id);return !!s&&s.held!==true;};
  const writeBinding=(id,ref,base=join(reportsDir,id))=>writeFileDurable(join(base,'binding.json'),JSON.stringify({enrollmentRef:ref}));
  // null when storage can't say; nothing is sent, bound or released on an unknown enrollment.
  const enrollmentNow=async()=>{try{return await access.enrollmentState();}catch{return null;}};
  // A fenced report (held:true) stays held until released, whatever its binding says.
  const isHeld=(x,ref)=>!!x.report&&(x.held===true||(x.code!=='permanent'&&x.enrollmentRef!==ref));
  // Reports from an older SDK can't be told apart: bind them once to the enrollment present now,
  // or persist 'unbound' so a later enrollment can never claim them. Then fence held reports with
  // the permanent code, which older SDKs skip and keep, so a downgrade can't send them under its
  // token. held:true tells this code the difference from a real rejection. Attempts are unchanged.
  // reread: state came from before the lock, and waiting for it can outlast that enrollment. A fence
  // written against an old ref would hold a report saved since. enqueue checks its ref under this
  // lock, so a read made here is at least as new as any report this pass can see.
  async function settle(given,locked=false,reread=false){
    if(!given)return;
    const needed=(x,state)=>x.report&&(x.enrollmentRef===undefined||(x.held!==true&&isHeld(x,state.enrollmentRef)));
    if(!(await all()).some(x=>needed(x,given)))return;
    const work=async()=>{
      const state=reread?await enrollmentNow():given;if(!state)return;
      const legacyRef=state.active&&state.enrollmentRef?state.enrollmentRef:UNBOUND;
      for(const x of await all()){
        if(!needed(x,state))continue;
        try{
          if(x.enrollmentRef===undefined){await writeBinding(x.id,legacyRef);x.enrollmentRef=legacyRef;}
          if(x.held!==true&&isHeld(x,state.enrollmentRef))await writeFileDurable(join(reportsDir,x.id,'state.json'),JSON.stringify({attempts:x.attempts||0,nextAttemptAt:0,code:'permanent',held:true}));
        }catch{/* retried on the next pass; an unfenced held report still isn't sent by this code */}
      }
    };
    await (locked?work():lock.run(work)).catch(()=>{});
  }
  async function all(){
    await ready();
    const ids=(await readdir(reportsDir)).filter(n=>UUID.test(n));
    const rows=await Promise.all(ids.map(readItem));
    return rows.sort((a,b)=>a.queuedAt-b.queuedAt||a.id.localeCompare(b.id));
  }
  // Runs overlap, and one can read older state yet finish later. Only the latest started publishes.
  // An earlier run waits for that one and resolves with its view, so it can wait as long as that run
  // does. Anything with a result to return uses statusSoon.
  let statusRuns=0,latestStatus;
  function changed(){
    const run=++statusRuns;
    return latestStatus=(async()=>{
      const next=await readView();
      if(run!==statusRuns)return latestStatus;
      view=next;
      for(const fn of listeners)try{fn(view);}catch{}
      return view;
    })();
  }
  // A result that has committed returns after this at most, with whatever view is current. The status
  // run carries on and publishes when it can, so a stalled enrollment read can't hold the result back.
  // The timer stays referenced: it's short and cleared when done, and with nothing else alive it's what
  // keeps a headless host's process running to get the result.
  function statusSoon(){
    const run=changed();let timeout;
    return Promise.race([run,new Promise(r=>{timeout=setTimeout(()=>r(view),STATUS_WAIT_MS);})]).finally(()=>clearTimeout(timeout));
  }
  async function readView(){
    try{const enrollment=await enrollmentNow();await settle(enrollment,false,true);
      const rows=await all(),ref=enrollment?.enrollmentRef??null,held=enrollment?heldIn(rows,ref):null;
      return Object.freeze({state:'available',items:rows.length,bytes:rows.reduce((n,x)=>n+x.bytes,0),
      maxItems:LIMITS.queueItems,maxBytes:LIMITS.queueBytes,blocked:rows.map(withUnsaved).filter(x=>x.code==='permanent'&&x.held!==true).length,
      correlationWaiting:rows.filter(x=>x.report?.incident&&!(held?.includes(x))&&access?.status?.().feedbackCorrelationVersion!==1).length,
      heldForEnrollment:held?held.length:view.heldForEnrollment,heldBytes:held?held.reduce((n,x)=>n+x.bytes,0):view.heldBytes,
      releaseToken:held?.length&&enrollment.active?releaseTokenFor(ref,held):null,clearToken:held?.length?clearTokenFor(ref,held):null,retention:'until-delivered-or-cleared'});}
    catch{return Object.freeze({...view,state:'storage-unavailable'});}
  }
  const defer=(id,state)=>lock.run(async()=>{
    try{await stat(join(reportsDir,id));}catch{return;} // delivered or cleared meanwhile
    await writeFileDurable(join(reportsDir,id,'state.json'),JSON.stringify(state));
  });
  const deferred=(id,state)=>defer(id,state).then(()=>{unsaved.delete(id);},()=>{unsaved.set(id,state);});
  // removeTree commits with its rename. If only deleting the moved copy failed, the report is removed,
  // and the next start sweeps the leftover.
  const removeRow=async id=>{
    try{await removeTree(join(reportsDir,id),dir);}
    catch(e){if(await stat(join(reportsDir,id)).then(()=>true,x=>x?.code!=='ENOENT'))throw e;}
    const ack=delivered.get(id);
    unsaved.delete(id);delivered.delete(id);
    if(ack)receipt(ack);
  };
  const remove=id=>lock.run(()=>removeRow(id));

  async function schedule(){
    clearTimer(timer);timer=undefined;if(!running)return;
    try{
      const enrollment=await enrollmentNow();
      const current=(await all()).map(withUnsaved),rows=current.filter(x=>delivered.has(x.id)||(x.code!=='permanent'&&(!enrollment||!isHeld(x,enrollment.enrollmentRef))));await statusSoon();
      if(!running)return;
      // A row held only because its state couldn't be read may be fine by the next look, with
      // nothing else due to prompt one. It needs no network, so it doesn't wait for online either.
      let look=Infinity;
      if(current.some(x=>x.unreadable)){look=unreadableWait;unreadableWait=Math.min(UNREADABLE_MAX_MS,unreadableWait*2);}
      else unreadableWait=UNREADABLE_FIRST_MS;
      if(!rows.length&&look===Infinity)return;
      const due=rows.length?Math.max(isOnline()?1000:60000,Math.min(...rows.map(x=>x.nextAttemptAt||0))-now()):Infinity;
      timer=setTimer(()=>{void wake();},Math.min(due,look));
    }catch{if(running)timer=setTimer(()=>{void wake();},60000);}
  }
  async function drain(ticket){
    if(!isOnline()||typeof endpoint!=='string')return;
    await settle(await enrollmentNow(),false,true);
    const rows=(await all()).map(withUnsaved);
    // Delivered here, then removed by another process: the receipt is still owed.
    for(const [id,ack] of [...delivered])if(!rows.some(x=>x.id===id)){unsaved.delete(id);delivered.delete(id);receipt(ack);}
    for(const item of rows){
      if(!running||ticket!==generation)return;
      const confirmed=delivered.get(item.id);
      if((!confirmed&&(item.held===true||item.code==='permanent'))||((item.nextAttemptAt||0)>now()&&
        !(item.code==='correlation-unsupported'&&access?.status?.().feedbackCorrelationVersion===1)))continue;
      if(!confirmed){
        // Before any token. getTokenFor then refuses if the enrollment moved after this check.
        const enrollment=await enrollmentNow();if(!running||ticket!==generation||!enrollment)return;
        if(item.enrollmentRef!==enrollment.enrollmentRef)continue;
      }
      const abort=new AbortController();controller=abort;
      const getToken=()=>access.getTokenFor(item.enrollmentRef);
      try{
        let ack=confirmed;
        if(!ack){
          let authorization;
          if(item.report.incident){
            authorization=await access.getFeedbackAuthorization?.(item.enrollmentRef);
            if(!running||ticket!==generation)return;
            if(authorization?.feedbackCorrelationVersion!==1||typeof authorization.token!=='string')
              throw Object.assign(Error('Incident service support required'),{code:'correlation-unsupported'});
          }
          const png=item.report.media===null?null:await readFile(join(reportsDir,item.id,'media.png'));
          ack=await send({report:item.report,png,endpoint,getToken,getAuthorization:()=>authorization,fetchImpl,signal:abort.signal});
          if(!running||ticket!==generation)return;
          if(ack?.id!==item.id||ack.gameId!==gameId||!['ready','processed'].includes(ack.status))throw Object.assign(Error(),{code:'invalid-ack'});
          delivered.set(item.id,ack);
        }
        await remove(item.id);
      }catch(e){
        if(!running||ticket!==generation)return;
        // Delivered, and only the removal failed. Its backoff stays in memory with the ack, so a fence
        // on disk is left alone and still applies if a restart forgets the delivery.
        if(delivered.has(item.id)){
          const attempts=Math.min(32,(item.attempts||0)+1);
          unsaved.set(item.id,{attempts,nextAttemptAt:now()+backoffFor(attempts,random)});
          continue;
        }
        // The enrollment moved during this attempt: the report is held now. No retry is spent,
        // and only state.json would change here, so the attempt can't rebind or lose it.
        if((await enrollmentNow())?.enrollmentRef!==item.enrollmentRef)continue;
        const code=typeof e?.code==='string'?e.code:'network';
        // Capability hold is not a failed upload. Keep the reviewed report byte-for-byte,
        // do not consume attempts, and avoid a tight polling loop while ordinary work flows.
        if(code==='correlation-unsupported'){
          await deferred(item.id,{attempts:item.attempts||0,code,nextAttemptAt:now()+300000});
          continue;
        }
        const attempts=Math.min(32,(item.attempts||0)+1);
        const backoff=backoffFor(attempts,random);
        // Access may refresh/reconnect later; never mint new access here.
        const delay=code==='access-required'?300000:Math.max(backoff,e?.retryAfterMs||0,code==='quota'?60000:0);
        await deferred(item.id,{attempts,code:terminal.has(code)?'permanent':retryable.includes(code)?code:'network',
          nextAttemptAt:terminal.has(code)?0:now()+Math.min(delay,DAY)});
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
  // Fence during the change itself, before the new token can be used. 'unbound' for anything still
  // legacy here: a report first seen during a change never belonged to the new enrollment.
  const unhook=access.onEnrollmentChange?.(({enrollmentRef})=>settle({enrollmentRef,active:false}));
  const unsubscribe=access?.subscribe?.(v=>{if(v?.state==='connected'&&running)void wake();if(['connected','disconnected','expired','access-required','connection-uncertain','enrollment-response-rejected'].includes(v?.state))void changed();});
  function stop(){running=false;generation++;clearTimer(timer);timer=undefined;controller?.abort();controller=undefined;}

  return Object.freeze({dir,gameId,
    status:()=>view,
    subscribe(fn){listeners.add(fn);try{fn(view);}catch{}return()=>listeners.delete(fn);},
    onReceipt(fn){receiptListeners.add(fn);return()=>receiptListeners.delete(fn);},
    list:async()=>(await all()).map(withUnsaved).map(({id,report,queuedAt,bytes,attempts,nextAttemptAt,code})=>({id,gameId:report?.gameId??null,queuedAt,bytes,attempts,nextAttemptAt,code:code??null})),
    // Resolves only after the report is durably committed; then delivery is the worker's job.
    // enrollmentRef: the ref recorded when this report was opened. A different or missing ref
    // saves nothing and rejects with code 'enrollment-changed'; that prepared object is dead.
    async enqueue({report,png=null,enrollmentRef}){
      if(clearing)throw storageError('storage-unavailable','Local storage is being cleared');
      const frozen=normalizeReport(structuredClone(report));
      if(frozen.gameId!==gameId||(frozen.media===null?png!==null:!(isPng(png)&&png.length===frozen.media.bytes&&frozen.media.type==='image/png'&&png.length<=LIMITS.media)))
        throw storageError('invalid-input','Invalid reviewed feedback');
      if(frozen.media!==null&&frozen.media.sha256!==sha256(png))throw storageError('invalid-input','Reviewed feedback hash mismatch');
      await ready();
      try{
        await lock.run(async()=>{
          const enrollment=await access.enrollmentState();
          if(typeof enrollmentRef!=='string'||enrollmentRef!==enrollment.enrollmentRef)throw storageError('enrollment-changed','The enrollment changed after this report was prepared');
          const rows=await all(),existing=rows.find(x=>x.id===frozen.id);
          if(existing){if(JSON.stringify(existing.report)!==JSON.stringify(frozen))throw storageError('conflict','Local feedback identity conflict');return;}
          if(rows.length>=LIMITS.queueItems||rows.reduce((n,x)=>n+x.bytes,0)+(png?.length??0)>LIMITS.queueBytes)
            throw storageError('storage-full','Local feedback storage is full');
          const staging=join(reportsDir,`.staging-${randomUUID()}`);
          await mkdir(staging,{mode:0o700});
          try{
            if(png)await writeFileDurable(join(staging,'media.png'),png);
            await writeFileDurable(join(staging,'report.json'),JSON.stringify({v:1,report:frozen,queuedAt:now()}));
            await writeBinding(frozen.id,enrollmentRef,staging);
            await renameDurable(staging,join(reportsDir,frozen.id));
          }catch(e){await removeDir(staging).catch(()=>{});throw e;}
        });
      }catch(e){void changed();throw typeof e?.code==='string'&&['conflict','storage-full','invalid-input','enrollment-changed'].includes(e.code)?e:storageError('storage-unavailable','Local feedback storage is unavailable');}
      void changed();
      if(running)void wake();
      return Object.freeze({id:frozen.id,gameId,status:'saved-local',sent:false});
    },
    // Delivery continues in the background; await flush() to wait for the current attempt.
    async start(){if(clearing)return view;if(!running){running=true;generation++;}const v=await statusSoon();void wake();return v;},
    resume:()=>wake(),
    // Waits for any in-flight delivery attempt to settle.
    async flush(){if(inflight)await inflight;},
    stop,
    // The only way a held report gets a new enrollment. Pass the releaseToken from the status the
    // user saw: if the enrollment or the held set has changed since, nothing rebinds. Each report
    // rebinds durably or stays held. Rebinding doesn't change report bytes, and delivery follows
    // asynchronously, so released doesn't mean delivered.
    async releaseHeldReports({releaseToken}={}){
      let result;
      try{
        result=await lock.run(async()=>{
          const enrollment=await access.enrollmentState();
          await settle(enrollment,true);
          const rows=await all(),ref=enrollment.enrollmentRef,held=heldIn(rows,ref);
          if(!enrollment.active||!ref)return {released:0,remaining:held.length,failed:0,code:'not-enrolled'};
          if(!held.length||releaseToken!==releaseTokenFor(ref,held))return {released:0,remaining:held.length,failed:0,code:'stale-release'};
          let released=0,failed=0;
          for(const item of held){
            // Rebind first: if the crash comes between these, the report stays fenced and held.
            // The fence lifts only with its binding on the enrollment the user released to.
            try{
              await writeBinding(item.id,ref);
              await writeFileDurable(join(reportsDir,item.id,'state.json'),JSON.stringify({attempts:item.attempts||0,nextAttemptAt:0}));
              unsaved.delete(item.id);
              released++;
            }catch{
              // Unfenced, the binding alone decides: once it's on this enrollment the report is
              // released, and a release means now, so old backoff is dropped for this process. A fence,
              // or a state file that might hold one, still holds it.
              if(await fenceAbsent(item.id)&&await readBinding(item.id)===ref){unsaved.set(item.id,{attempts:item.attempts||0,code:undefined,nextAttemptAt:0});released++;}
              else failed++;
            }
          }
          return {released,remaining:held.length-released,failed};
        });
      }catch{return Object.freeze({released:0,remaining:view.heldForEnrollment,failed:0,code:'storage-unavailable'});}
      await statusSoon();
      if(running&&result.released)void wake();
      return Object.freeze(result);
    },
    // Discards held reports only, and only the ones the user confirmed. Pass the clearToken from the
    // status they saw: if the enrollment or the held set has changed since, nothing is removed and
    // status carries the new count and token, so the host can ask again. The check and the removal
    // share the file lock, so another process can't change the rows between them. Never takes an
    // access token or sends, so it works while unenrolled.
    async clearHeldReports({clearToken}={}){
      let result;
      try{
        result=await lock.run(async()=>{
          const enrollment=await access.enrollmentState();
          await settle(enrollment,true);
          const ref=enrollment.enrollmentRef,held=heldIn(await all(),ref);
          if(!held.length||clearToken!==clearTokenFor(ref,held))return {cleared:0,remaining:held.length,failed:0,code:'stale-release'};
          let cleared=0,failed=0;
          for(const item of held){try{await removeRow(item.id);cleared++;}catch{failed++;}}
          return {cleared,remaining:held.length-cleared,failed};
        });
      }catch{return Object.freeze({cleared:0,remaining:view.heldForEnrollment,failed:0,code:'storage-unavailable'});}
      await statusSoon();
      return Object.freeze(result);
    },
    // Explicit storage API, never a side effect of disconnect. Discards everything, held or not.
    async clear(){
      stop();clearing=true;
      try{
        await inflight;await ready();let failure;
        await lock.run(async()=>{for(const n of await readdir(reportsDir))if(UUID.test(n))try{await removeRow(n);}catch(e){failure??=e;}});
        const v=await statusSoon();if(failure)throw failure;return v;
      }
      finally{clearing=false;}
    },
    dispose(){stop();unhook?.();unsubscribe?.();listeners.clear();receiptListeners.clear();},
  });
}
