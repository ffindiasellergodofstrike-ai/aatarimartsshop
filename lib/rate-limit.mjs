"use strict";
// Firestore-backed transactional throttling: works across serverless instances.
// Never persists raw IP addresses or customer email/phone in rate-limit records.
import {createHmac,createHash} from "node:crypto";
import {getDatabaseContext,OrderStoreUnavailableError} from "./order-store.mjs";

export class CheckoutRateLimitError extends Error{
 constructor(retryAfterSeconds,message="Too many attempts. Please wait before trying again.",unblockAt=null){
  super(message);
  this.name="CheckoutRateLimitError";
  this.retryAfterSeconds=Math.max(1,Math.ceil(retryAfterSeconds));
  this.unblockAt=Number.isFinite(Number(unblockAt))?Number(unblockAt):Date.now()+this.retryAfterSeconds*1000;
 }
}

export class CheckoutAbuseBlockedError extends Error{
 constructor(retryAfterSeconds=86400,message="Access blocked for 24 hours due to repeated restricted or abusive attempts.",unblockAt=null){
  super(message);
  this.name="CheckoutAbuseBlockedError";
  this.retryAfterSeconds=Math.max(60,Math.ceil(retryAfterSeconds));
  this.unblockAt=Number.isFinite(Number(unblockAt))?Number(unblockAt):Date.now()+this.retryAfterSeconds*1000;
 }
}

const memoryLimits=new Map();
const memoryRateDb={
 collection(name){
  return {doc(id){return {id:name+":"+id};}};
 },
 async runTransaction(fn){
  const writes=[];
  const tx={
   get:async ref=>({exists:memoryLimits.has(ref.id),data:()=>structuredClone(memoryLimits.get(ref.id))}),
   set:(ref,data)=>writes.push({id:ref.id,data}),
  };
  const result=await fn(tx);
  for(const w of writes)memoryLimits.set(w.id,w.data);
  if(memoryLimits.size>5000){
   const firstKey=memoryLimits.keys().next().value;
   if(firstKey)memoryLimits.delete(firstKey);
  }
  return result;
 },
};

function resolveRateLimitKey(merchantSalt){
 const explicit=String(merchantSalt||process.env.PAYU_MERCHANT_SALT||"").trim();
 if(explicit)return explicit;
 if(process.env.VERCEL!=="1"){
  return createHash("sha256").update("attire-preview-rate-limit").digest("hex");
 }
 throw new OrderStoreUnavailableError("Rate-limit secret is not configured.");
}

async function resolveRateBackend(dbOverride,rtdbOverride){
 if(rtdbOverride){
  return {backend:"rtdb",rtdb:rtdbOverride};
 }
 if(dbOverride){
  return {backend:"firestore",db:dbOverride};
 }
 try{
  const ctx=await getDatabaseContext();
  return ctx.backend==="rtdb"
   ? {backend:"rtdb",rtdb:ctx.rtdb}
   : {backend:"firestore",db:ctx.db};
 }catch(error){
  if(process.env.VERCEL!=="1"){
   return {backend:"firestore",db:memoryRateDb};
  }
  throw error;
 }
}

function limitDocId(key,tag){
 return createHmac("sha256",key).update(tag).digest("hex");
}

export function clientAddress(request){
 const raw=request.headers.get("x-vercel-forwarded-for")||
           request.headers.get("x-forwarded-for")||
           request.headers.get("x-real-ip")||"";
 const value=raw.split(",")[0].trim();
 return /^[a-fA-F0-9.:]{3,64}$/.test(value)?value.toLowerCase():"unknown";
}

function cleanDeviceSubject(deviceId){
 const clean=String(deviceId||"").trim();
 return /^[a-zA-Z0-9_-]{8,64}$/.test(clean)?clean:"";
}

function limitDocRef(db,key,tag){
 return db.collection("request_limits").doc(limitDocId(key,tag));
}

function rtdbLimitRef(rtdb,key,tag){
 return rtdb.ref("request_limits/"+limitDocId(key,tag));
}

