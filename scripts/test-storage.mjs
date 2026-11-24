"use strict";
import assert from "node:assert/strict";
import {
  createFirestoreOrderStore,
  createRtdbOrderStore,
  normalizePrivateKey,
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

// 4. Test Firebase Realtime Database (RTDB) config + private key quote tolerance + atomic store
const normalizedFromJson = normalizePrivateKey(
  '"-----BEGIN PRIVATE KEY-----\\nLINE1\\nLINE2\\n-----END PRIVATE KEY-----\\n",'
);
assert.ok(normalizedFromJson.startsWith("-----BEGIN PRIVATE KEY-----\nLINE1\nLINE2\n-----END PRIVATE KEY-----"));
assert.ok(!normalizedFromJson.startsWith('"'));

const rtdbResolved = resolveFirebaseConfig({
  VERCEL: "1",
  FIREBASE_DATABASE_URL: "https://my-rtdb-app-default-rtdb.asia-southeast1.firebasedatabase.app/",
  FIREBASE_CLIENT_EMAIL: "firebase-adminsdk@my-rtdb-app.iam.gserviceaccount.com",
  FIREBASE_PRIVATE_KEY: '"-----BEGIN PRIVATE KEY-----\\nTESTKEY\\n-----END PRIVATE KEY-----\\n"',
});
assert.equal(rtdbResolved.storageBackend, "rtdb");
assert.equal(rtdbResolved.projectId, "my-rtdb-app");
assert.equal(
  rtdbResolved.databaseUrl,
  "https://my-rtdb-app-default-rtdb.asia-southeast1.firebasedatabase.app"
);

function createFakeRtdb() {
  const tree = new Map();
  return {
    ref(path) {
      return {
        async once(event) {
          assert.equal(event, "value");
          const exists = tree.has(path);
          return {
            exists: () => exists,
            val: () => (exists ? structuredClone(tree.get(path)) : null),
          };
        },
        async transaction(updateFn) {
          const current = tree.has(path) ? structuredClone(tree.get(path)) : null;
          const next = updateFn(current);
          if (next === undefined) {
            return {
              committed: false,
              snapshot: { val: () => (tree.has(path) ? structuredClone(tree.get(path)) : null) },
            };
          }
          const resolvedObj = structuredClone(next);
          for (const k of ["createdAt", "updatedAt", "paymentVerifiedAt", "telegramNotifiedAt"]) {
            if (resolvedObj[k] && resolvedObj[k].__ts) {
              resolvedObj[k] = 1795600000000;
            }
          }
          tree.set(path, resolvedObj);
          return {
            committed: true,
            snapshot: { val: () => structuredClone(resolvedObj) },
          };
        },
        async update(patch) {
          const prev = tree.get(path) || {};
          const next = { ...prev, ...structuredClone(patch) };
          for (const k of ["updatedAt", "telegramNotifiedAt"]) {
            if (next[k] && next[k].__ts) next[k] = 1795600000000;
          }
          tree.set(path, next);
        },
      };
    },
  };
}

const fakeRtdb = createFakeRtdb();
const rtdbStore = createRtdbOrderStore(fakeRtdb, { serverTimestamp: () => ({ __ts: true }) });
const rtdbToken = newGuestOrderToken();
const rtdbOrder = {
  id: "AMRTDB1234567890AB",
  status: "pending",
  fulfillmentStatus: "awaiting_payment",
  paymentMethod: "prepaid",
  currency: "INR",
  total: 599,
  payAmount: 599,
  balanceDue: 0,
  customer: { name: "Rohan Verma", email: "rohan@gmail.com" },
  items: [{ id: "1", qty: 1, title: "Kurta", unitPrice: 599 }],
  accessTokenHash: hashGuestToken(rtdbToken),
};
await rtdbStore.save(rtdbOrder, true);
await assert.rejects(() => rtdbStore.save(rtdbOrder, true), DuplicateOrderError);
const rtdbFound = await rtdbStore.find(rtdbOrder.id);
assert.equal(rtdbFound.status, "pending");
assert.ok(rtdbFound.createdAt.startsWith("2026-"));
const rtdbPaid = await rtdbStore.reconcile(rtdbOrder.id, current =>
  computeOrderReconciliationPatch(current, {
    state: "success",
    unmapped: "captured",
    amount: 599,
    txnId: rtdbOrder.id,
    payuId: "PAYURTDB1",
  })
);
assert.equal(rtdbPaid.status, "paid");
const rtdbClaim1 = await rtdbStore.claimTelegramNotification(rtdbOrder.id);
assert.equal(rtdbClaim1.claimed, true);
const rtdbClaim2 = await rtdbStore.claimTelegramNotification(rtdbOrder.id);
assert.equal(rtdbClaim2.claimed, false);
assert.equal(await rtdbStore.markTelegramNotificationSent(rtdbOrder.id), true);

console.log(
  "PASS: Firestore & Realtime Database (RTDB) config fail-closed, transactional saves, duplicate protection, token matching, immutable paid/cod_advance_paid states, and record validation."
);
