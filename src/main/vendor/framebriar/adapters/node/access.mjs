// Enrollment controller for Node/Electron main processes: a port of
// adapters/browser/playtest-access.mjs onto the secure store (secure-store.mjs).
// v2 contract (docs/general-feedback-v2.md): explicit single redemption that never
// auto-retries, persisted 'connection-uncertain' marker, coalesced refresh, a 30-day family
// with one-hour upload tokens, and persistent notices until replacement or explicit clear.
// Requests carry no Origin header; the service accepts originless clients.
import {randomBytes} from 'node:crypto';
export const FRAMEBRIAR_ENDPOINT='https://framebriar-masra91-poc.azurewebsites.net/api';
const HOUR=3600000,MONTH=30*86400000;
const token=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{43}$/.test(x);
const fault=kind=>Object.assign(new Error('Framebriar access unavailable'),{kind});
export const unrefTimer=(fn,ms)=>{const t=setTimeout(fn,ms);t.unref?.();return t;};

export function validEndpoint(endpoint){
  try{
    const u=new URL(endpoint);
    if(u.username||u.password||u.search||u.hash||endpoint.endsWith('/'))return false;
    return u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname));
  }catch{return false;}
}
const iso=v=>{const t=Date.parse(v);return Number.isFinite(t)?new Date(t).toISOString():null;};
const noticeOf=n=>n?{state:n.state,expiresAt:n.expiresAt?iso(n.expiresAt):null,enrolled:n.enrolled!==false}:null;