export async function checkAbuseBlock(request,{deviceId="",merchantSalt="",dbOverride=null,rtdbOverride=null,now=Date.now()}={}){
 const key=resolveRateLimitKey(merchantSalt);
 const address=clientAddress(request);
 const cleanDevice=cleanDeviceSubject(deviceId);
 try{
  const target=await resolveRateBackend(dbOverride,rtdbOverride);
  if(target.backend==="rtdb"){
   const tags=["abuse|ip-block|"+address];
   if(cleanDevice)tags.push("abuse|dev-block|"+cleanDevice);
   const snaps=await Promise.all(tags.map(t=>rtdbLimitRef(target.rtdb,key,t).once("value")));
   for(const snap of snaps){
    const val=snap?.val?.();
    const blockedUntil=Number(val?.blockedUntil)||0;
    if(blockedUntil>now){
     throw new CheckoutAbuseBlockedError((blockedUntil-now)/1000,undefined,blockedUntil);
    }
   }
   return;
  }
  await target.db.runTransaction(async tx=>{
   const refs=[limitDocRef(target.db,key,"abuse|ip-block|"+address)];
   if(cleanDevice)refs.push(limitDocRef(target.db,key,"abuse|dev-block|"+cleanDevice));
   const snaps=await Promise.all(refs.map(r=>tx.get(r)));
   for(const snap of snaps){
    if(!snap.exists)continue;
    const blockedUntil=Number(snap.data()?.blockedUntil)||0;
    if(blockedUntil>now){
     throw new CheckoutAbuseBlockedError((blockedUntil-now)/1000,undefined,blockedUntil);
    }
   }
  });
 }catch(error){
  if(error instanceof CheckoutAbuseBlockedError||error instanceof OrderStoreUnavailableError)throw error;
  throw new OrderStoreUnavailableError("Abuse protection storage is unavailable.",{cause:error});
 }
}

