// Screenshot editing for feedback composers: a headless model, a flattener and a modal view.
// Contract: docs/feedback-composer-contract.md sections 1 to 3 and 8. No dependencies, no network, no
// global state, and nothing that needs eval, a fetched asset or inline style. No DOM at import.
// Sources and marks stay in memory: they have no serialized form and never go in a report.
import {FEEDBACK_COPY} from './feedback-copy.mjs';

export const SCREENSHOT_LIMITS=Object.freeze({maxBytes:8*1024*1024,maxPixels:20_000_000,maxSide:8192});
/** On the mounted view's root. A host capturing the DOM skips anything matching the selector. */
export const FEEDBACK_EXCLUDE_ATTRIBUTE='data-feedback-capture';
export const FEEDBACK_EXCLUDE_SELECTOR='[data-feedback-capture="exclude"]';
// A decode guard, well above what the report limits keep. The fit-down brings the result within them.
const MAX_DECODE_PIXELS=100_000_000;
const MAX_ENCODE_ATTEMPTS=8;
const WORKER_TIMEOUT_MS=60_000;
const typeTag=value=>Object.prototype.toString.call(value).slice(8,-1);
const isFrozenSource=value=>['Blob','File','ImageBitmap'].includes(typeTag(value));
const finite=(...values)=>values.every(Number.isFinite);
const cancelled=()=>Object.assign(new Error('Screenshot editing was cancelled.'),{name:'AbortError'});

// ---- marks: upright source pixels, top-left origin, frozen plain objects ----

function cleanMark(mark){
  if(mark?.type==='pen'){
    const {points,width,ink=FEEDBACK_COPY.inks.default}=mark;
    if(!Array.isArray(points)||!points.length||!points.every(p=>Array.isArray(p)&&finite(p[0],p[1]))||!finite(width)||width<=0||!Array.isArray(FEEDBACK_COPY.inks[ink]))
      throw TypeError('Invalid pen mark.');
    return Object.freeze({type:'pen',points:Object.freeze(points.map(([x,y])=>Object.freeze([x,y]))),width,ink});
  }
  if(mark?.type==='redact'){
    const {x,y,width,height}=mark;
    // Rejected, never skipped: a redaction that can't be drawn mustn't quietly not cover.
    if(!finite(x,y,width,height)||width<0||height<0)throw TypeError('Invalid redaction.');
    return Object.freeze({type:'redact',x,y,width,height});
  }
  throw TypeError('Unknown mark type.');
}

/** Whole pixels, expanded outward so a partly covered pixel is fully covered. Null if outside the image. */
export function coveredPixels(rect,{scale=1,scaleX=scale,scaleY=scale,width=Infinity,height=Infinity}={}){
  const left=Math.max(0,Math.floor(rect.x*scaleX)),right=Math.min(width,Math.ceil((rect.x+rect.width)*scaleX));
  const top=Math.max(0,Math.floor(rect.y*scaleY)),bottom=Math.min(height,Math.ceil((rect.y+rect.height)*scaleY));
  return right>left&&bottom>top?{x:left,y:top,width:right-left,height:bottom-top}:null;
}

/** A stroke's width in source pixels: 6 on screen, and at least 3 at the fitted zoom. */
export function penWidth(zoom,fittedZoom){return Math.max(6/zoom,3/fittedZoom);}

/** The largest size within the pixel and side limits, keeping the aspect ratio. */
export function fitDownSize(width,height,limits=SCREENSHOT_LIMITS){
  const scale=Math.min(1,Math.sqrt(limits.maxPixels/(width*height)),limits.maxSide/width,limits.maxSide/height);
  return scale===1?{width,height}:{width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale))};
}

/** Pen under redactions whichever came first. The preview and the flattener both draw with this, so they match. */
export function renderMarks(context,marks,{scale=1,width,height}={}){
  context.lineCap='round';context.lineJoin='round';
  for(const mark of marks){
    if(mark.type!=='pen')continue;
    const [first,...rest]=mark.points,color=`rgb(${FEEDBACK_COPY.inks[mark.ink??FEEDBACK_COPY.inks.default].join(',')})`;
    context.beginPath();
    if(rest.length){
      context.strokeStyle=color;context.lineWidth=mark.width*scale;context.moveTo(first[0]*scale,first[1]*scale);
      for(const point of rest)context.lineTo(point[0]*scale,point[1]*scale);
      context.stroke();
    }else{
      // A lone point still draws a dot.
      context.fillStyle=color;context.arc(first[0]*scale,first[1]*scale,mark.width*scale/2,0,Math.PI*2);context.fill();
    }
  }
  context.fillStyle='rgb(0,0,0)';
  for(const mark of marks){
    if(mark.type!=='redact')continue;
    const pixels=coveredPixels(mark,{scale,width,height});
    if(pixels)context.fillRect(pixels.x,pixels.y,pixels.width,pixels.height);
  }
}

// ---- PNG: written here so no alpha or metadata can arrive from a browser's encoder ----

