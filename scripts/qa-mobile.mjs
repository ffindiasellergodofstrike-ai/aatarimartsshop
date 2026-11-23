"use strict";
import {chromium,firefox,webkit} from "playwright";
import {startStoreServer,captureGeometry,assertGeometry} from "./qa-server.mjs";
const srv=await startStoreServer(),errors=[];
try{
 for(const [engine,adapter] of Object.entries({chromium,firefox,webkit})){
  const browser=await adapter.launch();
  try{
   for(const width of [320,360,375,390,430,768,1280]){
    const page=await browser.newPage({viewport:{width,height:840}});
    page.on("pageerror",e=>errors.push({engine,width,issue:"JavaScript",message:e.message}));
    await page.goto(srv.origin+"/",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>typeof products==="object" && Object.keys(products).length>0,{timeout:25000});
    await page.waitForFunction(()=>document.querySelector(".header-row") && getComputedStyle(document.querySelector(".header-row")).display==="flex",null,{timeout:25000});
    const routes=await page.evaluate(()=>{
     const first=Object.values(products).find(p=>p.variants.some(v=>v.available));
     state.cart=[{id:first.variants.find(v=>v.available).id,qty:1}];persist();
     return ["/","/collections/all","/products/"+first.handle,
       "/pages/terms-and-conditions","/cart","/checkout"];
    });
    for(const route of routes){
     await page.evaluate(r=>{history.replaceState(null,"",r);render()},route);
     await page.locator(".brand-logo").evaluateAll(imgs=>Promise.all(imgs.map(img=>img.decode().catch(()=>{}))));
     if(route==="/" && (width===375||width===1280)){
     const logoStyle=await page.locator(".site-footer .brand-logo").evaluate(img=>{
      const css=getComputedStyle(img);
      return {loaded:img.complete&&img.naturalWidth>0,filter:css.filter,blend:css.mixBlendMode};
     });
     if(!logoStyle.loaded||logoStyle.filter!=="invert(1)"||logoStyle.blend!=="screen")
      errors.push({engine,width,route,issue:"footer-logo-invisible",logoStyle});
    }
    const g=await captureGeometry(page);
     assertGeometry(g,engine,width,route,errors);
     if(route==="/" && engine==="chromium" && width===1280){
      const pictures=await page.locator(".hero-pictures img").evaluateAll(async imgs=>Promise.all(imgs.map(async img=>{
       await Promise.race([img.decode().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,15000))]);
       return {source:img.currentSrc||img.src,ok:img.naturalWidth>0};
      })));
      if(pictures.length!==3||pictures.some(p=>!p.ok||p.source.endsWith("/fallback.svg")))
       errors.push({engine,width,route,issue:"hero-product-photo-missing",pictures});
     }
     if(route==="/checkout"){
      const count=await page.locator("#guest-order-form input").count();
      if(count<9)errors.push({engine,width,route,issue:"missing-checkout-inputs",count});
      if(await page.getByText("Secure guest checkout",{exact:true}).count())
       errors.push({engine,width,route,issue:"unwanted-guest-checkout-label"});
      const remove=page.locator(".checkout-product .checkout-remove-btn");
      if(await remove.count()!==1)errors.push({engine,width,route,issue:"missing-checkout-remove-action"});
      if(engine==="chromium" && width===390){
       await page.locator("#name").fill("Test Customer");
       await remove.click();
       if(await page.locator("#guest-order-form").count()!==0 ||
          await page.getByRole("heading",{name:"Your bag is empty"}).count()!==1 ||
          (await page.evaluate(()=>state.cart.length))!==0)
        errors.push({engine,width,route,issue:"checkout-remove-failed-to-clear-last-item"});
      }
     }
    }
    if(engine==="chromium"&&width===390){
     const handle=await page.evaluate(()=>Object.values(products).find(p=>p.options.some(o=>o.name==="Color"&&o.values.length>1))?.handle);
     if(handle){
      await page.evaluate(h=>{history.replaceState(null,"","/products/"+h);state.gallery="";render()},handle);
      const swatches=page.locator('button[data-option="Color"]');
      if(await swatches.count()>1){
       await swatches.nth(1).click();
       const colorResult=await page.evaluate(()=>{
        const p=products[location.pathname.split("/").pop()],color=getSelection(p).Color,selected=chosenVariant(p);
        const allowed=new Set(imagesForSelectedColour(p,color).map(i=>new URL(i.src,location.origin).href));
        const main=document.querySelector(".gallery-main img")?.src;
        const thumb=[...document.querySelectorAll(".thumbs img")].map(i=>i.src);
        return {color,main,variantImage:new URL(selected.image,location.origin).href,thumbs:thumb.length,
         valid:main===new URL(selected.image,location.origin).href&&thumb.every(x=>allowed.has(x))};
       });
       if(!colorResult.valid)errors.push({engine,width,route:"/products/"+handle,issue:"colour-gallery-mismatch",colorResult});
      }
     }
    }
    if(engine==="chromium"&&width===390){
     await page.route("**/api/order-status?*",async route=>{
      const txn=new URL(route.request().url()).searchParams.get("txnid");
      const status=txn?.includes("FAILED")?"failed":"paid";
      await route.fulfill({status:200,contentType:"application/json",
       body:JSON.stringify({txnId:txn,status,total:499})});
     });
     const baseline=await page.evaluate(()=>{
      const variants=Object.values(products).flatMap(p=>p.variants).filter(v=>v.available);
      const first=String(variants[0].id),second=String(variants.find(v=>String(v.id)!==first).id);
      state.cart=[{id:second,qty:2}];persist();
      const txnId="AMPAIDOLD1234567890";
      localStorage.setItem(GUEST_ORDERS_KEY,JSON.stringify([{
       txnId,orderToken:"a".repeat(64),cartSnapshot:[{id:first,qty:1}],
       cartHandled:false,createdAt:new Date().toISOString(),status:"pending"
      }]));
      sessionStorage.setItem(CHECKOUT_ATTEMPT_KEY,JSON.stringify({
       fingerprint:"test",key:"b".repeat(48),txnId,status:"pending"
      }));
      history.replaceState(null,"","/order-status?txnid="+txnId);render();
      return {first,second,txnId};
     });
     await page.locator("#order-status-result .order-status-pill").waitFor();
     const preserved=await page.evaluate(()=>{
      const refs=guestLoad(GUEST_ORDERS_KEY,[]);
      return {cart:state.cart,handled:refs[0].cartHandled,attempt:readCheckoutAttempt()};
     });
     if(preserved.cart.length!==1||String(preserved.cart[0].id)!==baseline.second||
        !preserved.handled||preserved.attempt!==null)
      errors.push({engine,width,issue:"historical-paid-order-destroys-current-cart",preserved});
     await page.evaluate(({first})=>{
      const txnId="AMPAIDNEW1234567890";
      state.cart=[{id:first,qty:1}];persist();
      localStorage.setItem(GUEST_ORDERS_KEY,JSON.stringify([{
       txnId,orderToken:"a".repeat(64),cartSnapshot:[{id:first,qty:1}],
       cartHandled:false,createdAt:new Date().toISOString(),status:"pending"
      }]));
      sessionStorage.setItem(CHECKOUT_ATTEMPT_KEY,JSON.stringify({
       fingerprint:"test2",key:"c".repeat(48),txnId,status:"pending"
      }));
      history.replaceState(null,"","/order-status?txnid="+txnId);render();
     },baseline);
     await page.locator("#order-status-result .order-status-pill").waitFor();
     const paid=await page.evaluate(()=>({
      cart:state.cart,handled:guestLoad(GUEST_ORDERS_KEY,[])[0]?.cartHandled,attempt:readCheckoutAttempt()
     }));
     if(paid.cart.length||!paid.handled||paid.attempt!==null)
      errors.push({engine,width,issue:"paid-current-order-not-finalized",paid});
     await page.evaluate(({second})=>{
      state.cart=[{id:second,qty:1}];persist();
      render();
     },baseline);
     await page.locator("#order-status-result .order-status-pill").waitFor();
     const rereadCart=await page.evaluate(()=>state.cart);
     if(rereadCart.length!==1||String(rereadCart[0].id)!==baseline.second)
      errors.push({engine,width,issue:"reopened-paid-order-clears-new-cart",rereadCart});
     await page.evaluate(({second})=>{
      const txnId="AMFAILED1234567890";
      state.cart=[{id:second,qty:1}];persist();
      localStorage.setItem(GUEST_ORDERS_KEY,JSON.stringify([{
       txnId,orderToken:"a".repeat(64),cartSnapshot:[{id:second,qty:1}],
       cartHandled:false,createdAt:new Date().toISOString(),status:"pending"
      }]));
      sessionStorage.setItem(CHECKOUT_ATTEMPT_KEY,JSON.stringify({
       fingerprint:"test3",key:"d".repeat(48),txnId,status:"pending"
      }));
      history.replaceState(null,"","/order-status?txnid="+txnId);render();
     },baseline);
     await page.locator("#order-status-result .order-status-pill").waitFor();
     const failed=await page.evaluate(()=>({cart:state.cart,attempt:readCheckoutAttempt()}));
     if(failed.cart.length!==1||failed.attempt!==null)
      errors.push({engine,width,issue:"failed-payment-should-retain-cart-and-release-attempt",failed});
     const keyTest=await page.evaluate(async()=>{
      const cart=[{id:"A",qty:1}],payload={cart,paymentMethod:"prepaid",customer:{name:"Test"}};
      const first=await checkoutAttemptKey(payload);
      rememberCheckoutAttempt("AMRETRY1234567890",first);
      const again=await checkoutAttemptKey(payload);
      releaseCheckoutAttempt("AMRETRY1234567890");
      const next=await checkoutAttemptKey(payload);
      return {reuse:first===again,retired:first!==next};
     });
     if(!keyTest.reuse||!keyTest.retired)
      errors.push({engine,width,issue:"idempotency-key-retry-or-renewal-failed",keyTest});
    }
    await page.close();
    console.log("MOBILE CHECK",engine,width,"6 routes OK");
   }
  }finally{await browser.close()}
 }
}finally{await srv.close()}
if(errors.length)throw Error("Mobile visual audit failed ("+errors.length+"):\n"+JSON.stringify(errors.slice(0,35),null,2));
console.log("PASS: Chromium Firefox WebKit mobile, tablet and desktop 320-1280px; no content overlap or JS crashes");
