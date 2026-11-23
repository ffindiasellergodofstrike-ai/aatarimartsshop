"use strict";

/**
 * ATTIRE MART payment & Firestore order helpers.
 * PayU merchant key/salt and Firebase Admin credentials stay strictly server-side.
 * Browsers never set authoritative prices, payment states, or raw database records.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import catalog from "../data/checkout-catalog.json" with { type: "json" };
import {
  getDefaultOrderStore,
  isValidOrderId,
  OrderStoreUnavailableError,
  DuplicateOrderError,
} from "./order-store.mjs";

export { OrderStoreUnavailableError, DuplicateOrderError, isValidOrderId };

export function sendJSON(value, status = 200, extraHeaders = {}) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      ...extraHeaders,
    },
  });
}

export function getMerchant() {
  const key = String(process.env.PAYU_MERCHANT_KEY || "").trim();
  const salt = String(process.env.PAYU_MERCHANT_SALT || "").trim();
  if (
    !key ||
    !salt ||
    /^(PENDING_|PLACEHOLDER_|REPLACE_|SET_REAL_|YOUR_)/i.test(key) ||
    /^(PENDING_|PLACEHOLDER_|REPLACE_|SET_REAL_|YOUR_)/i.test(salt)
  ) {
    throw new Error("Online checkout is being configured. Please try again later.");
  }
  const mode = process.env.PAYU_ENV === "live" ? "live" : "test";
  return {
    key,
    salt,
    mode,
    paymentUrl: mode === "live" ? "https://secure.payu.in/_payment" : "https://test.payu.in/_payment",
    verifyUrl:
      mode === "live"
        ? "https://info.payu.in/merchant/postservice.php?form=2"
        : "https://test.payu.in/merchant/postservice?form=2",
  };
}

export function hash(value) {
  return createHash("sha512").update(value, "utf8").digest("hex");
}

export function sha256(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function hashMatches(expected, actual) {
  const a = Buffer.from(String(expected || ""), "hex");
  const b = Buffer.from(String(actual || ""), "hex");
  return a.length === 64 && b.length === 64 && timingSafeEqual(a, b);
}

export function newGuestOrderToken() {
  return randomBytes(32).toString("hex");
}

export function hashGuestToken(token) {
  return sha256(String(token || ""));
}

export function guestTokenMatches(token, expectedHash) {
  const cleanToken = String(token || "").trim();
  const cleanHash = String(expectedHash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(cleanToken) || !/^[a-f0-9]{64}$/.test(cleanHash)) {
    return false;
  }
  const actualBuf = Buffer.from(hashGuestToken(cleanToken), "hex");
  const expectedBuf = Buffer.from(cleanHash, "hex");
  return actualBuf.length === 32 && expectedBuf.length === 32 && timingSafeEqual(actualBuf, expectedBuf);
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function validateCustomer(customer) {
  if (!customer || typeof customer !== "object") throw Error("Please enter your delivery details.");
  const name = text(customer.name, 100);
  const email = text(customer.email, 180).toLowerCase();
  const phone = text(customer.phone, 16).replace(/[\s-]/g, "");
  const address1 = text(customer.address1, 200);
  const address2 = text(customer.address2, 150);
  const city = text(customer.city, 80);
  const state = text(customer.state, 80);
  const pincode = text(customer.pincode, 6);
  if (
    name.length < 2 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !/^[6-9]\d{9}$/.test(phone) ||
    address1.length < 8 ||
    city.length < 2 ||
    state.length < 2 ||
    !/^[1-9]\d{5}$/.test(pincode)
  ) {
    throw Error("Please enter a valid name, email, Indian mobile number and delivery address.");
  }
  return { name, email, phone, address1, address2, city, state, pincode, country: "India" };
}

export function priceItems(lines, paymentMethod) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 30) {
    throw Error("Your shopping bag is empty or too large.");
  }
  if (!["prepaid", "cod"].includes(paymentMethod)) {
    throw Error("Please select a payment option.");
  }
  const unique = new Set();
  const productQuantities = new Map();
  let total = 0;
  const items = lines.map(row => {
    const id = String(row?.id || "");
    const qty = Number(row?.qty);
    const v = catalog.variants[id];
    if (!v || !v.available || unique.has(id) || !Number.isInteger(qty) || qty < 1 || qty > 10) {
      throw Error("An item or quantity in your bag is unavailable. Please update the bag.");
    }
    if (!Number.isFinite(v.price) || v.price <= 0) throw Error("An item has invalid pricing.");
    const productTotal = (productQuantities.get(v.handle) || 0) + qty;
    if (productTotal > 10) throw Error("Maximum 10 units of each product are allowed per order.");
    productQuantities.set(v.handle, productTotal);
    unique.add(id);
    const lineTotal = Number((Number(v.price) * qty).toFixed(2));
    total += lineTotal;
    return {
      id,
      qty,
      handle: v.handle,
      title: v.title,
      options: v.options || {},
      image: v.image,
      unitPrice: v.price,
      lineTotal,
    };
  });
  total = Number(total.toFixed(2));
  if (total <= 0 || total > 200000) throw Error("Order total is outside the supported range.");
  const payAmount = paymentMethod === "cod" ? Math.min(total, total < 700 ? 199 : 299) : total;
  return { items, total, payAmount, balanceDue: Number((total - payAmount).toFixed(2)) };
}

export function newTransactionId() {
  return "AM" + Date.now().toString(36).toUpperCase() + randomBytes(10).toString("hex").toUpperCase();
}

export function checkoutFields(order, merchant, baseUrl) {
  const firstname = order.customer.name.split(/\s+/)[0].slice(0, 60);
  const amount = Number(order.payAmount).toFixed(2);
  const productinfo = "ATTIRE MART Order " + order.id;
  const fields = {
    key: merchant.key,
    txnid: order.id,
    amount,
    productinfo,
    firstname,
    email: order.customer.email,
    phone: order.customer.phone,
    surl: baseUrl + "/api/payu-callback",
    furl: baseUrl + "/api/payu-callback",
    address1: order.customer.address1,
    address2: order.customer.address2,
    city: order.customer.city,
    state: order.customer.state,
    zipcode: order.customer.pincode,
    country: "India",
    udf1: order.paymentMethod,
    udf2: "",
    udf3: "",
    udf4: "",
    udf5: "",
  };
  // PayU _payment: key|txnid|amount|productinfo|firstname|email|udf1...udf5||||||SALT.
  fields.hash = hash(
    [
      fields.key,
      fields.txnid,
      fields.amount,
      fields.productinfo,
      fields.firstname,
      fields.email,
      fields.udf1,
      fields.udf2,
      fields.udf3,
      fields.udf4,
      fields.udf5,
      "",
      "",
      "",
      "",
      "",
      merchant.salt,
    ].join("|")
  );
  return { gateway: merchant.paymentUrl, fields };
}

export function callbackHashValid(data, merchant) {
  if (!data || data.key !== merchant.key || !data.txnid || !data.hash || !data.status) return false;
  const fields = [
    merchant.salt,
    String(data.status),
    "",
    "",
    "",
    "",
    "",
    String(data.udf5 || ""),
    String(data.udf4 || ""),
    String(data.udf3 || ""),
    String(data.udf2 || ""),
    String(data.udf1 || ""),
    String(data.email || ""),
    String(data.firstname || ""),
    String(data.productinfo || ""),
    String(data.amount || ""),
    String(data.txnid),
    merchant.key,
  ];
  if (data.additionalCharges || data.additional_charges) {
    fields.unshift(String(data.additionalCharges || data.additional_charges));
  }
  return hashMatches(hash(fields.join("|")), data.hash);
}

export async function saveOrder(order, isNew = false, storeOverride = null) {
  const store = storeOverride || (await getDefaultOrderStore());
  await store.save(order, isNew);
}

export async function findOrder(id, storeOverride = null) {
  if (!isValidOrderId(id)) return null;
  const store = storeOverride || (await getDefaultOrderStore());
  return store.find(id);
}

export async function verifyPayment(txnId, merchant) {
  const post = new URLSearchParams({
    key: merchant.key,
    command: "verify_payment",
    var1: txnId,
    hash: hash([merchant.key, "verify_payment", txnId, merchant.salt].join("|")),
  });
  const response = await fetch(merchant.verifyUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: post,
    signal: AbortSignal.timeout(13000),
  });
  if (!response.ok) throw Error("Could not verify PayU transaction.");
  const result = await response.json();
  const transaction = result.transaction_details?.[txnId];
  if (!transaction || String(transaction.status).toLowerCase() === "not found") {
    return { state: "pending" };
  }
  return {
    state: String(transaction.status || "").toLowerCase(),
    unmapped: String(transaction.unmappedstatus || "").toLowerCase(),
    amount: Number(transaction.transaction_amount || transaction.amt),
    txnId: String(transaction.txnid || txnId),
    payuId: String(transaction.mihpayid || ""),
  };
}

export function computeOrderReconciliationPatch(current, verified) {
  if (["paid", "cod_advance_paid"].includes(current.status)) return null;
  if (verified.txnId !== current.id || verified.amount !== Number(current.payAmount)) return null;
  if (verified.state === "success" && verified.unmapped === "captured") {
    return {
      status: current.paymentMethod === "cod" ? "cod_advance_paid" : "paid",
      fulfillmentStatus: "unfulfilled",
      payuId: verified.payuId || "",
    };
  }
  if (verified.state === "failure" && current.status === "pending") {
    return {
      status: "failed",
      fulfillmentStatus: "payment_failed",
      payuId: verified.payuId || current.payuId || "",
    };
  }
  return null;
}

export async function reconcileOrder(order, merchant, storeOverride = null) {
  // Only PayU's independently fetched transaction status may confirm payment.
  if (["paid", "cod_advance_paid"].includes(order.status)) return order;
  const verified = await verifyPayment(order.id, merchant);
  if (verified.txnId !== order.id || verified.amount !== Number(order.payAmount)) return order;
  const store = storeOverride || (await getDefaultOrderStore());
  const updated = await store.reconcile(order.id, current =>
    computeOrderReconciliationPatch(current, verified)
  );
  return updated || order;
}

export function merchantSite(request) {
  // PayU returns to the exact host processing checkout.
  const base = new URL(request.url).origin;
  if (!/^https:\/\//.test(base) && !/^http:\/\/localhost(?::\d+)?$/.test(base)) {
    throw Error("Secure checkout site URL is not configured.");
  }
  return base;
}
