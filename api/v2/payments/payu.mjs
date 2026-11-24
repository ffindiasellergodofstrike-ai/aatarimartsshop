"use strict";

/**
 * Isolated PayU payment API routes for /attirecheckout.
 * Handles order creation with customer safety validation, masked PayU fields,
 * strict price-whitelist mapping to ATTIRE MART products, and PayU return/webhook/status verification.
 */
import {
  sendJSON,
  getMerchant,
  hash,
  callbackHashValid,
  newTransactionId,
  newGuestOrderToken,
  hashGuestToken,
  guestTokenMatches,
  saveOrder,
  findOrder,
  reconcileOrder,
  verifyPayment,
  computeOrderReconciliationPatch,
  merchantSite,
  isValidOrderId,
  OrderStoreUnavailableError,
} from "../../../lib/checkout.mjs";
import { mapExternalAmountToCatalogProduct } from "../../../lib/catalog-product-picker.js";
import {
  validateCustomerName,
  validateCustomerEmail,
  validateCustomerPhone,
  containsBlockedKeyword,
} from "../../../lib/customer-safety-validation.js";
import {
  enforceActionRateLimit,
  checkAbuseBlock,
  recordAbuseStrike,
  clientAddress,
  CheckoutRateLimitError,
  CheckoutAbuseBlockedError,
} from "../../../lib/rate-limit.mjs";
import { getDefaultOrderStore } from "../../../lib/order-store.mjs";
import {
  runInBackground,
  sendPaidOrderTelegramNotification,
} from "../../../lib/telegram-notify.mjs";

// Preview-only memory fallback when running outside Vercel and Firestore Admin is unconfigured.
const previewMemoryOrders = new Map();

function savePreviewOrder(order) {
  if (previewMemoryOrders.size > 500) {
    const oldestKey = previewMemoryOrders.keys().next().value;
    if (oldestKey) previewMemoryOrders.delete(oldestKey);
  }
  const now = new Date().toISOString();
  previewMemoryOrders.set(order.id, {
    ...order,
    createdAt: order.createdAt || now,
    updatedAt: now,
  });
}

async function persistOrder(order) {
  try {
    await saveOrder(order, true);
    return;
  } catch (error) {
    if (
      error instanceof OrderStoreUnavailableError &&
      process.env.VERCEL !== "1"
    ) {
      savePreviewOrder(order);
      return;
    }
    throw error;
  }
}

async function lookupOrder(orderId) {
  if (!isValidOrderId(orderId)) return null;
  if (previewMemoryOrders.has(orderId)) {
    return previewMemoryOrders.get(orderId);
  }
  try {
    return await findOrder(orderId);
  } catch (error) {
    if (
      error instanceof OrderStoreUnavailableError &&
      process.env.VERCEL !== "1"
    ) {
      return previewMemoryOrders.get(orderId) || null;
    }
    throw error;
  }
}

