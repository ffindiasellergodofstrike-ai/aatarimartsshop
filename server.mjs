import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import createOrder from "./api/create-order.mjs";
import orderStatus from "./api/order-status.mjs";
import payuCallback from "./api/payu-callback.mjs";
import {
  createPayuIsolatedOrder,
  payuIsolatedReturn,
  payuIsolatedWebhook,
  payuIsolatedStatus,
} from "./api/v2/payments/payu.mjs";
import { readCheckoutParameters } from "./lib/checkout-access.js";
import { buildPrivateCheckoutBundle } from "./lib/private-checkout-bundle.mjs";

const root = process.cwd();
const publishDir = path.join(root, "publish");

if (!fs.existsSync(path.join(publishDir, "index.html"))) {
  await import("./scripts/build-public.mjs");
}

// Pre-build the isolated /attirecheckout client bundle (stored outside publish/)
await buildPrivateCheckoutBundle();

const app = express();
app.set("trust proxy", true);

const apiRoutes = {
  "/api/create-order": createOrder,
  "/api/order-status": orderStatus,
  "/api/payu-callback": payuCallback,
  "/api/v2/payments/payu/create-order": createPayuIsolatedOrder,
  "/api/v2/payments/payu/return": payuIsolatedReturn,
  "/api/v2/payments/payu/webhook": payuIsolatedWebhook,
  "/api/v2/payments/payu/status": payuIsolatedStatus,
};

function isPrivateCheckoutRoute(pathname) {
  const normalized = String(pathname || "")
    .replace(/\/+$/, "")
    .replace(/-+/g, "")
    .toLowerCase();
  return normalized === "/attirecheckout";
}

function isBlockedLegacyPrivateRoute(pathname) {
  const normalized = String(pathname || "")
    .replace(/\/+$/, "")
    .replace(/-+/g, "")
    .toLowerCase();
  return normalized === "/booyahpay";
}

function hasCookie(cookieHeader, name, expectedValue) {
  if (!cookieHeader) return false;
  const prefix = `${name}=`;
  for (const part of String(cookieHeader).split(";")) {
    const trimmed = part.trim();
    if (trimmed === `${prefix}${expectedValue}`) {
      return true;
    }
  }
  return false;
}

function applyPrivateSecurityHeaders(res, { nonce = null, allowPreviewIframe = false } = {}) {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Vercel-CDN-Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!allowPreviewIframe) {
    res.setHeader("X-Frame-Options", "DENY");
  }
  if (nonce) {
    const frameDirective = allowPreviewIframe
      ? "frame-ancestors 'self' https://aistudio.google.com https://*.google.com https://*.googleusercontent.com"
      : "frame-ancestors 'none'";
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "form-action 'self' https://test.payu.in https://secure.payu.in",
        frameDirective,
        "base-uri 'self'",
      ].join("; ")
    );
  }
}

