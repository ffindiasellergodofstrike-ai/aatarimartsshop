"use strict";

/**
 * Authoritative Firebase Cloud Firestore order repository for ATTIRE MART.
 * Runs exclusively on the server using firebase-admin against the configured
 * project and named Firestore database. Never imported by browser JavaScript.
 */
import fs from "node:fs";
import path from "node:path";

export const ORDER_COLLECTION = "orders";
const ID_PATTERN = /^AM[A-Za-z0-9_-]{10,60}$/;
const PLACEHOLDER_PATTERN = /^(PENDING_|PLACEHOLDER_|REPLACE_|SET_REAL_|YOUR_|remixed-)/i;

export const isValidOrderId = id => ID_PATTERN.test(String(id || ""));

export class OrderStoreUnavailableError extends Error {
  constructor(message = "Order storage is temporarily unavailable.", options) {
    super(message, options);
    this.name = "OrderStoreUnavailableError";
    this.code = "ORDER_STORAGE_UNAVAILABLE";
  }
}

export class DuplicateOrderError extends Error {
  constructor(message = "Order reference already exists.", options) {
    super(message, options);
    this.name = "DuplicateOrderError";
    this.code = "DUPLICATE_ORDER";
  }
}

function cleanValue(value) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s || PLACEHOLDER_PATTERN.test(s)) return "";
  return s;
}

