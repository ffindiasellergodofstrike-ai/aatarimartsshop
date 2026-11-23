
"use strict";
const APP=document.getElementById("app");
// ATTIRE MART storefront.
const parts=["01","02","03","04"];
const MAX_ITEM_QTY=10;
let categories=[],products={},pages=[];
const state={cart:load("am-replica-cart"),wishlist:load("am-replica-wishlist"),selection:{},quantity:1,gallery:"",sort:"featured",menu:false};
const mainCategories=["dresses","tops-t-shirts","co-ord-sets","jeans-pants-bottoms","loungewear-nightwear","activewear","plus-size-fashion","winter-wear","hoodies-sweatshirts","sweaters-knitwear","jackets-coats","jumpsuits","skirts"];
function load(key){try{let x=JSON.parse(localStorage.getItem(key)||"[]");return Array.isArray(x)?x:[]}catch(e){return []}}
function persist(){localStorage.setItem("am-replica-cart",JSON.stringify(state.cart));localStorage.setItem("am-replica-wishlist",JSON.stringify(state.wishlist))}
function esc(x){return String(x===undefined||x===null?"":x).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function money(v){return new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(Number(v)||0)}
function getCat(h){return categories.find(c=>c.handle===h)}
function prod(h){return products[h]}
function firstImg(p){return p?.variants?.find(v=>v.available)?.image||p?.variants?.[0]?.image||p?.images?.[0]?.src||"/fallback.svg"}
function photo(src,alt,extra){return '<img loading="lazy" decoding="async" src="'+esc(src||"/fallback.svg")+'" alt="'+esc(alt||"ATTIRE MART")+'" '+(extra||"")+'>'}
function info(p){let v=p?.variants?.[0]||{};return {price:Number(v.price)||0,compare:Number(v.compareAtPrice)||0}}
function url(route){return route}
function routeLink(path,label,cls){return '<a data-route href="'+esc(path)+'"'+(cls?' class="'+esc(cls)+'"':'')+'>'+label+'</a>'}
function icon(name){let paths={search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',bag:'<path d="M5 8h14l1.3 12H3.7L5 8Z"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/>',heart:'<path d="M20 8.5c0 5-8 10-8 10S4 13.5 4 8.5A4.4 4.4 0 0 1 12 6a4.4 4.4 0 0 1 8 2.5Z"/>',account:'<circle cx="12" cy="8" r="4"/><path d="M4.5 20c.7-4.4 3.4-6 7.5-6s6.8 1.6 7.5 6"/>',menu:'<path d="M3 6h18M3 12h18M3 18h18"/>'};return '<svg viewBox="0 0 24 24" aria-hidden="true">'+(paths[name]||"")+'</svg>'}
function catLink(c){return "/collections/"+c.handle}
/* Keep SEO metadata accurate after client-side navigation. */
function syncSeoMeta(title){
 const path=location.pathname;
 const segments=path.split("/").filter(Boolean);
 const publicRoute=path==="/"||path==="/collections/all"||
  (segments[0]==="collections" && !!getCat(segments[1]))||
  (segments[0]==="products" && !!products[segments[1]])||
  (segments[0]==="pages" && pages.some(x=>x.handle===segments[1]));
 const product=segments[0]==="products"?products[segments[1]]:null;
 const cat=segments[0]==="collections"?getCat(segments[1]):null;
 const legalPage=segments[0]==="pages"?pages.find(x=>x.handle===segments[1]):null;
 const brief=s=>String(s||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,159);
 const description=product?brief(product.descriptionHtml)||"Shop "+product.title+" at ATTIRE MART":
  cat?brief(cat.description)||"Explore "+cat.title+" at ATTIRE MART":
  legalPage?brief(legalPage.body):
  "ATTIRE MART independent fashion store. Shop dresses, tops and everyday styles with free shipping.";
 const url=location.origin+path;
 function attr(name,value,isProperty=false){
  const selector=isProperty?'meta[property="'+name+'"]':'meta[name="'+name+'"]';
  let el=document.head.querySelector(selector);
  if(!el){el=document.createElement("meta");el.setAttribute(isProperty?"property":"name",name);document.head.appendChild(el)}
  el.setAttribute("content",value);
 }
 attr("description",description);
 attr("robots",publicRoute?"index,follow,max-image-preview:large":"noindex,nofollow,noarchive");
 attr("og:title",document.title,true);attr("og:description",description,true);attr("og:url",url,true);
 let canon=document.head.querySelector('link[rel="canonical"]');
 if(!canon){canon=document.createElement("link");canon.rel="canonical";document.head.appendChild(canon)}
 canon.href=url;
 const existing=document.getElementById("seo-structured-data");
 if(existing)existing.remove();
 let schema=null;
 if(product){
  const v=product.variants.find(x=>x.available)||product.variants[0];
  if(v)schema={"@context":"https://schema.org","@type":"Product","name":product.title,
   "url":url,"description":description,"image":product.images.slice(0,4).map(i=>new URL(i.src,location.origin).href),
   "brand":{"@type":"Brand","name":"ATTIRE MART"},
   "sku":String(v.id),"offers":{"@type":"Offer","url":url,"priceCurrency":"INR",
    "price":String(v.price),"availability":product.variants.some(x=>x.available)?"https://schema.org/InStock":"https://schema.org/OutOfStock"}};
 }else if(cat||path==="/collections/all"){
  schema={"@context":"https://schema.org","@type":"CollectionPage","name":title||"All styles","url":url};
 }else if(legalPage){
  schema={"@context":"https://schema.org","@type":"WebPage","name":legalPage.title,"url":url};
 }else if(path==="/"){
  schema={"@context":"https://schema.org","@type":"WebSite","name":"ATTIRE MART","url":url};
 }
 if(schema){
  const script=document.createElement("script");script.id="seo-structured-data";
  script.type="application/ld+json";script.textContent=JSON.stringify(schema);
  document.head.appendChild(script);
 }
}
function shell(content,title){
 document.title=(title?title+" | ":"")+"ATTIRE MART — Everyday Fashion";
 const navLabels={"tops-t-shirts":"Tops & Tees","co-ord-sets":"Co-ords","jeans-pants-bottoms":"Bottoms","loungewear-nightwear":"Loungewear"};
 const nav=mainCategories.slice(0,5).map(h=>getCat(h)).filter(Boolean).map(c=>routeLink(catLink(c),esc(navLabels[c.handle]||c.title))).join("");
 const extra=routeLink("/collections/winter-wear","WINTER WEAR")+routeLink("/collections/all","SHOP ALL");
 const footerLinks=pages.map(p=>routeLink("/pages/"+p.handle,esc(p.title))).join("");
 APP.innerHTML='<div class="announcement"><div class="announcement-track" aria-label="Free shipping and fresh arrivals"><span>FREE SHIPPING ON ALL ORDERS &nbsp; ✦ &nbsp; FRESH STYLES EVERY WEEK &nbsp; ✦ &nbsp; SHOP WITH CONFIDENCE &nbsp; ✦ &nbsp; EASY RETURNS</span><span aria-hidden="true">FREE SHIPPING ON ALL ORDERS &nbsp; ✦ &nbsp; FRESH STYLES EVERY WEEK &nbsp; ✦ &nbsp; SHOP WITH CONFIDENCE &nbsp; ✦ &nbsp; EASY RETURNS</span></div></div>'
 +'<header class="site-header"><div class="container header-row">'
 +'<button class="icon-button hamburger" aria-label="Open navigation" data-menu>'+icon("menu")+'</button>'
 +routeLink("/",'<img class="brand-logo" src="/assets/attiremart-logo.png" alt="ATTIRE MART" width="900" height="148">',"logo")
 +'<nav class="nav" aria-label="Main navigation">'+nav+extra+'</nav>'
 +'<div class="tools">'
 +routeLink("/search",icon("search"),"icon-button")
 +""
 +routeLink("/wishlist",icon("heart")+'<span class="bubble">'+state.wishlist.length+'</span>',"icon-button")
 +routeLink("/cart",icon("bag")+'<span class="bubble">'+state.cart.reduce((s,i)=>s+i.qty,0)+'</span>',"icon-button")
 +'</div></div></header>'
 +'<div class="mobile-nav'+(state.menu?" open":"")+'" id="mobile-nav">'+mainCategories.map(h=>getCat(h)).filter(Boolean).map(c=>routeLink(catLink(c),esc(c.title))).join("")+routeLink("/collections/all","Shop all")+'</div>'
 +'<main id="main">'+content+'</main>'
 +'<footer class="site-footer"><div class="container footer-grid"><div><div class="logo"><img class="brand-logo" src="/assets/attiremart-logo.png" alt="ATTIRE MART" width="900" height="148"></div><p>Fresh fits, everyday fashion and the styles you love — all in one place.</p><p>Made for your kind of style.</p></div>'
 +'<div class="footer-col"><h3>Explore</h3>'+routeLink("/collections/all","Shop All")+routeLink("/orders","Track your orders")+mainCategories.slice(0,6).map(h=>getCat(h)).filter(Boolean).map(c=>routeLink(catLink(c),esc(c.title))).join("")+'</div>'
 +'<div class="footer-col"><h3>Customer policies</h3>'+footerLinks+'</div>'
 +'<div class="footer-col"><h3>Contact & support</h3><p>Email: <a href="mailto:support@attiremart.shop">support@attiremart.shop</a></p>'+routeLink("/pages/contact","Customer helpdesk")+routeLink("/pages/support-and-grievances","Grievance support")+'<p>Free shipping on serviceable Indian addresses.</p></div></div>'
 +'<div class="container footer-bottom"><span>© '+new Date().getFullYear()+' ATTIRE MART. All rights reserved.</span><span>Made for everyday confidence · Secure payments · Prices in INR</span></div></footer>';
 syncSeoMeta(title);
}
function crumbs(items){return '<div class="breadcrumb">'+routeLink("/","Home")+items.map(i=>' <span>›</span> '+(i.link?routeLink(i.link,esc(i.text)):esc(i.text))).join("")+'</div>'}
function card(p){if(!p)return "";let i=info(p),saved=state.wishlist.includes(p.handle),variant=p.variants?.find(v=>v.available)||p.variants?.[0],sameColour=imagesForSelectedColour(p,variant?.options?.Color),secondary=sameColour.find(img=>img.src!==firstImg(p))?.src;
 return '<article class="product-card"><div class="product-media">'
 +routeLink("/products/"+p.handle,photo(firstImg(p),p.title)+(secondary?photo(secondary,p.title+' alternate view','class="hover-img"'):""))
 +'<button type="button" class="wish-btn'+(saved?" saved":"")+'" data-wish="'+esc(p.handle)+'" title="Toggle wishlist" aria-label="Toggle wishlist">'+(saved?"♥":"♡")+'</button></div>'
 +'<div class="product-info">'+routeLink("/products/"+p.handle,'<h3 class="product-title">'+esc(p.title)+'</h3>')
 +'<span class="price">'+money(i.price)+'</span>'+(i.compare>i.price?'<span class="was">'+money(i.compare)+'</span>':"")
 +'</div></article>'}
function grid(handles){return '<div class="product-grid">'+[...new Set(handles)].map(h=>card(prod(h))).join("")+'</div>'}
function categoryRail(){
 return '<div class="category-rail">'+mainCategories.map(h=>getCat(h)).filter(c=>c&&c.products.length).map(c=>{
 const p=prod(c.products[0]);return routeLink(catLink(c),'<div class="round-img">'+photo(firstImg(p),c.title)+'</div><span>'+esc(c.title)+'</span>',"category-circle")
 }).join("")+'</div>';
}
function section(title,h,description,handles,extraClass){
 const c=getCat(h); if(!c)return "";
 return '<section class="section '+(extraClass||"")+'"><div class="container"><div class="section-head"><div><h2 class="section-title">'+esc(title)+'</h2>'+(description?'<p>'+esc(description)+'</p>':"")+'</div>'+routeLink(catLink(c),"View all","text-link")+'</div>'+grid(c.products)+'</div></section>';
}
function home(){
 const dresses=getCat("dresses"),co=getCat("co-ord-sets"),dp=dresses?.products||[],cp=co?.products||[];
 const d1=prod(dp[0]),d2=prod(dp[1]),c1=prod(cp[0]),c2=prod(cp[1]);
 const hero='<section class="hero"><div class="container hero-inner"><div class="hero-copy"><div class="kicker">NEW SEASON / NEW STYLES</div><h1>Your next favourite look</h1><p>Fresh fits. Everyday prices. Made for your kind of style.</p><div class="hero-actions">'+routeLink("/collections/all","SHOP ALL STYLES","btn btn-primary")+routeLink("/collections/dresses","EXPLORE DRESSES","btn btn-outline")+'</div></div><div class="hero-pictures">'+photo(firstImg(d1),"Dresses from ATTIRE MART",'class="hero-main"')+'<div class="hero-side">'+photo(firstImg(d2),"Fashion dress")+photo(firstImg(c1),"Co-ord outfit")+'</div></div></div></section>';
 const trust='<div class="trust-strip"><div class="container trust-list"><div><b>✦</b> FRESH EVERYDAY STYLES</div><div><b>✦</b> FREE SHIPPING</div><div><b>✦</b> SECURE SHOPPING</div></div></div>';
 const cats='<section class="section"><div class="container"><div class="section-head"><div><h2 class="section-title">Shop by category</h2><p>Your next favourite outfit is a tap away.</p></div>'+routeLink("/collections/all","View all","text-link")+'</div>'+categoryRail()+'</div></section>';
 const ed='<section class="section bg-soft"><div class="container"><div class="editorial"><div class="editorial-card"><div class="ed-copy"><span class="eyebrow">THE EDIT</span><h3>The dress edit</h3><p>From everyday minis to statement styles.</p>'+routeLink("/collections/dresses","SHOP DRESSES","text-link")+'</div>'+photo(firstImg(d2),"Dress edit")+'</div><div class="editorial-card"><div class="ed-copy"><span class="eyebrow">THE EDIT</span><h3>Matching sets, made easy</h3><p>Fresh co-ords for every plan.</p>'+routeLink("/collections/co-ord-sets","EXPLORE CO-ORDS","text-link")+'</div>'+photo(firstImg(c2),"Co-ord sets")+'</div></div></div></section>';
 shell(hero+trust+cats+section("Fresh dresses","dresses","New silhouettes, everyday prices.",dp)+ed+section("Customer-reviewed styles","customer-reviewed-edit","Looks the community loves.",[])+section("Styles at ₹299","299-style-picks","Find your next budget-friendly style.",[],"bg-soft")+section("The ₹499 edit","499-everyday-edit","Easy everyday fashion.",[]),"");
}
function collection(handle){
 let c=getCat(handle),all=handle==="all";if(!c&&!all){notFound();return}
 let list=all?[...new Set(categories.flatMap(x=>x.handle==="frontpage"?[]:x.products))]:[...c.products];
 const title=all?"All styles":c.title;const p=(handle==="all"?"Browse our selected styles.":" "+(c.description||"")).trim();
 if(state.sort==="price-asc")list.sort((a,b)=>info(prod(a)).price-info(prod(b)).price);
 else if(state.sort==="price-desc")list.sort((a,b)=>info(prod(b)).price-info(prod(a)).price);
 else if(state.sort==="az")list.sort((a,b)=>prod(a).title.localeCompare(prod(b).title));
 else if(state.sort==="available")list.sort((a,b)=>Number(prod(b).variants.some(v=>v.available))-Number(prod(a).variants.some(v=>v.available)));
 const sort='<select id="collection-sort" aria-label="Sort products"><option value="featured">Featured</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option><option value="az">Name A–Z</option><option value="available">Available first</option></select>';
 const chip='<div class="chip-list">'+mainCategories.map(h=>getCat(h)).filter(Boolean).map(x=>routeLink(catLink(x),esc(x.title),"chip"+(x.handle===handle?" selected":""))).join("")+'</div>';
 shell('<div class="container">'+crumbs([{text:"Collections",link:"/collections/all"},{text:title}])+'<section class="collection-intro"><span class="eyebrow">THE ATTIRE MART EDIT</span><h1 class="page-heading">'+esc(title)+'</h1><p>'+esc(p)+'</p></section>'+chip+'<div class="collection-toolbar"><span><b>'+list.length+'</b> styles</span><div>Sort by: '+sort+'</div></div>'+grid(list)+'</div>',title);
 const el=document.getElementById("collection-sort");if(el)el.value=state.sort;
}
function getSelection(p){if(!state.selection[p.handle])state.selection[p.handle]=Object.assign({},(p.variants.find(v=>v.available)||p.variants[0])?.options||{});return state.selection[p.handle]}
function chosenVariant(p){let sel=getSelection(p);return p.variants.find(v=>Object.keys(sel).every(k=>v.options[k]===sel[k]))||null}
function imagesForSelectedColour(p,color){
 const images=p.images||[],colours=[...new Map((p.variants||[])
  .filter(v=>v.options?.Color).map(v=>[v.options.Color,v.image])).entries()];
 if(!color||colours.length<2)return images;
 // Product galleries have contiguous colour groups starting at each variant's primary image.
 const boundaries=colours.map(([name,src])=>({name,index:images.findIndex(i=>i.src===src)}))
  .filter(x=>x.index>=0).sort((a,b)=>a.index-b.index);
 if(boundaries.length!==colours.length)return images.filter(i=>i.src===(p.variants.find(v=>v.options.Color===color)?.image))||images;
 const pos=boundaries.findIndex(x=>x.name===color);
 if(pos<0)return images;
 return images.slice(boundaries[pos].index,pos+1<boundaries.length?boundaries[pos+1].index:images.length);
}

function productPage(handle){
 let p=prod(handle);if(!p){notFound();return}
 let selected=getSelection(p),v=chosenVariant(p),images=imagesForSelectedColour(p,selected.Color);
 let current=(images.some(i=>i.src===state.gallery)?state.gallery:null)||v?.image||images[0]?.src||firstImg(p);
 let breadcrumbs=crumbs([{text:"Shop All",link:"/collections/all"},{text:p.title}]);
 let thumbs=images.map(m=>'<button class="thumb'+(current===m.src?" active":"")+'" data-img="'+esc(m.src)+'" aria-label="View product image">'+photo(m.src,m.alt)+'</button>').join("");
 let options=p.options.filter(o=>o.name!=="Title").map(o=>'<div class="variant-group"><div class="variant-label">'+esc(o.name)+' <span>'+esc(selected[o.name]||"")+'</span></div><div class="option-list">'+o.values.map(value=>'<button type="button" data-option="'+esc(o.name)+'" data-value="'+esc(value)+'" class="option'+(selected[o.name]===value?" active":"")+'">'+esc(value)+'</button>').join("")+'</div></div>').join("");
 let status=v?.available?'<div class="pdp-stock">● Available for order</div>':'<div class="pdp-stock" style="color:#a43737">Currently unavailable</div>';
 let price=v?.price??p.variants[0]?.price??0,compare=v?.compareAtPrice??null;
 let gallery='<div class="product-gallery"><div class="gallery-main">'+photo(current,p.title)+'</div><div class="thumbs">'+thumbs+'</div></div>';
 let right='<div class="pdp-right"><span class="eyebrow">ATTIRE MART</span><h1 class="pdp-title">'+esc(p.title)+'</h1><div class="pdp-price">'+money(price)+(compare>price?'<span class="was">'+money(compare)+'</span>':"")+'</div>'+status
 +options+'<p class="quantity-rule">Maximum '+MAX_ITEM_QTY+' units per product per order.</p><div class="purchase-row"><div class="qty"><button data-pdp-qty="-1" aria-label="Decrease quantity" '+(state.quantity<=1?'disabled':'')+'>−</button><span>'+state.quantity+'</span><button data-pdp-qty="1" aria-label="Increase quantity" '+(state.quantity>=MAX_ITEM_QTY?'disabled':'')+'>+</button></div><button class="btn btn-primary btn-full" data-add="'+esc(handle)+'" '+(!v?.available?"disabled":"")+'>ADD TO BAG</button></div><button class="btn btn-dark btn-full" data-buy="'+esc(handle)+'" '+(!v?.available?"disabled":"")+'>BUY NOW</button>'
 +'<div class="buy-note">Enjoy secure payments through PayU, with free delivery to serviceable Indian PIN codes. Colours may vary slightly by screen.</div>'
 +'<div class="info-bar"><div>✓ FREE SHIPPING</div><div>✓ SIZE OPTIONS</div><div>✓ SECURE CHECKOUT</div></div>'
 +'<div class="pdp-details"><h3>Product details</h3>'+plainDetail(p.descriptionHtml)+'<p>Choose your favourite colour and size above.</p><p>'+routeLink("/pages/shipping-delivery","Shipping & delivery")+' · '+routeLink("/pages/returns-refunds-cancellations","Returns & refunds")+'</p></div></div>';
 shell('<div class="container">'+breadcrumbs+'<div class="product-layout">'+gallery+right+'</div></div>'+section("Explore more styles","dresses","",[]),p.title);
}
function plainDetail(html){let div=document.createElement("div");div.innerHTML=html||"";div.querySelectorAll("script,style,iframe,img,svg,video,audio,form").forEach(n=>n.remove());return '<p>'+esc((div.textContent||"").trim().slice(0,2500)||"Style details as shown in the product photos.")+'</p>'}
function countProductInCart(handle){return cartLines().filter(line=>line.p.handle===handle).reduce((sum,line)=>sum+line.qty,0)}
function notifyQuantityLimit(){let el=document.querySelector(".cart-limit-toast");if(!el){el=document.createElement("div");el.className="cart-limit-toast";el.setAttribute("role","status");el.setAttribute("aria-live","polite");document.body.append(el)}el.textContent="You can add a maximum of "+MAX_ITEM_QTY+" units of each product per order.";clearTimeout(notifyQuantityLimit.timer);notifyQuantityLimit.timer=setTimeout(()=>el?.remove(),4200)}
function normalizeCart(){const cleaned=[],perProduct=new Map(),seen=new Set();for(const item of state.cart){if(!item||typeof item!=="object")continue;const id=String(item.id||"");if(seen.has(id))continue;let found=null;for(const p of Object.values(products)){const v=p.variants.find(v=>v.id===id);if(v){found={p,v};break}}if(!found||!found.v.available)continue;const remaining=MAX_ITEM_QTY-(perProduct.get(found.p.handle)||0);const raw=Number(item.qty);if(!Number.isFinite(raw)||raw<1||remaining<=0)continue;const qty=Math.min(MAX_ITEM_QTY,remaining,Math.floor(raw));if(qty<1)continue;cleaned.push({id,qty});seen.add(id);perProduct.set(found.p.handle,(perProduct.get(found.p.handle)||0)+qty)}state.cart=cleaned;persist()}
function cartLines(){return state.cart.map(i=>{for(const p of Object.values(products)){let v=p.variants.find(v=>v.id===i.id);if(v)return {p,v,qty:i.qty}}return null}).filter(Boolean)}
function addToCart(handle,buyNow){const p=prod(handle),v=p&&chosenVariant(p);if(!v||!v.available)return;if(countProductInCart(handle)+state.quantity>MAX_ITEM_QTY){notifyQuantityLimit();return}const line=state.cart.find(i=>i.id===v.id);if(line)line.qty+=state.quantity;else state.cart.push({id:v.id,qty:state.quantity});persist();state.gallery="";state.quantity=1;go(buyNow?"/checkout":"/cart")}
function changeCart(id,delta){const line=state.cart.find(x=>x.id===id);if(!line)return;const entry=cartLines().find(l=>l.v.id===id);if(!entry)return;if(delta>0&&countProductInCart(entry.p.handle)+delta>MAX_ITEM_QTY){notifyQuantityLimit();return}line.qty=Math.max(0,Math.min(MAX_ITEM_QTY,line.qty+delta));if(!line.qty)state.cart=state.cart.filter(x=>x.id!==id);persist();render()}
function summary(lines,checkout){const total=lines.reduce((s,l)=>s+Number(l.v.price)*l.qty,0);return '<aside class="summary"><h3>Order summary</h3>'+lines.map(l=>'<div class="summary-line"><span>'+esc(l.p.title)+' × '+l.qty+'</span><b>'+money(Number(l.v.price)*l.qty)+'</b></div>').join("")+'<div class="summary-line"><span>Subtotal</span><b>'+money(total)+'</b></div><div class="summary-line"><span>Shipping</span><b class="text-success">FREE</b></div><div class="summary-line summary-total"><span>Total</span><b>'+money(total)+'</b></div>'+routeLink("/checkout","PROCEED TO SECURE CHECKOUT","btn btn-primary btn-full")+'<p class="buy-note">No account required. Free delivery to serviceable PIN codes. Payment through PayU.</p></aside>'}

function cartPage(isCheckout){if(isCheckout){guestCheckoutPage();return}
 const lines=cartLines();if(!lines.length){shell('<div class="container empty"><h1 class="page-heading">Your bag is empty</h1><p>Find your next favourite look.</p>'+routeLink("/collections/all","SHOP ALL STYLES","btn btn-primary")+'</div>',isCheckout?"Checkout":"Your Bag");return}
 let list='<div class="item-list">'+lines.map(l=>'<article class="bag-row">'+routeLink("/products/"+l.p.handle,photo(l.v.image||firstImg(l.p),l.p.title))+'<div>'+routeLink("/products/"+l.p.handle,'<h3>'+esc(l.p.title)+'</h3>')+'<p>'+esc(Object.entries(l.v.options).map(([k,v])=>k+": "+v).join(" · "))+'</p><div class="qty item-qty"><button data-cart-qty="'+l.v.id+'" data-delta="-1">−</button><span>'+l.qty+'</span><button data-cart-qty="'+l.v.id+'" data-delta="1" aria-label="Add one item" title="Maximum 10 per product" '+(countProductInCart(l.p.handle)>=MAX_ITEM_QTY?'disabled':'')+'>+</button></div><small class="item-qty-note">Max '+MAX_ITEM_QTY+' per product</small><button class="link-button" data-remove="'+l.v.id+'">Remove</button></div><b class="price">'+money(l.v.price*l.qty)+'</b></article>').join("")+'</div>';
let intro="";
 shell('<div class="container">'+crumbs([{text:isCheckout?"Checkout":"Shopping bag"}])+'<h1 class="page-heading">'+(isCheckout?"Checkout":"Your shopping bag")+'</h1>'+intro+'<div class="bag-layout"><div>'+list+'</div>'+summary(lines,isCheckout)+'</div></div>',isCheckout?"Checkout":"Your Bag");
}
function safeHtml(html){
 let wrapper=document.createElement("div");wrapper.innerHTML=html||"";
 const allowed=new Set(["P","H2","H3","H4","UL","OL","LI","STRONG","EM","B","I","BR","A","DIV","SPAN","CODE"]);
 let all=[...wrapper.querySelectorAll("*")];for(let el of all.reverse()){
  if(!wrapper.contains(el))continue;
  if(!allowed.has(el.tagName)){if(["SCRIPT","STYLE","IFRAME","SVG","FORM","OBJECT","META","LINK","NOSCRIPT"].includes(el.tagName))el.remove();else el.replaceWith(...el.childNodes);continue}
  const href=el.getAttribute("href");for(let attr of [...el.attributes])el.removeAttribute(attr.name);
  if(el.tagName==="A"&&href&&(/^(\/|mailto:)/.test(href)||/^https:\/\/(www\.)?attiremart\.shop(\/|$)/i.test(href)))el.setAttribute("href",href);
 }
 return wrapper.innerHTML;
}
function page(handle){const p=pages.find(x=>x.handle===handle);if(!p){notFound();return}shell('<div class="container"><div class="policy-wrap">'+crumbs([{text:p.title}])+'<h1 class="page-heading">'+esc(p.title)+'</h1><article class="policy-body">'+safeHtml(p.body)+'</article></div></div>',p.title)}
function wishlist(){let list=state.wishlist.filter(h=>prod(h));shell('<div class="container">'+crumbs([{text:"Wishlist"}])+'<h1 class="page-heading">Your wishlist</h1>'+(list.length?'<p class="muted">'+list.length+' saved styles</p>'+grid(list):'<div class="empty"><h2>No saved styles yet</h2><p>Tap ♡ on any product to save it here.</p>'+routeLink("/collections/all","EXPLORE STYLES","btn btn-primary")+'</div>')+'</div>',"Wishlist")}
function searchPage(){let q=new URLSearchParams(location.search).get("q")||"";let found=q?[...Object.values(products)].filter(p=>p.title.toLowerCase().includes(q.toLowerCase())||String(p.type||"").toLowerCase().includes(q.toLowerCase())).map(p=>p.handle):[];const form='<form class="search-box" data-search><input name="q" value="'+esc(q)+'" type="search" placeholder="Search dresses, tops, co-ords…" aria-label="Search catalogue" required><button class="btn btn-primary" type="submit">SEARCH</button></form>';shell('<div class="container">'+crumbs([{text:"Search"}])+'<h1 class="page-heading">Find your look</h1>'+form+(q?'<p class="muted">'+found.length+' results for “'+esc(q)+'”</p>'+grid(found):'<p class="muted">Search our curated clothing categories and styles.</p>')+'</div>',"Search")}
function accountPage(){guestOrdersPage()}
function notFound(){shell('<div class="container empty"><h1 class="page-heading">Page not found</h1><p>We could not find that page.</p>'+routeLink("/","BACK TO HOME","btn btn-primary")+'</div>',"Page not found")}
function render(){let path;try{path=decodeURIComponent(location.pathname)}catch(e){path=location.pathname}let seg=path.split("/").filter(Boolean);if(!seg.length)home();else if(seg[0]==="collections")collection(seg[1]||"all");else if(seg[0]==="products")productPage(seg[1]);else if(seg[0]==="pages")page(seg[1]);else if(seg[0]==="cart")cartPage(false);else if(seg[0]==="checkout")guestCheckoutPage();else if(seg[0]==="order-status")guestOrderStatusPage();else if(seg[0]==="orders"||seg[0]==="account")guestOrdersPage();else if(seg[0]==="wishlist")wishlist();else if(seg[0]==="search")searchPage();else if(seg[0]==="about")page("about-us");else if(seg[0]==="contact")page("contact");else notFound()}
function go(path){history.pushState({},"",path);state.menu=false;state.gallery="";state.quantity=1;state.sort="featured";render();window.scrollTo(0,0)}
window.addEventListener("popstate",()=>{state.gallery="";state.quantity=1;render()});
document.addEventListener("click",e=>{
 const link=e.target.closest("a[data-route]");if(link){e.preventDefault();go(link.getAttribute("href"));return}
 const menu=e.target.closest("[data-menu]");if(menu){state.menu=!state.menu;document.querySelector(".mobile-nav")?.classList.toggle("open",state.menu);return}
 const w=e.target.closest("[data-wish]");if(w){const h=w.getAttribute("data-wish");state.wishlist=state.wishlist.includes(h)?state.wishlist.filter(x=>x!==h):[...state.wishlist,h];persist();render();return}
 const op=e.target.closest("[data-option]");if(op){const h=location.pathname.split("/").pop(),p=prod(h);if(!p)return;const name=op.getAttribute("data-option"),value=op.getAttribute("data-value"),requested=Object.assign({},getSelection(p),{[name]:value});let matched=p.variants.find(v=>Object.entries(requested).every(([key,val])=>v.options[key]===val));if(!matched){const candidates=p.variants.filter(v=>v.options[name]===value);matched=candidates.find(v=>v.available)||candidates[0]}state.selection[h]=matched?Object.assign({},matched.options):requested;state.gallery="";render();return}
 const img=e.target.closest("[data-img]");if(img){const target=img.getAttribute("data-img"),p=prod(location.pathname.split("/").pop());if(p&&imagesForSelectedColour(p,getSelection(p).Color).some(x=>x.src===target))state.gallery=target;render();return}
 const pq=e.target.closest("[data-pdp-qty]");if(pq){state.quantity=Math.max(1,Math.min(MAX_ITEM_QTY,state.quantity+Number(pq.getAttribute("data-pdp-qty"))));render();return}
 const add=e.target.closest("[data-add]");if(add){addToCart(add.getAttribute("data-add"),false);return}
 const buy=e.target.closest("[data-buy]");if(buy){addToCart(buy.getAttribute("data-buy"),true);return}
 const cq=e.target.closest("[data-cart-qty]");if(cq){changeCart(cq.getAttribute("data-cart-qty"),Number(cq.getAttribute("data-delta")));return}
 const rem=e.target.closest("[data-remove]");if(rem){state.cart=state.cart.filter(x=>x.id!==rem.getAttribute("data-remove"));persist();render();return}
});
document.addEventListener("change",e=>{if(e.target.id==="collection-sort"){state.sort=e.target.value;render()}});
document.addEventListener("submit",e=>{if(e.target.matches("[data-search]")){e.preventDefault();let q=e.target.querySelector("[name=q]").value.trim();go("/search?q="+encodeURIComponent(q))}});
document.addEventListener("error",e=>{
 const img=e.target;
 if(img.tagName!=="IMG"||img.src.endsWith("/fallback.svg"))return;
 const box=img.closest(".product-gallery,.product-media");
 let tried;try{tried=JSON.parse(img.dataset.failedPhotos||"[]")}catch{tried=[]}
 const failed=img.getAttribute("src");
 if(!tried.includes(failed))tried.push(failed);
 const alternatives=[...(box?.querySelectorAll("img")||[])].map(x=>x.getAttribute("src"))
  .filter(src=>src&&src!=="/fallback.svg"&&!tried.includes(src));
 img.dataset.failedPhotos=JSON.stringify(tried);
 img.src=alternatives[0]||"/fallback.svg";
},true);
async function init(){
 try{
  const responses=await Promise.all([...parts.map(i=>fetch("/data/part-"+i+".json")),fetch("/data/pages.json")]);
  if(responses.some(r=>!r.ok))throw Error("Store catalogue data is temporarily unavailable.");
  const all=await Promise.all(responses.map(r=>r.json()));
  all.slice(0,4).forEach(c=>{categories.push(...c.categories);Object.assign(products,c.products)});
  pages=all[4];
  normalizeCart();
  render();
 }catch(err){APP.innerHTML='<div class="container empty"><h2>Storefront could not load</h2><p>'+esc(err.message)+'</p><p>Please refresh the page or try again shortly.</p></div>';console.error(err)}
}
init();
