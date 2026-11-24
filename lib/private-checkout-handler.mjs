"use strict";

import crypto from "node:crypto";
import fs from "node:fs";
import { readCheckoutParameters } from "./checkout-access.js";
import { buildPrivateCheckoutBundle, getPrivateCheckoutBundlePath } from "./private-checkout-bundle.mjs";

const EPHEMERAL_FALLBACK = crypto.randomBytes(32).toString("hex");

function getAssetSecret() {
  const seed =
    process.env.ASSET_SIGNING_SECRET ||
    process.env.PAYU_MERCHANT_SALT ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VERCEL_PROJECT_ID ||
    process.env.VERCEL_URL ||
    EPHEMERAL_FALLBACK;
  return crypto.createHash("sha256").update(`attirecheckout-asset|${seed}`).digest();
}

function signAssetToken(ttlMs = 60000) {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac("sha256", getAssetSecret()).update(String(exp)).digest("base64url");
  return `${exp}.${sig}`;
}

function verifyAssetToken(token) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = crypto.createHmac("sha256", getAssetSecret()).update(expStr).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookieValue(cookieHeader, name) {
  if (!cookieHeader) return "";
  const prefix = `${name}=`;
  for (const part of String(cookieHeader).split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return "";
}

function hasCookie(cookieHeader, name, expectedValue) {
  return readCookieValue(cookieHeader, name) === String(expectedValue);
}

function parseCheckoutContextCookie(cookieHeader) {
  const raw = readCookieValue(cookieHeader, "ac_ctx");
  if (!raw) return {};
  try {
    const decoded = JSON.parse(Buffer.from(decodeURIComponent(raw), "base64url").toString("utf8"));
    const check = readCheckoutParameters(decoded);
    return check.valid ? check.params : {};
  } catch {
    return {};
  }
}

const CRAWLER_UA_RE =
  /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandex|sogou|exabot|facebot|facebookexternalhit|ia_archiver|twitterbot|rogerbot|linkedinbot|embedly|quora link preview|showyoubot|outbrain|pinterest|slackbot|vkshare|w3c_validator|whatsapp|telegrambot|discordbot|applebot|semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|bytespider|gptbot|claudebot|anthropic|ccbot|perplexitybot|oai-searchbot|scrapy|python-requests|python-urllib|aiohttp|curl\/|wget\/|go-http-client|java\/|apache-httpclient|okhttp|headlesschrome|phantomjs|payu|cashfree|razorpay|stripe|phonepe|paytm)/i;

export function isCrawlerOrInspectorRequest(request) {
  const ua = String(request.headers.get("user-agent") || "").trim();
  if (!ua || ua.length < 12) return true;
  if (CRAWLER_UA_RE.test(ua)) return true;
  const purpose = String(
    request.headers.get("purpose") ||
      request.headers.get("x-purpose") ||
      request.headers.get("sec-purpose") ||
      ""
  ).toLowerCase();
  if (purpose.includes("preview") || purpose.includes("prefetch")) return true;
  return false;
}

export function isPreviewIframeRequest(request) {
  if (request.headers.get("sec-fetch-dest") === "iframe") return true;
  const host = String(request.headers.get("host") || new URL(request.url).host || "").toLowerCase();
  return (
    host.startsWith("ais-dev-") ||
    host.startsWith("ais-pre-") ||
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1")
  );
}

