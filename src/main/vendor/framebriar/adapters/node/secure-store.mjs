// OS-backed enrollment store for Electron main processes. One compare-and-swap record
// {revision, session, notice} per file, encrypted with Electron's injected `safeStorage`
// (macOS Keychain, Windows DPAPI, Linux libsecret/kwallet). Same semantics as
// adapters/godot/normal/secure_store.gd. No plaintext fallback: when safeStorage cannot
// encrypt (or Linux selected the 'basic_text' backend) every operation is refused.
// Prefers the async safeStorage API (isAsyncEncryptionAvailable/encryptStringAsync/
// decryptStringAsync, Electron 42+, the only one in 46+). Falls back to the sync API
// (deprecated in Electron 45, removed in 46). Both read and write the same on-disk format.
import {readFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {createFileLock,writeFileDurable} from './files.mjs';

export const SECURE_STORE_PAYLOAD_MAX=2048;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const NOTICES=['expired','access-required','connection-uncertain'];
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export const validStoredSession=s=>s===null||(plain(s)&&Object.keys(s).length===2&&
  typeof s.refreshToken==='string'&&/^[A-Za-z0-9_-]{43}$/.test(s.refreshToken)&&typeof s.expiresAt==='string'&&ISO.test(s.expiresAt));
export const validStoredNotice=n=>n===null||(plain(n)&&Object.keys(n).length===3&&NOTICES.includes(n.state)&&
  typeof n.enrolled==='boolean'&&(n.expiresAt===null||(typeof n.expiresAt==='string'&&ISO.test(n.expiresAt))));

export class SecureStoreError extends Error{
  constructor(code,extra={}){super(`Secure store ${code}`);this.name='SecureStoreError';this.code=code;Object.assign(this,extra);}
}

const ASYNC_API=['isAsyncEncryptionAvailable','encryptStringAsync','decryptStringAsync'];
const SYNC_API=['isEncryptionAvailable','encryptString','decryptString'];
// 'async' | 'sync' | null. Never mixes the two: a partial async API uses the sync one.
export const safeStorageApi=safeStorage=>
  ASYNC_API.every(k=>typeof safeStorage?.[k]==='function')?'async':SYNC_API.every(k=>typeof safeStorage?.[k]==='function')?'sync':null;
// Linux only: 'basic_text' is a hardcoded key (effectively plaintext); 'unknown' means not ready
// yet. Electron's isAsyncEncryptionAvailable() resolves true on basic_text, so this check stays.
function linuxBackend(safeStorage,platform){
  if(platform!=='linux')return {available:true};
  let backend;try{backend=safeStorage.getSelectedStorageBackend?.();}catch{backend=undefined;}
  if(typeof backend!=='string'||backend==='basic_text'||backend==='unknown')return {available:false,reason:'plaintext-backend',backend:backend??null};
  return {available:true,backend};
}

// {available, reason?, backend?}, sync API only. Call after Electron's app 'ready' (Linux
// backends load late). Deprecated: on Electron 46+ (no sync API) it reports
// 'safe-storage-missing'. Use secureStorageAvailabilityAsync.
export function secureStorageAvailability(safeStorage,platform=process.platform){
  if(!SYNC_API.every(k=>typeof safeStorage?.[k]==='function'))return {available:false,reason:'safe-storage-missing'};
  try{if(safeStorage.isEncryptionAvailable()!==true)return {available:false,reason:'encryption-unavailable'};}
  catch{return {available:false,reason:'encryption-unavailable'};}
  return linuxBackend(safeStorage,platform);
}

// {available, api, reason?, backend?}. api is the safeStorage API the store uses: 'async' or 'sync'.
export async function secureStorageAvailabilityAsync(safeStorage,platform=process.platform){
  const api=safeStorageApi(safeStorage);
  if(api===null)return {available:false,reason:'safe-storage-missing'};
  if(api==='sync')return {...secureStorageAvailability(safeStorage,platform),api};
  let ok;try{ok=await safeStorage.isAsyncEncryptionAvailable();}catch{ok=false;}
  if(ok!==true)return {available:false,reason:'encryption-unavailable',api};
  return {...linuxBackend(safeStorage,platform),api};
}

// Electron rejects decryptStringAsync with these when the key store is only momentarily
// unreachable. That is "unavailable, try later", not a corrupt record.
const TRANSIENT=/temporarily unavailable|before app is ready/i;

export function createSecureStore({safeStorage,file,scope='',platform=process.platform,lock:lockOptions}={}){
  if(typeof file!=='string'||!file)throw new TypeError('createSecureStore requires a file path');
  const lock=createFileLock(`${file}.lock`,lockOptions);
  // Re-checked on every operation: encryption can disappear at runtime. Returns the API to use.
  const usable=async()=>{const a=await secureStorageAvailabilityAsync(safeStorage,platform);if(!a.available)throw new SecureStoreError('secure-store-unavailable',{reason:a.reason});return a.api;};
  const encrypt=async(api,text)=>Buffer.from(api==='async'?await safeStorage.encryptStringAsync(text):safeStorage.encryptString(text)).toString('base64');
  async function outer(){
    let raw;
    try{raw=await readFile(file,'utf8');}catch(e){if(e?.code==='ENOENT')return null;throw new SecureStoreError('secure-store-unavailable');}
    let x;try{x=JSON.parse(raw);}catch{throw new SecureStoreError('invalid-store');}
    if(!plain(x)||x.v!==1||typeof x.revision!=='string'||!UUID.test(x.revision)||typeof x.data!=='string'||x.data.length>4*SECURE_STORE_PAYLOAD_MAX)
      throw new SecureStoreError('invalid-store');
    return x;
  }
  // {record, reencrypt}. reencrypt is the async API's shouldReEncrypt (the OS key rotated).
  async function decode(api,x){
    let text,reencrypt=false;
    try{
      if(api==='async'){const r=await safeStorage.decryptStringAsync(Buffer.from(x.data,'base64'));text=r?.result;reencrypt=r?.shouldReEncrypt===true;}
      else text=safeStorage.decryptString(Buffer.from(x.data,'base64'));
    }catch(e){
      if(api==='async'&&TRANSIENT.test(String(e?.message)))throw new SecureStoreError('secure-store-unavailable');
      throw new SecureStoreError('invalid-store',{revision:x.revision});
    }
    let value;
    try{value=JSON.parse(text);}
    catch{throw new SecureStoreError('invalid-store',{revision:x.revision});}
    // The revision and scope are bound inside the ciphertext: a swapped or copied file fails.
    if(!plain(value)||value.v!==1||value.revision!==x.revision||value.scope!==scope||!validStoredSession(value.session??null)||!validStoredNotice(value.notice??null))
      throw new SecureStoreError('invalid-store',{revision:x.revision});
    return {record:{revision:x.revision,session:value.session??null,notice:value.notice??null},reencrypt};
  }
  const locked=fn=>lock.run(fn).catch(e=>{throw e instanceof SecureStoreError?e:new SecureStoreError(e?.code==='busy'?'busy':'secure-store-unavailable');});
  return Object.freeze({file,
    // Deprecated: sync API only. Use probeAsync().
    probe:()=>secureStorageAvailability(safeStorage,platform),
    probeAsync:()=>secureStorageAvailabilityAsync(safeStorage,platform),
    // {revision:'missing'|uuid, session, notice}. An undecryptable record throws
    // invalid-store carrying its outer `revision`, so an explicit replace can still clear it.
    async read(){
      const api=await usable();
      return locked(async()=>{
        const x=await outer();if(!x)return {revision:'missing',session:null,notice:null};
        const {record,reencrypt}=await decode(api,x);
        // Rewrap under the rotated key with the same revision and contents, so CAS is unaffected.
        // Best effort: the old ciphertext still decrypts if this fails.
        if(reencrypt)try{
          const data=await encrypt(api,JSON.stringify({v:1,revision:x.revision,scope,session:record.session,notice:record.notice}));
          await writeFileDurable(file,JSON.stringify({v:1,revision:x.revision,data}));
        }catch{/* keep the readable record */}
        return record;
      });
    },
    // Compare-and-swap. {ok:true,revision} or {ok:false,code:'conflict'}; throws when unavailable.
    async replace(expectedRevision,{session=null,notice=null}={}){
      if(!(expectedRevision==='missing'||(typeof expectedRevision==='string'&&UUID.test(expectedRevision)))||!validStoredSession(session)||!validStoredNotice(notice))
        throw new SecureStoreError('invalid-input');
      const api=await usable();
      const revision=randomUUID(),body=JSON.stringify({v:1,revision,scope,session,notice});
      if(Buffer.byteLength(body)>SECURE_STORE_PAYLOAD_MAX)throw new SecureStoreError('invalid-input');
      let data;try{data=await encrypt(api,body);}catch{throw new SecureStoreError('secure-store-unavailable');}
      return locked(async()=>{
        let current;
        try{current=(await outer())?.revision??'missing';}catch(e){if(e.code!=='invalid-store')throw e;current=null;}
        if(current!==expectedRevision)return {ok:false,code:'conflict'};
        try{
          await mkdir(dirname(file),{recursive:true,mode:0o700});
          await writeFileDurable(file,JSON.stringify({v:1,revision,data}));
        }catch{throw new SecureStoreError('secure-store-unavailable');}
        return {ok:true,revision};
      });
    },
  });
}
