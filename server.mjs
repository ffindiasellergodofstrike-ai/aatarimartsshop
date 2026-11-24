import "dotenv/config";
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
import { buildPrivateCheckoutBundle } from "./lib/private-checkout-bundle.mjs";
import { handlePrivateCheckoutRequest } from "./lib/private-checkout-handler.mjs";

const root = process.cwd();
const publishDir = path.join(root, "publish");

if (!fs.existsSync(path.join(publishDir, "index.html"))) {
  await import("./scripts/build-public.mjs");
}

// Pre-build the isolated /attirecheckout client bundle (stored outside publish/)
await buildPrivateCheckoutBundle({ force: true });

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

// 1. Dedicated isolated server-side gate for /attirecheckout (MUST run before static/SPA fallbacks)
app.use(async (req, res, next) => {
  if (!isPrivateCheckoutRoute(req.path)) {
    return next();
  }
  delete req.headers["referer"];
  delete req.headers["referrer"];
  try {
    const webReq = toWebRequest(req);
    const webRes = await handlePrivateCheckoutRequest(webReq);
    await sendWebResponse(res, webRes);
  } catch (err) {
    console.error("Private checkout handler error:", err);
    res.status(500).type("text/plain").send("Internal server error");
  }
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
  const cookies = typeof webRes.headers.getSetCookie === "function" ? webRes.headers.getSetCookie() : [];
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  if (cookies.length > 0) {
    res.setHeader("set-cookie", cookies);
  }
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
