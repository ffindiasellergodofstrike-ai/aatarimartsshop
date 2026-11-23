"use strict";
import assert from "node:assert/strict";
import {enforceActionRateLimit,CheckoutRateLimitError,clientAddress} from "../lib/rate-limit.mjs";
import {identityForKey} from "../api/create-order.mjs";
const records=new Map();
const fakeDb={
 collection(name){
  assert.equal(name,"request_limits");
  return {doc(id){return {id}}};
 },
 async runTransaction(fn){
  const writes=[];
  const tx={
   get:async ref=>({exists:records.has(ref.id),data:()=>structuredClone(records.get(ref.id))}),
   set:(ref,data)=>writes.push({id:ref.id,data})
  };
  const result=await fn(tx);
  for(const w of writes)records.set(w.id,w.data);
  return result;
 }
};
const ip="203.0.113.75",secret="local-test-secret";
const request=new Request("https://store.example/api/create-order",{headers:{"x-forwarded-for":ip}});
assert.equal(clientAddress(request),ip);
const args={action:"checkout",email:"customer@example.com",merchantSalt:secret,dbOverride:fakeDb,now:1000000};
for(let i=0;i<6;i++)await enforceActionRateLimit(request,args);
await assert.rejects(()=>enforceActionRateLimit(request,args),CheckoutRateLimitError);
assert.ok([...records.keys()].every(k=>/^[a-f0-9]{64}$/.test(k)));
assert.ok([...records.values()].every(d=>d.count===6));
assert.ok([...records.values()].every(d=>d.expiresAt instanceof Date),
 "Each rate-limit counter must carry a Firestore TTL timestamp");
assert.ok([...records.values()].every(d=>d.expiresAt.getTime()>d.resetAt),
 "TTL must only expire after the counter's active window");

await enforceActionRateLimit(request,{...args,now:1060001});
const other=new Request("https://store.example/api/create-order",{headers:{"x-forwarded-for":"198.51.100.54"}});
for(let i=0;i<8;i++)await enforceActionRateLimit(other,{...args,email:"different@example.com",now:1000000+Math.floor(i/4)*60001});
await assert.rejects(()=>enforceActionRateLimit(other,{...args,email:"different@example.com",now:1120002}),CheckoutRateLimitError);
const statusDb={...fakeDb};
const statusReq=new Request("https://store.example/api/order-status",{headers:{"x-forwarded-for":"198.51.100.201"}});
for(let i=0;i<30;i++)await enforceActionRateLimit(statusReq,{action:"status",merchantSalt:secret,dbOverride:statusDb,now:1000000});
await assert.rejects(()=>enforceActionRateLimit(statusReq,{action:"status",merchantSalt:secret,dbOverride:statusDb,now:1000000}),CheckoutRateLimitError);
const a=identityForKey("a".repeat(48),{salt:secret}),b=identityForKey("b".repeat(48),{salt:secret});
assert.equal(a.id.length,25,"PayU hosted checkout txnid must fit 25 characters");
assert.match(a.id,/^AM[A-F0-9]{23}$/);
assert.match(a.guestToken,/^[a-f0-9]{64}$/);
assert.deepEqual(identityForKey("a".repeat(48),{salt:secret}),a,"Repeated requests must reuse the same payment identity");
assert.notEqual(a.id,b.id,"Distinct checkout attempts cannot share a transaction ID");
console.log("PASS: Firestore transaction rate limits, hashed counters, 25-char PayU IDs, deterministic idempotency and retry windows.");