async function reconcileIsolatedOrder(order, merchant) {
  if (previewMemoryOrders.has(order.id)) {
    if (["paid", "cod_advance_paid"].includes(order.status)) return order;
    const verified = await verifyPayment(order.id, merchant);
    const patch = computeOrderReconciliationPatch(order, verified);
    if (!patch) return order;
    const updated = {
      ...order,
      ...patch,
      paymentVerifiedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    previewMemoryOrders.set(order.id, updated);
    return updated;
  }
  return reconcileOrder(order, merchant);
}

function scheduleIsolatedPaidTelegramAlert(order) {
  if (!order || !["paid", "cod_advance_paid"].includes(order.status)) {
    return;
  }

  if (previewMemoryOrders.has(order.id)) {
    const claimFn = async id => {
      const current = previewMemoryOrders.get(id);
      if (!current || !["paid", "cod_advance_paid"].includes(current.status)) {
        return { claimed: false, reason: "not_paid" };
      }
      if (current.telegramNotified === true || current.telegramNotifyState === "sent") {
        return { claimed: false, reason: "already_notified" };
      }
      if (
        current.telegramNotifyState === "sending" &&
        Number.isFinite(Number(current.telegramClaimedAtMs)) &&
        Date.now() - Number(current.telegramClaimedAtMs) < 60000
      ) {
        return { claimed: false, reason: "in_flight" };
      }
      const next = {
        ...current,
        telegramNotifyState: "sending",
        telegramClaimedAtMs: Date.now(),
      };
      previewMemoryOrders.set(id, next);
      return { claimed: true, order: next };
    };
    const markSentFn = async id => {
      const current = previewMemoryOrders.get(id);
      if (current) {
        previewMemoryOrders.set(id, {
          ...current,
          telegramNotified: true,
          telegramNotifyState: "sent",
          telegramNotifiedAt: new Date().toISOString(),
        });
      }
      return true;
    };
    const releaseClaimFn = async id => {
      const current = previewMemoryOrders.get(id);
      if (current && current.telegramNotifyState !== "sent") {
        previewMemoryOrders.set(id, { ...current, telegramNotifyState: "failed" });
      }
      return true;
    };
    runInBackground(
      sendPaidOrderTelegramNotification(order, {
        claimFn,
        markSentFn,
        releaseClaimFn,
      })
    );
    return;
  }

  runInBackground(
    (async () => {
      const store = await getDefaultOrderStore();
      await sendPaidOrderTelegramNotification(order, {
        claimFn: id => store.claimTelegramNotification(id),
        markSentFn: id => store.markTelegramNotificationSent(id),
        releaseClaimFn: id => store.releaseTelegramNotificationClaim(id),
      });
    })()
  );
}

function cleanGeoHeader(rawValue) {
  if (!rawValue) return "";
  let text = String(rawValue).trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep raw text if malformed percent-encoding
  }
  return text.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 64);
}

function extractIpGeo(request) {
  const city = cleanGeoHeader(request.headers.get("x-vercel-ip-city"));
  const region = cleanGeoHeader(request.headers.get("x-vercel-ip-country-region"));
  const country = cleanGeoHeader(request.headers.get("x-vercel-ip-country"));
  const parts = [city, region, country].filter(Boolean);
  return parts.length ? parts.join(", ") : "";
}

function extractIpCoords(request) {
  const lat = Number(request.headers.get("x-vercel-ip-latitude"));
  const lng = Number(request.headers.get("x-vercel-ip-longitude"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {
    latitude: Number(lat.toFixed(4)),
    longitude: Number(lng.toFixed(4)),
  };
}

function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  const prefix = `${name}=`;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length));
      } catch {
        return trimmed.slice(prefix.length);
      }
    }
  }
  return "";
}

function cleanTelemetryText(value, maxLen = 100) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function resolveRequestDeviceId(request, input) {
  const bodyDid = cleanTelemetryText(input?.deviceId, 64);
  if (/^[a-zA-Z0-9_-]{8,64}$/.test(bodyDid)) {
    return bodyDid;
  }
  const cookieDid = cleanTelemetryText(readCookie(request, "ac_did"), 64);
  if (/^[a-zA-Z0-9_-]{8,64}$/.test(cookieDid)) {
    return cookieDid;
  }
  const sigDid = cleanTelemetryText(input?.deviceInfo?.deviceSignature, 64);
  if (/^[a-zA-Z0-9_-]{8,64}$/.test(sigDid)) {
    return sigDid;
  }
  return "";
}

