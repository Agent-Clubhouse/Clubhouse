// Durable file primitives for the Node/Electron adapter: atomic replace and a cross-process
// lock. Node built-ins only. The lock is an O_EXCL lockfile holding {pid,nonce,at}; a holder
// whose pid is gone (or whose lock is older than staleMs) is recovered automatically.
//
// Windows refuses a rename while anything holds the target, or a file inside a moved directory,
// open: a virus scanner, an indexer, or a plain read in this process. Those refusals usually pass
// in milliseconds, so win32 retries them briefly. Other platforms make one attempt, as before.
import {AsyncLocalStorage} from 'node:async_hooks';
import {open,readFile,rename,unlink,stat,link,mkdir,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname,basename,join,resolve} from 'node:path';

export const LOCK_LIMITS=Object.freeze({waitMs:5000,pollMs:25,staleMs:60000,emptyGraceMs:1000});
const chains=new Map(),liveNonces=new Set();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const TRANSIENT=new Set(['EPERM','EBUSY','EACCES']);
// One call waits at most their sum, 1 s.
export const RETRY_DELAYS_MS=Object.freeze([10,20,40,80,150,250,450]);
// A locked operation can write 40 times (10 reports, a fence and a release each), so 1 s per write
// would outlast waitMs in every other process, and so would several short holds queued in this one.
// So all retries on one lock path in this process share this much waiting, refilled only after a
// full waitMs with none. When it runs out, each remaining call gets its one attempt. This limits
// this process's retries only: a waiter can still get busy, say behind other processes or sustained
// work under the lock, and that's a retry for its caller and not a loss.
export const LOCK_RETRY_BUDGET_MS=2000;
export const lockRetryBudgetMs=limits=>Math.min(LOCK_RETRY_BUDGET_MS,Math.floor(Math.min(limits.waitMs,limits.staleMs)*0.4));
const retryBudget=new AsyncLocalStorage(),lockPools=new Map();
// A callback started under a lock keeps this context after the lock is gone, so check it's still held.
const heldBudget=()=>{const b=retryBudget.getStore();return b?.held?b.pool:null;};
export const isProcessAlive=pid=>{
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(e){return e?.code==='EPERM';}
};
export class FileLockBusy extends Error{constructor(){super('Lock busy');this.code='busy';}}

async function syncDirectory(dir,platform=process.platform){
  if(platform==='win32')return;
  try{const d=await open(dir,'r');try{await d.sync();}finally{await d.close();}}catch{/* best effort */}
}
// platform, fs and wait are seams for tests.
export function createDurableFiles({platform=process.platform,fs={},wait=sleep}={}){
  const io={open,rename,rm,unlink,...fs};
  // Throws the first refusal once retries run out; any other error ends them at once.
  async function retried(attempt){
    try{return await attempt();}
    catch(first){
      if(platform!=='win32'||!TRANSIENT.has(first?.code))throw first;
      for(const delay of RETRY_DELAYS_MS){
        const budget=heldBudget(),ms=budget?Math.min(delay,budget.leftMs):delay;
        if(ms<=0)break;
        if(budget){budget.leftMs-=ms;budget.lastWaitAt=Date.now()+ms;}
        await wait(ms);
        try{return await attempt();}catch(e){if(!TRANSIENT.has(e?.code))throw e;}
      }
      throw first;
    }
  }
  const removeDir=path=>retried(()=>io.rm(path,{recursive:true,force:true}));
  return Object.freeze({
    // The temp file is complete and synced before the first rename and stays until the last attempt.
    // After a final failure it gets one unlink attempt; if that's refused too, it stays beside the
    // target. It never replaces the target.
    async writeFileDurable(path,data,{mode=0o600}={}){
      const dir=dirname(path),tmp=join(dir,`.${basename(path)}.${randomUUID()}.tmp`);
      try{
        const h=await io.open(tmp,'wx',mode);
        try{await h.writeFile(data);await h.sync();}finally{await h.close();}
        await retried(()=>io.rename(tmp,path));
      }catch(e){await io.unlink(tmp).catch(()=>{});throw e;}
      await syncDirectory(dir,platform);
    },
    async renameDurable(from,to){await retried(()=>io.rename(from,to));await syncDirectory(dirname(to),platform);},
    // Atomic removal: the directory leaves its visible name in one rename, then is deleted. A throw
    // from the delete means the name has already gone, and the moved copy is left in graveDir.
    async removeTree(path,graveDir=dirname(path)){
      const grave=join(graveDir,`.trash-${randomUUID()}`);
      try{await retried(()=>io.rename(path,grave));}catch(e){if(e?.code==='ENOENT')return;throw e;}
      await syncDirectory(dirname(path),platform);
      await removeDir(grave);
    },
    removeDir,
  });
}
export const durableFiles=createDurableFiles();
export const {writeFileDurable,renameDurable,removeTree}=durableFiles;
export {syncDirectory};

