# ATTIRE MART — Vercel & Firebase Firestore Ecommerce Storefront

**GitHub main** contains the independent ATTIRE MART storefront. It includes 24 collections, 184 products, 878 variant records, 1,112 catalogue image references (only **194 WebP files are currently present in this replacement repository**), all policy pages, search, wishlist, a `localStorage` shopping bag, and a guest checkout with PayU hosted payments backed by **Google Firebase Cloud Firestore**. No customer login or account is required. The bag and server enforce a **maximum of 10 items per product across sizes/colours**.

## Vercel & Firebase Firestore Setup (Do Not Deploy Before Verification)

Connect this GitHub repository to **Vercel**, with **Root Directory = `.`**, **Framework Preset = `Other`**, **Production branch = `main`**, and **Node.js 22.x**. The checked-in `vercel.json` controls `buildCommand: npm run build`, `outputDirectory: publish`, three native Serverless Functions (`api/*.mjs`), and targeted static SEO rewrites.

### Firebase Project & Firestore Database

- **Firebase / Google Cloud Project ID:** `decent-mender-ps58c`
- **Firestore Database ID:** `ai-studio-835ece8d-07ef-4123-be16-5607a728e4a0`
- **Orders Collection:** `orders/{transactionId}`
- **Client Security Rules (`firestore.rules`):** Direct client SDK reads and writes are completely denied (`allow read, write: if false;`). All order creation, guest status verification, and PayU updates run exclusively on the server through `firebase-admin`.

### Server-Only Environment Variables

Set these in **Vercel → Project Settings → Environment Variables** (never expose them in frontend JavaScript or commit them to GitHub):

| Variable | Purpose |
| --- | --- |
| `PAYU_MERCHANT_KEY` | Your PayU merchant key |
| `PAYU_MERCHANT_SALT` | Your PayU merchant salt |
| `PAYU_ENV` | `test` for sandbox; change to `live` only after real verification |
| `PUBLIC_SITE_URL` | Final production HTTPS origin, no path or trailing slash |
| `FIREBASE_PROJECT_ID` | `decent-mender-ps58c` |
| `FIRESTORE_DATABASE_ID` | `ai-studio-835ece8d-07ef-4123-be16-5607a728e4a0` |
| `FIREBASE_CLIENT_EMAIL` | Least-privilege GCP service-account email (`roles/datastore.user`) |
| `FIREBASE_PRIVATE_KEY` | Service-account private key (keep `\n` escaped in Vercel env UI) |

### Troubleshooting HTTP 503 vs 404 / 401 / 403

- **HTTP 503 (`Order storage is temporarily unavailable`):** Firebase Admin credentials (`FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`), IAM permissions (`roles/datastore.user`), project billing/upgrade status, or Firestore connectivity failed. Checkout fails closed and never redirects to PayU.
- **HTTP 400:** Invalid transaction ID format or invalid customer/cart payload.
- **HTTP 401 / 403 on `/api/order-status`:** Missing or mismatched `X-Order-Token` / `am_ot_<txnid>` `HttpOnly` cookie. Guest order status lookup requires both the transaction ID and the cryptographically random 256-bit guest access token issued when the order was created.
- **HTTP 404:** Valid transaction ID and token format, but the order document does not exist in Firestore.
- **HTTP 405:** Unsupported HTTP method.