export function sanitizeDeviceTelemetry(rawInfo, request) {
  const src = rawInfo && typeof rawInfo === "object" && !Array.isArray(rawInfo) ? rawInfo : {};
  const ua = cleanTelemetryText(request.headers.get("user-agent"), 240);
  const secModel = cleanTelemetryText(request.headers.get("sec-ch-ua-model"), 80).replace(/^"|"$/g, "");
  const secPlatform = cleanTelemetryText(request.headers.get("sec-ch-ua-platform"), 60).replace(/^"|"$/g, "");

  return {
    browser: cleanTelemetryText(src.browser, 80) || (ua ? ua.slice(0, 80) : ""),
    os: cleanTelemetryText(src.os, 80) || secPlatform || "",
    deviceModel: cleanTelemetryText(src.deviceModel, 100) || secModel || "",
    deviceType: cleanTelemetryText(src.deviceType, 32),
    screen: cleanTelemetryText(src.screen, 40),
    viewport: cleanTelemetryText(src.viewport, 40),
    timezone: cleanTelemetryText(src.timezone, 64),
    language: cleanTelemetryText(src.language || request.headers.get("accept-language"), 64),
    cpuCores: cleanTelemetryText(src.cpuCores, 16),
    ramGb: cleanTelemetryText(src.ramGb, 16),
    networkType: cleanTelemetryText(src.networkType, 48),
    gpuRenderer: cleanTelemetryText(src.gpuRenderer, 120),
    battery: cleanTelemetryText(src.battery, 40),
    redirectSource: cleanTelemetryText(src.redirectSource, 200),
    deviceSignature: cleanTelemetryText(src.deviceSignature, 64),
    platform: cleanTelemetryText(src.platform, 64),
    touchPoints: cleanTelemetryText(src.touchPoints, 16),
  };
}

export function sanitizeCustomerLocation(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const lat = Number(raw.latitude ?? raw.lat);
  const lng = Number(raw.longitude ?? raw.lng);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return null;
  }
  const accRaw = Number(raw.accuracy);
  const accuracy =
    Number.isFinite(accRaw) && accRaw >= 0 && accRaw <= 100000 ? Math.round(accRaw) : null;
  const capturedAt =
    typeof raw.capturedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(raw.capturedAt)
      ? raw.capturedAt.slice(0, 40)
      : new Date().toISOString();
  return {
    latitude: Number(lat.toFixed(6)),
    longitude: Number(lng.toFixed(6)),
    ...(accuracy !== null ? { accuracy } : {}),
    capturedAt,
  };
}

function normalizeGatewayPhone(rawPhone) {
  const digits = String(rawPhone || "")
    .replace(/\D/g, "")
    .slice(-10)
    .padStart(10, "9");
  return /^[6-9]\d{9}$/.test(digits) ? digits : "9" + digits.slice(1);
}

function normalizeGatewayEmail(rawEmail) {
  const clean = String(rawEmail || "").trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    return clean.slice(0, 120);
  }
  return "customer12@gmail.com";
}

function sanitizeGatewayHeaders(request) {
  // Never pass referrer or external tracking context further.
  const origin = request.headers.get("origin");
  const expectedOrigin = new URL(request.url).origin;
  if (origin && origin !== expectedOrigin) {
    return { validOrigin: false, expectedOrigin };
  }
  return { validOrigin: true, expectedOrigin };
}

function privateNoStoreHeaders(extra = {}) {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Vercel-CDN-Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
}

function redirectResponse(location) {
  return new Response(null, {
    status: 303,
    headers: privateNoStoreHeaders({
      Location: location,
    }),
  });
}