export function createFileLock(path,{pid=process.pid,isAlive=isProcessAlive,limits=LOCK_LIMITS}={}){
  const lockPath=resolve(path),retryMs=lockRetryBudgetMs(limits);
  const parse=raw=>{try{const x=JSON.parse(raw);return Number.isSafeInteger(x?.pid)&&typeof x.nonce==='string'?x:null;}catch{return null;}};
  async function breakStale(){
    let raw,info;
    try{raw=await readFile(lockPath,'utf8');info=await stat(lockPath);}catch(e){if(e?.code==='ENOENT')return true;throw e;}
    const holder=parse(raw),age=Date.now()-info.mtimeMs;
    const stale=holder?age>limits.staleMs||(holder.pid===pid?!liveNonces.has(holder.nonce):!isAlive(holder.pid))
      :age>limits.emptyGraceMs; // a creator that died between create and write
    if(!stale)return false;
    // Move the stale lock aside atomically, then confirm we moved what we judged stale.
    const grave=`${lockPath}.${randomUUID()}.stale`;
    try{await rename(lockPath,grave);}catch(e){if(e?.code==='ENOENT')return true;throw e;}
    const moved=await readFile(grave,'utf8').catch(()=>null);
    if(moved!==raw)await link(grave,lockPath).catch(()=>{}); // a fresh holder raced us: restore it
    await unlink(grave).catch(()=>{});
    return true;
  }
  async function acquire(){
    await mkdir(dirname(lockPath),{recursive:true,mode:0o700});
    const nonce=randomUUID(),deadline=Date.now()+limits.waitMs;
    for(;;){
      try{
        const h=await open(lockPath,'wx',0o600);
        liveNonces.add(nonce);
        try{await h.writeFile(JSON.stringify({pid,nonce,at:new Date().toISOString()}));await h.sync();}finally{await h.close();}
        return nonce;
      }catch(e){if(e?.code!=='EEXIST'){liveNonces.delete(nonce);throw e;}}
      if(await breakStale())continue;
      if(Date.now()>=deadline)throw new FileLockBusy();
      await sleep(limits.pollMs);
    }
  }
  async function release(nonce){
    liveNonces.delete(nonce);
    try{if(parse(await readFile(lockPath,'utf8'))?.nonce===nonce)await unlink(lockPath);}catch{/* already recovered by someone else */}
  }
  return Object.freeze({path:lockPath,
    // In-process callers queue on a promise chain; other processes contend on the lockfile.
    async run(fn){
      const prior=chains.get(lockPath)??Promise.resolve();let done;
      const mine=new Promise(r=>done=r),tail=prior.then(()=>mine);chains.set(lockPath,tail);
      await prior;
      try{
        const nonce=await acquire();
        try{
          // A lock taken inside another extends that one's hold, so it shares that one's budget.
          if(heldBudget())return await fn();
          const pool=lockPools.get(lockPath)??{leftMs:retryMs,lastWaitAt:0};lockPools.set(lockPath,pool);
          if(Date.now()-pool.lastWaitAt>=limits.waitMs)pool.leftMs=retryMs;
          const hold={held:true,pool};
          try{return await retryBudget.run(hold,fn);}finally{hold.held=false;}
        }finally{await release(nonce);}
      }
      finally{done();if(chains.get(lockPath)===tail)chains.delete(lockPath);}
    },
  });
}