// Cold starts of a scaled-to-zero service can take well over 10 s, so allow 45 s per access call.
export const ACCESS_TIMEOUT_MS=45000;
export function createAccess({accessTimeoutMs=ACCESS_TIMEOUT_MS,retryDelay=ms=>new Promise(r=>setTimeout(r,ms)),endpoint=FRAMEBRIAR_ENDPOINT,appId,gameId=appId,buildSha=null,store,
  fetchImpl=(...a)=>fetch(...a),now=()=>Date.now(),setTimer=unrefTimer,clearTimer=clearTimeout,onChange=()=>{}}={}){
  let lastAttempt; // {invitation, attemptId, at}: in memory only, reused when the user retries the same invite
  if(!validEndpoint(endpoint)||!/^[a-z0-9-]{1,60}$/.test(gameId??'')||(buildSha!==null&&!/^[a-f0-9]{7,40}$/.test(buildSha)))throw Error('Invalid Framebriar access scope');
  if(typeof store?.read!=='function'||typeof store.replace!=='function')throw Error('Framebriar access requires a secure store');
  let running=false,disposed=false,generation=0,revision=null,session,timer,controller,inflight,operation,failures=0;
  let notice=null,optedIn=false,writes=0;
  let view=Object.freeze({state:'disconnected',connected:false,enrolled:false,canCapture:false,notice:null,expiresAt:null});
  const listeners=new Set([onChange]);
  const emit=(state,expiresAt=session?.refreshExpiresAt??null)=>{
    view=Object.freeze({state,connected:state==='connected',enrolled:optedIn,canCapture:optedIn,notice:notice?.state??null,expiresAt:expiresAt??notice?.expiresAt??null});
    for(const fn of listeners)try{fn(view);}catch{/* UI cannot change enrollment */}
    return view;
  };
  const halt=()=>{generation++;clearTimer(timer);timer=undefined;controller?.abort();controller=undefined;inflight=undefined;operation=undefined;session=undefined;};
  const current=ticket=>running&&!disposed&&ticket===generation;
  const valid=x=>x?.v===1&&x.gameId===gameId&&x.scopeVersion===2&&token(x.token)&&token(x.refreshToken)&&
    Date.parse(x.expiresAt)>now()&&Date.parse(x.expiresAt)<=now()+HOUR&&
    Date.parse(x.refreshExpiresAt)>=Date.parse(x.expiresAt)&&Date.parse(x.refreshExpiresAt)<=now()+MONTH;
  // Storage seam: an undecryptable record (e.g. the OS key was reset) reads as empty for an
  // explicit connect/disconnect, so the user can always replace or clear it.
  async function load({recover=false}={}){
    try{return await store.read();}
    catch(e){if(recover&&e?.code==='invalid-store'&&e.revision)return {revision:e.revision,session:null,notice:null};throw e;}
  }
  async function put(expected,session,next){
    const result=await store.replace(expected,{session,notice:noticeOf(next)});
    if(result?.ok)writes++;
    return result?.ok?result.revision:null;
  }
  async function request(action,body,ticket){
    const abort=new AbortController();controller=abort;
    try{
      const response=await fetchImpl(`${endpoint}/v1/access/${action}`,{method:'POST',redirect:'error',
        headers:{'content-type':'application/json'},body:JSON.stringify({v:1,...body}),
        signal:AbortSignal.any([abort.signal,AbortSignal.timeout(accessTimeoutMs)])});
      if(!current(ticket))throw fault('stale');
      if(!response.ok){await response.body?.cancel();throw fault([401,403].includes(response.status)?'denied':'transient');}
      if(response.redirected||response.headers.get('content-type')?.split(';')[0]!=='application/json')throw fault('invalid');
      const reader=response.body?.getReader();if(!reader)throw fault('invalid');
      const chunks=[];let length=0;
      try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;
        if(length>2048){await reader.cancel();throw fault('invalid');}chunks.push(value);
      }}finally{reader.releaseLock();}
      if(!current(ticket))throw fault('stale');
      return JSON.parse(Buffer.concat(chunks.map(c=>Buffer.from(c))).toString('utf8'));
    }catch(e){throw e?.kind?e:fault('transient');}
    finally{if(controller===abort)controller=undefined;}
  }
  function schedule(ms){clearTimer(timer);if(running)timer=setTimer(()=>{void refresh();},Math.max(1000,ms));}
  async function adoptStored(ticket){
    const saved=await load();if(!current(ticket))return;
    revision=saved.revision;notice=noticeOf(saved.notice);optedIn=!!saved.session||!!notice&&notice.enrolled!==false;
    session=saved.session?{refreshToken:saved.session.refreshToken,refreshExpiresAt:saved.session.expiresAt}:undefined;
    emit(session?'checking':notice?.state??'disconnected',session?.refreshExpiresAt??null);
    if(session)schedule(1000);
  }
  async function forget(ticket,state){
    const reason={state,expiresAt:session?.refreshExpiresAt??notice?.expiresAt??null,enrolled:optedIn};
    const next=await put(revision,null,reason);
    if(!current(ticket))return;
    session=undefined;
    if(next===null){await adoptStored(ticket);return;}
    revision=next;notice=noticeOf(reason);optedIn=reason.enrolled;emit(state,null);
  }
  async function accept(value,ticket){
    if(!valid(value))throw fault('invalid');
    if(!current(ticket))return false;
    const next=await put(revision,{refreshToken:value.refreshToken,expiresAt:iso(value.refreshExpiresAt)},null);
    if(!current(ticket))return false;
    if(next===null){session=undefined;await adoptStored(ticket);return false;}
    revision=next;
    session={token:value.token,refreshToken:value.refreshToken,expiresAt:value.expiresAt,refreshExpiresAt:iso(value.refreshExpiresAt)};
    notice=null;optedIn=true;failures=0;emit('connected');
    const end=Date.parse(session.refreshExpiresAt),expiry=Date.parse(session.expiresAt);
    schedule((expiry>=end?end:expiry-4*60000)-now());
    return true;
  }
  async function restoreOrRefresh(ticket){
    try{
      if(!session){
        const saved=await load();if(!current(ticket))return;
        revision=saved.revision;
        if(!saved.session){notice=noticeOf(saved.notice);optedIn=!!notice&&notice.enrolled!==false;emit(notice?.state??'disconnected',null);return;}
        optedIn=true;notice=null;session={refreshToken:saved.session.refreshToken,refreshExpiresAt:saved.session.expiresAt};
      }
      if(Date.parse(session.refreshExpiresAt)<=now()){await forget(ticket,'expired');return;}
      const value=await request('refresh',{refreshToken:session.refreshToken,scopeVersion:2},ticket);
      if(!current(ticket))return;
      // The issuer rotates only access, never the refresh credential or family deadline.
      if(value.refreshToken!==session.refreshToken||iso(value.refreshExpiresAt)!==session.refreshExpiresAt)throw fault('invalid');
      await accept(value,ticket);
    }catch(e){
      if(!current(ticket))return;
      if(e?.kind==='denied'){try{await forget(ticket,'access-required');}catch{session=undefined;emit('storage-unavailable',null);}return;}
      if(!e?.kind){session=undefined;emit('storage-unavailable',null);return;}
      // Offline/rate limit/server outage: retain enrollment, but never show Connected.
      if(session)delete session.token;
      emit('offline');schedule(Math.min(300000,5000*2**Math.min(failures++,6)));
    }
  }
  function refresh(){
    if(!running||disposed||operation)return Promise.resolve(view);
    if(inflight)return inflight;
    const ticket=generation,work=restoreOrRefresh(ticket).then(()=>view);
    const result=work.finally(()=>{if(inflight===result)inflight=undefined;});inflight=result;return result;
  }
  return Object.freeze({endpoint,gameId,
    status:()=>view,
    subscribe(fn){listeners.add(fn);try{fn(view);}catch{}return()=>listeners.delete(fn);},
    // Restores the encrypted enrollment and silently refreshes; never redeems an invitation.
    async start(){
      if(disposed)return view;
      if(running){if(inflight)await inflight;return view;}
      running=true;emit('checking',null);
      await refresh();return view;
    },
    // Suspends (e.g. before quit) without forgetting.
    stop(){running=false;halt();emit(notice?.state??(optedIn?'stopped':'disconnected'),null);},
    refresh,
    async connect(invitation){
      if(disposed||!token(invitation)||operation)return false;
      // Explicit redemption. Transient failures (timeouts, 5xx) are retried with the SAME attempt id,
      // which the service treats idempotently for 15 min, so a slow cold start cannot burn the invite.
      halt();running=true;const ticket=generation;operation='connect';emit('connecting',null);
      try{
        const old=await load({recover:true});if(!current(ticket))return false;
        optedIn=!!old.session||!!old.notice&&old.notice.enrolled!==false;
        const next=await put(old.revision,null,{state:'connection-uncertain',expiresAt:null,enrolled:optedIn});if(!current(ticket))return false;
        if(next===null)throw fault('stale');revision=next;
        if(!lastAttempt||lastAttempt.invitation!==invitation||now()-lastAttempt.at>14*60000)lastAttempt={invitation,attemptId:randomBytes(16).toString('base64url'),at:now()};
        let value;
        for(let n=0;;n++){
          try{value=await request('redeem',{invitation,gameId,buildSha,scopeVersion:2,attemptId:lastAttempt.attemptId},ticket);break;}
          catch(e){if(e?.kind!=='transient'||n>=2||!current(ticket))throw e;await retryDelay(n?5000:2000);if(!current(ticket))throw fault('stale');}
        }
        lastAttempt=undefined;invitation=undefined;
        return await accept(value,ticket);
      }catch(e){
        if(current(ticket)){
          session=undefined;notice={state:e?.kind==='denied'?'access-required':'connection-uncertain',expiresAt:null,enrolled:optedIn};
          try{const next=await put(revision,null,notice);if(current(ticket)&&next!==null)revision=next;}catch{}
          if(current(ticket))emit(e?.kind?notice.state:'storage-unavailable',null);
        }
        return false;
      }finally{invitation=undefined;if(ticket===generation)operation=undefined;}
    },
    async getToken(){
      if(!running||disposed||operation)return undefined;
      // Another process (or a disconnect elsewhere) may have replaced the record.
      const ticket=generation,seen=writes;
      try{
        const saved=await load();if(!current(ticket)||operation)return undefined;
        // Our own write (e.g. a coalesced refresh) landed during this read: memory is newer.
        if(writes===seen&&(saved.revision!==revision||saved.session?.refreshToken!==session?.refreshToken)){session=undefined;revision=saved.revision;}
        if(writes===seen&&!saved.session){notice=noticeOf(saved.notice);optedIn=!!notice&&notice.enrolled!==false;emit(notice?.state??'disconnected',null);return undefined;}
      }catch{if(current(ticket)){session=undefined;emit('storage-unavailable',null);}return undefined;}
      if(session?.token&&Date.parse(session.expiresAt)-now()>5*60000)return session.token;
      await refresh();return session?.token&&Date.parse(session.expiresAt)>now()?session.token:undefined;
    },
    // Forgets locally (reports stay queued) and attempts server revocation.
    async disconnect(){
      if(disposed)return {forgotten:false,revoked:false};
      halt();running=true;const ticket=generation;operation='disconnect';emit('disconnecting',null);
      try{
        const old=await load({recover:true});if(!current(ticket))return {forgotten:false,revoked:false};
        const next=await put(old.revision,null,null);
        if(!current(ticket)||next===null){if(current(ticket))emit('storage-unavailable',null);return {forgotten:false,revoked:false};}
        revision=next;notice=null;optedIn=false;emit('disconnected',null);
        if(!old.session)return {forgotten:true,revoked:null};
        try{const result=await request('disconnect',{refreshToken:old.session.refreshToken},ticket);
          return {forgotten:true,revoked:result?.v===1&&result.disconnected===true};
        }catch{return {forgotten:true,revoked:false};}
      }catch{if(current(ticket))emit('storage-unavailable',null);return {forgotten:false,revoked:false};}
      finally{if(ticket===generation)operation=undefined;}
    },
    dispose(){running=false;disposed=true;halt();listeners.clear();},
  });
}