let crcTable;
function crc32(bytes){
  crcTable??=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  let crc=0xffffffff;
  for(let i=0;i<bytes.length;i++)crc=crcTable[(crc^bytes[i])&255]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
function pngChunk(type,data){
  const out=new Uint8Array(data.length+12),view=new DataView(out.buffer);
  view.setUint32(0,data.length);
  for(let i=0;i<4;i++)out[i+4]=type.charCodeAt(i);
  out.set(data,8);
  view.setUint32(data.length+8,crc32(out.subarray(4,data.length+8)));
  return out;
}
// Each row gets whichever PNG filter leaves the smallest residuals: none, sub, up or Paeth.
function filterRow(current,previous,rows,scores){
  const length=current.length;
  const [none,sub,up,best]=rows;
  let scoreNone=0,scoreSub=0,scoreUp=0,scoreBest=0;
  for(let i=0;i<length;i++){
    const value=current[i],a=i>=3?current[i-3]:0,b=previous[i],c=i>=3?previous[i-3]:0;
    const p=a+b-c,pa=p>a?p-a:a-p,pb=p>b?p-b:b-p,pc=p>c?p-c:c-p,pick=pa<=pb&&pa<=pc?a:pb<=pc?b:c;
    const s=(value-a)&255,u=(value-b)&255,w=(value-pick)&255;
    none[i+1]=value;sub[i+1]=s;up[i+1]=u;best[i+1]=w;
    scoreNone+=value<128?value:256-value;scoreSub+=s<128?s:256-s;scoreUp+=u<128?u:256-u;scoreBest+=w<128?w:256-w;
  }
  scores[0]=scoreNone;scores[1]=scoreSub;scores[2]=scoreUp;scores[3]=scoreBest;
  let chosen=0;
  for(let i=1;i<4;i++)if(scores[i]<scores[chosen])chosen=i;
  return rows[chosen];
}
/** RGBA pixels to opaque 8-bit RGB PNG bytes, with only IHDR, IDAT and IEND. Alpha is ignored. */
export async function encodeOpaquePng(rgba,width,height,{signal}={}){
  const compressor=new CompressionStream('deflate'),writer=compressor.writable.getWriter();
  const compressed=new Response(compressor.readable).arrayBuffer();
  const stride=width*3,rowBytes=stride+1,scores=new Float64Array(4);
  const rows=[0,1,2,4].map(filter=>{const row=new Uint8Array(rowBytes);row[0]=filter;return row;});
  let previous=new Uint8Array(stride),current=new Uint8Array(stride),yielded=performance.now();
  const writing=(async()=>{
    for(let y=0;y<height;){
      if(signal?.aborted)throw cancelled();
      const count=Math.min(128,height-y),batch=new Uint8Array(count*rowBytes);
      for(let r=0;r<count;r++,y++){
        for(let x=0,from=y*width*4,to=0;x<width;x++,from+=4,to+=3){current[to]=rgba[from];current[to+1]=rgba[from+1];current[to+2]=rgba[from+2];}
        batch.set(filterRow(current,previous,rows,scores),r*rowBytes);
        [previous,current]=[current,previous];
      }
      await writer.write(batch);
      // Stays responsive on the main thread. A host can also pass a workerFactory.
      if(performance.now()-yielded>32){await new Promise(resolve=>setTimeout(resolve));yielded=performance.now();}
    }
    await writer.close();
  })();
  let deflated;
  try{[deflated]=await Promise.all([compressed,writing]);}
  catch(error){writer.abort(error).catch(()=>{});compressed.catch(()=>{});throw error;}
  const header=new Uint8Array(13),view=new DataView(header.buffer);
  view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=2;
  return new Blob([Uint8Array.of(137,80,78,71,13,10,26,10),pngChunk('IHDR',header),pngChunk('IDAT',new Uint8Array(deflated)),pngChunk('IEND',new Uint8Array(0))],{type:'image/png'});
}

// ---- flattener ----

// The renderer the flattener needs. Node tests inject their own, and pixels are real everywhere else.
const canvasRaster=Object.freeze({
  async decode(source){
    // Orientation applied. An ImageBitmap is already decoded, and stays the host's.
    if(typeTag(source)==='ImageBitmap')return {width:source.width,height:source.height,image:source,close(){}};
    const bitmap=await createImageBitmap(source,{imageOrientation:'from-image'}).catch(()=>createImageBitmap(source));
    return {width:bitmap.width,height:bitmap.height,image:bitmap,close(){bitmap.close();}};
  },
  surface(width,height){
    const canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(width,height):Object.assign(document.createElement('canvas'),{width,height});
    const context=canvas.getContext('2d',{alpha:false,colorSpace:'srgb',willReadFrequently:true});
    if(!context||canvas.width!==width||canvas.height!==height)throw Error('Canvas unavailable.');
    context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
    return {context,image:canvas,
      draw(image){context.drawImage(image,0,0,width,height);},
      read(){return context.getImageData(0,0,width,height).data;},
      release(){canvas.width=0;canvas.height=0;}};
  },
});

// Copies the pixels, then writes black straight into them, so nothing a canvas does can reach the output.
function coveredOutput(raster,full,fullWidth,fullHeight,width,height,redactions){
  let surface=full;
  if(width!==fullWidth||height!==fullHeight){surface=raster.surface(width,height);surface.draw(full.image);}
  const data=surface.read();
  if(surface!==full)surface.release();
  const scaleX=width/fullWidth,scaleY=height/fullHeight;
  for(const rect of redactions){
    const pixels=coveredPixels(rect,{scaleX,scaleY,width,height});
    if(!pixels)continue;
    for(let y=pixels.y;y<pixels.y+pixels.height;y++){
      for(let i=(y*width+pixels.x)*4,end=i+pixels.width*4;i<end;i+=4){data[i]=0;data[i+1]=0;data[i+2]=0;}
    }
  }
  return data;
}

async function flattenHere(source,marks,max,raster,signal){
  const decoded=await raster.decode(source);
  let full;
  try{
    if(signal?.aborted)throw cancelled();
    const {width,height}=decoded;
    if(!width||!height||width*height>MAX_DECODE_PIXELS)throw Error('Image size is out of range.');
    full=raster.surface(width,height);
    full.context.fillStyle='rgb(255,255,255)';full.context.fillRect(0,0,width,height);
    full.draw(decoded.image);
    renderMarks(full.context,marks,{width,height});
    const redactions=marks.filter(mark=>mark.type==='redact');
    let size=fitDownSize(width,height,max);
    for(let attempt=0;attempt<MAX_ENCODE_ATTEMPTS;attempt++){
      const png=await encodeOpaquePng(coveredOutput(raster,full,width,height,size.width,size.height,redactions),size.width,size.height,{signal});
      if(png.size<=max.maxBytes)return png;
      if(size.width===1&&size.height===1)break;
      // Bytes follow area closely enough to get there in a few passes rather than eight.
      const shrink=Math.min(.9,Math.sqrt(max.maxBytes/png.size)*.95);
      size={width:Math.max(1,Math.floor(size.width*shrink)),height:Math.max(1,Math.floor(size.height*shrink))};
    }
    throw Error('Image cannot fit the limits.');
  }finally{
    full?.release();
    decoded.close?.();
  }
}

function flattenInWorker(workerFactory,source,marks,limits,signal){
  return new Promise((resolve,reject)=>{
    const worker=workerFactory();
    let timer;
    const finish=(settle,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);try{worker.terminate();}catch{}settle(value);};
    const abort=()=>finish(reject,cancelled());
    if(signal?.aborted)return abort();
    signal?.addEventListener('abort',abort);
    timer=setTimeout(()=>finish(reject,Error('Worker timed out.')),WORKER_TIMEOUT_MS);
    worker.onmessage=({data})=>typeTag(data?.png)==='Blob'&&data.png!==source?finish(resolve,data.png):finish(reject,Error('Worker failed.'));
    worker.onerror=worker.onmessageerror=()=>finish(reject,Error('Worker failed.'));
    try{worker.postMessage({source,marks,limits});}catch(error){finish(reject,error);}
  });
}

/** In a host's own worker script, which is one line: `serveScreenshotWorker(self)`. */
export function serveScreenshotWorker(scope){
  scope.addEventListener('message',async({data})=>{
    try{scope.postMessage({png:await flattenScreenshot(data.source,data.marks,{limits:data.limits})});}
    catch{scope.postMessage({failed:true});}
  });
}

/**
 * New opaque PNG bytes with the marks flattened in, or a rejection. Never returns the source. An optional
 * `workerFactory` runs it off the main thread and falls back to this thread on any failure.
 */
export async function flattenScreenshot(source,marks=[],{limits,raster,workerFactory,signal}={}){
  const max={...SCREENSHOT_LIMITS,...limits},cleaned=Array.from(marks,cleanMark);
  if(!isFrozenSource(source))throw TypeError('A frozen Blob or ImageBitmap is required.');
  if(signal?.aborted)throw cancelled();
  if(workerFactory&&!raster){
    try{return await flattenInWorker(workerFactory,source,cleaned,max,signal);}
    catch(error){if(signal?.aborted)throw error;}
  }
  return flattenHere(source,cleaned,max,raster??canvasRaster,signal);
}