async function handleCreateOrder(request) {
  if (request.method !== "POST") {
    return sendJSON({ error: "Method not allowed" }, 405, privateNoStoreHeaders());
  }

  const { validOrigin } = sanitizeGatewayHeaders(request);
  if (!validOrigin) {
    return sendJSON(
      { error: "Cross-site checkout requests are not accepted." },
      403,
      privateNoStoreHeaders()
    );
  }

  try {
    const rateSalt = String(process.env.PAYU_MERCHANT_SALT || "");
    const cookieDeviceId = cleanTelemetryText(readCookie(request, "ac_did"), 64);

    // Pre-check IP & cookie device block even before parsing body
    await checkAbuseBlock(request, { deviceId: cookieDeviceId, merchantSalt: rateSalt });

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 35000) {
      return sendJSON({ error: "Request payload too large." }, 413, privateNoStoreHeaders());
    }

    const input = await request.json();
    if (!input || typeof input !== "object") {
      return sendJSON({ error: "Invalid request payload." }, 400, privateNoStoreHeaders());
    }

    const deviceId = resolveRequestDeviceId(request, input);
    if (deviceId && deviceId !== cookieDeviceId) {
      await checkAbuseBlock(request, { deviceId, merchantSalt: rateSalt });
    }

    const maskedCustomer = input.customer && typeof input.customer === "object" ? input.customer : {};
    const origCustomer =
      input.originalCustomerData && typeof input.originalCustomerData === "object"
        ? input.originalCustomerData
        : maskedCustomer;

    const origName = String(origCustomer.name || maskedCustomer.name || "").trim();
    const origEmail = String(origCustomer.email || maskedCustomer.email || "").trim();
    const origPhone = String(origCustomer.phone || maskedCustomer.phone || "")
      .replace(/\D/g, "")
      .slice(-10);

    const nameCheck = validateCustomerName(origName);
    const maskedNameRestricted = Boolean(
      maskedCustomer.name && containsBlockedKeyword(String(maskedCustomer.name))
    );
    const emailCheck = validateCustomerEmail(origEmail);

    if (nameCheck.restricted || maskedNameRestricted || emailCheck.restricted) {
      const strike = await recordAbuseStrike(request, {
        deviceId,
        merchantSalt: rateSalt,
      });
      return sendJSON(
        {
          error: strike.blocked
            ? "Access blocked for 24 hours due to repeated restricted or abusive attempts."
            : `Restricted or abusive terms are not permitted (Warning ${strike.strikes}/${strike.maxWarnings} — after 3 warnings, access will be blocked for 24 hours).`,
          blocked: Boolean(strike.blocked),
          strikes: strike.strikes,
          maxWarnings: strike.maxWarnings,
          ...(strike.retryAfterSeconds ? { retryAfterSeconds: strike.retryAfterSeconds } : {}),
          ...(strike.blockedUntil ? { unblockAt: strike.blockedUntil } : {}),
        },
        403,
        privateNoStoreHeaders(
          strike.retryAfterSeconds ? { "Retry-After": String(strike.retryAfterSeconds) } : {}
        )
      );
    }

    if (!nameCheck.valid) {
      return sendJSON(
        { error: nameCheck.message || "Invalid customer name." },
        400,
        privateNoStoreHeaders()
      );
    }

    const phoneCheck = validateCustomerPhone(origPhone);
    if (!phoneCheck.valid) {
      return sendJSON(
        { error: phoneCheck.message || "Please enter a valid 10-digit Indian mobile number." },
        400,
        privateNoStoreHeaders()
      );
    }

    if (!emailCheck.valid) {
      return sendJSON(
        { error: emailCheck.message || "Invalid personal email address." },
        400,
        privateNoStoreHeaders()
      );
    }

    // Strict price-whitelist & catalog mapping
    const mapped = mapExternalAmountToCatalogProduct(input.amount);

    const merchant = getMerchant();

    // Enforce rate limits: 5/min and 50/24h per IP + persistent Device ID
    await enforceActionRateLimit(request, {
      action: "attire_checkout",
      email: origEmail,
      deviceId,
      merchantSalt: merchant.salt,
    });
    const siteOrigin = merchantSite(request);
    const orderId = newTransactionId();
    const guestToken = newGuestOrderToken();

    const payuPhone = normalizeGatewayPhone(maskedCustomer.phone || origPhone);
    const payuEmail = normalizeGatewayEmail(maskedCustomer.email || origEmail);
    const firstname =
      origName
        .split(/\s+/)[0]
        .replace(/[^a-zA-Z0-9 ._-]/g, "")
        .slice(0, 60) || "Customer";

    const amountStr = Number(mapped.totalAmount).toFixed(2);
    // Clean ATTIRE MART fashion order description only — zero gaming keys or identifiers.
    const productinfo = `ATTIRE MART Order ${orderId} - ${mapped.primaryProductName}`.slice(0, 95);
    const returnUrl = `${siteOrigin}/api/v2/payments/payu/return?orderId=${encodeURIComponent(orderId)}&pkg=${encodeURIComponent(mapped.totalAmount)}`;

    const fields = {
      key: merchant.key,
      txnid: orderId,
      amount: amountStr,
      productinfo,
      firstname,
      email: payuEmail,
      phone: payuPhone,
      surl: returnUrl,
      furl: returnUrl,
      udf1: "prepaid",
      udf2: String(mapped.primaryProductId),
      udf3: "",
      udf4: "",
      udf5: "",
    };

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

    const customerIp = clientAddress(request);
    const ipGeo = extractIpGeo(request);
    const ipCoords = extractIpCoords(request);
    const customerLocation = sanitizeCustomerLocation(input.customerLocation);
    const deviceTelemetry = sanitizeDeviceTelemetry(input.deviceInfo, request);

    const order = {
      id: orderId,
      status: "pending",
      fulfillmentStatus: "awaiting_payment",
      paymentMethod: "prepaid",
      currency: "INR",
      total: mapped.totalAmount,
      payAmount: mapped.totalAmount,
      balanceDue: 0,
      items: mapped.items,
      productinfo,
      customer: {
        name: origName,
        email: payuEmail,
        phone: payuPhone,
      },
      // Stored strictly server-side; never transmitted to PayU or client status responses.
      originalCustomerData: {
        name: origName,
        email: origEmail.toLowerCase(),
        phone: origPhone,
      },
      customerMeta: {
        ip: customerIp,
        ...(ipGeo ? { ipGeo } : {}),
        ...(ipCoords ? { ipCoords } : {}),
        ...(deviceId ? { deviceId } : {}),
        deviceTelemetry,
      },
      customerLocation,
      orderTags: mapped.orderTags,
      payuId: "",
      paymentVerifiedAt: null,
      source: "attirecheckout",
      accessTokenHash: hashGuestToken(guestToken),
    };

    await persistOrder(order);

    const secureFlag = siteOrigin.startsWith("https://")
      ? "; Secure; SameSite=None; Partitioned"
      : "; SameSite=Lax";
    const statusCookie = `am_ot_${orderId}=${encodeURIComponent(guestToken)}; Path=/api; HttpOnly; Max-Age=900${secureFlag}`;

    return sendJSON(
      {
        success: true,
        gateway: merchant.paymentUrl,
        mode: merchant.mode,
        fields,
        orderId,
        amount: mapped.totalAmount,
        currency: "INR",
        product: mapped,
        orderToken: guestToken,
      },
      200,
      privateNoStoreHeaders({ "Set-Cookie": statusCookie })
    );
  } catch (error) {
    if (error instanceof CheckoutAbuseBlockedError) {
      return sendJSON(
        {
          error: error.message,
          blocked: true,
          retryAfterSeconds: error.retryAfterSeconds,
          unblockAt: error.unblockAt,
        },
        403,
        privateNoStoreHeaders({ "Retry-After": String(error.retryAfterSeconds) })
      );
    }
    if (error instanceof CheckoutRateLimitError) {
      return sendJSON(
        {
          error: error.message,
          blocked: true,
          retryAfterSeconds: error.retryAfterSeconds,
          unblockAt: error.unblockAt,
        },
        429,
        privateNoStoreHeaders({ "Retry-After": String(error.retryAfterSeconds) })
      );
    }
    const message = String(error?.message || "Payment initiation failed.");
    const isInvalidInput = /Invalid|Please /i.test(message);
    const isConfig = /configured|PAYU_MERCHANT|Firebase/i.test(message);
    return sendJSON(
      { error: message },
      isInvalidInput ? 400 : isConfig ? 503 : 500,
      privateNoStoreHeaders()
    );
  }
}

