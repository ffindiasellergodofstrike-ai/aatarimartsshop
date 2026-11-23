"use strict";
import fs from "node:fs";
import path from "node:path";

const root=process.cwd(),out=path.join(root,"publish");
const fileList=["index.html","app.js","checkout.js","styles.css","favicon.svg","fallback.svg"];
const dirs=["assets","media"];
const dataFiles=["pages.json","part-01.json","part-02.json","part-03.json","part-04.json"];
fs.rmSync(out,{recursive:true,force:true});
fs.mkdirSync(out,{recursive:true});
for(const name of fileList){
 const src=path.join(root,name);
 if(!fs.existsSync(src))throw Error("Required storefront file missing: "+name);
 fs.copyFileSync(src,path.join(out,name));
}
for(const name of dirs){
 const src=path.join(root,name);
 if(!fs.existsSync(src))throw Error("Required public asset directory missing: "+name);
 fs.cpSync(src,path.join(out,name),{recursive:true});
}
fs.mkdirSync(path.join(out,"data"),{recursive:true});
for(const name of dataFiles){
 const src=path.join(root,"data",name);
 if(!fs.existsSync(src))throw Error("Required browser catalogue shard missing: "+name);
 fs.copyFileSync(src,path.join(out,"data",name));
}
const mediaFiles=fs.readdirSync(path.join(out,"media")).filter(x=>x.endsWith(".webp"));
if(!mediaFiles.length)throw Error("No media assets were published");

/* Safeguard exact product photography and variant mapping.
   Gallery order must be preserved; never silently swap in another product. */
const localImages=new Set(mediaFiles.map(name=>"/media/"+name));
const allowedCDN=/^https:\/\/cdn\.shopify\.com\/s\/files\/1\/1042\/1220\/1653\/files\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)\?v=\d+$/;
const strictlyLocal=fs.existsSync(path.join(root,"data","local-media-lock.json"));
const validPhoto=src=>typeof src==="string"&&(localImages.has(src)||(!strictlyLocal&&allowedCDN.test(src)));
const knownProducts=new Set();
let photoCount=0,variantCount=0;
for(const name of dataFiles.filter(name=>/^part-\d+\.json$/.test(name))){
 const data=JSON.parse(fs.readFileSync(path.join(out,"data",name),"utf8"));
 for(const p of Object.values(data.products||{})){
  if(knownProducts.has(p.handle))continue;
  knownProducts.add(p.handle);
  if(!Array.isArray(p.images)||!p.images.length)throw Error("Product without photos: "+p.handle);
  const gallery=new Set();
  for(const img of p.images){
   if(!validPhoto(img.src)||gallery.has(img.src))throw Error("Invalid or duplicate product photo: "+p.handle+" "+img.src);
   gallery.add(img.src);photoCount++;
  }
  for(const v of p.variants||[]){
   variantCount++;
   if(!validPhoto(v.image)||!gallery.has(v.image))throw Error("Variant photo does not match gallery: "+p.handle+" / "+v.id);
   for(const [key,value] of Object.entries(v.options||{})){
    if(!p.options?.some(o=>o.name===key&&o.values.includes(value)))throw Error("Variant option mismatch: "+p.handle+" / "+v.id);
   }
  }
 }
}
if(knownProducts.size!==184||photoCount!==1112||variantCount!==878)throw Error("Catalogue lost products or original photos");
if(strictlyLocal&&localImages.size!==1112)throw Error("Local media migration is incomplete or assets are missing");
console.log("Photo mapping verified:",knownProducts.size,"products,",photoCount,"real photos,",variantCount,"variants,",localImages.size,"self-hosted media files.");

await import("./build-seo.mjs");
const { buildPrivateCheckoutBundle } = await import("../lib/private-checkout-bundle.mjs");
await buildPrivateCheckoutBundle({ force: true });
for(const forbidden of ["api","lib","dist-private","attirecheckout","data/checkout-catalog.json","firebase-applet-config.json","firestore.rules","server.mjs",".env"]){
 if(fs.existsSync(path.join(out,forbidden)))throw Error("Private source leaked into publish/: "+forbidden);
}
console.log("Vercel static output ready: "+mediaFiles.length+" real WebP images, public JSON catalogue, SEO pages, CSS and logo; private APIs remain outside publish/.");
