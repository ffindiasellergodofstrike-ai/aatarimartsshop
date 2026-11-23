"use strict";
import fs from "node:fs";
import assert from "node:assert/strict";
const shards=["01","02","03","04"].map(id=>JSON.parse(fs.readFileSync("data/part-"+id+".json","utf8")));
const products=Object.assign({},...shards.map(p=>p.products));
const checkout=JSON.parse(fs.readFileSync("data/checkout-catalog.json","utf8")).variants;
const media=new Set(fs.readdirSync("media").map(name=>"/media/"+name));
const cdn=/^https:\/\/cdn\.shopify\.com\/s\/files\/1\/1042\/1220\/1653\/files\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)\?v=\d+$/;
const strictlyLocal=fs.existsSync("data/local-media-lock.json");
const good=src=>typeof src==="string"&&(media.has(src)||(!strictlyLocal&&cdn.test(src)));
let images=0,variants=0,colors=0,remote=0;
for(const [handle,p] of Object.entries(products)){
 assert.equal(p.handle,handle,"Product handle mismatch");
 assert.ok(p.images?.length>0,"Missing product gallery: "+handle);
 const gallery=new Set();
 for(const img of p.images){
  assert.ok(good(img.src),"Missing photo or untrusted URL: "+handle+" "+img.src);
  assert.ok(!gallery.has(img.src),"Duplicate photo: "+handle+" "+img.src);
  gallery.add(img.src);images++;if(img.src.startsWith("https:"))remote++;
 }
 for(const v of p.variants){
  variants++;
  assert.ok(gallery.has(v.image),"Wrong colour/size photo: "+handle+" / "+v.id);
  assert.equal(checkout[v.id]?.handle,handle,"Checkout product mismatch: "+v.id);
  assert.equal(checkout[v.id]?.image,v.image,"Checkout colour image mismatch: "+v.id);
  for(const [key,value] of Object.entries(v.options||{}))
   assert.ok(p.options.some(o=>o.name===key&&o.values.includes(value)),"Invalid option: "+handle+" "+key+"="+value);
 }
 for(const o of p.options.filter(o=>o.name==="Color"))for(const value of o.values){
  const choices=p.variants.filter(v=>v.options.Color===value);
  assert.ok(choices.length&&choices.every(v=>gallery.has(v.image)),"Color-specific photo not mapped: "+handle+" / "+value);
  colors++;
 }
}
assert.equal(Object.keys(products).length,184,"Product count changed");
assert.equal(images,1112,"Image count changed");
assert.equal(variants,878,"Variant count changed");
assert.equal(variants,Object.keys(checkout).length,"Server checkout variant count changed");
if(strictlyLocal){
 assert.equal(remote,0,"All original images must be hosted locally");
 assert.equal(media.size,1112,"1112 actual media files must be present");
 for(const src of media){
  const file=fs.readFileSync(src.slice(1));
  assert.ok(file.length>2500&&file.toString("ascii",0,4)==="RIFF"&&file.toString("ascii",8,12)==="WEBP","Corrupt WebP file: "+src);
 }
 const manifest=JSON.parse(fs.readFileSync("data/local-media-lock.json","utf8"));
 assert.equal(manifest.photos,1112);assert.equal(manifest.remoteSources,0);
}
console.log("PASS: "+Object.keys(products).length+" products, "+images+" exact images, "+variants+" variants, "+colors+" color options, "+remote+" CDN images and "+media.size+" locally hosted image files.");
