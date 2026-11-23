"use strict";
import fs from "node:fs";
import path from "node:path";
import {chromium,firefox,webkit} from "playwright";
import {startStoreServer,captureGeometry,assertGeometry} from "./qa-server.mjs";
const errors=[],counts={widths:0,routes:0,seo:0};
const sitemap=fs.readFileSync("publish/sitemap.xml","utf8");
const publicUrls=[...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>new URL(m[1]).pathname);
if(publicUrls.length!==216)errors.push({issue:"sitemap-url-count",expected:216,actual:publicUrls.length});
for(const uri of publicUrls){
 const file=uri==="/"?path.join("publish","index.html"):path.join("publish",uri.slice(1),"index.html");
 if(!fs.existsSync(file))errors.push({issue:"missing-seo-html",uri});
}
const robots=fs.readFileSync("publish/robots.txt","utf8");
if(!robots.includes("Disallow: /api/")||!robots.includes("sitemap.xml"))errors.push({issue:"robots-noindex-or-sitemap"});
counts.seo=publicUrls.length;
fs.mkdirSync("qa-screenshots",{recursive:true});
const srv=await startStoreServer();
try{
 // Validate every actual photo served by the site's own static HTTP server,
 // not just the shape of an image URL or one hero thumbnail.
 const shards=["01","02","03","04"].map(id=>JSON.parse(fs.readFileSync("data/part-"+id+".json","utf8")));
 const localPhotos=[...new Set(shards.flatMap(s=>Object.values(s.products||{})
  .flatMap(p=>p.images.map(image=>image.src))))];
 if(localPhotos.length!==1112)errors.push({issue:"local-image-count",count:localPhotos.length});
 let photoCursor=0;
 await Promise.all(Array.from({length:16},async()=>{
  while(photoCursor<localPhotos.length){
   const src=localPhotos[photoCursor++];
   if(!/^\/media\/[A-Za-z0-9._-]+\.webp$/.test(src)){
    errors.push({issue:"external-or-bad-product-photo",src});continue;
   }
   try{
    const response=await fetch(srv.origin+src,{method:"HEAD",signal:AbortSignal.timeout(10000)});
    if(response.status!==200||!(response.headers.get("content-type")||"").startsWith("image/webp"))
     errors.push({issue:"broken-product-photo-http",src,status:response.status,type:response.headers.get("content-type")});
   }catch(error){errors.push({issue:"product-photo-http-error",src,error:String(error)});}
  }
 }));
 if(errors.some(e=>String(e.issue).includes("photo")))throw Error("Static media HTTP audit failed: "+JSON.stringify(errors.slice(0,20)));
 console.log("PASS:",localPhotos.length,"product photos served as local image/webp HTTP 200 responses.");
 for(const [engine,adapter] of Object.entries({chromium,firefox,webkit})){
  const browser=await adapter.launch();
  try{
   const widths=[280,320,360,375,390,430,540,650,768,820,912,1024,1180,1200,1280,1366,1440,1536,1920,2560,3840];
   for(const width of widths){
    const page=await browser.newPage({viewport:{width,height:860}});
    page.on("pageerror",e=>errors.push({engine,width,issue:"browser-error",message:e.message}));
    await page.goto(srv.origin+"/",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>typeof products==="object" && Object.keys(products).length>0,{timeout:25000});
    await page.waitForFunction(()=>document.querySelector(".header-row") && getComputedStyle(document.querySelector(".header-row")).display==="flex",null,{timeout:25000});
    const first=await page.evaluate(()=>Object.keys(products)[0]);
    for(const route of ["/","/collections/all","/collections/dresses","/products/"+first,"/pages/terms-and-conditions","/cart","/checkout","/orders","/wishlist","/search"]){
     if(route==="/checkout")await page.evaluate(()=>{const p=Object.values(products).find(p=>p.variants.some(v=>v.available));state.cart=[{id:p.variants.find(v=>v.available).id,qty:1}];persist()});
     await page.evaluate(r=>{history.replaceState(null,"",r);render()},route);
     await page.locator(".brand-logo").evaluateAll(imgs=>Promise.all(imgs.map(img=>img.decode().catch(()=>{}))));
     const geom=await captureGeometry(page);assertGeometry(geom,engine,width,route,errors);
     counts.routes++;
     if((width===375||width===1440)&&["/","/pages/terms-and-conditions","/checkout"].includes(route)){
      await page.screenshot({path:path.join("qa-screenshots",engine+"-"+width+"-"+route.replaceAll("/","-").replace(/^-+/,"")+".png"),fullPage:false});
     }
    }
    counts.widths++;
    await page.close();
   }
   for(const width of [375,1440]){
    const page=await browser.newPage({viewport:{width,height:860}});
    await page.goto(srv.origin+"/",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>typeof products==="object" && Object.keys(products).length>0,{timeout:25000});
    await page.waitForFunction(()=>document.querySelector(".header-row") && getComputedStyle(document.querySelector(".header-row")).display==="flex",null,{timeout:25000});
    const routes=await page.evaluate(()=>[
     ...categories.filter(c=>c.handle!=="frontpage").map(c=>"/collections/"+c.handle),
     ...Object.keys(products).map(h=>"/products/"+h),
     ...pages.map(p=>"/pages/"+p.handle)]);
    for(const route of routes){
     // WebKit throttles >100 synchronous History API mutations over 10 seconds.
     if(engine==="webkit")await page.waitForTimeout(140);
     try{await page.evaluate(r=>{history.replaceState(null,"",r);render()},route)}
     catch(e){errors.push({engine,width,route,issue:"route-crash",message:String(e)});continue}
     await page.locator(".brand-logo").evaluateAll(imgs=>Promise.all(imgs.map(img=>img.decode().catch(()=>{}))));
     const g=await captureGeometry(page);assertGeometry(g,engine,width,route,errors);counts.routes++;
    }
    console.log("ALL ROUTES",engine,width,routes.length);
    await page.close();
   }
  }finally{await browser.close()}
 }
}finally{await srv.close()}
console.log("AUDIT",JSON.stringify({counts,errorCount:errors.length,firstErrors:errors.slice(0,25)}));
if(errors.length)throw Error("Full-site visual/SEO audit failed:\n"+JSON.stringify(errors.slice(0,30),null,2));
console.log("PASS: 3 browser engines, 21 widths, all catalog and legal pages at phone and desktop widths");
