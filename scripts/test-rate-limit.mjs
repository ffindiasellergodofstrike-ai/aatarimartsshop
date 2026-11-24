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

// Verify /attirecheckout rate limits: 5/min & 50/24h (10min & 1h buckets removed) + anti-VPN deviceId
const attireDeviceId="did_testdevice1234567890abcd";
const attireReq=new Request("https://store.example/api/v2/payments/payu/create-order",{headers:{"x-forwarded-for":"198.51.100.88"}});
for(let i=0;i<5;i++){
 await enforceActionRateLimit(attireReq,{action:"attire_checkout",email:`u${i}@gmail.com`,deviceId:attireDeviceId,merchantSalt:secret,dbOverride:fakeDb,now:2000000});
}
await assert.rejects(
 ()=>enforceActionRateLimit(attireReq,{action:"attire_checkout",email:"u9@gmail.com",deviceId:attireDeviceId,merchantSalt:secret,dbOverride:fakeDb,now:2000000}),
 err=>err instanceof CheckoutRateLimitError&&err.unblockAt===2060000
);
// Switching IP via VPN with same deviceId must still respect minute limit
const attireVpnReq=new Request("https://store.example/api/v2/payments/payu/create-order",{headers:{"x-forwarded-for":"198.51.100.188"}});
await assert.rejects(
 ()=>enforceActionRateLimit(attireVpnReq,{action:"attire_checkout",email:"u10@gmail.com",deviceId:attireDeviceId,merchantSalt:secret,dbOverride:fakeDb,now:2000500}),
 CheckoutRateLimitError
);

// Verify 10-minute / 1-hour caps are removed and 50/24h daily cap enforces across minutes
const dailyIpReq=new Request("https://store.example/api/v2/payments/payu/create-order",{headers:{"x-forwarded-for":"198.51.100.77"}});
const dailyDid="did_dailydevice1234567890ab";
for(let i=0;i<50;i++){
 await enforceActionRateLimit(dailyIpReq,{action:"attire_checkout",email:`d${i}@gmail.com`,deviceId:dailyDid,merchantSalt:secret,dbOverride:fakeDb,now:5000000+Math.floor(i/5)*61000});
}
await assert.rejects(
 ()=>enforceActionRateLimit(dailyIpReq,{action:"attire_checkout",email:"d50@gmail.com",deviceId:dailyDid,merchantSalt:secret,dbOverride:fakeDb,now:5000000+11*61000}),
 err=>err instanceof CheckoutRateLimitError&&err.unblockAt===5000000+86400000
);

// Verify abuse strike blocking: 3 warnings, then 4th restricted attempt locks BOTH IP and Device ID for 24h
const abuseDid="did_abusedevice1234567890ab";
const abuseReq=new Request("https://store.example/api/v2/payments/payu/create-order",{headers:{"x-forwarded-for":"198.51.100.99"}});
for(let strike=1;strike<=3;strike++){
 const s=await recordAbuseStrike(abuseReq,{deviceId:abuseDid,merchantSalt:secret,dbOverride:fakeDb,now:3000000+strike*1000});
 assert.equal(s.blocked,false);
 assert.equal(s.strikes,strike);
 assert.equal(s.maxWarnings,3);
}
const s4=await recordAbuseStrike(abuseReq,{deviceId:abuseDid,merchantSalt:secret,dbOverride:fakeDb,now:3005000});
assert.equal(s4.blocked,true);
assert.equal(s4.blockedUntil,3005000+86400000);
await assert.rejects(
 ()=>checkAbuseBlock(abuseReq,{deviceId:abuseDid,merchantSalt:secret,dbOverride:fakeDb,now:3010000}),
 err=>err instanceof CheckoutAbuseBlockedError&&err.unblockAt===3005000+86400000
);
// Anti-VPN: changing IP while keeping same deviceId stays blocked for 24h
const abuseVpnReq=new Request("https://store.example/api/v2/payments/payu/create-order",{headers:{"x-forwarded-for":"203.0.113.199"}});
await assert.rejects(
 ()=>checkAbuseBlock(abuseVpnReq,{deviceId:abuseDid,merchantSalt:secret,dbOverride:fakeDb,now:3010000}),
 err=>err instanceof CheckoutAbuseBlockedError&&err.unblockAt===3005000+86400000
);