// PNG bytes within the limits go as attached. The header is read, nothing is decoded.
async function attachable(source,limits){
  if(typeTag(source)==='ImageBitmap'||source.type!=='image/png'||source.size>limits.maxBytes||source.size<33)return false;
  const head=new Uint8Array(await source.slice(0,24).arrayBuffer()),view=new DataView(head.buffer);
  const signature=[137,80,78,71,13,10,26,10].every((byte,i)=>head[i]===byte);
  if(!signature)return false;
  const width=view.getUint32(16),height=view.getUint32(20);
  return width>0&&height>0&&width<=limits.maxSide&&height<=limits.maxSide&&width*height<=limits.maxPixels;
}

// ---- model ----

const NO_MARKS=Object.freeze([]);

/**
 * What a composer holds for its image. Edits stay reversible until a Send starts, and `beginSend()` makes
 * the flattened bytes the only source, so if that save fails what was covered can't come back. No DOM and
 * no global state, and each model belongs to one composer.
 */
export function createScreenshotEditorModel({views,activeView,limits,raster,workerFactory}={}){
  if(!Array.isArray(views)||!views.length)throw Error('At least one view is required.');
  const max={...SCREENSHOT_LIMITS,...limits},byId=new Map(),listeners=new Set(),decoder=raster??canvasRaster;
  const abort=new AbortController(),aborted=new Promise(resolve=>abort.signal.addEventListener('abort',resolve,{once:true}));
  let mediaCounter=0,queue=Promise.resolve();
  let included=true,revision=0,flattening=0,imageVersion=0,finality=0,disposed=false,removed=false,lastMedia,snapshot;
  for(const {id,label,source} of views){
    if(typeof id!=='string'||!id||byId.has(id))throw Error('Each view needs its own id.');
    const view={id,label:String(label??id),source:null,status:'pending',marks:NO_MARKS,applied:NO_MARKS,
      bytes:null,attached:false,exported:null,final:false,media:++mediaCounter,settled:Promise.resolve(),frames:new Set()};
    byId.set(id,view);
    // Frozen, because a live canvas could change after review. A host converts its canvas once.
    if(typeof source?.then==='function'){
      view.settled=Promise.resolve(source).then(value=>{
        if(!byId.has(id)||disposed||removed)return;
        if(isFrozenSource(value)){view.source=value;view.status='ready';}else view.status='failed';
        changed();
      },()=>{
        if(!byId.has(id)||disposed||removed)return;
        view.status='failed';changed();
      });
    }else if(isFrozenSource(source)){view.source=source;view.status='ready';}
    else throw TypeError('A frozen Blob or ImageBitmap, or a Promise of one, is required, not a live canvas.');
  }
  let activeId=activeView??views[0].id;
  if(!byId.has(activeId))throw Error('Unknown active view.');
  // Only the ids, which outlive the views. Holding `views` here would hold every source for good.
  const knownIds=new Set(byId.keys());
  const active=()=>byId.get(activeId);
  const same=(a,b)=>a===b||(a.length===b.length&&a.every((mark,i)=>mark===b[i]));
  const isDirty=view=>!same(view.marks,view.applied);
  const anyDirty=()=>[...byId.values()].some(isDirty);
  const mediaKey=()=>removed?'removed':included?`${activeId}:${active().media}`:'left-out';
  function build(){
    if(removed)return Object.freeze({status:'removed',activeView:null,views:NO_MARKS,marks:NO_MARKS,included,edited:false,dirty:false,editsAreFinal:false,revision,canUndo:false,flattening:false,imageVersion});
    const view=active();
    return Object.freeze({status:view.status,activeView:activeId,views:Object.freeze([...byId.values()].map(({id,label,status})=>Object.freeze({id,label,status}))),
      marks:view.marks,included,edited:view.applied.length>0||view.final,dirty:isDirty(view),editsAreFinal:view.final,revision,canUndo:view.marks.length>0,flattening:flattening>0,imageVersion});
  }
  // `revision` follows the media a report would carry, never the working marks, so Cancel doesn't move it.
  function changed(){
    if(disposed)return;
    const key=mediaKey();
    if(key!==lastMedia){lastMedia=key;revision++;}
    snapshot=build();
    for(const listener of [...listeners]){try{listener(snapshot);}catch{/* Presentation cannot own state. */}}
  }
  lastMedia=mediaKey();
  snapshot=build();
  const live=()=>!disposed&&!removed;
  const flatten=(source,marks)=>flattenScreenshot(source,marks,{limits:max,raster,workerFactory,signal:abort.signal});
  function serial(task){const run=queue.then(task);queue=run.then(()=>{},()=>{});return run;}
  // Bytes land only if they're still what's wanted: a revert or the first Send tap during the flatten wins,
  // and a newer mark on a picked view flattens again, so this ends with nothing there left uncommitted.
  async function flattenMarks(pick){
    for(;;){
      if(!live())throw cancelled();
      const dirty=pick().filter(isDirty).map(view=>({view,marks:view.marks,source:view.source})),started=finality;
      if(!dirty.length)return;
      flattening++;changed();
      try{
        const done=[];
        for(const job of dirty){
          const bytes=await flatten(job.source,job.marks);
          if(typeTag(bytes)!=='Blob'||bytes===job.source)throw Error('The flattener must return new bytes.');
          done.push(bytes);
        }
        if(!live())throw cancelled();
        if(started===finality&&dirty.every(job=>job.view.marks===job.marks&&job.view.source===job.source)){
          dirty.forEach((job,i)=>{job.view.bytes=done[i];job.view.attached=false;job.view.exported=null;job.view.applied=job.marks;job.view.media=++mediaCounter;});
        }
      }finally{flattening--;changed();}
    }
  }
  // Several views can hold marks. All of them go in, or none do.
  function commit(){return serial(()=>flattenMarks(()=>[...byId.values()]));}
  const untilSettled=view=>Promise.race([view.settled,aborted]);
  const closeFrames=view=>{for(const frame of [...view.frames])frame.close();};
  // Encoded once, and those bytes are then fixed.
  async function encoded(view){
    if(view.bytes||!live()||view.status!=='ready')return view.bytes;
    const source=view.source,attached=await attachable(source,max);
    const bytes=attached?source:await flatten(source,[]);
    if(!live()||byId.get(view.id)!==view)return null;
    // Never the new source here, even after a Send tap: fitted bytes are smaller, and marks and any open
    // preview are in this source's coordinates. Only the end of reversibility changes what marks go on.
    view.bytes=bytes;view.attached=attached;
    return bytes;
  }
  const prepared=view=>serial(()=>encoded(view));
  function dropView(view){closeFrames(view);view.source=null;view.bytes=null;view.exported=null;view.marks=NO_MARKS;view.applied=NO_MARKS;}
  const exportable=view=>view.bytes&&view.bytes!==view.source?view.bytes:view.exported;
  function exported(view){
    return serial(async()=>{
      if(!live()||view.status!=='ready'||exportable(view))return live()?exportable(view):null;
      const source=view.source,bytes=await flatten(source,[]);
      if(live()&&byId.get(view.id)===view&&view.source===source)view.exported=bytes;
      return live()?exportable(view):null;
    });
  }
  // The first Send tap: the selected view's bytes become the only source and the other views go. Quiet if
  // nothing moved, so a retry after a failed save tells no one anything.
  function endHere(){
    const view=active(),final=view.final||view.applied.length>0,image=view.bytes&&view.bytes!==view.source;
    const moved=image||final!==view.final||view.marks.length>0||byId.size>1;
    finality++;
    view.final=final;
    if(image){view.source=view.bytes;imageVersion++;closeFrames(view);}
    view.marks=NO_MARKS;view.applied=NO_MARKS;view.exported=null;
    for(const other of [...byId.values()])if(other!==view){dropView(other);byId.delete(other.id);}
    if(moved)changed();
  }
  const notSent=(code,block)=>Object.freeze({ok:false,code,block,viewId:null,bytes:null,finalBytes:null,original:false,edited:false});
  // All in one turn of the queue, and the last check and finality have no await between them, so what's
  // returned is the view selected and the marks made at the moment reversibility ended.
  function beginSend(){
    return serial(async()=>{
      for(;;){
        if(disposed)return notSent('disposed',FEEDBACK_COPY.notes.cannotFinish);
        if(removed)return Object.freeze({ok:true,viewId:null,bytes:null,finalBytes:null,original:false,edited:false});
        const view=active(),marks=view.marks;
        if(view.status==='pending'&&included)return notSent('pending',FEEDBACK_COPY.notes.capturePending);
        try{
          await flattenMarks(()=>[active()]);
          if(live()&&view===active())await encoded(view);
        }catch{
          // A failure only counts if it's about what's selected now. Otherwise go round for the current state.
          if(live()&&view===active()&&view.marks===marks)return notSent('prepare-failed',FEEDBACK_COPY.notes.cannotFinish);
          continue;
        }
        if(!live()||view!==active()||isDirty(view)||(view.status==='ready'&&!view.bytes)||(view.status==='pending'&&included))continue;
        endHere();
        const finalBytes=view.status==='ready'?view.bytes:null;
        return Object.freeze({ok:true,viewId:view.id,bytes:included?finalBytes:null,finalBytes,original:Boolean(finalBytes)&&view.attached,edited:view.final});
      }
    });
  }
  // Whatever happens while waiting, the answer is about the state when it's returned: anything the tester
  // has since covered is in it, and something left out or switched away from isn't.
  async function clean(produce,current){
    for(;;){
      if(!live()||!included)return null;
      const view=active();
      await untilSettled(view);
      if(!live()||!included)return null;
      if(view!==active())continue;
      if(isDirty(view)){await commit();continue;}
      const bytes=await produce(view);
      if(!live()||!included)return null;
      if(view===active()&&!isDirty(view)&&bytes===current(view))return bytes;
    }
  }
  return Object.freeze({
    getSnapshot(){return snapshot;},
    subscribe(listener){listeners.add(listener);return ()=>{listeners.delete(listener);};},
    /** False while there's nothing to mark, or for an empty redaction. Throws on a malformed mark. */
    addMark(mark){
      const clean=cleanMark(mark);
      if(!live()||active().status!=='ready'||(clean.type==='redact'&&(clean.width===0||clean.height===0)))return false;
      const view=active();view.marks=Object.freeze([...view.marks,clean]);changed();return true;
    },
    undo(){if(!live())return;const view=active();if(!view.marks.length)return;view.marks=Object.freeze(view.marks.slice(0,-1));changed();},
    clear(){if(!live())return;const view=active();if(!view.marks.length)return;view.marks=NO_MARKS;changed();},
    /** Whether any view, not just the selected one, holds marks not yet committed. */
    hasUncommittedMarks:anyDirty,
    /** Back to the marks in each view's bytes, which is what Cancel does. */
    revert(){if(!live()||!anyDirty())return;for(const view of byId.values())view.marks=view.applied;changed();},
    setIncluded(value){if(!live()||included===Boolean(value))return;included=Boolean(value);changed();},
    /** After the first Send tap only one view is left, and the choice can't change. */
    setActiveView(id){
      if(!live()||id===activeId||(!byId.has(id)&&knownIds.has(id)))return;
      if(!byId.has(id))throw Error('Unknown view.');
      activeId=id;changed();
    },
    /** Drops every source and mark. The composer goes on with no image. */
    remove(){
      if(!live())return;
      abort.abort();
      removed=true;
      for(const view of byId.values())dropView(view);
      byId.clear();
      changed();
    },
    /** Flattens the marks. On a rejection nothing changes, and `dirty` stays true. */
    commit,
    /** The PNG to send, or null: left out, removed, or a capture that failed. Commits pending marks first. */
    bytesToSend(){return clean(prepared,view=>view.bytes);},
    /** For a local export, which isn't a Send: new flattened bytes of the selected view, never a source. */
    exportBytes(){return clean(exported,exportable);},
    /**
     * Draws the selected view for a host's own preview, so it never holds the source. Null with nothing to
     * show. Closed for it when the image changes: after the first Send tap it can't show the original.
     * Open a new one when `imageVersion` moves.
     */
    async openPreview(){
      if(!live())return null;
      const view=active();
      await untilSettled(view);
      if(!live()||view.status!=='ready'||byId.get(view.id)!==view)return null;
      const source=view.source,decoded=await decoder.decode(source);
      if(!live()||view.source!==source){decoded.close?.();return null;}
      let image=decoded.image;
      const frame=Object.freeze({width:decoded.width,height:decoded.height,
        get open(){return image!==null;},
        draw(context){
          if(image===null)return false;
          context.fillStyle='rgb(255,255,255)';context.fillRect(0,0,decoded.width,decoded.height);
          context.drawImage(image,0,0);
          return true;
        },
        close(){if(image===null)return;image=null;view.frames.delete(frame);decoded.close?.();}});
      view.frames.add(frame);
      return frame;
    },
    /**
     * The Send tap in one call: commits the selected view, prepares its bytes whether or not they're included,
     * and only then ends reversibility. If it can't, nothing has ended and no save should start.
     */
    beginSend,
    /** For a host's own order of the parts; hosts use beginSend. Throws if any view has uncommitted marks. */
    endReversibility(){
      if(!live())return;
      if(anyDirty())throw Error('Commit or revert marks before sending.');
      endHere();
    },
    /** Cancels anything in progress: a pending call rejects or resolves to nothing, and no bytes arrive late. */
    dispose(){
      if(disposed)return;
      abort.abort();
      disposed=true;listeners.clear();
      for(const view of byId.values())dropView(view);
    },
  });
}

