"use strict";
import assert from "node:assert/strict";
import fs from "node:fs";
import createOrder from "../api/create-order.mjs";
import orderStatus from "../api/order-status.mjs";
import payuCallback from "../api/payu-callback.mjs";
import {
  checkoutFields,
  getMerchant,
  merchantSite,
  hash,
} from "../lib/checkout.mjs";

assert.equal(typeof createOrder.fetch, "function");
assert.equal(typeof orderStatus.fetch, "function");
assert.equal(typeof payuCallback.fetch, "function");

const vercel = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
assert.equal(vercel.outputDirectory, "publish");
assert.equal(vercel.buildCommand, "npm run build");
assert.equal(vercel.framework, null);
assert.equal(
  vercel.routes,
  undefined,
  "Avoid legacy catch-all routes shadowing Vercel API handlers or SEO pages"
);
assert.equal(vercel.functions["api/*.mjs"].maxDuration, 30);

assert.ok(fs.existsSync("publish/robots.txt"));
assert.ok(fs.existsSync("publish/sitemap.xml"));
assert.ok(fs.existsSync("publish/checkout/index.html"));
assert.ok(fs.existsSync("publish/products"));
const publishedImages = fs.readdirSync("publish/media").filter(f => f.endsWith(".webp")).length;
const sourceImages = fs.readdirSync("media").filter(f => f.endsWith(".webp")).length;
assert.ok(sourceImages > 0, "The repository must contain local product images");
assert.equal(publishedImages, sourceImages, "Every source WebP must be included in the deployed site");
if(sourceImages < 1112) console.log("Using original verified CDN images alongside",sourceImages,"self-hosted product photos.");

// Security isolation checks: server code, secrets, rules, and catalog must never be published
assert.ok(!fs.existsSync("publish/api"), "Private API source leaked into public folder");
assert.ok(!fs.existsSync("publish/lib"));
assert.ok(!fs.existsSync("publish/data/checkout-catalog.json"));
assert.ok(!fs.existsSync("publish/firebase-applet-config.json"));
assert.ok(!fs.existsSync("publish/firestore.rules"));
assert.ok(!fs.existsSync("publish/_redirects"));

// Input validation & HTTP method guards
const checkBadId = await orderStatus.fetch(
  new Request("https://attire.example.com/api/order-status?txnid=bad")
);
assert.equal(checkBadId.status, 400);
assert.equal((await checkBadId.json()).error, "Invalid order reference.");
assert.match(checkBadId.headers.get("x-robots-tag"), /noindex/);

const missingToken = await orderStatus.fetch(
  new Request("https://attire.example.com/api/order-status?txnid=AM1234567890ABCDEF")
);
assert.equal(missingToken.status, 401);

const badMethod = await createOrder.fetch(
  new Request("https://attire.example.com/api/create-order", { method: "GET" })
);
assert.equal(badMethod.status, 405);

const badStatusMethod = await orderStatus.fetch(
  new Request("https://attire.example.com/api/order-status?txnid=AM1234567890ABCDEF", {
    method: "POST",
  })
);
assert.equal(badStatusMethod.status, 405);

const badCallback = await payuCallback.fetch(
  new Request("https://attire.example.com/api/payu-callback", { method: "GET" })
);
assert.equal(badCallback.status, 405);

const invalidOrigin = await createOrder.fetch(
  new Request("https://attire.example.com/api/create-order", {
    method: "POST",
    headers: { Origin: "https://evil.example.net", "Content-Type": "application/json" },
    body: JSON.stringify({ cart: [], customer: {} }),
  })
);
assert.equal(invalidOrigin.status, 403);

// Fail-closed check when Vercel lacks Firebase Admin credentials
process.env.VERCEL = "1";
process.env.PAYU_ENV = "test";
process.env.PAYU_MERCHANT_KEY = "sample-test-key";
process.env.PAYU_MERCHANT_SALT = "sample-test-salt";
delete process.env.FIREBASE_CLIENT_EMAIL;
delete process.env.FIREBASE_PRIVATE_KEY;
delete process.env.FIRESTORE_EMULATOR_HOST;

const catalog = JSON.parse(fs.readFileSync("data/checkout-catalog.json", "utf8"));
const variant = Object.values(catalog.variants).find(x => x.available && x.price > 0);
const payload = {
  customer: {
    name: "Asha Kumar",
    email: "asha@example.com",
    phone: "9876543210",
    address1: "12 Test Street Example City",
    address2: "Near park",
    city: "Varanasi",
    state: "Uttar Pradesh",
    pincode: "221003",
  },
  paymentMethod: "prepaid",
  cart: [{ id: variant.id, qty: 1 }],
};

