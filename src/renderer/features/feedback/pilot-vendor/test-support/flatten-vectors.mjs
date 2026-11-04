// Reads PNG bytes directly and applies tests/fixtures/screenshot-flatten-v1.json. Runs in Node and in a
// real browser page, so a browser's own image decoder can't hide what the file really holds.
const SIGNATURE=[137,80,78,71,13,10,26,10];

export function pngChunks(bytes){
  if(!SIGNATURE.every((byte,i)=>bytes[i]===byte))throw Error('Not a PNG.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),chunks=[];
  for(let at=8;at<bytes.length;){
    const length=view.getUint32(at),type=String.fromCharCode(...bytes.subarray(at+4,at+8));
    chunks.push({type,data:bytes.subarray(at+8,at+8+length)});
    at+=12+length;
  }
  return chunks;
}

/** RGB pixels from an 8-bit color type 2 PNG, without a browser decoder involved. */
export async function readRgbPng(blob){
  const bytes=new Uint8Array(await blob.arrayBuffer()),chunks=pngChunks(bytes),header=chunks[0].data;
  const view=new DataView(header.buffer,header.byteOffset,header.byteLength);
  const width=view.getUint32(0),height=view.getUint32(4),depth=header[8],colorType=header[9];
  if(depth!==8||colorType!==2)return {width,height,depth,colorType,chunks,bytes,pixels:null};
  const stream=new Blob(chunks.filter(chunk=>chunk.type==='IDAT').map(chunk=>chunk.data)).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw=new Uint8Array(await new Response(stream).arrayBuffer()),stride=width*3,pixels=new Uint8Array(stride*height);
  for(let y=0;y<height;y++){
    const filter=raw[y*(stride+1)],from=y*(stride+1)+1,to=y*stride;
    for(let i=0;i<stride;i++){
      const a=i>=3?pixels[to+i-3]:0,b=y?pixels[to-stride+i]:0,c=y&&i>=3?pixels[to-stride+i-3]:0;
      let predicted=0;
      if(filter===1)predicted=a;
      else if(filter===2)predicted=b;
      else if(filter===3)predicted=(a+b)>>1;
      else if(filter===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);predicted=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
      pixels[to+i]=(raw[from+i]+predicted)&255;
    }
  }
  return {width,height,depth,colorType,chunks,bytes,pixels,at:(x,y)=>[...pixels.subarray((y*width+x)*3,(y*width+x)*3+3)]};
}

/** RGBA pixels for a vector's source pattern. */
export function patternPixels({width,height,pattern}){
  const data=new Uint8ClampedArray(width*height*4);
  if(pattern.kind==='noise'){
    let x=pattern.seed>>>0;
    for(let i=0;i<data.length;i+=4){
      x^=x<<13;x>>>=0;x^=x>>>17;x^=x<<5;x>>>=0;
      data[i]=x&255;data[i+1]=(x>>>8)&255;data[i+2]=(x>>>16)&255;data[i+3]=255;
    }
    return data;
  }
  for(let y=0,i=0;y<height;y++)for(let x=0;x<width;x++,i+=4){
    const color=pattern.kind==='solid'?pattern.color
      :pattern.kind==='stripes'?pattern.colors[Math.floor(x/pattern.size)%2]
      :pattern.kind==='halves'?pattern.colors[x<Math.floor(width/2)?0:1]:null;
    if(!color)throw Error('Unknown pattern.');
    data[i]=color[0];data[i+1]=color[1];data[i+2]=color[2];data[i+3]=color[3];
  }
  return data;
}

/** Everything wrong with a flattened output, per the fixture's checks. Empty means it passes. */
export async function vectorFailures(fixture,vector,output){
  const failures=[],limits={...fixture.limits,...vector.limits},{source}=vector;
  const png=await readRgbPng(output);
  if(output.size>limits.maxBytes)failures.push(`${output.size} bytes is over ${limits.maxBytes}`);
  if(output.type!=='image/png')failures.push(`type ${output.type}`);
  for(const {type} of png.chunks)if(!fixture.allowedChunks.includes(type))failures.push(`chunk ${type}`);
  if(!fixture.allowedColorTypes.includes(png.colorType)||png.depth!==8)failures.push(`color type ${png.colorType} depth ${png.depth}`);
  if(png.width>limits.maxSide||png.height>limits.maxSide||png.width*png.height>limits.maxPixels)failures.push(`${png.width}x${png.height} is over the limits`);
  const smaller=png.width<source.width||png.height<source.height;
  if(vector.expect.fitDown!==smaller)failures.push(`fitDown ${smaller} at ${png.width}x${png.height}`);
  if(source.metadataText&&new TextDecoder('latin1').decode(png.bytes).includes(source.metadataText))failures.push('source metadata survived');
  if(!png.pixels)return failures;
  const sx=png.width/source.width,sy=png.height/source.height;
  for(const mark of vector.marks){
    if(mark.type!=='redact')continue;
    const left=Math.max(0,Math.floor(mark.x*sx)),right=Math.min(png.width,Math.ceil((mark.x+mark.width)*sx));
    const top=Math.max(0,Math.floor(mark.y*sy)),bottom=Math.min(png.height,Math.ceil((mark.y+mark.height)*sy));
    let leaks=0;
    for(let y=top;y<bottom;y++)for(let i=(y*png.width+left)*3,end=(y*png.width+right)*3;i<end;i++)if(png.pixels[i]!==0)leaks++;
    if(leaks)failures.push(`${leaks} channel values aren't black in a redaction at ${left},${top}`);
  }
  for(const {x,y,rgb,tolerance=0} of vector.expect.probes??[]){
    const got=png.at(Math.floor(x*sx),Math.floor(y*sy));
    if(got.some((value,i)=>Math.abs(value-rgb[i])>tolerance))failures.push(`probe ${x},${y}: ${got} not ${rgb}`);
  }
  return failures;
}

const crcOf=bytes=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let k=0;k<8;k++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}return (crc^0xffffffff)>>>0;};
/** The same PNG with a tEXt chunk just before its first IDAT. */
export function withTextChunk(bytes,text){
  const chunks=pngChunks(bytes),keyword=new TextEncoder().encode(`Comment\0${text}`);
  const body=new Uint8Array(keyword.length+4);body.set(new TextEncoder().encode('tEXt'));body.set(keyword,4);
  const chunk=new Uint8Array(body.length+8),view=new DataView(chunk.buffer);
  view.setUint32(0,keyword.length);chunk.set(body,4);view.setUint32(body.length+4,crcOf(body));
  let at=8;
  for(const {type,data} of chunks){if(type==='IDAT')break;at+=12+data.length;}
  const out=new Uint8Array(bytes.length+chunk.length);
  out.set(bytes.subarray(0,at));out.set(chunk,at);out.set(bytes.subarray(at),at+chunk.length);
  return out;
}
