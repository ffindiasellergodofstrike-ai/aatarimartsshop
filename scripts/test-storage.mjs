"use strict";
import assert from "node:assert/strict";
import {
  createFirestoreOrderStore,
  resolveFirebaseConfig,
  OrderStoreUnavailableError,
  DuplicateOrderError,
} from "../lib/order-store.mjs";
import {
  newGuestOrderToken,
  hashGuestToken,
  guestTokenMatches,
  computeOrderReconciliationPatch,
} from "../lib/checkout.mjs";

// 1. Test resolveFirebaseConfig fails closed on missing/incomplete Vercel credentials.
assert.throws(
  () => resolveFirebaseConfig({ VERCEL: "1", FIREBASE_PROJECT_ID: "decent-mender-ps58c" }),
  OrderStoreUnavailableError
);
assert.throws(
  () =>
    resolveFirebaseConfig({
      FIREBASE_PROJECT_ID: "decent-mender-ps58c",
      FIREBASE_CLIENT_EMAIL: "svc@decent-mender-ps58c.iam.gserviceaccount.com",
    }),
  OrderStoreUnavailableError
);
const resolved = resolveFirebaseConfig({
  VERCEL: "1",
  FIREBASE_PROJECT_ID: "decent-mender-ps58c",
  FIRESTORE_DATABASE_ID: "ai-studio-835ece8d-07ef-4123-be16-5607a728e4a0",
  FIREBASE_CLIENT_EMAIL: "orders@decent-mender-ps58c.iam.gserviceaccount.com",
  FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----",
});
assert.equal(resolved.projectId, "decent-mender-ps58c");
assert.equal(resolved.databaseId, "ai-studio-835ece8d-07ef-4123-be16-5607a728e4a0");
assert.equal(resolved.hasServiceAccount, true);
assert.ok(resolved.privateKey.includes("\nTEST\n"));

// 2. Faithfully simulate Firestore transactions and Timestamp objects.
function createFakeFirestore() {
  const docs = new Map();
  let txCount = 0;

  const resolveSentinels = obj => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v && v.__serverTimestamp) {
        out[k] = { __ts: "2026-11-23T10:00:00.000Z" };
      } else {
        out[k] = structuredClone(v);
      }
    }
    return out;
  };

  const hydrate = data => {
    if (!data) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (v && v.__ts) {
        const iso = v.__ts;
        out[k] = { toDate: () => new Date(iso) };
      } else {
        out[k] = structuredClone(v);
      }
    }
    return out;
  };

  const makeSnap = id => {
    const data = docs.get(id);
    return {
      exists: docs.has(id),
      data: () => hydrate(data),
    };
  };

  return {
    _docs: docs,
    _getTxCount: () => txCount,
    collection(name) {
      assert.equal(name, "orders");
      return {
        doc(id) {
          return {
            _id: id,
            async get() {
              return makeSnap(id);
            },
          };
        },
      };
    },
    async runTransaction(fn) {
      txCount += 1;
      const writes = [];
      const tx = {
        async get(ref) {
          return makeSnap(ref._id);
        },
        set(ref, data, options) {
          writes.push({ type: "set", id: ref._id, data: resolveSentinels(data), options });
        },
        update(ref, patch) {
          writes.push({ type: "update", id: ref._id, patch: resolveSentinels(patch) });
        },
      };
      const result = await fn(tx);
      for (const w of writes) {
        if (w.type === "set") {
          const prev = docs.get(w.id) || {};
          docs.set(w.id, w.options?.merge ? { ...prev, ...w.data } : w.data);
        } else if (w.type === "update") {
          const prev = docs.get(w.id);
          assert.ok(prev, "Cannot update missing Firestore document");
          docs.set(w.id, { ...prev, ...w.patch });
        }
      }
      return result;
    },
  };
}

const fakeDb = createFakeFirestore();
const store = createFirestoreOrderStore(fakeDb, {
  serverTimestamp: () => ({ __serverTimestamp: true }),
});

const token = newGuestOrderToken();
const order = {
  id: "AM1234567890ABCDEF",
  status: "pending",
  fulfillmentStatus: "awaiting_payment",
  paymentMethod: "prepaid",
  currency: "INR",
  total: 745,
  payAmount: 745,
  balanceDue: 0,
  customer: { name: "example-only", email: "asha@example.com" },
  items: [{ id: "1", qty: 1, title: "Dress", unitPrice: 745 }],
  accessTokenHash: hashGuestToken(token),
};