async function handlePayuReturn(request) {
  const url = new URL(request.url);
  const queryPkg = url.searchParams.get("pkg") || "";
  const queryOrderId = url.searchParams.get("orderId") || url.searchParams.get("txnid") || "";

  let fields = {};
  if (request.method === "POST") {
    try {
      const bodyText = await request.text();
      if (bodyText.length <= 20000) {
        fields = Object.fromEntries(new URLSearchParams(bodyText));
      }
    } catch {
      fields = {};
    }
  } else if (request.method === "GET") {
    fields = Object.fromEntries(url.searchParams.entries());
  } else {
    return sendJSON({ error: "Method not allowed" }, 405, privateNoStoreHeaders());
  }

  const orderId = String(fields.txnid || queryOrderId || "").trim();
  const safePkg =
    /^\d+(?:\.\d{1,2})?$/.test(queryPkg) && Number(queryPkg) > 0
      ? queryPkg
      : /^\d+(?:\.\d{1,2})?$/.test(String(fields.amount || ""))
        ? String(Math.round(Number(fields.amount)))
        : "599";

  const failRedirect = `/attirecheckout?status=failed&pkg=${encodeURIComponent(safePkg)}`;

  try {
    if (!orderId || !isValidOrderId(orderId)) {
      return redirectResponse(failRedirect);
    }

    const merchant = getMerchant();
    if (!callbackHashValid(fields, merchant)) {
      return redirectResponse(failRedirect);
    }

    const order = await lookupOrder(orderId);
    if (!order) {
      return redirectResponse(failRedirect);
    }

    const matchesOrder =
      Number(fields.amount) === Number(order.payAmount) &&
      fields.udf1 === "prepaid" &&
      fields.productinfo === order.productinfo &&
      fields.email === order.customer.email &&
      fields.firstname === order.customer.name.split(/\s+/)[0].replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, 60);

    if (!matchesOrder) {
      return redirectResponse(failRedirect);
    }

    let verifiedOrder = order;
    try {
      verifiedOrder = await reconcileIsolatedOrder(order, merchant);
    } catch (err) {
      console.error("PayU isolated reconciliation delayed:", err?.message);
    }

    const finalPkg = encodeURIComponent(String(order.payAmount || safePkg));
    if (verifiedOrder?.status === "paid" || verifiedOrder?.status === "cod_advance_paid") {
      scheduleIsolatedPaidTelegramAlert(verifiedOrder);
      return redirectResponse(`/attirecheckout?status=success&pkg=${finalPkg}`);
    }
    return redirectResponse(`/attirecheckout?status=failed&pkg=${finalPkg}`);
  } catch {
    return redirectResponse(failRedirect);
  }
}