### Native HTTP API

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/create-order` | `POST` | Validate guest address, 10-unit product cap, and server catalogue prices; atomically create pending order in Firestore with `accessTokenHash`; issue `orderToken` and `HttpOnly` cookie; return signed PayU form |
| `/api/payu-callback` | `POST` | Validate PayU reverse SHA-512 hash and order fields; independently query PayU `verify_payment`; atomically reconcile Firestore order status (`paid` / `cod_advance_paid` / `failed`) without reversing previously paid orders |
| `/api/order-status?txnid=AM...` | `GET` | Verify guest order access token (`X-Order-Token` or `HttpOnly` cookie) and return strictly non-PII payment/fulfillment status from Firestore |

Frontend `checkout.js` calls these same-origin endpoints. The APIs share `lib/checkout.mjs` and `lib/order-store.mjs`; `data/checkout-catalog.json` and `firebase-applet-config.json` are excluded from `publish/`.

## Important: restoring missing media

The replacement repository contains **194 of 1,112 original WebP images**. The production build prioritizes exact, present local files and temporarily uses the corresponding original image's catalogue CDN URL for missing files. It never substitutes a different product's photo. This external image source is temporary and its availability and usage rights must be verified; restore the remaining 918 images from your authorized project export into `media/` for self-hosting. No internal deployment or source-control message is displayed to customers. Do not invent replacement product images or conceal missing assets by weakening CI.

## SEO, Local Dev, and Tests

Use Node.js >=22.12.0:

```sh
npm install
npm run lint
npm run test:api
npm run build
npm run dev
```

`npm run dev` runs `server.mjs` locally on port `3000` (`0.0.0.0`), bridging `/api/*` Web Fetch handlers and serving `publish/`.

## Before Accepting Real Orders

1. Ensure `decent-mender-ps58c` is a user-owned Google Cloud project with Cloud Billing enabled and a least-privilege service account (`roles/datastore.user`) configured in Vercel.
2. Complete PayU merchant domain approval and test sandbox prepaid, COD-advance, success, failure, and S2S callback reconciliation flows.
3. Verify `firestore.rules` is deployed (`allow read, write: if false;` for client access) before enabling `PAYU_ENV=live`.


## Checkout safety and rate-limit retention

- Checkout uses a per-attempt idempotency key; network retries reuse the original order instead of creating another PayU payment. Once an authenticated order becomes paid or failed, the matching browser attempt key is retired. Historical order lookups never erase a different cart.
- Firestore transactions enforce 6 checkouts/minute/IP, 24 checkouts/hour/IP, 8 checkouts/hour/email, plus 30 status lookups/minute/IP and 180/hour/IP. Rate-limit record keys are hashed and store no raw IP/email.
- Every new or refreshed `request_limits` document includes the Firestore timestamp field `expiresAt`, set 24 hours after the relevant counter window. **TTL deletion requires a one-time database admin setting**. Run `bash scripts/enable-rate-limit-ttl.sh` using a Google Cloud admin identity with permission to modify TTL policies and `FIREBASE_PROJECT_ID` / `FIRESTORE_DATABASE_ID` configured for the real database. Do not put privileged admin keys in the website.
- To activate through Google Cloud Console instead: Firestore → Databases → the production database → Time-to-live → Create Policy; collection group `request_limits`, timestamp field `expiresAt`, offset 0. Check that it becomes enabled. Without this policy, rate limiting still works but old counter documents are not automatically removed.
- Signed PayU S2S webhooks receive a retryable 503 if independent payment verification is temporarily unavailable or the transaction is still pending; only verified terminal outcomes receive 200. Browser returns go to authenticated order status even if verification is delayed. Never assume that a callback alone proves payment success.
- `scripts/migrate-original-images.mjs` is deliberately manual/idempotent; there are 1,112 local product images and no external product-photo references. Re-run via the manual `ATTIRE MART one-time local photo migration` workflow only when explicitly rebuilding original assets.

The same-domain image assets and system-font stacks avoid external image/font requests. QA checks every local product image and verifies that checkout/order browsing does not clear unrelated cart items.

### PayU merchant dashboard: S2S verification

Configure the separate PayU payment-status S2S webhook callback at
`https://YOUR-STOREFRONT-DOMAIN/api/payu-callback?webhook=1` in the merchant
dashboard (replace the domain with the real, HTTPS production host). This is
different from the browser success/failure return URLs, which deliberately
redirect to the order-status page. Verify PayU webhook delivery settings and
use its test merchant account for a complete transaction before enabling live
payment acceptance. The website never grants a paid status on the callback
body alone; an independent PayU verification must confirm it.