// ---- camera: zoom in screen points per source pixel, pan is the image's top-left on the stage ----

/** Centered while smaller than the stage, otherwise no gap at an edge. */
export function clampCamera({zoom,panX,panY},image,stage){
  const limit=(pan,scaled,room)=>scaled<=room?(room-scaled)/2:Math.min(0,Math.max(room-scaled,pan));
  return {zoom,panX:limit(panX,image.width*zoom,stage.width),panY:limit(panY,image.height*zoom,stage.height)};
}
export function fitZoom(image,stage){return Math.min(stage.width/image.width,stage.height/image.height);}
export function maxZoom(image,stage){return Math.max(fitZoom(image,stage)*8,4);}
/** Zooms about a stage point, which stays over the same image point. */
export function zoomCamera(camera,factor,atX,atY,image,stage){
  const zoom=Math.min(maxZoom(image,stage),Math.max(fitZoom(image,stage),camera.zoom*factor)),ratio=zoom/camera.zoom;
  return clampCamera({zoom,panX:atX-(atX-camera.panX)*ratio,panY:atY-(atY-camera.panY)*ratio},image,stage);
}
/** From fit to a useful zoom about a point, or back to fit. */
export function toggleZoom(camera,atX,atY,image,stage){
  const fit=fitZoom(image,stage);
  if(camera.zoom>fit*1.001)return clampCamera({zoom:fit,panX:0,panY:0},image,stage);
  // Filling the short side is what makes a tall screenshot readable.
  const fill=Math.max(stage.width/image.width,stage.height/image.height);
  return zoomCamera(camera,Math.max(fill,fit*2.5)/camera.zoom,atX,atY,image,stage);
}

