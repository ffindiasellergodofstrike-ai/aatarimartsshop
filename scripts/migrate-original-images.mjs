"use strict";
// One-time, audited ATTIRE MART photo migration.
// Fetch exact original product photos and store optimized WebP assets in Git.
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import sharp from "sharp";

const root=process.cwd();
const dataDir=path.join(root,"data"),mediaDir=path.join(root,"media");
const files=["01","02","03","04"].map(i=>"part-"+i+".json");
const catalogs=await Promise.all(files.map(async file=>JSON.parse(await fs.readFile(path.join(dataDir,file),"utf8"))));
const catalog=JSON.parse(await fs.readFile(path.join(dataDir,"checkout-catalog.json"),"utf8"));
const allowed=/^https:\/\/cdn\.shopify\.com\/s\/files\/1\/1042\/1220\/1653\/files\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)\?v=\d+$/;
// The catalogue stores the exact, authorised originals even after its public
// image paths have been converted to /media/*.webp. Recover incomplete uploads
// from this map without substituting any other product's photo.
const originalSources=new Map();
for(const shard of catalogs)for(const [local,url] of Object.entries(shard.sources||{})){
 if(!/^\\/media\\/[A-Za-z0-9._-]+\\.webp$/.test(local)||!allowed.test(url))
  throw Error("Invalid original image mapping: "+local);
 const filename=path.posix.basename(new URL(url).pathname).replace(/\\.(jpg|jpeg|png|webp)$/i,".webp");
 if(local!=="/media/"+filename)throw Error("Original image filename mismatch: "+local);
 const prior=originalSources.get(local);
 if(prior&&prior!==url)throw Error("Conflicting original image mapping: "+local);
 originalSources.set(local,url);
}
const requested=new Map();
const assetPath=url=>{
 if(typeof url!=="string")throw Error("Missing image source");
 if(url.startsWith("/media/")){
  if(!/^\/media\/[A-Za-z0-9._-]+\.webp$/.test(url))throw Error("Invalid local image "+url);
  const original=originalSources.get(url);
  if(!original)throw Error("Missing approved image origin for "+url);
  const previous=requested.get(url);
  if(previous&&previous!==original)throw Error("Conflicting source for "+url);
  requested.set(url,original);
  return url;
 }
 if(!allowed.test(url))throw Error("Unapproved image origin "+url);
 const original=path.posix.basename(new URL(url).pathname);
 const local="/media/"+original.replace(/\.(jpg|jpeg|png|webp)$/i,".webp");
 const existing=requested.get(local);
 if(existing&&existing!==url)throw Error("Filename collision: "+local);
 requested.set(local,url);
 return local;
};
for(const shard of catalogs)for(const p of Object.values(shard.products||{})){
 for(const image of p.images||[])assetPath(image.src);
 for(const variant of p.variants||[])assetPath(variant.image);
}
for(const v of Object.values(catalog.variants))assetPath(v.image);
await fs.mkdir(mediaDir,{recursive:true});
const queue=[...requested.entries()];
if(queue.length!==1112)throw Error("Expected 1112 unique original catalogue images; found "+queue.length);
let downloaded=0,skipped=0,bytes=0,failures=[];
async function download([local,url]){
 const dest=path.join(root,local.slice(1));
 try{
  try{
   const existing=await fs.stat(dest);
   if(existing.size>2500){
    const info=await sharp(dest).metadata();
    if(info.width>=200&&info.height>=200&&info.format==="webp"){skipped++;return}
   }
  }catch{}
  let lastError;
  for(let attempt=1;attempt<=5;attempt++){
   try{
    const response=await fetch(url,{signal:AbortSignal.timeout(35000),headers:{"user-agent":"ATTIRE-MART-Catalogue-Asset-Migration/1.0","accept":"image/avif,image/webp,image/jpeg,image/png"}});
    if(!response.ok)throw Error("HTTP "+response.status+" "+url);
    const contentType=response.headers.get("content-type")||"";
    if(!contentType.startsWith("image/"))throw Error("Non-image source: "+contentType);
    const source=Buffer.from(await response.arrayBuffer());
    if(source.length<2500||source.length>16000000)throw Error("Unexpected image size "+source.length);
    const result=await sharp(source,{failOn:"error"}).rotate()
      .resize({width:960,height:1280,fit:"inside",withoutEnlargement:true})
      .webp({quality:80,effort:5}).toBuffer();
    const meta=await sharp(result).metadata();
    if(meta.format!=="webp"||meta.width<200||meta.height<200)throw Error("Converted image invalid "+url);
    const temp=dest+".incomplete";
    await fs.writeFile(temp,result);await fs.rename(temp,dest);
    downloaded++;bytes+=result.length;
    if(downloaded%80===0)console.log("Downloaded",downloaded,"of",queue.length,"new photos");
    return;
   }catch(e){lastError=e;if(attempt<5)await new Promise(resolve=>setTimeout(resolve,800*attempt*attempt))}
  }
  throw lastError;
 }catch(e){failures.push({image:local,error:String(e.message||e)});}
}
let index=0;
await Promise.all(Array.from({length:8},async()=>{while(index<queue.length){const job=queue[index++];await download(job)}}));
if(failures.length)throw Error("Image migration aborted: "+JSON.stringify(failures.slice(0,20)));
const unique=new Set(),seen=new Map(),originalSnapshots=new Map();
let imageRefs=0,variantCount=0,removedDuplicates=0;
for(let i=0;i<catalogs.length;i++){
 const shard=catalogs[i];
 for(const [handle,p] of Object.entries(shard.products||{})){
  if(unique.has(handle)){
   // Earlier catalogue shards already contain exactly the same product.
   if(originalSnapshots.get(handle)!==JSON.stringify(p))throw Error("Non-identical duplicated product "+handle);
   delete shard.products[handle];removedDuplicates++;continue;
  }
  unique.add(handle);originalSnapshots.set(handle,JSON.stringify(p));seen.set(handle,p);
  for(const image of p.images){image.src=assetPath(image.src);imageRefs++;}
  for(const v of p.variants){v.image=assetPath(v.image);variantCount++;}
  if(p.variants.some(v=>!p.images.some(image=>image.src===v.image)))throw Error("Variant gallery mismatch "+handle);
 }
}
for(const v of Object.values(catalog.variants)){
 const p=seen.get(v.handle);
 const matched=p?.variants.find(x=>String(x.id)===String(v.id));
 if(!matched)throw Error("Checkout variant not found in product "+v.id);
 v.image=matched.image;
}
if(unique.size!==184||imageRefs!==1112||variantCount!==878||removedDuplicates>28){
 throw Error("Catalogue integrity check failed "+JSON.stringify({products:unique.size,imageRefs,variantCount,removedDuplicates}));
}
for(const p of seen.values())for(const img of p.images){
 if(!img.src.startsWith("/media/"))throw Error("Remote image survives: "+p.handle);
 const dest=path.join(root,img.src.slice(1));
 const st=await fs.stat(dest);
 if(st.size<2500)throw Error("Small or missing product image "+p.handle);
 const meta=await sharp(dest,{failOn:"error"}).metadata();
 if(meta.format!=="webp"||meta.width<200||meta.height<200)throw Error("Undecodable product photo "+p.handle);
}
for(let i=0;i<files.length;i++)await fs.writeFile(path.join(dataDir,files[i]),JSON.stringify(catalogs[i]));
await fs.writeFile(path.join(dataDir,"checkout-catalog.json"),JSON.stringify(catalog));
await fs.writeFile(path.join(dataDir,"local-media-lock.json"),JSON.stringify({
 version:1,products:184,photos:1112,variants:878,remoteSources:0,
 imagePathDigest:createHash("sha256").update([...new Set([...seen.values()].flatMap(p=>p.images.map(i=>i.src)))].sort().join("\n")).digest("hex")
}));

console.log("SUCCESS: 184 unique products, 1112 local photos, 878 variants,",removedDuplicates,"redundant records removed.");
console.log("Image files downloaded:",downloaded,"already local:",skipped,"new bytes:",bytes,"external dependencies in product catalog: 0");