function renderPrivateCheckoutHtml(nonce, bootstrapParams) {
  const safeJson = JSON.stringify(bootstrapParams || {}).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <meta name="referrer" content="no-referrer" />
    <title>Checkout</title>
  </head>
  <body>
    <div id="private-checkout-root"></div>
    <script nonce="${nonce}">
      try {
        Object.defineProperty(document, 'referrer', { get: function () { return ''; }, configurable: true });
        Object.defineProperty(Document.prototype, 'referrer', { get: function () { return ''; }, configurable: true });
      } catch (e) {}
      window.__CHECKOUT__ = ${safeJson};
    </script>
    <script nonce="${nonce}" src="/attirecheckout?asset=checkout.js"></script>
  </body>
</html>`;
}

// 1. Dedicated isolated server-side gate for /attirecheckout (MUST run before static/SPA fallbacks)
app.use(async (req, res, next) => {
  if (isBlockedLegacyPrivateRoute(req.path)) {
    delete req.headers["referer"];
    delete req.headers["referrer"];
    applyPrivateSecurityHeaders(res);
    return res.status(404).type("text/plain").send("Not found");
  }

  if (!isPrivateCheckoutRoute(req.path)) {
    return next();
  }

  // Immediately strip incoming referrer headers
  delete req.headers["referer"];
  delete req.headers["referrer"];

  const allowPreviewIframe = req.headers["sec-fetch-dest"] === "iframe";

  if (req.method !== "GET") {
    applyPrivateSecurityHeaders(res, { allowPreviewIframe });
    return res.status(404).type("text/plain").send("Not found");
  }

  // Serve isolated minified IIFE JS asset outside publish/
  if (req.query?.asset === "checkout.js") {
    try {
      const bundlePath = await buildPrivateCheckoutBundle();
      applyPrivateSecurityHeaders(res, { allowPreviewIframe });
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      return res.sendFile(bundlePath);
    } catch (err) {
      console.error("Failed to serve isolated checkout bundle:", err);
      applyPrivateSecurityHeaders(res, { allowPreviewIframe });
      return res.status(500).type("text/plain").send("Bundle error");
    }
  }

  const qIdx = req.originalUrl.indexOf("?");
  const rawSearch = qIdx === -1 ? "" : req.originalUrl.slice(qIdx);
  const check = readCheckoutParameters(req.query, rawSearch);
  const hasSessionCookie = hasCookie(req.headers.cookie, "bp_session", "1");

  // Reject invalid/tampered/duplicate query strings even if cookie exists
  if (rawSearch.length > 1 && !check.valid) {
    applyPrivateSecurityHeaders(res, { allowPreviewIframe });
    return res.status(404).type("text/plain").send("Not found");
  }

  // Require either valid checkout query params (including pkg) OR active session cookie (for reloads after URL bar strip)
  if (!check.valid && !hasSessionCookie) {
    applyPrivateSecurityHeaders(res, { allowPreviewIframe });
    return res.status(404).type("text/plain").send("Not found");
  }

  if (check.valid) {
    const isHttps = req.secure || req.get("x-forwarded-proto") === "https";
    const cookieAttrs = isHttps
      ? "Path=/; Max-Age=900; HttpOnly; SameSite=None; Secure; Partitioned"
      : "Path=/; Max-Age=900; HttpOnly; SameSite=Lax";
    res.setHeader("Set-Cookie", `bp_session=1; ${cookieAttrs}`);
  }

  const nonce = crypto.randomBytes(16).toString("base64");
  applyPrivateSecurityHeaders(res, { nonce, allowPreviewIframe });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(renderPrivateCheckoutHtml(nonce, check.valid ? check.params : {}));
});

function toWebRequest(req) {
  const protocol = req.protocol || "http";
  const host = req.get("host") || "localhost:3000";
  const url = `${protocol}://${host}${req.originalUrl}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody && Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;
  return new Request(url, {
    method: req.method,
    headers,
    body,
  });
}

async function sendWebResponse(res, webRes) {
  res.status(webRes.status);
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.send(buf);
}

app.use(
  "/api",
  express.raw({ type: "*/*", limit: "1mb" }),
  async (req, res, next) => {
    if (req.path.startsWith("/v2/payments/")) {
      delete req.headers["referer"];
      delete req.headers["referrer"];
    }
    const handler = apiRoutes[`/api${req.path}`];
    if (!handler || typeof handler.fetch !== "function") {
      return next();
    }
    try {
      const webReq = toWebRequest(req);
      const webRes = await handler.fetch(webReq);
      await sendWebResponse(res, webRes);
    } catch (error) {
      console.error("API handler error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

app.use(
  "/media",
  express.static(path.join(publishDir, "media"), {
    maxAge: "1d",
  })
);

app.use(
  express.static(publishDir, {
    extensions: ["html"],
    redirect: false,
  })
);

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }
  const cleanRel = req.path.replace(/^\/+|\/+$/g, "");
  if (cleanRel) {
    const dirIndex = path.resolve(publishDir, cleanRel, "index.html");
    if (dirIndex.startsWith(publishDir + path.sep) && fs.existsSync(dirIndex)) {
      return res.sendFile(dirIndex);
    }
  }
  return res.sendFile(path.join(publishDir, "index.html"));
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`ATTIRE MART server listening on http://0.0.0.0:${PORT}`);
});
