"use strict";
import {enforceActionRateLimit,CheckoutRateLimitError} from "../lib/rate-limit.mjs";
import {
  sendJSON,
  getMerchant,
  findOrder,
  reconcileOrder,
  isValidOrderId,
  guestTokenMatches,
  OrderStoreUnavailableError,
} from "../lib/checkout.mjs";

function readCookieToken(cookieHeader, txnId) {
  if (!cookieHeader) return "";
  const prefix = `am_ot_${txnId}=`;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length));
      } catch {
        return "";
      }
    }
  }
  return "";
}

function extractGuestOrderToken(request, txnId) {
  const headerToken = (request.headers.get("x-order-token") || "").trim();
  if (headerToken) return headerToken;
  const authHeader = (request.headers.get("authorization") || "").trim();
  if (/^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, "").trim();
  }
  return readCookieToken(request.headers.get("cookie") || "", txnId);
}

/**
 * Guest status lookup requires both a valid transaction ID and a matching
 * cryptographically random order access token; it never reveals address or PII.
 */
async function orderStatus(request) {
  if (request.method !== "GET") return sendJSON({ error: "Method not allowed" }, 405);
  const txnid = new URL(request.url).searchParams.get("txnid") || "";
  if (!isValidOrderId(txnid)) {
    return sendJSON({ error: "Invalid order reference." }, 400);
  }
  const token = extractGuestOrderToken(request, txnid);
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return sendJSON({ error: "Order access token is required to view this order." }, 401);
  }
  try {
    await enforceActionRateLimit(request,{action:"status"});
    let order = await findOrder(txnid);
    if (!order) return sendJSON({ error: "Order reference not found." }, 404);
    if (!guestTokenMatches(token, order.accessTokenHash)) {
      return sendJSON({ error: "Unauthorized order access." }, 403);
    }
    if (order.status === "pending" && Date.now() - Date.parse(order.createdAt) > 5000) {
      try {
        order = await reconcileOrder(order, getMerchant());
      } catch (error) {
        console.info("Order still pending PayU verification:", error.message);
      }
    }
    return sendJSON({
      txnId: order.id,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      paymentVerifiedAt: order.paymentVerifiedAt || null,
      status: order.status,
      fulfillmentStatus: order.fulfillmentStatus || "awaiting_payment",
      total: order.total,
      payAmount: order.payAmount,
      balanceDue: order.balanceDue,
      paymentMethod: order.paymentMethod,
      currency: order.currency || "INR",
    });
  } catch (error) {
    if(error instanceof CheckoutRateLimitError)
      return sendJSON({error:error.message},429,{"Retry-After":String(error.retryAfterSeconds)});
    if (error instanceof OrderStoreUnavailableError) {
      console.error("Order status storage error:", error.name, error.message);
    } else {
      console.error("Order status lookup error:", error?.name, error?.message);
    }
    return sendJSON({ error: "Unable to fetch this order status right now." }, 503);
  }
}

// Vercel Web Handler: fetch(Request) receives an absolute URL and standard
// Request/Response APIs (not the legacy Node.js req/res pair).
export default { fetch: orderStatus };