export async function recordAbuseStrike(request,{deviceId="",merchantSalt="",dbOverride=null,rtdbOverride=null,now=Date.now(),immediateBlock=false}={}){
 const key=resolveRateLimitKey(merchantSalt);
 const address=clientAddress(request);
 const cleanDevice=cleanDeviceSubject(deviceId);
 const STRIKE_WINDOW_MS=86400000; // 24 hours strike memory
 const BLOCK_DURATION_MS=86400000; // 24 hours block
 // Allow 3 warnings; on the 4th offensive/restricted attempt ("after 3 times"), lock for 24h.
 const STRIKE_LIMIT=4;

 try{
  const target=await resolveRateBackend(dbOverride,rtdbOverride);
  if(target.backend==="rtdb"){
   const ipBlockRef=rtdbLimitRef(target.rtdb,key,"abuse|ip-block|"+address);
   const devBlockRef=cleanDevice?rtdbLimitRef(target.rtdb,key,"abuse|dev-block|"+cleanDevice):null;
   const blockSnaps=await Promise.all([ipBlockRef.once("value"),...(devBlockRef?[devBlockRef.once("value")]:[])]);
   const existingBlock=Math.max(
    Number(blockSnaps[0]?.val?.()?.blockedUntil)||0,
    Number(blockSnaps[1]?.val?.()?.blockedUntil)||0
   );
   if(existingBlock>now){
    return {
     blocked:true,
     strikes:STRIKE_LIMIT,
     maxWarnings:STRIKE_LIMIT-1,
     blockedUntil:existingBlock,
     retryAfterSeconds:Math.ceil((existingBlock-now)/1000),
    };
   }

   const bumpRtdbStrike=async ref=>{
    let computedCount=0;
    let computedReset=now+STRIKE_WINDOW_MS;
    await ref.transaction(prev=>{
     const resetAt=Number(prev?.resetAt)||0;
     const reset=resetAt<=now;
     computedCount=(reset?0:Number(prev?.count)||0)+1;
     computedReset=reset?now+STRIKE_WINDOW_MS:resetAt;
     return {
      count:computedCount,
      resetAt:computedReset,
      expiresAtMs:computedReset+86400000,
     };
    });
    return {count:computedCount,nextReset:computedReset};
   };

   const ipStrikeRef=rtdbLimitRef(target.rtdb,key,"abuse|ip-strike|"+address);
   const devStrikeRef=cleanDevice?rtdbLimitRef(target.rtdb,key,"abuse|dev-strike|"+cleanDevice):null;
   const ipRes=await bumpRtdbStrike(ipStrikeRef);
   const devRes=devStrikeRef?await bumpRtdbStrike(devStrikeRef):{count:0,nextReset:ipRes.nextReset};
   const strikes=Math.max(ipRes.count,devRes.count);

   if(immediateBlock||strikes>=STRIKE_LIMIT){
    const blockedUntil=now+BLOCK_DURATION_MS;
    const blockPayload={blockedUntil,expiresAtMs:blockedUntil+86400000};
    await Promise.all([ipBlockRef.set(blockPayload),...(devBlockRef?[devBlockRef.set(blockPayload)]:[])]);
    return {
     blocked:true,
     strikes,
     maxWarnings:STRIKE_LIMIT-1,
     blockedUntil,
     retryAfterSeconds:Math.ceil(BLOCK_DURATION_MS/1000),
    };
   }

   return {
    blocked:false,
    strikes,
    maxWarnings:STRIKE_LIMIT-1,
    blockedUntil:null,
    retryAfterSeconds:0,
   };
  }

  return await target.db.runTransaction(async tx=>{
   const ipStrikeRef=limitDocRef(target.db,key,"abuse|ip-strike|"+address);
   const ipBlockRef=limitDocRef(target.db,key,"abuse|ip-block|"+address);
   const devStrikeRef=cleanDevice?limitDocRef(target.db,key,"abuse|dev-strike|"+cleanDevice):null;
   const devBlockRef=cleanDevice?limitDocRef(target.db,key,"abuse|dev-block|"+cleanDevice):null;

   const reads=[tx.get(ipStrikeRef),tx.get(ipBlockRef)];
   if(devStrikeRef&&devBlockRef){
    reads.push(tx.get(devStrikeRef),tx.get(devBlockRef));
   }
   const snaps=await Promise.all(reads);
   const ipStrikeSnap=snaps[0];
   const ipBlockSnap=snaps[1];
   const devStrikeSnap=snaps[2]||null;
   const devBlockSnap=snaps[3]||null;

   const prevIpBlock=ipBlockSnap.exists?Number(ipBlockSnap.data()?.blockedUntil)||0:0;
   const prevDevBlock=devBlockSnap?.exists?Number(devBlockSnap.data()?.blockedUntil)||0:0;
   const existingBlock=Math.max(prevIpBlock,prevDevBlock);
   if(existingBlock>now){
    return {
     blocked:true,
     strikes:STRIKE_LIMIT,
     maxWarnings:STRIKE_LIMIT-1,
     blockedUntil:existingBlock,
     retryAfterSeconds:Math.ceil((existingBlock-now)/1000),
    };
   }

   const nextStrikeCount=snap=>{
    const prev=snap?.exists?snap.data():null;
    const resetAt=Number(prev?.resetAt)||0;
    const reset=resetAt<=now;
    return {
     count:(reset?0:Number(prev?.count)||0)+1,
     nextReset:reset?now+STRIKE_WINDOW_MS:resetAt,
    };
   };

   const ipNext=nextStrikeCount(ipStrikeSnap);
   const devNext=devStrikeSnap?nextStrikeCount(devStrikeSnap):{count:0,nextReset:now+STRIKE_WINDOW_MS};
   const strikes=Math.max(ipNext.count,devNext.count);
   const nextReset=Math.max(ipNext.nextReset,devNext.nextReset);

   tx.set(ipStrikeRef,{
    count:strikes,
    resetAt:nextReset,
    expiresAt:new Date(nextReset+86400000),
   });
   if(devStrikeRef){
    tx.set(devStrikeRef,{
     count:strikes,
     resetAt:nextReset,
     expiresAt:new Date(nextReset+86400000),
    });
   }

   if(immediateBlock||strikes>=STRIKE_LIMIT){
    const blockedUntil=now+BLOCK_DURATION_MS;
    const blockPayload={
     blockedUntil,
     expiresAt:new Date(blockedUntil+86400000),
    };
    tx.set(ipBlockRef,blockPayload);
    if(devBlockRef)tx.set(devBlockRef,blockPayload);
    return {
     blocked:true,
     strikes,
     maxWarnings:STRIKE_LIMIT-1,
     blockedUntil,
     retryAfterSeconds:Math.ceil(BLOCK_DURATION_MS/1000),
    };
   }

   return {
    blocked:false,
    strikes,
    maxWarnings:STRIKE_LIMIT-1,
    blockedUntil:null,
    retryAfterSeconds:0,
   };
  });
 }catch(error){
  if(error instanceof OrderStoreUnavailableError)throw error;
  throw new OrderStoreUnavailableError("Abuse protection storage is unavailable.",{cause:error});
 }
}

