"use strict";
import {createHmac} from "node:crypto";
import {
 sendJSON,getMerchant,validateCustomer,priceItems,hashGuestToken,sha256,
 checkoutFields,saveOrder,findOrder,merchantSite,guestTokenMatches,
 OrderStoreUnavailableError,DuplicateOrderError,
} from "../lib/checkout.mjs";
import {enforceActionRateLimit,CheckoutRateLimitError} from "../lib/rate-limit.mjs";

export function identityForKey(key,merchant){
 return {
  id:"AM"+createHmac("sha256",merchant.salt).update("order|"+key).digest("hex").slice(0,23).toUpperCase(),
  guestToken:createHmac("sha256",merchant.salt).update("guest|"+key).digest("hex"),
 };
}
function checkoutCookie(orderId,guestToken,baseUrl){
 const secure=baseUrl.startsWith("https://")?"; Secure":"";
 return "am_ot_"+orderId+"="+encodeURIComponent(guestToken)+
  "; Path=/api/order-status; HttpOnly; SameSite=Lax; Max-Age=2592000"+secure;
}
function replyWithCheckout(order,guestToken,merchant,baseUrl){
 const payload=checkoutFields(order,merchant,baseUrl);
 return sendJSON({txnId:order.id,orderToken:guestToken,amount:order.payAmount,currency:"INR",...payload},200,
  {"Set-Cookie":checkoutCookie(order.id,guestToken,baseUrl)});
}
function replyFinishedCheckout(order,guestToken,baseUrl){
 return sendJSON({
  error:"This checkout attempt has finished. Check its payment status before placing a new order.",
  txnId:order.id,status:order.status,orderToken:guestToken
 },409,{"Set-Cookie":checkoutCookie(order.id,guestToken,baseUrl)});
}
async function createOrder(request){
 if(request.method!=="POST")return sendJSON({error:"Method not allowed"},405);
 const origin=request.headers.get("origin");
 if(origin&&origin!==new URL(request.url).origin)
  return sendJSON({error:"Cross-site checkout requests are not accepted."},403);
 const key=String(request.headers.get("idempotency-key")||"").trim().toLowerCase();
 if(!/^[a-f0-9]{32,64}$/.test(key))
  return sendJSON({error:"Please refresh checkout and submit your order again."},400);
 try{
  if(Number(request.headers.get("content-length")||0)>25000)
   return sendJSON({error:"Checkout request is too large."},413);
  const merchant=getMerchant();
  const input=await request.json();
  const customer=validateCustomer(input.customer);
  const paymentMethod=String(input.paymentMethod||"");
  const priced=priceItems(input.cart,paymentMethod);
  const {id,guestToken}=identityForKey(key,merchant);
  const fingerprint=sha256(JSON.stringify({
   customer,paymentMethod,items:priced.items.map(i=>({id:i.id,qty:i.qty}))
  }));
  const baseUrl=merchantSite(request);
  // Transactional limiter is shared across all Vercel function instances.
  await enforceActionRateLimit(request,{action:"checkout",email:customer.email,merchantSalt:merchant.salt});
  const previous=await findOrder(id);
  if(previous){
   if(previous.idempotencyFingerprint!==fingerprint||
      !guestTokenMatches(guestToken,previous.accessTokenHash))
    return sendJSON({error:"This checkout attempt changed. Refresh checkout to try again."},409);
   if(["paid","cod_advance_paid","failed"].includes(previous.status))
    return replyFinishedCheckout(previous,guestToken,baseUrl);
   return replyWithCheckout(previous,guestToken,merchant,baseUrl);
  }
  const order={
   id,status:"pending",fulfillmentStatus:"awaiting_payment",
   customer,paymentMethod,...priced,currency:"INR",payuId:"",
   paymentVerifiedAt:null,source:"attiremart-guest-checkout",
   accessTokenHash:hashGuestToken(guestToken),
   idempotencyFingerprint:fingerprint,
  };
  try{
   // Unique Firestore order ID prevents duplicate PayU transactions under retries.
   await saveOrder(order,true);
  }catch(error){
   if(!(error instanceof DuplicateOrderError))throw error;
   const existing=await findOrder(id);
   if(!existing||existing.idempotencyFingerprint!==fingerprint||
      !guestTokenMatches(guestToken,existing.accessTokenHash))
    throw error;
   if(["paid","cod_advance_paid","failed"].includes(existing.status))
    return replyFinishedCheckout(existing,guestToken,baseUrl);
   return replyWithCheckout(existing,guestToken,merchant,baseUrl);
  }
  return replyWithCheckout(order,guestToken,merchant,baseUrl);
 }catch(error){
  if(error instanceof CheckoutRateLimitError)
   return sendJSON({error:error.message},429,{"Retry-After":String(error.retryAfterSeconds)});
  if(error instanceof OrderStoreUnavailableError){
   console.error("Order storage or throttling unavailable:",error.name,error.message);
   return sendJSON({error:"Checkout is temporarily unavailable. Please try again later."},503);
  }
  if(error instanceof DuplicateOrderError)
   return sendJSON({error:"This checkout request conflicts with an existing order. Please retry."},409);
  const message=String(error?.message||"");
  const configured=/being configured|Firebase Admin|Firebase project|Secure checkout site URL/.test(message);
  const invalid=/Please |unavailable|empty|too large|invalid|outside|JSON/i.test(message);
  console.error("Checkout request failed:",error?.name,message);
  return sendJSON({error:configured?message:invalid?message:"Checkout service is temporarily unavailable. Please try again later."},
   configured?503:invalid?400:503);
 }
}
export default {fetch:createOrder};