assert.equal(await store.find("bad"), null);
assert.equal(await store.find(order.id), null);

// Save new order atomically
await store.save(order, true);
assert.equal(fakeDb._getTxCount(), 1);

// Duplicate order creation rejected atomically
await assert.rejects(() => store.save(order, true), DuplicateOrderError);

// Retrieval normalizes Firestore timestamps and preserves fields
const fetched = await store.find(order.id);
assert.equal(fetched.id, order.id);
assert.equal(fetched.createdAt, "2026-11-23T10:00:00.000Z");
assert.equal(guestTokenMatches(token, fetched.accessTokenHash), true);
assert.equal(guestTokenMatches("0".repeat(64), fetched.accessTokenHash), false);

// Transactional reconciliation marks paid and protects against later failed callback
const paid = await store.reconcile(order.id, current =>
  computeOrderReconciliationPatch(current, {
    state: "success",
    unmapped: "captured",
    amount: 745,
    txnId: order.id,
    payuId: "PAYU999",
  })
);
assert.equal(paid.status, "paid");
assert.equal(paid.fulfillmentStatus, "unfulfilled");
assert.equal(paid.payuId, "PAYU999");

// Attempt to downgrade a paid order via a later failure must be ignored
const afterFail = await store.reconcile(order.id, current =>
  computeOrderReconciliationPatch(current, {
    state: "failure",
    unmapped: "failed",
    amount: 745,
    txnId: order.id,
    payuId: "PAYU999",
  })
);
assert.equal(afterFail.status, "paid");

// Corrupt stored record fails closed
fakeDb._docs.set("AMCORRUPT12345678", { id: "AMOTHER", status: "paid" });
await assert.rejects(() => store.find("AMCORRUPT12345678"), OrderStoreUnavailableError);

// 3. End-to-end checkout helper flow (saveOrder -> findOrder -> reconcileOrder with PayU mock)
const { saveOrder, findOrder, reconcileOrder } = await import("../lib/checkout.mjs");
const codToken = newGuestOrderToken();
const codOrder = {
  id: "AMCOD1234567890ABCD",
  status: "pending",
  fulfillmentStatus: "awaiting_payment",
  paymentMethod: "cod",
  currency: "INR",
  total: 1299,
  payAmount: 299,
  balanceDue: 1000,
  customer: { name: "example-only", email: "cod@example.com" },
  items: [{ id: "2", qty: 1, title: "Top", unitPrice: 1299 }],
  accessTokenHash: hashGuestToken(codToken),
};
await saveOrder(codOrder, true, store);
const loadedCod = await findOrder(codOrder.id, store);
assert.equal(loadedCod.status, "pending");
assert.equal(guestTokenMatches(codToken, loadedCod.accessTokenHash), true);

const origFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      transaction_details: {
        [codOrder.id]: {
          txnid: codOrder.id,
          transaction_amount: "299.00",
          status: "success",
          unmappedstatus: "captured",
          mihpayid: "PAYUCOD123",
        },
      },
    }),
  });
  const verifiedCod = await reconcileOrder(
    loadedCod,
    { key: "k", salt: "s", verifyUrl: "https://test.payu.in/merchant/postservice?form=2" },
    store
  );
  assert.equal(verifiedCod.status, "cod_advance_paid");
  assert.equal(verifiedCod.fulfillmentStatus, "unfulfilled");
  assert.equal(verifiedCod.payuId, "PAYUCOD123");

  // Subsequent failed verify response must never reverse cod_advance_paid
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      transaction_details: {
        [codOrder.id]: {
          txnid: codOrder.id,
          transaction_amount: "299.00",
          status: "failure",
          unmappedstatus: "failed",
          mihpayid: "PAYUCOD123",
        },
      },
    }),
  });
  const recheckedCod = await reconcileOrder(
    verifiedCod,
    { key: "k", salt: "s", verifyUrl: "https://test.payu.in/merchant/postservice?form=2" },
    store
  );
  assert.equal(recheckedCod.status, "cod_advance_paid");
} finally {
  globalThis.fetch = origFetch;
}

console.log(
  "PASS: Firestore config fail-closed, transactional saves, duplicate protection, token matching, immutable paid/cod_advance_paid states, and record validation."
);