// Verify obfuscated restricted/abusive words blocked while legitimate Indian names pass cleanly
assert.equal(validateCustomerName("Harshit Sharma").valid,true);
assert.equal(validateCustomerName("Rishit Verma").valid,true);
assert.equal(validateCustomerName("M. C. Verma").valid,true);
assert.equal(validateCustomerName("Priya Patel").valid,true);
assert.equal(validateCustomerName("p.a.y.u").restricted,true);
assert.equal(validateCustomerName("p 4 y u").restricted,true);
assert.equal(validateCustomerName("r@zorpay").restricted,true);
assert.equal(validateCustomerName("pay\u200Bu").restricted,true);
assert.equal(validateCustomerName("bsdk boy").restricted,true);
assert.equal(validateCustomerName("Cashfree Test").restricted,true);
assert.equal(validateCustomerName("Cyber Police").restricted,true);
assert.equal(validateCustomerName("Garena Diamond").restricted,true);
assert.equal(validateCustomerName("<script>alert(1)</script>").restricted,true);
assert.equal(validateCustomerEmail("payu.test@gmail.com").restricted,true);
assert.equal(validateCustomerEmail("p.a.y.u@gmail.com").restricted,true);
assert.equal(validateCustomerEmail("priya.sharma24@gmail.com").valid,true);
assert.equal(validateCustomerPhone("9999999999").valid,false);
assert.equal(validateCustomerPhone("9876543210").valid,true);

const a=identityForKey("a".repeat(48),{salt:secret}),b=identityForKey("b".repeat(48),{salt:secret});
assert.equal(a.id.length,25,"PayU hosted checkout txnid must fit 25 characters");
assert.match(a.id,/^AM[A-F0-9]{23}$/);
assert.match(a.guestToken,/^[a-f0-9]{64}$/);
assert.deepEqual(identityForKey("a".repeat(48),{salt:secret}),a,"Repeated requests must reuse the same payment identity");
assert.notEqual(a.id,b.id,"Distinct checkout attempts cannot share a transaction ID");

// Verify Realtime Database (RTDB) atomic rate-limit and 3-warning -> 4th-strike 24h block paths
const rtdbMap=new Map();
const fakeRtdb={
 ref(path){
  return {
   async once(){
    const exists=rtdbMap.has(path);
    return {exists:()=>exists,val:()=>exists?structuredClone(rtdbMap.get(path)):null};
   },
   async set(val){
    rtdbMap.set(path,structuredClone(val));
   },
   async transaction(fn){
    const cur=rtdbMap.has(path)?structuredClone(rtdbMap.get(path)):null;
    const next=fn(cur);
    if(next===undefined)return {committed:false};
    rtdbMap.set(path,structuredClone(next));
    return {committed:true};
   }
  };
 }
};
const rtdbDid="did_rtdblimit1234567890";
const rtdbReq=new Request("https://store.example/api/v2/payments/payu/create-order",{headers:{"x-forwarded-for":"198.51.100.210"}});
for(let i=0;i<5;i++){
 await enforceActionRateLimit(rtdbReq,{action:"attire_checkout",deviceId:rtdbDid,merchantSalt:secret,rtdbOverride:fakeRtdb,now:7000000});
}
await assert.rejects(
 ()=>enforceActionRateLimit(rtdbReq,{action:"attire_checkout",deviceId:rtdbDid,merchantSalt:secret,rtdbOverride:fakeRtdb,now:7000000}),
 CheckoutRateLimitError
);
for(let s=1;s<=3;s++){
 const res=await recordAbuseStrike(rtdbReq,{deviceId:rtdbDid,merchantSalt:secret,rtdbOverride:fakeRtdb,now:8000000+s*100});
 assert.equal(res.blocked,false);
 assert.equal(res.strikes,s);
}
const rtdbLock=await recordAbuseStrike(rtdbReq,{deviceId:rtdbDid,merchantSalt:secret,rtdbOverride:fakeRtdb,now:8001000});
assert.equal(rtdbLock.blocked,true);
await assert.rejects(
 ()=>checkAbuseBlock(new Request("https://store.example/api/v2/payments/payu/create-order",{headers:{"x-forwarded-for":"203.0.113.210"}}),{deviceId:rtdbDid,merchantSalt:secret,rtdbOverride:fakeRtdb,now:8005000}),
 CheckoutAbuseBlockedError
);

console.log("PASS: Firestore & RTDB transaction rate limits (5/min, 50/24h), anti-VPN deviceId, obfuscated keyword 3-warning + 24h lock, and 25-char PayU IDs.");