function buildSecurityHeaders({ nonce = null, allowPreviewIframe = false, contentType = "text/plain; charset=utf-8" } = {}) {
  const headers = new Headers({
    "Content-Type": contentType,
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Vercel-CDN-Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "geolocation=(self)",
  });
  if (!allowPreviewIframe) {
    headers.set("X-Frame-Options", "DENY");
  }
  if (nonce) {
    const frameDirective = allowPreviewIframe
      ? "frame-ancestors 'self' https://aistudio.google.com https://*.google.com https://*.googleusercontent.com https://*.usercontent.goog https://*.run.app"
      : "frame-ancestors 'none'";
    headers.set(
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
  return headers;
}

function renderPrivateCheckoutHtml(nonce, bootstrapParams, assetToken) {
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
    <script nonce="${nonce}" src="/attirecheckout?asset=checkout.js&t=${encodeURIComponent(assetToken)}"></script>
  </body>
</html>`;
}

function renderNotFoundHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <meta name="referrer" content="no-referrer" />
    <title>404 Page Not Found</title>
    <style>
      body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}
      .box{max-width:420px;width:100%;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:36px 24px;box-shadow:0 4px 20px rgba(15,23,42,.05)}
      h1{margin:0 0 8px;font-size:48px;font-weight:800;letter-spacing:-.02em;color:#0f172a}
      h2{margin:0 0 8px;font-size:18px;font-weight:700;color:#334155}
      p{margin:0;font-size:14px;color:#64748b;line-height:1.5}
    </style>
  </head>
  <body>
    <main class="box">
      <h1>404</h1>
      <h2>Page Not Found</h2>
      <p>The page you are looking for could not be found.</p>
    </main>
  </body>
</html>`;
}

export async function handlePrivateCheckoutRequest(request, { readStaticBundle = null } = {}) {
  const allowPreviewIframe = isPreviewIframeRequest(request);

  if (request.method !== "GET" || isCrawlerOrInspectorRequest(request)) {
    return new Response("Not found", {
      status: 404,
      headers: buildSecurityHeaders({ allowPreviewIframe }),
    });
  }

  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie") || "";
  const hasSessionCookie = hasCookie(cookieHeader, "ac_session", "1");

  if (url.searchParams.get("asset") === "checkout.js") {
    const tokenOk = verifyAssetToken(url.searchParams.get("t"));
    if (!hasSessionCookie && !tokenOk) {
      return new Response("Not found", {
        status: 404,
        headers: buildSecurityHeaders({ allowPreviewIframe }),
      });
    }
    try {
      let bundleBody = typeof readStaticBundle === "function" ? readStaticBundle() : null;
      if (!bundleBody) {
        let bundlePath = getPrivateCheckoutBundlePath();
        if (!fs.existsSync(bundlePath)) {
          bundlePath = await buildPrivateCheckoutBundle();
        }
        bundleBody = await fs.promises.readFile(bundlePath);
      }
      return new Response(bundleBody, {
        status: 200,
        headers: buildSecurityHeaders({
          allowPreviewIframe,
          contentType: "application/javascript; charset=utf-8",
        }),
      });
    } catch (err) {
      console.error("Failed to serve isolated checkout bundle:", err);
      return new Response("Bundle error", {
        status: 500,
        headers: buildSecurityHeaders({ allowPreviewIframe }),
      });
    }
  }

  const rawSearch = url.search || "";
  const queryObj = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(queryObj, k)) {
      queryObj[k] = Array.isArray(queryObj[k]) ? [...queryObj[k], v] : [queryObj[k], v];
    } else {
      queryObj[k] = v;
    }
  }
  const check = readCheckoutParameters(queryObj, rawSearch);

  if (rawSearch.length > 1 && !check.valid) {
    return new Response(renderNotFoundHtml(), {
      status: 404,
      headers: buildSecurityHeaders({ allowPreviewIframe, contentType: "text/html; charset=utf-8" }),
    });
  }

  const savedCtx = parseCheckoutContextCookie(cookieHeader);

  if (!check.valid && (!hasSessionCookie || !savedCtx.pkg)) {
    return new Response(renderNotFoundHtml(), {
      status: 404,
      headers: buildSecurityHeaders({ allowPreviewIframe, contentType: "text/html; charset=utf-8" }),
    });
  }

  let bootstrapParams = check.valid ? check.params : savedCtx;

  const nonce = crypto.randomBytes(16).toString("base64");
  const assetToken = signAssetToken();
  const headers = buildSecurityHeaders({
    nonce,
    allowPreviewIframe,
    contentType: "text/html; charset=utf-8",
  });

  if (check.valid) {
    const isHttps =
      url.protocol === "https:" ||
      String(request.headers.get("x-forwarded-proto") || "").toLowerCase() === "https";
    const cookieAttrs = isHttps
      ? "Path=/; Max-Age=900; HttpOnly; SameSite=None; Secure; Partitioned"
      : "Path=/; Max-Age=900; HttpOnly; SameSite=Lax";
    const mergedCtx = check.isCallback ? { ...savedCtx, ...check.params } : check.params;
    bootstrapParams = mergedCtx;
    const encodedCtx = encodeURIComponent(
      Buffer.from(JSON.stringify(mergedCtx), "utf8").toString("base64url")
    );
    headers.append("Set-Cookie", `ac_session=1; ${cookieAttrs}`);
    headers.append("Set-Cookie", `ac_ctx=${encodedCtx}; ${cookieAttrs}`);
  }

  return new Response(renderPrivateCheckoutHtml(nonce, bootstrapParams, assetToken), {
    status: 200,
    headers,
  });
}
