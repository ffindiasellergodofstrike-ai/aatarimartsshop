"use strict";
import fs from "node:fs";
import path from "node:path";
import {createServer} from "node:http";
const root=path.resolve("publish");
const mime={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",
 ".json":"application/json; charset=utf-8",".png":"image/png",".webp":"image/webp",".svg":"image/svg+xml",
 ".xml":"application/xml; charset=utf-8",".txt":"text/plain; charset=utf-8"};
export async function startStoreServer(){
 const server=createServer((req,res)=>{
  try{
   const pathname=decodeURIComponent(new URL(req.url,"http://127.0.0.1").pathname);
   let file=path.resolve(root,"."+pathname);
   if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
   if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,"index.html");
   if(!fs.existsSync(file))file=path.join(root,"index.html");
   res.writeHead(200,{"Content-Type":mime[path.extname(file)]||"application/octet-stream","Cache-Control":"no-store"});
   fs.createReadStream(file).pipe(res);
  }catch(e){res.writeHead(500);res.end("Internal test server error")}
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address();
 return {origin:"http://127.0.0.1:"+address.port,close:()=>new Promise(resolve=>server.close(resolve))};
}
export async function captureGeometry(page){
 return page.evaluate(()=>{
  const rect=el=>el?{x:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,
    width:el.getBoundingClientRect().width,y:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom}:null;
  const elementOK=el=>el&&!((el.getBoundingClientRect().width>0)&&(el.getBoundingClientRect().left < -3 || el.getBoundingClientRect().right > innerWidth+3));
  const bad=[...document.querySelectorAll(".site-footer a,.site-footer h3,#main h1,#main h2,#main h3,.checkout-summary,.payment-choice,.product-layout,.product-grid")]
   .filter(el=>!elementOK(el)).slice(0,8).map(el=>({tag:el.tagName,text:el.textContent.trim().slice(0,40),r:rect(el)}));
  return {scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,
   viewport:innerWidth,logoOk:document.querySelector(".site-header .brand-logo")?.naturalWidth>0,
   footerLogoOk:document.querySelector(".site-footer .brand-logo")?.naturalWidth>0,
   logo:rect(document.querySelector(".header-row .logo")),tools:rect(document.querySelector(".header-row .tools")),
   nav:rect(document.querySelector(".header-row .nav")),navDisplay:document.querySelector(".header-row .nav")?getComputedStyle(document.querySelector(".header-row .nav")).display:"",
   footer:rect(document.querySelector(".site-footer .footer-grid")),
   header:rect(document.querySelector(".site-header")),h1:!!document.querySelector("#main h1"),
   canonical:document.querySelector("link[rel=canonical]")?.href,
   robots:document.querySelector('meta[name="robots"]')?.content,
   bad};
 });
}
export function assertGeometry(g,engine,width,route,errors){
 const add=(issue,data)=>errors.push({engine,width,route,issue,details:data});
 if(g.scrollWidth>width+2||g.bodyWidth>width+2)add("horizontal-scroll",{scroll:g.scrollWidth,body:g.bodyWidth});
 if(!g.logoOk||!g.footerLogoOk)add("logo-missing",{logo:g.logoOk,footer:g.footerLogoOk});
 if(!g.h1)add("missing-h1",{});
 if(g.bad.length)add("cut-heading-or-section",g.bad);
 if(g.logo&&g.tools&&g.logo.right>g.tools.x+2)add("logo-overlap-tools",{logo:g.logo,tools:g.tools});
 if(g.navDisplay!=="none"&&g.logo&&g.nav&&g.tools&&(g.logo.right>g.nav.x+3||g.nav.right>g.tools.x+3))
  add("nav-overlap",{logo:g.logo,nav:g.nav,tools:g.tools});
 if(g.footer&&width>1400&&(g.footer.x<12||g.footer.right>width-12))add("footer-not-centered",g.footer);
 if(!g.canonical)add("missing-canonical",{});
 const priv=/^\/(?:cart|checkout|wishlist|orders|order-status|account|search)(?:\/|$)/.test(route);
 if(priv&&!g.robots?.includes("noindex"))add("guest-private-route-indexed",g.robots);
 if(!priv&&g.robots?.includes("noindex"))add("public-route-noindex",g.robots);
}