async function handlePayuWebhook(request) {
  if (request.method !== "POST") {
    return sendJSON({ error: "Method not allowed" }, 405, privateNoStoreHeaders());
  }

  try {
    const bodyText = await request.text();
    if (bodyText.length > 20000) {
      return sendJSON({ error: "Invalid webhook payload." }, 413, privateNoStoreHeaders());
    }
    const fields = Object.fromEntries(new URLSearchParams(bodyText));
    const merchant = getMerchant();

    if (!callbackHashValid(fields, merchant)) {
      return sendJSON({ error: "Invalid PayU webhook signature." }, 400, privateNoStoreHeaders());
    }

    const order = await lookupOrder(fields.txnid);
    if (!order) {
      return sendJSON({ error: "Unknown order." }, 404, privateNoStoreHeaders());
    }

    if (
      Number(fields.amount) !== Number(order.payAmount) ||
      fields.productinfo !== order.productinfo ||
      fields.email !== order.customer.email
    ) {
      return sendJSON({ error: "Order mismatch." }, 400, privateNoStoreHeaders());
    }

    const verifiedOrder = await reconcileIsolatedOrder(order, merchant);
    if (!["paid", "cod_advance_paid", "failed"].includes(verifiedOrder?.status)) {
      return sendJSON(
        { received: false, retry: true },
        503,
        privateNoStoreHeaders({ "Retry-After": "30" })
      );
    }

    if (verifiedOrder?.status === "paid" || verifiedOrder?.status === "cod_advance_paid") {
      scheduleIsolatedPaidTelegramAlert(verifiedOrder);
    }

    return sendJSON({ received: true, verified: true, status: verifiedOrder.status }, 200, privateNoStoreHeaders());
  } catch {
    return sendJSON(
      { error: "Payment verification temporarily unavailable." },
      503,
      privateNoStoreHeaders()
    );
  }
}