// ---- view ----

const CSS=`
:host{all:initial}
*{box-sizing:border-box}
[hidden]{display:none!important}
dialog.editor{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;border:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  overflow:auto;overscroll-behavior:contain;font:1rem/1.35 var(--feedback-editor-font,system-ui,sans-serif);color:var(--feedback-editor-text,#f4f4f4);background:var(--feedback-editor-background,#1c1c1e)}
dialog.editor[open]{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(38vh,1fr) auto;grid-template-areas:"bar" "stage" "panel"}
.bar{grid-area:bar;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem;padding:.5rem}
.stage{grid-area:stage;min-height:0;position:relative;background:var(--feedback-editor-stage,#262626)}
canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline-offset:-3px}
.panel{grid-area:panel;max-height:42vh;overflow:auto;display:flex;flex-direction:column;gap:.5rem;padding:.5rem;background:var(--feedback-editor-panel,#2c2c2e)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.hint,.problem{margin:0;font-size:.875rem}
.keys{position:absolute;left:.5rem;right:.5rem;bottom:.5rem;margin:0;padding:.25rem .5rem;font-size:.875rem;border-radius:var(--feedback-editor-radius,.5rem);color:#fff;background:rgba(0,0,0,.8);pointer-events:none}
.problem{color:var(--feedback-editor-danger,#ff8a80)}
button{font:inherit;min-height:2.75rem;min-width:2.75rem;padding:.25rem .75rem;border:1px solid var(--feedback-editor-border,#636366);border-radius:var(--feedback-editor-radius,.5rem);color:inherit;background:var(--feedback-editor-button,#3a3a3c);cursor:pointer}
button:disabled{opacity:.45;cursor:default}
button:focus-visible,canvas:focus-visible{outline:3px solid var(--feedback-editor-accent,#0a84ff)}
button[aria-pressed=true]{background:var(--feedback-editor-accent,#0a84ff);color:var(--feedback-editor-on-accent,#fff)}
button.primary{font-weight:600}
button.ink{width:2.75rem;padding:0;border-width:2px}
button.ink[aria-pressed=true]{outline:3px solid var(--feedback-editor-text,#f4f4f4);outline-offset:2px}
button.danger{color:var(--feedback-editor-danger,#ff8a80)}
.quiet{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
dialog.confirm{max-width:min(32rem,calc(100vw - 2rem));max-height:calc(100vh - 2rem);overflow:auto;border:1px solid var(--feedback-editor-border,#636366);border-radius:var(--feedback-editor-radius,.5rem);padding:1rem;font:inherit;color:var(--feedback-editor-text,#f4f4f4);background:var(--feedback-editor-panel,#2c2c2e)}
dialog.confirm p{margin:0 0 1rem}
@media (orientation:landscape) and (max-height:520px){
  dialog.editor[open]{grid-template-columns:minmax(0,1fr) minmax(13rem,38%);grid-template-rows:auto minmax(0,1fr);grid-template-areas:"stage bar" "stage panel"}
  .panel{max-height:none}
}
`;

// Created without markup strings, so a Trusted Types policy has nothing to object to.
function element(documentRef,tag,properties={},...children){
  const node=documentRef.createElement(tag);
  for(const [key,value] of Object.entries(properties)){
    if(key==='class')node.className=value;
    else if(key.startsWith('aria-')||key.startsWith('data-')||key==='role'||key==='tabindex')node.setAttribute(key,value);
    else node[key]=value;
  }
  node.append(...children);
  return node;
}

const mounted=new WeakMap();

/** Constructable stylesheets, which a strict CSP allows, and CompressionStream, which the flattener needs. */
export function screenshotEditorSupported(windowRef=globalThis){
  return typeof windowRef.CSSStyleSheet==='function'&&'replaceSync' in (windowRef.CSSStyleSheet.prototype??{})&&typeof windowRef.CompressionStream==='function';
}

/**
 * A full-window modal rendered inside `container`, normally the host's own dialog, so it's never portaled
 * out of it. Done or Cancel closes it, then calls `onDone` or `onCancel`, and Done with what the visit
 * opened with is Cancel. Mounting a model that's already open returns the open view.
 */
