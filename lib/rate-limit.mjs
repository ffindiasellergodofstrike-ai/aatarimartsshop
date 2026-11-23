"use strict";
// Firestore-backed transactional throttling: works across serverless instances.
// Never persists raw IP addresses or customer email in rate-limit records.
import {createHmac} from "node:crypto";
import {getFirestoreContext,OrderStoreUnavailableError} from "./order-store.mjs";

export class CheckoutRateLimitError extends Error{
 constructor(retryAfterSeconds){
  super("Too many attempts. Please wait before trying again.");
  this.name="CheckoutRateLimitError";
  this.retryAfterSeconds=Math.max(1,Math.ceil(retryAfterSeconds));
 }
}
export function clientAddress(request){
 const raw=request.headers.get("x-vercel-forwarded-for")||
           request.headers.get("x-forwarded-for")||
           request.headers.get("x-real-ip")||"";
 const value=raw.split(",")[0].trim();
 return /^[a-fA-F0-9.:]{3,64}$/.test(value)?value.toLowerCase():"unknown";
}
export async function enforceActionRateLimit(request,{action,email="",merchantSalt="",dbOverride=null,now=Date.now()}={}){
 if(!["checkout","status"].includes(action))throw TypeError("Unknown rate-limit action");
 // Keyed digest makes stored identifiers opaque, even for common email addresses.
 const key=String(merchantSalt||process.env.PAYU_MERCHANT_SALT||"");
 if(!key)throw new OrderStoreUnavailableError("Rate-limit secret is not configured.");
 const address=clientAddress(request);
 const buckets=action==="checkout"
  ? [{name:"ip-minute",subject:address,limit:6,ms:60000},
     {name:"ip-hour",subject:address,limit:24,ms:3600000},
     {name:"email-hour",subject:String(email).trim().toLowerCase(),limit:8,ms:3600000}]
  : [{name:"status-minute",subject:address,limit:30,ms:60000},
     {name:"status-hour",subject:address,limit:180,ms:3600000}];
 const db=dbOverride||(await getFirestoreContext()).db;
 const records=buckets.map(bucket=>({
  ...bucket,
  ref:db.collection("request_limits").doc(createHmac("sha256",key).update(action+"|"+bucket.name+"|"+bucket.subject).digest("hex"))
 }));
 try{
  await db.runTransaction(async transaction=>{
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