export async function enforceActionRateLimit(request,{action,email="",deviceId="",merchantSalt="",dbOverride=null,rtdbOverride=null,now=Date.now()}={}){
 if(!["checkout","attire_checkout","status"].includes(action))throw TypeError("Unknown rate-limit action");
 // Keyed digest makes stored identifiers opaque, even for common email/device values.
 const key=resolveRateLimitKey(merchantSalt);
 const address=clientAddress(request);
 const cleanDevice=cleanDeviceSubject(deviceId);
 let buckets;
 if(action==="checkout"){
  buckets=[
   {name:"ip-minute",subject:address,limit:6,ms:60000},
   {name:"ip-hour",subject:address,limit:24,ms:3600000},
   {name:"email-hour",subject:String(email).trim().toLowerCase(),limit:8,ms:3600000},
  ];
 }else if(action==="attire_checkout"){
  buckets=[
   {name:"ip-minute",subject:address,limit:5,ms:60000},
   ...(cleanDevice?[{name:"device-minute",subject:cleanDevice,limit:5,ms:60000}]:[]),
   {name:"ip-day",subject:address,limit:50,ms:86400000},
   ...(cleanDevice?[{name:"device-day",subject:cleanDevice,limit:50,ms:86400000}]:[]),
  ];
 }else{
  buckets=[
   {name:"status-minute",subject:address,limit:30,ms:60000},
   {name:"status-hour",subject:address,limit:180,ms:3600000},
  ];
 }
 try{
  const target=await resolveRateBackend(dbOverride,rtdbOverride);
  if(target.backend==="rtdb"){
   for(const r of buckets){
    const ref=rtdbLimitRef(target.rtdb,key,action+"|"+r.name+"|"+r.subject);
    let exceededError=null;
    await ref.transaction(prev=>{
     exceededError=null;
     const resetAt=Number(prev?.resetAt)||0;
     const reset=resetAt<=now;
     const count=(reset?0:Number(prev?.count)||0)+1;
     const expires=reset?now+r.ms:resetAt;
     if(count>r.limit){
      exceededError=new CheckoutRateLimitError((expires-now)/1000,undefined,expires);
      return;
     }
     return {count,resetAt:expires,expiresAtMs:expires+86400000};
    });
    if(exceededError)throw exceededError;
   }
   return;
  }

  await target.db.runTransaction(async transaction=>{
   const records=buckets.map(bucket=>({
    ...bucket,
    ref:limitDocRef(target.db,key,action+"|"+bucket.name+"|"+bucket.subject),
   }));
   // Firestore requires all reads before writes.
   const snapshots=await Promise.all(records.map(r=>transaction.get(r.ref)));
   const updates=records.map((r,i)=>{
    const value=snapshots[i].exists?snapshots[i].data():null;
    const resetAt=Number(value?.resetAt)||0;
    const reset=resetAt<=now;
    const count=(reset?0:Number(value?.count)||0)+1;
    const expires=reset?now+r.ms:resetAt;
    if(count>r.limit)throw new CheckoutRateLimitError((expires-now)/1000,undefined,expires);
    // A Firestore TTL policy on 'expiresAt' cleans abandoned per-IP counters.
    // Expiry is delayed beyond the window so an active counter is never
    // prematurely deleted. The rate-limit decision still uses resetAt.
    return {ref:r.ref,data:{count,resetAt:expires,expiresAt:new Date(expires+86400000)}};
   });
   for(const u of updates)transaction.set(u.ref,u.data);
  });
 }catch(error){
  if(error instanceof CheckoutRateLimitError||error instanceof OrderStoreUnavailableError)throw error;
  throw new OrderStoreUnavailableError("Rate-limit database is unavailable.",{cause:error});
 }
}

