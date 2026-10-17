// OS-backed enrollment store for Electron main processes. One compare-and-swap record
// {revision, session, notice} per file, encrypted with Electron's injected `safeStorage`
// (macOS Keychain, Windows DPAPI, Linux libsecret/kwallet). Same semantics as
// adapters/godot/normal/secure_store.gd. No plaintext fallback: when safeStorage cannot
// encrypt (or Linux selected the 'basic_text' backend) every operation is refused.
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

// {available, reason?, backend?}. Call after Electron's app 'ready' (Linux backends load late).
export function secureStorageAvailability(safeStorage,platform=process.platform){
  if(!safeStorage||typeof safeStorage.encryptString!=='function'||typeof safeStorage.decryptString!=='function'||typeof safeStorage.isEncryptionAvailable!=='function')
    return {available:false,reason:'safe-storage-missing'};
  try{if(safeStorage.isEncryptionAvailable()!==true)return {available:false,reason:'encryption-unavailable'};}
  catch{return {available:false,reason:'encryption-unavailable'};}
  if(platform==='linux'){
    let backend;try{backend=safeStorage.getSelectedStorageBackend?.();}catch{backend=undefined;}
    // 'basic_text' is a hardcoded key (effectively plaintext); 'unknown' means not ready yet.
    if(typeof backend!=='string'||backend==='basic_text'||backend==='unknown')return {available:false,reason:'plaintext-backend',backend:backend??null};
    return {available:true,backend};
  }
  return {available:true};
}

export function createSecureStore({safeStorage,file,scope='',platform=process.platform,lock:lockOptions}={}){
  if(typeof file!=='string'||!file)throw new TypeError('createSecureStore requires a file path');
  const lock=createFileLock(`${file}.lock`,lockOptions);
  const usable=()=>{const a=secureStorageAvailability(safeStorage,platform);if(!a.available)throw new SecureStoreError('secure-store-unavailable',{reason:a.reason});};
  async function outer(){
    let raw;
    try{raw=await readFile(file,'utf8');}catch(e){if(e?.code==='ENOENT')return null;throw new SecureStoreError('secure-store-unavailable');}
    let x;try{x=JSON.parse(raw);}catch{throw new SecureStoreError('invalid-store');}
    if(!plain(x)||x.v!==1||typeof x.revision!=='string'||!UUID.test(x.revision)||typeof x.data!=='string'||x.data.length>4*SECURE_STORE_PAYLOAD_MAX)
      throw new SecureStoreError('invalid-store');
    return x;
  }
  function decode(x){
    let value;
    try{value=JSON.parse(safeStorage.decryptString(Buffer.from(x.data,'base64')));}
    catch{throw new SecureStoreError('invalid-store',{revision:x.revision});}
    // The revision and scope are bound inside the ciphertext: a swapped or copied file fails.
    if(!plain(value)||value.v!==1||value.revision!==x.revision||value.scope!==scope||!validStoredSession(value.session??null)||!validStoredNotice(value.notice??null))
      throw new SecureStoreError('invalid-store',{revision:x.revision});
    return {revision:x.revision,session:value.session??null,notice:value.notice??null};
  }
  const locked=fn=>lock.run(fn).catch(e=>{throw e instanceof SecureStoreError?e:new SecureStoreError(e?.code==='busy'?'busy':'secure-store-unavailable');});
  return Object.freeze({file,
    probe:()=>secureStorageAvailability(safeStorage,platform),
    // {revision:'missing'|uuid, session, notice}. An undecryptable record throws
    // invalid-store carrying its outer `revision`, so an explicit replace can still clear it.
    async read(){
      usable();
      return locked(async()=>{const x=await outer();return x?decode(x):{revision:'missing',session:null,notice:null};});
    },
    // Compare-and-swap. {ok:true,revision} or {ok:false,code:'conflict'}; throws when unavailable.
    async replace(expectedRevision,{session=null,notice=null}={}){
      if(!(expectedRevision==='missing'||(typeof expectedRevision==='string'&&UUID.test(expectedRevision)))||!validStoredSession(session)||!validStoredNotice(notice))
        throw new SecureStoreError('invalid-input');
      usable();
      const revision=randomUUID(),body=JSON.stringify({v:1,revision,scope,session,notice});
      if(Buffer.byteLength(body)>SECURE_STORE_PAYLOAD_MAX)throw new SecureStoreError('invalid-input');
      let data;try{data=Buffer.from(safeStorage.encryptString(body)).toString('base64');}catch{throw new SecureStoreError('secure-store-unavailable');}
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
