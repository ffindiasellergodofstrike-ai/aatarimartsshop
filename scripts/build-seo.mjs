"use strict";
/** Vercel static SEO pre-render: indexes public routes, never private order routes. */
import fs from "node:fs";
import path from "node:path";

const out=path.resolve("publish");
const index=fs.readFileSync(path.join(out,"index.html"),"utf8");
const placeholder='<div id="app"><div class="loading-state"><div class="spinner"></div><p>Loading ATTIRE MART…</p></div></div>';
if(!index.includes(placeholder))throw Error("index.html app mount placeholder changed");
const shards=["01","02","03","04"].map(id=>JSON.parse(fs.readFileSync(path.join(out,"data","part-"+id+".json"),"utf8")));
const products=Object.assign({},...shards.map(s=>s.products));
const categories=shards.flatMap(s=>s.categories).filter(c=>c.handle!=="frontpage");
const policies=JSON.parse(fs.readFileSync(path.join(out,"data","pages.json"),"utf8"));
const host=(process.env.PUBLIC_SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL?"https://"+process.env.VERCEL_PROJECT_PRODUCTION_URL:"") || "https://aatari-mart.example").replace(/\/+$/,"");
if(!/^https:\/\/[^/?#]+$/.test(host))throw Error("PUBLIC_SITE_URL must be an HTTPS origin without a path");
const h=s=>String(s??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const txt=s=>String(s??"").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
const desc=s=>txt(s).slice(0,158);
const money=n=>"₹"+new Intl.NumberFormat("en-IN",{maximumFractionDigits:0}).format(Number(n)||0);
const publicUrls=[];
const localMedia=new Set(fs.readdirSync(path.join(out,"media")));
function safeImg(src){
 if(typeof src!=="string")return "/fallback.svg";
 if(/^https:\/\/cdn\.shopify\.com\/s\/files\/1\/1042\/1220\/1653\/files\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)\?v=\d+$/.test(src))return src;
 if(!src.startsWith("/media/"))return "/fallback.svg";
 return localMedia.has(src.split("/").pop())?src:"/fallback.svg";
}
function absoluteImg(src){const out=safeImg(src);return out.startsWith("https://")?out:host+out}
function card(handle){
 const p=products[handle];if(!p)return "";
 const v=p.variants.find(x=>x.available)||p.variants[0];
 return '<article class="product-card"><a href="/products/'+h(handle)+'">'+
 '<div class="product-media"><img loading="lazy" width="360" height="440" src="'+h(safeImg(v?.image||p.images?.[0]?.src))+'" alt="'+h(p.title)+'"></div>'+
 '<h2 class="product-title">'+h(p.title)+'</h2></a><span class="price">'+money(v?.price)+'</span></article>';
}
function publish(route,title,description,content,structured=null,noindex=false,img="/assets/attiremart-logo.png"){
 const canonical=host+route;
 const social=[
 '<link rel="canonical" href="'+h(canonical)+'">',
 '<meta name="robots" content="'+(noindex?"noindex,nofollow,noarchive":"index,follow,max-image-preview:large")+'">',
 '<meta property="og:site_name" content="ATTIRE MART">',
 '<meta property="og:title" content="'+h(title)+'">',
 '<meta property="og:description" content="'+h(description)+'">',
 '<meta property="og:url" content="'+h(canonical)+'">',
 '<meta property="og:image" content="'+h(absoluteImg(img))+'">',
 '<meta name="twitter:card" content="summary_large_image">'
 ];
 // The logo is a static asset and does not require media lookup.
 social[6]='<meta property="og:image" content="'+h((img.startsWith("/assets/")?host+img:absoluteImg(img)))+'">';
 if(structured)social.push('<script id="seo-structured-data" type="application/ld+json">'+JSON.stringify(structured).replace(/</g,"\\u003c")+'</script>');
 const html=index.replace(/<title>[^<]*<\/title>/,'<title>'+h(title)+'</title>')
 .replace(/<meta name="description"[^>]*>/,'<meta name="description" content="'+h(desc(description))+'">')
 .replace("</head>",social.join("\n")+"\n</head>")
 .replace(placeholder,'<div id="app"><main id="main" class="seo-fallback"><div class="container">'+content+'</div></main></div>');
 const dest=route==="/"?path.join(out,"index.html"):path.join(out,route.slice(1),"index.html");
 fs.mkdirSync(path.dirname(dest),{recursive:true});
 fs.writeFileSync(dest,html);
 if(!noindex)publicUrls.push(route);
}
function collectionContent(title,description,handles){
 return '<nav class="breadcrumb"><a href="/">Home</a> › <a href="/collections/all">Shop all</a></nav>'+
 '<section class="collection-intro"><h1 class="page-heading">'+h(title)+'</h1><p>'+h(desc(description))+'</p></section>'+
 '<div class="product-grid">'+handles.slice(0,18).map(card).join("")+'</div>';
}
const allHandles=[...new Set(categories.flatMap(c=>c.products))];
publish("/","ATTIRE MART — Everyday Fashion","Shop ATTIRE MART for dresses, co-ords, tops and everyday styles. Explore new styles and easy shopping.",
 '<section class="collection-intro"><h1 class="page-heading">Fresh fashion at ATTIRE MART</h1><p>Find your next favourite outfit.</p></section>'+
 '<nav class="chip-list">'+categories.map(c=>'<a class="chip" href="/collections/'+h(c.handle)+'">'+h(c.title)+'</a>').join("")+'</nav>'+
 '<div class="product-grid">'+allHandles.slice(0,18).map(card).join("")+'</div>',
 {"@context":"https://schema.org","@type":"WebSite","name":"ATTIRE MART","url":host+"/"});
publish("/collections/all","Shop All Styles | ATTIRE MART","Shop all fashion collections at ATTIRE MART",collectionContent("Shop all","Browse our complete range of styles.",allHandles),
 {"@context":"https://schema.org","@type":"CollectionPage","name":"Shop all styles","url":host+"/collections/all"});
for(const c of categories){
 const route="/collections/"+c.handle;
 const description=desc(c.description)||"Discover "+c.title+" at ATTIRE MART";
 publish(route,c.title+" | ATTIRE MART",description,collectionContent(c.title,description,c.products),
  {"@context":"https://schema.org","@type":"CollectionPage","name":c.title,"description":description,"url":host+route});
}
for(const p of Object.values(products)){
 const route="/products/"+p.handle;
 const v=p.variants.find(x=>x.available)||p.variants[0];
 if(!v)continue;
 const image=safeImg(v?.image||p.images?.[0]?.src);
 const description=desc(p.descriptionHtml)||"Browse "+p.title+" at ATTIRE MART";
 const availability=p.variants.some(x=>x.available)?"InStock":"OutOfStock";
 const body='<nav class="breadcrumb"><a href="/">Home</a> › <a href="/collections/all">Shop all</a></nav>'+
 '<section class="product-layout"><div class="product-gallery"><img src="'+h(image)+'" width="540" height="680" alt="'+h(p.title)+'"></div>'+
 '<div class="pdp-right"><h1 class="pdp-title">'+h(p.title)+'</h1><p class="pdp-price">'+money(v.price)+'</p><p>'+h(description)+'</p></div></section>';
 publish(route,p.title+" | ATTIRE MART",description,body,
  {"@context":"https://schema.org","@type":"Product","name":p.title,"description":description,
   "image":p.images.slice(0,4).map(i=>absoluteImg(i.src)),"sku":String(v.id),
   "brand":{"@type":"Brand","name":"ATTIRE MART"},"offers":{"@type":"Offer","url":host+route,"priceCurrency":"INR","price":String(v.price),
   "availability":"https://schema.org/"+availability}},false,image);
}
for(const p of policies){
 const route="/pages/"+p.handle;
 const safe=p.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi,"");
 publish(route,p.title+" | ATTIRE MART",desc(p.body),'<article class="policy-wrap"><h1 class="page-heading">'+h(p.title)+'</h1><div class="policy-body">'+safe+'</div></article>',
 {"@context":"https://schema.org","@type":"WebPage","name":p.title,"url":host+route});
}
for(const route of ["/cart","/checkout","/orders","/order-status","/wishlist","/search","/account","/about","/contact"]){
 const name=route.slice(1).replace(/-/g," ");
 publish(route,name+" | ATTIRE MART","ATTIRE MART shopping and order support.",
 '<div class="empty"><h1 class="page-heading">'+h(name[0].toUpperCase()+name.slice(1))+'</h1><p>Open this page using ATTIRE MART.</p></div>',null,true);
}
const datedPages=new Map(policies.map(p=>{
 const match=p.body.match(/Last updated:\s*(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
 if(!match)return ["/pages/"+p.handle,null];
 const months={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
 const iso=match[3]+"-"+String(months[match[2].toLowerCase()]).padStart(2,"0")+"-"+match[1].padStart(2,"0");
 return ["/pages/"+p.handle,iso];
}));
const xml='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+
 publicUrls.map(r=>'  <url><loc>'+h(host+r)+'</loc>'+(datedPages.get(r)?'<lastmod>'+datedPages.get(r)+'</lastmod>':'')+'</url>').join("\n")+'\n</urlset>\n';
fs.writeFileSync(path.join(out,"sitemap.xml"),xml);
fs.writeFileSync(path.join(out,"robots.txt"),[
 "User-agent: *","Allow: /","Disallow: /api/","Disallow: /data/","Disallow: /cart",
 "Disallow: /checkout","Disallow: /orders","Disallow: /order-status",
 "Disallow: /wishlist","Disallow: /search","Disallow: /account",
 "","Sitemap: "+host+"/sitemap.xml",""
].join("\n"));
console.log("SEO prerender completed: "+publicUrls.length+" public canonical URLs, 9 noindex pages, robots.txt and sitemap.xml");
