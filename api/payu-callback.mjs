"use strict";
import {
  sendJSON,
  getMerchant,
  callbackHashValid,
  findOrder,
  reconcileOrder,
  OrderStoreUnavailableError,
} from "../lib/checkout.mjs";

/**
 * PayU return and S2S webhook receiver.
 * Works independently of guest browser access tokens.
 * Never trusts status=success in a browser redirect alone.
 * Validates reverse SHA512, matches the stored order, independently verifies
 * PayU transaction state, and updates Firestore atomically.
 */
export function createPaymentCallback({merchantProvider=getMerchant,orderFinder=findOrder,orderReconciler=reconcileOrder}={}){
 return async function paymentCallback(request) {
  if (request.method !== "POST") return sendJSON({ error: "Method not allowed" }, 405);
  const url = new URL(request.url);
  const webhook = url.searchParams.get("webhook") === "1";
  try {
    const body = await request.text();
    if (body.length > 20000) return sendJSON({ error: "Invalid callback payload." }, 413);
    const fields = Object.fromEntries(new URLSearchParams(body));
    const merchant = merchantProvider();
    if (!callbackHashValid(fields, merchant)) {
      console.warn("Rejected PayU callback with invalid hash");
      return sendJSON({ error: "Payment callback signature could not be verified." }, 400);
    }
    const order = await orderFinder(fields.txnid);
    if (!order) return sendJSON({ error: "Unknown order." }, 404);
    if (
      Number(fields.amount) !== Number(order.payAmount) ||
      fields.udf1 !== order.paymentMethod ||
      fields.productinfo !== "ATTIRE MART Order " + order.id ||
      fields.email !== order.customer.email ||
      fields.firstname !== order.customer.name.split(/\s+/)[0].slice(0, 60)
    ) {
      return sendJSON({ error: "Payment callback does not match the saved order." }, 400);
    }
    // An authenticated callback still does not prove that PayU captured money.
    // Give S2S deliveries retryable 503 until independent verification finishes.
    let verifiedOrder=order,verificationError=null;
    try{
      verifiedOrder=await orderReconciler(order,merchant);
    }catch(error){
      verificationError=error;
      console.error("PayU independent verification delayed:",error?.name,error?.message);
    }
    const verifiedTerminal=["paid","cod_advance_paid","failed"].includes(verifiedOrder?.status);
    if(webhook){
      if(verificationError||!verifiedTerminal)
        return sendJSON({received:false,retry:true},503,{"Retry-After":"30"});
      return sendJSON({received:true,verified:true});
    }
    // Browser returns are always sent to an authenticated status page. It can
    // display pending status and allow another verification attempt safely.
    return new Response(null,{
      status:303,
      headers:{
        Location:"/order-status?txnid="+encodeURIComponent(order.id),
        "Cache-Control":"no-store"
      }
    });
  } catch (error) {
    console.error("Callback failure:", error?.name, error?.message);
    return sendJSON({ error: "Payment verification is currently unavailable." }, 503);
  }
}

// Vercel Web Handler: fetch(Request) receives an absolute URL and standard
// Request/Response APIs (not the legacy Node.js req/res pair).
}
export default { fetch: createPaymentCallback() };