export function mountScreenshotEditor(container,{model,copy=FEEDBACK_COPY,onDone=()=>{},onCancel=()=>{}}={}){
  if(!container||typeof container.append!=='function')throw Error('A container element is required.');
  if(!model||typeof model.subscribe!=='function')throw Error('A screenshot editor model is required.');
  const open=mounted.get(model);
  if(open)return open;
  if(!model.getSnapshot().included||model.getSnapshot().status==='removed')throw Error('The editor opens only while an image is included.');
  const documentRef=container.ownerDocument??globalThis.document,windowRef=documentRef.defaultView??globalThis,words=copy.editor;
  if(!screenshotEditorSupported(windowRef))throw Error('This browser cannot run the screenshot editor.');
  const make=(tag,properties,...children)=>element(documentRef,tag,properties,...children);
  const root=make('div',{[FEEDBACK_EXCLUDE_ATTRIBUTE]:'exclude'});
  const shadow=root.attachShadow({mode:'open'});
  const sheet=new windowRef.CSSStyleSheet();sheet.replaceSync(CSS);shadow.adoptedStyleSheets=[sheet];

  // Through shadow roots, so a host's own component gets focus back on destroy.
  let previousFocus=documentRef.activeElement;
  while(previousFocus?.shadowRoot?.activeElement)previousFocus=previousFocus.shadowRoot.activeElement;
  const openedView=model.getSnapshot().activeView;
  let tool='move',ink=copy.inks.default,camera=null,bitmap=null,loadedKey=null,loadTicket=0;
  let stageSize={width:0,height:0},busy=false,problem=false,destroyed=false,onKeyboard=false,liveMark=null,cursor=null,frame=0,lastTap=null,gesture=null;
  const pointers=new Map();

  const button=(label,onclick,properties={})=>make('button',{type:'button',textContent:label,onclick,...properties});
  const cancelButton=button(copy.labels.cancel,()=>cancel(),{'data-action':'cancel'});
  const undoButton=button(copy.labels.undo,()=>undo(),{'data-action':'undo'});
  const doneButton=button(copy.labels.done,()=>done(),{class:'primary','data-action':'done'});
  const canvas=make('canvas',{tabindex:'0',role:'img'});
  // Over the image, because anything that resized the panel could move a button out from under a click.
  const keyHint=make('p',{class:'keys'});
  const stage=make('div',{class:'stage'},canvas,keyHint);
  const toolButtons=Object.fromEntries(['move','pen','redact'].map(name=>[name,button(copy.labels[name],()=>setTool(name),{'data-tool':name})]));
  const inkButtons=Object.fromEntries(['red','yellow','blue','white'].map(name=>{
    const node=button('',()=>{ink=name;render();},{class:'ink','aria-label':words[name],'data-ink':name});
    node.style.backgroundColor=`rgb(${copy.inks[name].join(',')})`;
    return [name,node];
  }));
  const zoomButtons={
    out:button('−',()=>zoomStep(1/1.5),{'aria-label':words.zoomOut,'data-zoom':'out'}),
    in:button('+',()=>zoomStep(1.5),{'aria-label':words.zoomIn,'data-zoom':'in'}),
    fit:button(words.zoomFit,()=>fit(),{'data-zoom':'fit'}),
  };
  const viewRow=make('div',{class:'row',role:'group','aria-label':words.views});
  const inkRow=make('div',{class:'row',role:'group','aria-label':words.inks},...Object.values(inkButtons));
  const zoomRow=make('div',{class:'row',role:'group','aria-label':words.zoom},zoomButtons.out,zoomButtons.in,zoomButtons.fit);
  const hint=make('p',{class:'hint'});
  const problemLine=make('p',{class:'problem',role:'alert'});
  const clearButton=button(copy.labels.clearEdits,()=>askClear(),{class:'danger','data-action':'clear'});
  const panel=make('div',{class:'panel'},viewRow,make('div',{class:'row',role:'group','aria-label':words.tools},...Object.values(toolButtons)),inkRow,zoomRow,hint,make('div',{class:'row'},clearButton),problemLine);
  const announce=make('p',{class:'quiet',role:'status'});
  const confirmText=make('p');
  const keepButton=button(copy.labels.cancel,()=>confirmDialog.close(),{'data-confirm':'keep'});
  const confirmDialog=make('dialog',{class:'confirm',role:'alertdialog'},confirmText,make('div',{class:'row'},keepButton,button(copy.labels.clearEdits,()=>{confirmDialog.close();stopGesture();model.clear();},{class:'danger','data-confirm':'clear'})));
  const dialog=make('dialog',{class:'editor','aria-label':copy.labels.title},make('div',{class:'bar'},cancelButton,undoButton,doneButton),stage,panel,announce,confirmDialog);
  shadow.append(dialog);

  const image=()=>({width:bitmap.width,height:bitmap.height});
  const schedule=()=>{if(!frame&&!destroyed)frame=windowRef.requestAnimationFrame(()=>{frame=0;draw();});};
  function draw(){
    if(destroyed)return;
    const context=canvas.getContext('2d',{alpha:false});
    const ratio=windowRef.devicePixelRatio||1,{width,height}=stageSize;
    const pixelWidth=Math.max(1,Math.round(width*ratio)),pixelHeight=Math.max(1,Math.round(height*ratio));
    if(canvas.width!==pixelWidth||canvas.height!==pixelHeight){canvas.width=pixelWidth;canvas.height=pixelHeight;}
    context.setTransform(1,0,0,1,0,0);
    context.fillStyle='rgb(38,38,38)';context.fillRect(0,0,pixelWidth,pixelHeight);
    if(!bitmap||!camera)return;
    context.setTransform(ratio*camera.zoom,0,0,ratio*camera.zoom,ratio*camera.panX,ratio*camera.panY);
    context.imageSmoothingEnabled=camera.zoom<2;
    if(!bitmap.draw(context))return;
    const marks=model.getSnapshot().marks;
    renderMarks(context,liveMark?[...marks,currentMark()]:marks,{width:bitmap.width,height:bitmap.height});
    if(cursor&&shadow.activeElement===canvas){
      context.setTransform(ratio,0,0,ratio,0,0);
      const x=cursor[0]*camera.zoom+camera.panX,y=cursor[1]*camera.zoom+camera.panY;
      context.lineWidth=1;
      for(const [color,reach] of [['rgb(0,0,0)',12],['rgb(255,255,255)',10]]){
        context.strokeStyle=color;context.beginPath();context.moveTo(x-reach,y);context.lineTo(x+reach,y);context.moveTo(x,y-reach);context.lineTo(x,y+reach);context.stroke();
      }
    }
  }
  function currentRect(){
    const [ax,ay]=liveMark.anchor,[bx,by]=liveMark.at;
    return {x:Math.min(ax,bx),y:Math.min(ay,by),width:Math.abs(bx-ax),height:Math.abs(by-ay)};
  }
  function currentMark(){
    return liveMark.kind==='pen'?{type:'pen',points:liveMark.points,width:liveMark.width,ink:liveMark.ink}:{type:'redact',...currentRect()};
  }
  function render(){
    if(destroyed)return;
    const state=model.getSnapshot(),ok=Boolean(bitmap)&&!busy,focused=shadow.activeElement;
    cancelButton.disabled=busy;
    undoButton.disabled=!state.canUndo||!ok;
    doneButton.disabled=!ok;
    clearButton.disabled=!state.canUndo||!ok;
    for(const [name,node] of Object.entries(toolButtons)){node.disabled=!ok;node.setAttribute('aria-pressed',String(tool===name));}
    for(const [name,node] of Object.entries(inkButtons)){node.disabled=!ok;node.setAttribute('aria-pressed',String(ink===name));}
    for(const node of Object.values(zoomButtons))node.disabled=!ok;
    inkRow.hidden=tool!=='pen';zoomRow.hidden=tool!=='move';
    viewRow.hidden=state.views.length<2;
    if(viewRow.childElementCount!==state.views.length)viewRow.replaceChildren(...state.views.map(({id,label})=>button(label,()=>{finishMark();stopGesture();model.setActiveView(id);},{'data-view':id})));
    for(const node of viewRow.children){node.disabled=busy;node.setAttribute('aria-pressed',String(node.dataset.view===state.activeView));}
    hint.textContent=state.status==='pending'?copy.notes.capturePending:copy.editorHints[tool];
    // Only for someone on the keyboard, who otherwise couldn't find these.
    keyHint.textContent=tool==='move'?words.keysMove:words.keysDraw;
    keyHint.hidden=!ok||!onKeyboard||shadow.activeElement!==canvas;
    problemLine.textContent=problem||state.status==='failed'?copy.notes.cannotFinish:'';problemLine.hidden=!problemLine.textContent;
    const percent=camera&&bitmap&&stageSize.width?Math.round(camera.zoom/fitZoom(image(),stageSize)*100):100;
    const summary=`${words.screenshot}, ${state.marks.length} ${state.marks.length===1?words.mark:words.marks}, ${percent}% ${words.zoom}`;
    canvas.setAttribute('aria-label',summary);
    announce.textContent=busy?copy.notes.capturePending:summary;
    // A control that's just turned off or hidden would take keyboard focus out of the editor with it.
    if(focused&&focused!==canvas&&!confirmDialog.contains(focused)&&(focused.disabled||!focused.isConnected||!focused.getClientRects().length))canvas.focus({preventScroll:true});
    schedule();
  }
  function stopGesture(){liveMark=null;gesture=null;pointers.clear();}
  // Undo takes back a mark still being made before any finished one.
  function undo(){if(liveMark){stopGesture();schedule();return;}stopGesture();model.undo();}
  function setTool(name){finishMark();stopGesture();cursor=null;tool=name;render();}
  function fit(){if(bitmap&&stageSize.width&&stageSize.height){camera=clampCamera({zoom:fitZoom(image(),stageSize),panX:0,panY:0},image(),stageSize);render();}}
  function zoomStep(factor){if(bitmap&&camera){camera=zoomCamera(camera,factor,stageSize.width/2,stageSize.height/2,image(),stageSize);render();}}
  function refit(size){
    const wasFitted=!camera||!bitmap||!stageSize.width||camera.zoom<=fitZoom(image(),stageSize)*1.001;
    stageSize=size;
    if(!bitmap||!size.width||!size.height)return render();
    if(wasFitted)return fit();
    camera=clampCamera({...camera,zoom:Math.min(maxZoom(image(),size),Math.max(fitZoom(image(),size),camera.zoom))},image(),size);
    render();
  }
  // Decoding waits for the editor to open, and the preview draws to a canvas: no blob: image is needed.
  // The old image goes at once, because a mark made on it now would land on the new one in the wrong place.
  async function load(){
    const {activeView,status,imageVersion}=model.getSnapshot(),key=`${activeView}:${status}:${imageVersion}`;
    if(key===loadedKey)return;
    loadedKey=key;
    const ticket=++loadTicket;
    stopGesture();cursor=null;
    bitmap?.close();bitmap=null;camera=null;problem=false;
    render();
    if(status!=='ready')return;
    try{
      const frame=await model.openPreview();
      if(ticket!==loadTicket||destroyed)return frame?.close();
      if(!frame)return;
      bitmap=frame;
      fit();render();
    }catch{
      if(ticket!==loadTicket||destroyed)return;
      problem=true;render();
    }
  }
  const unsubscribe=model.subscribe(state=>{
    if(state.status==='removed')return close(onCancel);
    void load();render();
  });

  function stagePoint(event){const box=canvas.getBoundingClientRect();return [event.clientX-box.left,event.clientY-box.top];}
  function imagePoint([x,y]){
    return [Math.min(bitmap.width,Math.max(0,(x-camera.panX)/camera.zoom)),Math.min(bitmap.height,Math.max(0,(y-camera.panY)/camera.zoom))];
  }
  function beginMark(point){
    liveMark=tool==='pen'
      ?{kind:'pen',points:[point],width:penWidth(camera.zoom,fitZoom(image(),stageSize)),ink}
      :{kind:'redact',anchor:point,at:point};
    schedule();
  }
  function extendMark(point){
    if(liveMark.kind==='pen'){
      const last=liveMark.points.at(-1);
      if(Math.hypot(point[0]-last[0],point[1]-last[1])>=1/camera.zoom)liveMark.points.push(point);
    }else liveMark.at=point;
    schedule();
  }
  function finishMark(){
    const finished=liveMark;
    if(!finished)return;
    if(finished.kind==='pen')model.addMark(currentMark());
    else{
      const rect=currentRect();
      // A stray tap isn't a redaction, and two screen points is thin enough to cover a line of text.
      if(rect.width*camera.zoom>=2&&rect.height*camera.zoom>=2)model.addMark({type:'redact',...rect});
    }
    liveMark=null;schedule();
  }
  const capture=id=>{try{canvas.setPointerCapture?.(id);}catch{/* Already released. */}};
  canvas.addEventListener('pointerdown',event=>{
    if(!bitmap||!camera||busy||(event.pointerType==='mouse'&&event.button!==0))return;
    event.preventDefault();canvas.focus({preventScroll:true});cursor=null;
    if(tool==='move'){
      pointers.set(event.pointerId,stagePoint(event));
      capture(event.pointerId);
      if(pointers.size===1)gesture={kind:'pan',moved:0,last:stagePoint(event)};
      else if(pointers.size===2){
        const [a,b]=[...pointers.values()];
        gesture={kind:'pinch',distance:Math.hypot(a[0]-b[0],a[1]-b[1]),middle:[(a[0]+b[0])/2,(a[1]+b[1])/2]};lastTap=null;
      }
      return;
    }
    // One finger only: a second starts nothing, and zoom stays off under Pen and Redact.
    if(gesture)return;
    gesture={kind:'draw',pointerId:event.pointerId};
    capture(event.pointerId);
    beginMark(imagePoint(stagePoint(event)));
  });
  canvas.addEventListener('pointermove',event=>{
    if(!gesture||!bitmap||!camera)return;
    const at=stagePoint(event);
    if(gesture.kind==='draw'){if(event.pointerId===gesture.pointerId&&liveMark)extendMark(imagePoint(at));return;}
    if(!pointers.has(event.pointerId))return;
    pointers.set(event.pointerId,at);
    if(gesture.kind==='pan'){
      gesture.moved+=Math.hypot(at[0]-gesture.last[0],at[1]-gesture.last[1]);
      camera=clampCamera({...camera,panX:camera.panX+at[0]-gesture.last[0],panY:camera.panY+at[1]-gesture.last[1]},image(),stageSize);
      gesture.last=at;render();
    }else if(pointers.size===2){
      const [a,b]=[...pointers.values()],distance=Math.hypot(a[0]-b[0],a[1]-b[1]),middle=[(a[0]+b[0])/2,(a[1]+b[1])/2];
      if(gesture.distance>0&&distance>0)camera=zoomCamera(camera,distance/gesture.distance,middle[0],middle[1],image(),stageSize);
      camera=clampCamera({...camera,panX:camera.panX+middle[0]-gesture.middle[0],panY:camera.panY+middle[1]-gesture.middle[1]},image(),stageSize);
      gesture.distance=distance;gesture.middle=middle;render();
    }
  });
  function pointerEnd(event){
    if(!gesture)return;
    if(gesture.kind==='draw'){
      if(event.pointerId!==gesture.pointerId)return;
      gesture=null;
      if(event.type==='pointerup')finishMark();else{liveMark=null;schedule();}
      return;
    }
    if(!pointers.delete(event.pointerId))return;
    if(gesture.kind==='pan'&&event.type==='pointerup'&&gesture.moved<8&&bitmap&&camera){
      const [x,y]=stagePoint(event),now=event.timeStamp;
      if(lastTap&&now-lastTap.time<350&&Math.hypot(x-lastTap.x,y-lastTap.y)<32){
        camera=toggleZoom(camera,x,y,image(),stageSize);lastTap=null;render();
      }else lastTap={x,y,time:now};
    }
    if(!pointers.size)gesture=null;
    else if(pointers.size===1){const [only]=pointers.values();gesture={kind:'pan',moved:8,last:only};}
  }
  canvas.addEventListener('pointerup',pointerEnd);
  canvas.addEventListener('pointercancel',pointerEnd);
  canvas.addEventListener('lostpointercapture',event=>{if(gesture?.kind==='draw'&&event.pointerId===gesture.pointerId)pointerEnd(event);});
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();
    if(tool!=='move'||!bitmap||!camera||busy)return;
    const [x,y]=stagePoint(event),pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?stageSize.height:1);
    camera=zoomCamera(camera,Math.exp(-pixels*(event.ctrlKey?.01:.002)),x,y,image(),stageSize);
    render();
  },{passive:false});
  // The keyboard makes the same marks as a drag: arrows move a crosshair, Space or Enter starts and ends.
  canvas.addEventListener('keydown',event=>{
    if(!bitmap||!camera||busy)return;
    const step=(event.shiftKey?5:1)*(tool==='move'?32:8);
    const delta={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[event.key];
    if(tool==='move'){
      if(delta)camera=clampCamera({...camera,panX:camera.panX-delta[0],panY:camera.panY-delta[1]},image(),stageSize);
      else if(event.key==='+'||event.key==='=')camera=zoomCamera(camera,1.5,stageSize.width/2,stageSize.height/2,image(),stageSize);
      else if(event.key==='-'||event.key==='_')camera=zoomCamera(camera,1/1.5,stageSize.width/2,stageSize.height/2,image(),stageSize);
      else if(event.key==='0')camera=clampCamera({zoom:fitZoom(image(),stageSize),panX:0,panY:0},image(),stageSize);
      else return;
      event.preventDefault();render();
      return;
    }
    if(!delta&&event.key!==' '&&event.key!=='Enter')return;
    event.preventDefault();
    cursor??=imagePoint([stageSize.width/2,stageSize.height/2]);
    if(delta){
      cursor=[Math.min(bitmap.width,Math.max(0,cursor[0]+delta[0]/camera.zoom)),Math.min(bitmap.height,Math.max(0,cursor[1]+delta[1]/camera.zoom))];
      if(liveMark)extendMark(cursor);
    }else if(liveMark)finishMark();
    else beginMark(cursor);
    schedule();
  });
  canvas.addEventListener('focus',render);
  canvas.addEventListener('blur',render);

  function askClear(){
    const state=model.getSnapshot();
    if(!state.canUndo||busy)return;
    confirmText.textContent=state.editsAreFinal?copy.confirm.clearFinal:copy.confirm.clearReversible;
    confirmDialog.showModal();keepButton.focus();
  }
  function close(callback){
    destroy();
    try{callback();}catch{/* Presentation cannot own lifecycle. */}
  }
  function cancel(){
    if(busy)return;
    model.revert();
    try{model.setActiveView(openedView);}catch{/* That view is gone. */}
    close(onCancel);
  }
  async function done(){
    if(busy||!bitmap)return;
    // What's on screen is what the tester means, so a mark still being made goes in rather than vanishing.
    finishMark();
    stopGesture();
    const state=model.getSnapshot();
    if(!model.hasUncommittedMarks()&&state.activeView===openedView)return close(onCancel);
    busy=true;problem=false;render();
    try{
      await model.commit();
      if(!destroyed)close(onDone);
    }catch{
      if(destroyed)return;
      busy=false;problem=true;render();
    }
  }
  // Consumed here, so a host's composer never sees it: it stops a mark, or cancels only this visit.
  function escape(){
    if(confirmDialog.open)return confirmDialog.close();
    if(liveMark){stopGesture();schedule();return;}
    cancel();
  }
  // Tab cycles here, and moves focus itself: Safari's own Tab skips buttons, and a modal's would leave for the browser's controls.
  function keepTab(event){
    const scope=confirmDialog.open?confirmDialog:dialog;
    const stops=[...scope.querySelectorAll('button,canvas')].filter(node=>!node.disabled&&node.getClientRects().length&&(scope===confirmDialog||!confirmDialog.contains(node)));
    if(!stops.length)return;
    event.preventDefault();
    const at=stops.indexOf(shadow.activeElement),step=event.shiftKey?-1:1;
    stops[at<0?(event.shiftKey?stops.length-1:0):(at+step+stops.length)%stops.length].focus();
  }
  dialog.addEventListener('pointerdown',()=>{if(onKeyboard){onKeyboard=false;render();}},{capture:true});
  dialog.addEventListener('keydown',event=>{
    if(!onKeyboard){onKeyboard=true;render();}
    if(event.key==='Tab')keepTab(event);
    else if(event.key==='Escape'){event.preventDefault();escape();}
    else if((event.metaKey||event.ctrlKey)&&!event.shiftKey&&event.key.toLowerCase()==='z'&&!confirmDialog.open&&!busy){event.preventDefault();undo();}
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();event.stopPropagation();escape();});
  // A browser can force a modal closed. It stays open until Done or Cancel says otherwise.
  dialog.addEventListener('close',event=>{event.stopPropagation();if(!destroyed&&!dialog.open)dialog.showModal();});
  // Game input is the host's to suspend, but nothing from here should reach it anyway.
  for(const type of ['keydown','keyup','keypress','pointerdown','pointermove','pointerup','pointercancel','wheel','click','dblclick','contextmenu','touchstart','touchmove','touchend','mousedown','mouseup','mousemove'])
    root.addEventListener(type,event=>event.stopPropagation());
  const observer=new windowRef.ResizeObserver(([entry])=>refit({width:entry.contentRect.width,height:entry.contentRect.height}));

  function destroy(){
    if(destroyed)return;
    destroyed=true;
    loadTicket++;
    if(frame)windowRef.cancelAnimationFrame(frame);
    observer.disconnect();unsubscribe();
    bitmap?.close();bitmap=null;
    if(confirmDialog.open)confirmDialog.close();
    if(dialog.open)dialog.close();
    root.remove();
    mounted.delete(model);
    if(previousFocus?.isConnected)previousFocus.focus?.({preventScroll:true});
  }
  const view=Object.freeze({destroy,root});
  mounted.set(model,view);
  container.append(root);
  dialog.showModal();
  canvas.focus({preventScroll:true});
  stageSize={width:stage.clientWidth,height:stage.clientHeight};
  observer.observe(stage);
  render();
  void load();
  return view;
}
