// One-shot report delivery (Node port of adapters/browser/submit-feedback.mjs):
// POST /v1/reports prepares; a pending reply carries a ticket for PUT /v1/reports/:id/media.
// Text-only reports (media:null) are ready after prepare. Errors carry a retry `code`.
import {createHash} from 'node:crypto';
import {LIMITS,normalizeReport} from '../../src/protocol.mjs';

export class FeedbackDeliveryError extends Error{
  constructor(code,message,extra={}){super(message);this.name='FeedbackDeliveryError';this.code=code;Object.assign(this,extra);}
}
const fail=(code,message,extra)=>{throw new FeedbackDeliveryError(code,message,extra);};
export const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const isPng=bytes=>Buffer.isBuffer(bytes)&&bytes.length>PNG_SIGNATURE.length&&bytes.subarray(0,8).equals(PNG_SIGNATURE);

export async function sendReport({report,png=null,endpoint,getToken,fetchImpl=(...a)=>fetch(...a),signal}){
  let frozen;
  try{frozen=normalizeReport(structuredClone(report));}catch{fail('invalid-input','Invalid reviewed report.');}
  const textOnly=frozen.media===null;
  if(textOnly?png!==null:!(isPng(png)&&png.length<=LIMITS.media&&frozen.media.type==='image/png'&&frozen.media.bytes===png.length&&frozen.media.sha256===sha256(png)))
    fail('invalid-media','Reviewed PNG length or hash does not match the report.');
  const checkAbort=()=>{if(signal?.aborted)fail('cancelled','Submission cancelled; retry this same report.');};
  checkAbort();
  let token;
  try{token=await getToken();}catch{token=undefined;}
  checkAbort();
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{16,256}$/.test(token))fail('access-required','Feedback access is unavailable.');
  const base=`${endpoint}/v1/reports`;
  async function request(path,init){
    checkAbort();let response;
    const timeout=AbortSignal.timeout(30000);
    try{response=await fetchImpl(base+path,{...init,redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout,
      headers:{...init.headers,authorization:`Bearer ${token}`}});}
    catch{checkAbort();fail('network','Delivery could not be confirmed. Retry this same report.');}
    checkAbort();
    if(!response.ok){
      const status=response.status;await response.body?.cancel();
      if(status===401||status===403)fail('access-required','Feedback access is missing, expired or not permitted.');
      if(status===409)fail('conflict','This report conflicts with an existing submission.');
      if(status===429||status===503){
        const raw=response.headers.get('retry-after'),seconds=raw&&/^\d+$/.test(raw)?Number(raw):NaN;
        fail(status===429?'quota':'unavailable','Feedback is temporarily unavailable.',{retryAfterMs:Math.min(86400000,Number.isFinite(seconds)?seconds*1000:0)});
      }
      if(status>=500||status===408)fail('unavailable','Feedback is temporarily unavailable.');
      fail('permanent','The service rejected this report.');
    }
    try{return await response.json();}catch{fail('invalid-ack','Delivery acknowledgement is invalid.');}
  }
  try{
    let ack=await request('',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(frozen)});
    if(ack?.id!==frozen.id)fail('invalid-ack','Acknowledgement does not match this report.');
    if(ack.status==='pending'){
      if(textOnly||typeof ack.ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(ack.ticket))fail('invalid-ack','Upload authorization is invalid.');
      ack=await request(`/${frozen.id}/media`,{method:'PUT',headers:{'content-type':'image/png','x-upload-ticket':ack.ticket},body:png});
    }
    if(ack?.id!==frozen.id||!['ready','processed'].includes(ack.status))fail('invalid-ack','Delivery has not been confirmed.');
    if(ack.gameId!==undefined&&ack.gameId!==frozen.gameId)fail('invalid-ack','Delivery app does not match this report.');
    return Object.freeze({id:frozen.id,status:ack.status,gameId:frozen.gameId});
  }finally{token=undefined;}
}
