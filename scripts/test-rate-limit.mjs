"use strict";
import assert from "node:assert/strict";
import {
 enforceActionRateLimit,
 checkAbuseBlock,
 recordAbuseStrike,
 CheckoutRateLimitError,
 CheckoutAbuseBlockedError,
 clientAddress
} from "../lib/rate-limit.mjs";
import {
 validateCustomerName,
 validateCustomerEmail,
 validateCustomerPhone,
} from "../lib/customer-safety-validation.js";
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

// Verify /attirecheckout bulk rate limits (4/min, 6/10min, 10/hour)
const attireReq=new Request("https://store.example/api/v2/payments/payu/create-order",{headers:{"x-forwarded-for":"198.51.100.88"}});
for(let i=0;i<4;i++){
 await enforceActionRateLimit(attireReq,{action:"attire_checkout",email:`u${i}@gmail.com`,phone:`987654321${i}`,merchantSalt:secret,dbOverride:fakeDb,now:2000000});
}
await assert.rejects(
 ()=>enforceActionRateLimit(attireReq,{action:"attire_checkout",email:"u9@gmail.com",phone:"9876543299",merchantSalt:secret,dbOverride:fakeDb,now:2000000}),
 CheckoutRateLimitError
);

// Verify abuse strike blocking (2 restricted attempts lock IP for 24h)
const abuseReq=new Request("https://store.example/api/v2/payments/payu/create-order",{headers:{"x-forwarded-for":"198.51.100.99"}});
const s1=await recordAbuseStrike(abuseReq,{merchantSalt:secret,dbOverride:fakeDb,now:3000000});
assert.equal(s1.blocked,false);
const s2=await recordAbuseStrike(abuseReq,{merchantSalt:secret,dbOverride:fakeDb,now:3005000});
assert.equal(s2.blocked,true);
await assert.rejects(()=>checkAbuseBlock(abuseReq,{merchantSalt:secret,dbOverride:fakeDb,now:3010000}),CheckoutAbuseBlockedError);

// Verify restricted/trigger words blocked while legitimate Indian names pass cleanly
assert.equal(validateCustomerName("Harshit Sharma").valid,true);
assert.equal(validateCustomerName("Rishit Verma").valid,true);
assert.equal(validateCustomerName("Priya Patel").valid,true);
assert.equal(validateCustomerName("Cashfree Test").restricted,true);
assert.equal(validateCustomerName("Cyber Police").restricted,true);
assert.equal(validateCustomerName("Garena Diamond").restricted,true);
assert.equal(validateCustomerName("<script>alert(1)</script>").restricted,true);
assert.equal(validateCustomerEmail("payu.test@gmail.com").restricted,true);
assert.equal(validateCustomerEmail("priya.sharma24@gmail.com").valid,true);
assert.equal(validateCustomerPhone("9999999999").valid,false);
assert.equal(validateCustomerPhone("9876543210").valid,true);

const a=identityForKey("a".repeat(48),{salt:secret}),b=identityForKey("b".repeat(48),{salt:secret});
assert.equal(a.id.length,25,"PayU hosted checkout txnid must fit 25 characters");
assert.match(a.id,/^AM[A-F0-9]{23}$/);
assert.match(a.guestToken,/^[a-f0-9]{64}$/);
assert.deepEqual(identityForKey("a".repeat(48),{salt:secret}),a,"Repeated requests must reuse the same payment identity");
assert.notEqual(a.id,b.id,"Distinct checkout attempts cannot share a transaction ID");
console.log("PASS: Firestore transaction rate limits, attire_checkout bulk & abuse blocks, 25-char PayU IDs, deterministic idempotency and retry windows.");