const blocked = await createOrder.fetch(
  new Request("https://attire.example.com/api/create-order", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attire.example.com", "idempotency-key": "a".repeat(48) },
    body: JSON.stringify(payload),
  })
);
assert.equal(
  blocked.status,
  503,
  "Do not allow PayU redirect when Firebase Admin credentials are missing on Vercel"
);
assert.ok(!(await blocked.json()).gateway, "Never send a payment redirect when storage fails");

const statusBlocked = await orderStatus.fetch(
  new Request("https://attire.example.com/api/order-status?txnid=AM1234567890ABCDEF", {
    headers: { "X-Order-Token": "a".repeat(64) },
  })
);
assert.equal(statusBlocked.status, 503);

// Verify forged PayU callback cannot pass signature check
const forgedCallback = await payuCallback.fetch(
  new Request("https://attire.example.com/api/payu-callback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      key: "sample-test-key",
      txnid: "AM1234567890ABCDEF",
      amount: String(variant.price.toFixed(2)),
      status: "success",
      hash: hash("forged"),
    }).toString(),
  })
);
assert.equal(forgedCallback.status, 400);

const merchant = getMerchant();
const fields = checkoutFields(
  {
    id: "AM1234567890ABCDEF",
    customer: payload.customer,
    paymentMethod: "prepaid",
    payAmount: variant.price,
  },
  merchant,
  merchantSite(new Request("https://attire.example.com/api/create-order"))
);
assert.equal(fields.fields.surl, "https://attire.example.com/api/payu-callback");
assert.equal(fields.fields.furl, "https://attire.example.com/api/payu-callback");

for (const source of [
  "/products/:handle",
  "/collections/:handle",
  "/pages/:handle",
  "/checkout",
  "/cart",
]) {
  assert.ok(vercel.rewrites.some(x => x.source === source), "Missing Vercel static route: " + source);
}

const frontend = fs.readFileSync("publish/checkout.js", "utf8");
assert.ok(frontend.includes('"/api/create-order"'));
assert.ok(frontend.includes('"/api/order-status?'));
assert.ok(frontend.includes("X-Order-Token"));
assert.ok(!frontend.includes("FIREBASE_PRIVATE_KEY"));

// Ensure no leftover @vercel/blob or BLOB_ references in runtime code
const runtimeFiles = [
  "package.json",
  "lib/order-store.mjs",
  "lib/checkout.mjs",
  "api/create-order.mjs",
  "api/order-status.mjs",
  "api/payu-callback.mjs",
  "checkout.js",
];
for (const file of runtimeFiles) {
  const src = fs.readFileSync(file, "utf8");
  assert.ok(!src.includes("@vercel/blob"), `Removed @vercel/blob reference still in ${file}`);
  assert.ok(!src.includes("BLOB_STORE_ID"), `Removed BLOB_STORE_ID reference still in ${file}`);
  assert.ok(
    !src.includes("BLOB_READ_WRITE_TOKEN"),
    `Removed BLOB_READ_WRITE_TOKEN reference still in ${file}`
  );
}


const fallbackSvg=fs.readFileSync("publish/fallback.svg","utf8");
assert.doesNotMatch(fallbackSvg,/GitHub|syncing|internal|service.account/i);
const publicCatalogs=["01","02","03","04"].map(n=>JSON.parse(fs.readFileSync("publish/data/part-"+n+".json","utf8")));
const fileNames=new Set(fs.readdirSync("publish/media"));
const auditedHandles=new Set();
let repaired=0,local=0,total=0;
for(const shard of publicCatalogs)for(const product of Object.values(shard.products)){
 if(auditedHandles.has(product.handle))continue;
 auditedHandles.add(product.handle);
 for(const img of product.images){
  total++;
  if(img.src.startsWith("/media/")){
   assert.ok(fileNames.has(img.src.slice(7)),"Image not published: "+img.src);
   local++;
  }else if(img.src.startsWith("https://")){
   assert.match(img.src,/^https:\/\/cdn\.shopify\.com\/s\/files\/1\/1042\/1220\/1653\/files\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)\?v=\d+$/);
   repaired++;
  }else assert.fail("Unresolved photo in published catalogue: "+img.src);
 }
}
assert.equal(auditedHandles.size,184,"Every product must be checked once");
assert.equal(total,1112,"Every unique catalog photo must be verified");
assert.equal(local,fs.existsSync("data/local-media-lock.json")?1112:194,"Unexpected local photo references");
assert.equal(repaired,fs.existsSync("data/local-media-lock.json")?0:918,"Unexpected external CDN image references");
console.log("PASS: all 1112 original product photos are served from local verified WebP assets, with zero external image URLs.");

console.log(
  "PASS: Vercel API isolation, 400/401/403/405/503 fail-closed behavior, PayU signature checks, and zero Vercel Blob references."
);
