// Durable file primitives for the Node/Electron adapter: atomic replace and a cross-process
// lock. Node built-ins only. The lock is an O_EXCL lockfile holding {pid,nonce,at}; a holder
// whose pid is gone (or whose lock is older than staleMs) is recovered automatically.
import {open,readFile,rename,unlink,stat,link,mkdir,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname,basename,join,resolve} from 'node:path';

export const LOCK_LIMITS=Object.freeze({waitMs:5000,pollMs:25,staleMs:60000,emptyGraceMs:1000});
const chains=new Map(),liveNonces=new Set();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const isProcessAlive=pid=>{
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(e){return e?.code==='EPERM';}
};
export class FileLockBusy extends Error{constructor(){super('Lock busy');this.code='busy';}}

async function syncDirectory(dir){
  if(process.platform==='win32')return;
  try{const d=await open(dir,'r');try{await d.sync();}finally{await d.close();}}catch{/* best effort */}
}
export async function writeFileDurable(path,data,{mode=0o600}={}){
  const dir=dirname(path),tmp=join(dir,`.${basename(path)}.${randomUUID()}.tmp`);
  try{
    const h=await open(tmp,'wx',mode);
    try{await h.writeFile(data);await h.sync();}finally{await h.close();}
    await rename(tmp,path);
  }catch(e){await unlink(tmp).catch(()=>{});throw e;}
  await syncDirectory(dir);
}
export async function renameDurable(from,to){await rename(from,to);await syncDirectory(dirname(to));}
export {syncDirectory};

// Atomic removal: the directory leaves its visible name in one rename, then is deleted.
export async function removeTree(path,graveDir=dirname(path)){
  const grave=join(graveDir,`.trash-${randomUUID()}`);
  try{await rename(path,grave);}catch(e){if(e?.code==='ENOENT')return;throw e;}
  await syncDirectory(dirname(path));
  await rm(grave,{recursive:true,force:true});
}

export function createFileLock(path,{pid=process.pid,isAlive=isProcessAlive,limits=LOCK_LIMITS}={}){
  const lockPath=resolve(path);
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
      try{const nonce=await acquire();try{return await fn();}finally{await release(nonce);}}
      finally{done();if(chains.get(lockPath)===tail)chains.delete(lockPath);}
    },
  });
}
