"use strict";
// Firestore-backed transactional throttling: works across serverless instances.
// Never persists raw IP addresses or customer email/phone in rate-limit records.
import {createHmac,createHash} from "node:crypto";
import {getFirestoreContext,OrderStoreUnavailableError} from "./order-store.mjs";

export class CheckoutRateLimitError extends Error{
 constructor(retryAfterSeconds,message="Too many attempts. Please wait before trying again."){
  super(message);
  this.name="CheckoutRateLimitError";
  this.retryAfterSeconds=Math.max(1,Math.ceil(retryAfterSeconds));
 }
}

export class CheckoutAbuseBlockedError extends Error{
 constructor(retryAfterSeconds=86400,message="Access blocked due to abusive or restricted checkout activity."){
  super(message);
  this.name="CheckoutAbuseBlockedError";
  this.retryAfterSeconds=Math.max(60,Math.ceil(retryAfterSeconds));
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

async function runRateTransaction(dbOverride, fn){
 if(dbOverride){
  return dbOverride.runTransaction(tx=>fn(tx,dbOverride));
 }
 try{
  const db=(await getFirestoreContext()).db;
  return await db.runTransaction(tx=>fn(tx,db));
 }catch(error){
  if(error instanceof CheckoutRateLimitError||error instanceof CheckoutAbuseBlockedError){
   throw error;
  }
  if(process.env.VERCEL!=="1"){
   return await memoryRateDb.runTransaction(tx=>fn(tx,memoryRateDb));
  }
  throw error;
 }
}

export function clientAddress(request){
 const raw=request.headers.get("x-vercel-forwarded-for")||
           request.headers.get("x-forwarded-for")||
           request.headers.get("x-real-ip")||"";
 const value=raw.split(",")[0].trim();
 return /^[a-fA-F0-9.:]{3,64}$/.test(value)?value.toLowerCase():"unknown";
}

function limitDocRef(db,key,tag){
 return db.collection("request_limits").doc(createHmac("sha256",key).update(tag).digest("hex"));
}

export async function checkAbuseBlock(request,{merchantSalt="",dbOverride=null,now=Date.now()}={}){
 const key=resolveRateLimitKey(merchantSalt);
 const address=clientAddress(request);
 try{
  await runRateTransaction(dbOverride,async (tx,db)=>{
   const ref=limitDocRef(db,key,"abuse|ip-block|"+address);
   const snap=await tx.get(ref);
   if(!snap.exists)return;
   const data=snap.data();
   const blockedUntil=Number(data?.blockedUntil)||0;
   if(blockedUntil>now){
    throw new CheckoutAbuseBlockedError((blockedUntil-now)/1000);
   }
  });
 }catch(error){
  if(error instanceof CheckoutAbuseBlockedError||error instanceof OrderStoreUnavailableError)throw error;
  throw new OrderStoreUnavailableError("Abuse protection storage is unavailable.",{cause:error});
 }
}

export async function recordAbuseStrike(request,{merchantSalt="",dbOverride=null,now=Date.now(),immediateBlock=false}={}){
 const key=resolveRateLimitKey(merchantSalt);
 const address=clientAddress(request);
 const STRIKE_WINDOW_MS=3600000; // 1 hour
 const BLOCK_DURATION_MS=86400000; // 24 hours
 const STRIKE_LIMIT=2; // 2nd offensive/trigger attempt blocks IP for 24h

 try{
  return await runRateTransaction(dbOverride,async (tx,db)=>{
   const strikeRef=limitDocRef(db,key,"abuse|ip-strike|"+address);
   const blockRef=limitDocRef(db,key,"abuse|ip-block|"+address);
   const [strikeSnap,blockSnap]=await Promise.all([tx.get(strikeRef),tx.get(blockRef)]);
   const prevBlock=blockSnap.exists?Number(blockSnap.data()?.blockedUntil)||0:0;
   if(prevBlock>now){
    return {blocked:true,strikes:STRIKE_LIMIT,retryAfterSeconds:Math.ceil((prevBlock-now)/1000)};
   }
   const prevStrike=strikeSnap.exists?strikeSnap.data():null;
   const resetAt=Number(prevStrike?.resetAt)||0;
   const reset=resetAt<=now;
   const strikes=(reset?0:Number(prevStrike?.count)||0)+1;
   const nextReset=reset?now+STRIKE_WINDOW_MS:resetAt;
   tx.set(strikeRef,{
    count:strikes,
    resetAt:nextReset,
    expiresAt:new Date(nextReset+86400000),
   });
   if(immediateBlock||strikes>=STRIKE_LIMIT){
    const blockedUntil=now+BLOCK_DURATION_MS;
    tx.set(blockRef,{
     blockedUntil,
     expiresAt:new Date(blockedUntil+86400000),
    });
    return {blocked:true,strikes,retryAfterSeconds:Math.ceil(BLOCK_DURATION_MS/1000)};
   }
   return {blocked:false,strikes,retryAfterSeconds:0};
  });
 }catch(error){
  if(error instanceof OrderStoreUnavailableError)throw error;
  throw new OrderStoreUnavailableError("Abuse protection storage is unavailable.",{cause:error});
 }
}

export async function enforceActionRateLimit(request,{action,email="",phone="",merchantSalt="",dbOverride=null,now=Date.now()}={}){
 if(!["checkout","attire_checkout","status"].includes(action))throw TypeError("Unknown rate-limit action");
 // Keyed digest makes stored identifiers opaque, even for common email/phone values.
 const key=resolveRateLimitKey(merchantSalt);
 const address=clientAddress(request);
 let buckets;
 if(action==="checkout"){
  buckets=[
   {name:"ip-minute",subject:address,limit:6,ms:60000},
   {name:"ip-hour",subject:address,limit:24,ms:3600000},
   {name:"email-hour",subject:String(email).trim().toLowerCase(),limit:8,ms:3600000},
  ];
 }else if(action==="attire_checkout"){
  buckets=[
   {name:"ip-minute",subject:address,limit:4,ms:60000},
   {name:"ip-10min",subject:address,limit:6,ms:600000},
   {name:"ip-hour",subject:address,limit:10,ms:3600000},
   {name:"ip-day",subject:address,limit:15,ms:86400000},
  ];
  const cleanEmail=String(email||"").trim().toLowerCase();
  if(cleanEmail)buckets.push({name:"email-hour",subject:cleanEmail,limit:5,ms:3600000});
  const cleanPhone=String(phone||"").replace(/\D/g,"").slice(-10);
  if(cleanPhone)buckets.push({name:"phone-hour",subject:cleanPhone,limit:5,ms:3600000});
 }else{
  buckets=[
   {name:"status-minute",subject:address,limit:30,ms:60000},
   {name:"status-hour",subject:address,limit:180,ms:3600000},
  ];
 }
 try{
  await runRateTransaction(dbOverride,async (transaction,db)=>{
   const records=buckets.map(bucket=>({
    ...bucket,
    ref:limitDocRef(db,key,action+"|"+bucket.name+"|"+bucket.subject),
   }));
   // Firestore requires all reads before writes.
   const snapshots=await Promise.all(records.map(r=>transaction.get(r.ref)));
   const updates=records.map((r,i)=>{
    const value=snapshots[i].exists?snapshots[i].data():null;
    const resetAt=Number(value?.resetAt)||0;
    const reset=resetAt<=now;
    const count=(reset?0:Number(value?.count)||0)+1;
    const expires=reset?now+r.ms:resetAt;
    if(count>r.limit)throw new CheckoutRateLimitError((expires-now)/1000);
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