export function readFirebaseAppletConfig(rootDir = process.cwd()) {
  try {
    const file = path.join(rootDir, "firebase-applet-config.json");
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function resolveFirebaseConfig(env = process.env) {
  const disk = readFirebaseAppletConfig();
  const projectId = cleanValue(env.FIREBASE_PROJECT_ID) || cleanValue(disk.projectId);
  const databaseId =
    cleanValue(env.FIRESTORE_DATABASE_ID) ||
    cleanValue(disk.firestoreDatabaseId) ||
    "(default)";
  const clientEmail = cleanValue(env.FIREBASE_CLIENT_EMAIL);
  const rawKey = typeof env.FIREBASE_PRIVATE_KEY === "string" ? env.FIREBASE_PRIVATE_KEY.trim() : "";
  const privateKey = rawKey && !PLACEHOLDER_PATTERN.test(rawKey) ? rawKey.replace(/\\n/g, "\n") : "";
  const emulatorHost = cleanValue(env.FIRESTORE_EMULATOR_HOST);

  if (!projectId) {
    throw new OrderStoreUnavailableError("Firebase project ID is not configured.");
  }
  if ((clientEmail && !privateKey) || (!clientEmail && privateKey)) {
    throw new OrderStoreUnavailableError("Firebase Admin environment variables are incomplete.");
  }
  if (!clientEmail && !privateKey && !emulatorHost && env.VERCEL === "1") {
    throw new OrderStoreUnavailableError("Firebase Admin credentials are not configured.");
  }

  return {
    projectId,
    databaseId,
    clientEmail,
    privateKey,
    emulatorHost,
    hasServiceAccount: Boolean(clientEmail && privateKey),
  };
}

let cachedContext = null;

export async function getFirestoreContext(env = process.env) {
  const cfg = resolveFirebaseConfig(env);
  const cacheKey = `${cfg.projectId}|${cfg.databaseId}|${cfg.clientEmail}|${cfg.emulatorHost}`;
  if (cachedContext && cachedContext.cacheKey === cacheKey) {
    return cachedContext;
  }

  try {
    const { getApps, getApp, initializeApp, cert } = await import("firebase-admin/app");
    const { getFirestore, FieldValue } = await import("firebase-admin/firestore");

    const appName = `attiremart-${cfg.projectId}`;
    const existing = getApps().find(a => a.name === appName);
    const app = existing
      ? getApp(appName)
      : initializeApp(
          cfg.hasServiceAccount
            ? {
                credential: cert({
                  projectId: cfg.projectId,
                  clientEmail: cfg.clientEmail,
                  privateKey: cfg.privateKey,
                }),
                projectId: cfg.projectId,
              }
            : { projectId: cfg.projectId },
          appName
        );

    const db =
      cfg.databaseId && cfg.databaseId !== "(default)"
        ? getFirestore(app, cfg.databaseId)
        : getFirestore(app);

    cachedContext = {
      cacheKey,
      projectId: cfg.projectId,
      databaseId: cfg.databaseId,
      db,
      serverTimestamp: () => FieldValue.serverTimestamp(),
    };
    return cachedContext;
  } catch (error) {
    if (error instanceof OrderStoreUnavailableError) throw error;
    throw new OrderStoreUnavailableError("Unable to initialize Firebase Admin Firestore.", {
      cause: error,
    });
  }
}

function toIsoTimestamp(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

export function normalizeOrderRecord(data) {
  if (!data || typeof data !== "object") return null;
  const createdAt = toIsoTimestamp(data.createdAt) || new Date().toISOString();
  const updatedAt = toIsoTimestamp(data.updatedAt) || createdAt;
  const paymentVerifiedAt = toIsoTimestamp(data.paymentVerifiedAt);
  return {
    ...data,
    createdAt,
    updatedAt,
    paymentVerifiedAt,
  };
}

/**
 * Injectable Firestore repository supporting production firebase-admin,
 * Firebase Emulator Suite, and deterministic transactional test doubles.
 */
export function createFirestoreOrderStore(db, { serverTimestamp = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.collection !== "function" || typeof db.runTransaction !== "function") {
    throw new TypeError("Invalid Firestore database instance.");
  }

  const docRef = id => db.collection(ORDER_COLLECTION).doc(id);

  return {
    async save(order, isNew = false) {
      if (!order || !isValidOrderId(order.id)) {
        throw new TypeError("Invalid order record.");
      }
      const ref = docRef(order.id);
      try {
        await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          if (isNew) {
            if (snap.exists) {
              throw new DuplicateOrderError("Order reference already exists.");
            }
            const record = {
              ...order,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            };
            tx.set(ref, record);
          } else {
            if (!snap.exists) {
              throw new OrderStoreUnavailableError("Cannot update nonexistent order record.");
            }
            const record = {
              ...order,
              updatedAt: serverTimestamp(),
            };
            delete record.createdAt;
            tx.set(ref, record, { merge: true });
          }
        });
      } catch (error) {
        if (error instanceof DuplicateOrderError || error instanceof OrderStoreUnavailableError) {
          throw error;
        }
        throw new OrderStoreUnavailableError("Failed to persist order in Firestore.", {
          cause: error,
        });
      }
    },

    async find(id) {
      if (!isValidOrderId(id)) return null;
      try {
        const snap = await docRef(id).get();
        if (!snap || !snap.exists) return null;
        const raw = typeof snap.data === "function" ? snap.data() : null;
        const order = normalizeOrderRecord(raw);
        if (!order || order.id !== id || typeof order.status !== "string") {
          throw new OrderStoreUnavailableError("Stored order record failed validation.");
        }
        return order;
      } catch (error) {
        if (error instanceof OrderStoreUnavailableError) throw error;
        throw new OrderStoreUnavailableError("Failed to retrieve order from Firestore.", {
          cause: error,
        });
      }
    },

    async reconcile(id, computeUpdate) {
      if (!isValidOrderId(id)) return null;
      const ref = docRef(id);
      try {
        return await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          if (!snap || !snap.exists) return null;
          const raw = typeof snap.data === "function" ? snap.data() : null;
          const current = normalizeOrderRecord(raw);
          if (!current || current.id !== id || typeof current.status !== "string") {
            throw new OrderStoreUnavailableError("Stored order record failed validation.");
          }
          // Terminal successful payment states are immutable against later callbacks.
          if (["paid", "cod_advance_paid"].includes(current.status)) {
            return current;
          }
          const patch = computeUpdate(current);
          if (!patch || typeof patch !== "object") {
            return current;
          }
          const updatePayload = {
            ...patch,
            paymentVerifiedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          };
          tx.update(ref, updatePayload);
          return normalizeOrderRecord({
            ...current,
            ...patch,
            paymentVerifiedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        });
      } catch (error) {
        if (error instanceof OrderStoreUnavailableError) throw error;
        throw new OrderStoreUnavailableError("Failed to update order payment state in Firestore.", {
          cause: error,
        });
      }
    },

    async claimTelegramNotification(id, { now = Date.now(), lockTtlMs = 60000 } = {}) {
      if (!isValidOrderId(id)) return { claimed: false, reason: "invalid_id" };
      const ref = docRef(id);
      try {
        return await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          if (!snap || !snap.exists) return { claimed: false, reason: "missing" };
          const raw = typeof snap.data === "function" ? snap.data() : null;
          const current = normalizeOrderRecord(raw);
          if (!current || current.id !== id) {
            return { claimed: false, reason: "invalid_record" };
          }
          if (!["paid", "cod_advance_paid"].includes(current.status)) {
            return { claimed: false, reason: "not_paid" };
          }
          if (current.telegramNotified === true || current.telegramNotifyState === "sent") {
            return { claimed: false, reason: "already_notified" };
          }
          if (
            current.telegramNotifyState === "sending" &&
            Number.isFinite(Number(current.telegramClaimedAtMs)) &&
            now - Number(current.telegramClaimedAtMs) < lockTtlMs
          ) {
            return { claimed: false, reason: "in_flight" };
          }
          tx.update(ref, {
            telegramNotifyState: "sending",
            telegramClaimedAtMs: now,
            updatedAt: serverTimestamp(),
          });
          return { claimed: true, order: current };
        });
      } catch {
        return { claimed: false, reason: "storage_error" };
      }
    },

    async markTelegramNotificationSent(id) {
      if (!isValidOrderId(id)) return false;
      try {
        await docRef(id).update({
          telegramNotified: true,
          telegramNotifyState: "sent",
          telegramNotifiedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        return true;
      } catch {
        return false;
      }
    },

    async releaseTelegramNotificationClaim(id) {
      if (!isValidOrderId(id)) return false;
      try {
        await db.runTransaction(async tx => {
          const ref = docRef(id);
          const snap = await tx.get(ref);
          if (!snap || !snap.exists) return;
          const raw = typeof snap.data === "function" ? snap.data() : null;
          if (raw?.telegramNotified === true || raw?.telegramNotifyState === "sent") return;
          tx.update(ref, {
            telegramNotifyState: "failed",
            updatedAt: serverTimestamp(),
          });
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export async function getDefaultOrderStore(env = process.env) {
  const ctx = await getFirestoreContext(env);
  return createFirestoreOrderStore(ctx.db, { serverTimestamp: ctx.serverTimestamp });
}