async function handlePayuStatus(request) {
  if (request.method !== "GET") {
    return sendJSON({ error: "Method not allowed" }, 405, privateNoStoreHeaders());
  }

  const url = new URL(request.url);
  const orderId = (url.searchParams.get("orderId") || url.searchParams.get("txnid") || "").trim();
  if (!isValidOrderId(orderId)) {
    return sendJSON({ error: "Invalid order reference." }, 400, privateNoStoreHeaders());
  }

  const headerToken = (request.headers.get("x-order-token") || "").trim();
  const cookieHeader = request.headers.get("cookie") || "";
  let cookieToken = "";
  const prefix = `am_ot_${orderId}=`;
  for (const part of cookieHeader.split(";")) {
    const t = part.trim();
    if (t.startsWith(prefix)) {
      try {
        cookieToken = decodeURIComponent(t.slice(prefix.length));
      } catch {
        cookieToken = "";
      }
      break;
    }
  }
  const token = headerToken || cookieToken;
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return sendJSON({ error: "Order access token is required." }, 401, privateNoStoreHeaders());
  }

  try {
    await enforceActionRateLimit(request, {
      action: "status",
      merchantSalt: String(process.env.PAYU_MERCHANT_SALT || ""),
    });
    let order = await lookupOrder(orderId);
    if (!order) {
      return sendJSON({ error: "Order not found." }, 404, privateNoStoreHeaders());
    }
    if (!guestTokenMatches(token, order.accessTokenHash)) {
      return sendJSON({ error: "Unauthorized order access." }, 403, privateNoStoreHeaders());
    }

    if (order.status === "pending") {
      try {
        order = await reconcileIsolatedOrder(order, getMerchant());
        if (order?.status === "paid" || order?.status === "cod_advance_paid") {
          scheduleIsolatedPaidTelegramAlert(order);
        }
      } catch {
        // Keep current status if PayU check is pending/unavailable
      }
    }

    return sendJSON(
      {
        orderId: order.id,
        status: order.status,
        amount: order.payAmount,
        currency: order.currency || "INR",
        updatedAt: order.updatedAt,
      },
      200,
      privateNoStoreHeaders()
    );
  } catch (error) {
    if (error instanceof CheckoutRateLimitError) {
      return sendJSON(
        { error: error.message },
        429,
        privateNoStoreHeaders({ "Retry-After": String(error.retryAfterSeconds) })
      );
    }
    return sendJSON({ error: "Unable to verify order status." }, 503, privateNoStoreHeaders());
  }
}

export const createPayuIsolatedOrder = { fetch: handleCreateOrder };
export const payuIsolatedReturn = { fetch: handlePayuReturn };
export const payuIsolatedWebhook = { fetch: handlePayuWebhook };
export const payuIsolatedStatus = { fetch: handlePayuStatus };

export default {
  fetch() {
    return sendJSON({ error: "Not found" }, 404, privateNoStoreHeaders());
  },
};
