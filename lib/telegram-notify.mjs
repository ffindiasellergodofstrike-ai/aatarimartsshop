"use strict";

/**
 * Server-side Telegram Bot notifications for verified paid /attirecheckout orders.
 * Never imports client code, never logs tokens/secrets, and never delays HTTP redirects.
 */
import { waitUntil } from "@vercel/functions";

const PLACEHOLDER_RE = /^(PENDING_|PLACEHOLDER_|REPLACE_|SET_REAL_|YOUR_)/i;
const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,}$/;
const CHAT_ID_RE = /^-?\d{3,20}$/;

function cleanEnvValue(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s || PLACEHOLDER_RE.test(s)) return "";
  return s;
}

export function resolveTelegramConfig(env = process.env) {
  const botToken = cleanEnvValue(env.TELEGRAM_BOT_TOKEN);
  const chatId = cleanEnvValue(env.TELEGRAM_CHAT_ID);
  if (!botToken || !chatId) {
    return null;
  }
  if (!BOT_TOKEN_RE.test(botToken) || !CHAT_ID_RE.test(chatId)) {
    return null;
  }
  return { botToken, chatId };
}

export function runInBackground(promise) {
  const safePromise = Promise.resolve(promise).catch(() => {});
  try {
    waitUntil(safePromise);
  } catch {
    // No-op outside Vercel Serverless runtime (e.g. Express server / Node tests).
  }
  return safePromise;
}

function formatLocationBlock(order) {
  const loc = order?.customerLocation;
  const metaGeo = order?.customerMeta?.ipGeo;
  const lines = [];

  if (
    loc &&
    typeof loc === "object" &&
    Number.isFinite(Number(loc.latitude)) &&
    Number.isFinite(Number(loc.longitude))
  ) {
    const lat = Number(loc.latitude).toFixed(6);
    const lng = Number(loc.longitude).toFixed(6);
    const accText = Number.isFinite(Number(loc.accuracy)) ? ` (±${Math.round(Number(loc.accuracy))}m)` : "";
    lines.push(`Location (GPS): ${lat}, ${lng}${accText}`);
    lines.push(`Map: https://maps.google.com/?q=${lat},${lng}`);
  } else {
    lines.push("Location (GPS): Not shared");
  }

  if (metaGeo && typeof metaGeo === "string") {
    lines.push(`IP Geo: ${metaGeo}`);
  }

  return lines.join("\n");
}

export function buildPaidOrderTelegramMessage(order) {
  const orig =
    order?.originalCustomerData && typeof order.originalCustomerData === "object"
      ? order.originalCustomerData
      : {};
  const fallbackCustomer =
    order?.customer && typeof order.customer === "object" ? order.customer : {};

  const realName = String(orig.name || fallbackCustomer.name || "Customer").trim();
  const realPhone = String(orig.phone || fallbackCustomer.phone || "N/A").trim();
  const realEmail = String(orig.email || fallbackCustomer.email || "N/A").trim();
  const ip = String(order?.customerMeta?.ip || "unknown").trim();
  const amount = Number.isFinite(Number(order?.payAmount)) ? Number(order.payAmount) : 0;
  const payuId = String(order?.payuId || "Verified").trim();
  const productTitle = String(
    order?.items?.[0]?.title || order?.productinfo || "ATTIRE MART Order"
  ).trim();

  return [
    "NEW PAID ORDER (/attirecheckout)",
    `Status: ${String(order?.status || "paid").toUpperCase()}`,
    `Order ID: ${String(order?.id || "N/A")}`,
    `PayU ID: ${payuId}`,
    `Amount: Rs ${amount}`,
    `Item: ${productTitle}`,
    "",
    "Customer Details (Real):",
    `Name: ${realName}`,
    `Mobile: ${realPhone}`,
    `Email: ${realEmail}`,
    `IP Address: ${ip}`,
    formatLocationBlock(order),
  ].join("\n");
}

export async function sendPaidOrderTelegramNotification(
  order,
  {
    env = process.env,
    fetchImpl = fetch,
    claimFn,
    markSentFn,
    releaseClaimFn,
  } = {}
) {
  if (!order || !["paid", "cod_advance_paid"].includes(order.status)) {
    return { sent: false, skipped: "not_paid" };
  }

  const cfg = resolveTelegramConfig(env);
  if (!cfg) {
    return { sent: false, skipped: "not_configured" };
  }

  if (typeof claimFn !== "function") {
    return { sent: false, skipped: "missing_claim_handler" };
  }

  const claim = await claimFn(order.id);
  if (!claim?.claimed) {
    return { sent: false, skipped: claim?.reason || "already_claimed" };
  }

  const targetOrder = claim.order || order;
  const text = buildPaidOrderTelegramMessage(targetOrder);
  const endpoint = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(2500),
    });

    if (!response.ok) {
      if (typeof releaseClaimFn === "function") {
        await releaseClaimFn(order.id).catch(() => {});
      }
      return { sent: false, status: response.status };
    }

    if (typeof markSentFn === "function") {
      await markSentFn(order.id).catch(() => {});
    }
    return { sent: true };
  } catch {
    if (typeof releaseClaimFn === "function") {
      await releaseClaimFn(order.id).catch(() => {});
    }
    return { sent: false, error: "telegram_request_failed" };
  }
}
