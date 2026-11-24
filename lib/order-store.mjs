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

function extractProjectIdFromServiceEmail(email) {
  const m = String(email || "").trim().match(/@([a-z0-9-]+)\.iam\.gserviceaccount\.com$/i);
  return m ? m[1] : "";
}

function extractProjectIdFromDatabaseUrl(url) {
  const m = String(url || "")
    .trim()
    .match(/^https:\/\/([a-z0-9-]+?)(?:-default-rtdb)?\.(?:[a-z0-9-]+\.)?(?:firebaseio\.com|firebasedatabase\.app)/i);
  return m ? m[1] : "";
}

function cleanDatabaseUrl(rawUrl) {
  const s = cleanValue(rawUrl).replace(/\/+$/, "");
  if (!s) return "";
  if (
    /^https:\/\/[a-z0-9.-]+\.(?:firebaseio\.com|firebasedatabase\.app)(?:\/.*)?$/i.test(s) ||
    /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/.*)?$/i.test(s)
  ) {
    return s;
  }
  throw new OrderStoreUnavailableError("FIREBASE_DATABASE_URL is invalid.");
}

export function normalizePrivateKey(rawValue) {
  let rawKey = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!rawKey || PLACEHOLDER_PATTERN.test(rawKey)) return "";
  // Tolerate accidental outer JSON quotes or trailing comma when pasted from service-account.json
  rawKey = rawKey.replace(/^["']+/, "").replace(/["',]+$/, "").trim();
  return rawKey.replace(/\\n/g, "\n");
}

export function resolveFirebaseConfig(env = process.env) {
  const disk = readFirebaseAppletConfig();
  const clientEmail = cleanValue(env.FIREBASE_CLIENT_EMAIL);
  const privateKey = normalizePrivateKey(env.FIREBASE_PRIVATE_KEY);
  const databaseUrl = cleanDatabaseUrl(env.FIREBASE_DATABASE_URL) || cleanDatabaseUrl(disk.databaseURL);
  const projectId =
    cleanValue(env.FIREBASE_PROJECT_ID) ||
    extractProjectIdFromServiceEmail(clientEmail) ||
    extractProjectIdFromDatabaseUrl(databaseUrl) ||
    cleanValue(disk.projectId);
  const diskProjectId = cleanValue(disk.projectId);
  const effectiveProjectId = projectId || diskProjectId;
  const databaseId =
    cleanValue(env.FIRESTORE_DATABASE_ID) ||
    (effectiveProjectId && effectiveProjectId === diskProjectId ? cleanValue(disk.firestoreDatabaseId) : "") ||
    "(default)";
  const emulatorHost = cleanValue(env.FIRESTORE_EMULATOR_HOST) || cleanValue(env.FIREBASE_DATABASE_EMULATOR_HOST);

  if (!projectId && !databaseUrl) {
    throw new OrderStoreUnavailableError("Firebase project ID or database URL is not configured.");
  }
  if ((clientEmail && !privateKey) || (!clientEmail && privateKey)) {
    throw new OrderStoreUnavailableError("Firebase Admin environment variables are incomplete.");
  }
  if (!clientEmail && !privateKey && !emulatorHost && env.VERCEL === "1") {
    throw new OrderStoreUnavailableError("Firebase Admin credentials are not configured.");
  }

  return {
    projectId: projectId || "attiremart-rtdb",
    databaseId,
    databaseUrl,
    storageBackend: databaseUrl ? "rtdb" : "firestore",
    clientEmail,
    privateKey,
    emulatorHost,
    hasServiceAccount: Boolean(clientEmail && privateKey),
  };
}

let cachedContext = null;

export async function getDatabaseContext(env = process.env) {
  const cfg = resolveFirebaseConfig(env);
  const cacheKey = `${cfg.storageBackend}|${cfg.projectId}|${cfg.databaseId}|${cfg.databaseUrl}|${cfg.clientEmail}|${cfg.emulatorHost}`;
  if (cachedContext && cachedContext.cacheKey === cacheKey) {
    return cachedContext;
  }

  try {
    const { getApps, getApp, initializeApp, cert } = await import("firebase-admin/app");

    const appName = `attiremart-${cfg.projectId}-${cfg.storageBackend}`;
    const existing = getApps().find(a => a.name === appName);
    const appConfig = {
      projectId: cfg.projectId,
      ...(cfg.databaseUrl ? { databaseURL: cfg.databaseUrl } : {}),
    };
    if (cfg.hasServiceAccount) {
      appConfig.credential = cert({
        projectId: cfg.projectId,
        clientEmail: cfg.clientEmail,
        privateKey: cfg.privateKey,
      });
    }
    const app = existing ? getApp(appName) : initializeApp(appConfig, appName);

    if (cfg.storageBackend === "rtdb") {
      const { getDatabase, ServerValue } = await import("firebase-admin/database");
      const rtdb = getDatabase(app);
      cachedContext = {
        cacheKey,
        backend: "rtdb",
        projectId: cfg.projectId,
        databaseUrl: cfg.databaseUrl,
        rtdb,
        db: null,
        serverTimestamp: () => ServerValue.TIMESTAMP,
      };
      return cachedContext;
    }

    const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
    const db =
      cfg.databaseId && cfg.databaseId !== "(default)"
        ? getFirestore(app, cfg.databaseId)
        : getFirestore(app);

    cachedContext = {
      cacheKey,
      backend: "firestore",
      projectId: cfg.projectId,
      databaseId: cfg.databaseId,
      db,
      rtdb: null,
      serverTimestamp: () => FieldValue.serverTimestamp(),
    };
    return cachedContext;
  } catch (error) {
    if (error instanceof OrderStoreUnavailableError) throw error;
    throw new OrderStoreUnavailableError("Unable to initialize Firebase Admin database.", {
      cause: error,
    });
  }
}

export const getFirestoreContext = getDatabaseContext;

function toIsoTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
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

function stripUndefinedForRtdb(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map(item => stripUndefinedForRtdb(item)).filter(item => item !== undefined);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const cleaned = stripUndefinedForRtdb(v);
    if (cleaned !== undefined) out[k] = cleaned;
  }
  return out;
}

/**
 * Atomic Firebase Realtime Database (RTDB) repository matching Firestore order store behavior.
 */
export function createRtdbOrderStore(rtdb, { serverTimestamp = () => Date.now() } = {}) {
  if (!rtdb || typeof rtdb.ref !== "function") {
    throw new TypeError("Invalid Realtime Database instance.");
  }

  const orderRef = id => rtdb.ref(`${ORDER_COLLECTION}/${id}`);

  return {
    async save(order, isNew = false) {
      if (!order || !isValidOrderId(order.id)) {
        throw new TypeError("Invalid order record.");
      }
      const ref = orderRef(order.id);
      try {
        if (isNew) {
          let duplicate = false;
          const result = await ref.transaction(current => {
            duplicate = false;
            if (current !== null && current !== undefined) {
              duplicate = true;
              return;
            }
            return stripUndefinedForRtdb({
              ...order,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          });
          if (!result.committed && duplicate) {
            throw new DuplicateOrderError("Order reference already exists.");
          }
          if (!result.committed) {
            throw new OrderStoreUnavailableError("Failed to persist order in Realtime Database.");
          }
        } else {
          let missing = false;
          const result = await ref.transaction(current => {
            missing = false;
            if (!current || typeof current !== "object") {
              missing = true;
              return;
            }
            const record = {
              ...current,
              ...order,
              updatedAt: serverTimestamp(),
            };
            if (current.createdAt !== undefined) {
              record.createdAt = current.createdAt;
            }
            return stripUndefinedForRtdb(record);
          });
          if (!result.committed && missing) {
            throw new OrderStoreUnavailableError("Cannot update nonexistent order record.");
          }
          if (!result.committed) {
            throw new OrderStoreUnavailableError("Failed to update order in Realtime Database.");
          }
        }
      } catch (error) {
        if (error instanceof DuplicateOrderError || error instanceof OrderStoreUnavailableError) {
          throw error;
        }
        throw new OrderStoreUnavailableError("Failed to persist order in Realtime Database.", {
          cause: error,
        });
      }
    },

    async find(id) {
      if (!isValidOrderId(id)) return null;
      try {
        const snap = await orderRef(id).once("value");
        const exists = snap && (typeof snap.exists === "function" ? snap.exists() : snap.val() !== null);
        if (!exists) return null;
        const raw = typeof snap.val === "function" ? snap.val() : null;
        const order = normalizeOrderRecord(raw);
        if (!order || order.id !== id || typeof order.status !== "string") {
          throw new OrderStoreUnavailableError("Stored order record failed validation.");
        }
        return order;
      } catch (error) {
        if (error instanceof OrderStoreUnavailableError) throw error;
        throw new OrderStoreUnavailableError("Failed to retrieve order from Realtime Database.", {
          cause: error,
        });
      }
    },

    async reconcile(id, computeUpdate) {
      if (!isValidOrderId(id)) return null;
      const ref = orderRef(id);
      try {
        let missing = false;
        let corrupt = false;
        let unchanged = null;
        const result = await ref.transaction(current => {
          missing = false;
          corrupt = false;
          unchanged = null;
          if (!current || typeof current !== "object") {
            missing = true;
            return;
          }
          const normalized = normalizeOrderRecord(current);
          if (!normalized || normalized.id !== id || typeof normalized.status !== "string") {
            corrupt = true;
            return;
          }
          if (["paid", "cod_advance_paid"].includes(normalized.status)) {
            unchanged = normalized;
            return;
          }
          const patch = computeUpdate(normalized);
          if (!patch || typeof patch !== "object") {
            unchanged = normalized;
            return;
          }
          return stripUndefinedForRtdb({
            ...current,
            ...patch,
            paymentVerifiedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        });

        if (corrupt) {
          throw new OrderStoreUnavailableError("Stored order record failed validation.");
        }
        if (missing) return null;
        if (unchanged) return unchanged;
        const finalVal = result?.snapshot?.val?.();
        return finalVal ? normalizeOrderRecord(finalVal) : null;
      } catch (error) {
        if (error instanceof OrderStoreUnavailableError) throw error;
        throw new OrderStoreUnavailableError("Failed to update order payment state in Realtime Database.", {
          cause: error,
        });
      }
    },

    async claimTelegramNotification(id, { now = Date.now(), lockTtlMs = 60000 } = {}) {
      if (!isValidOrderId(id)) return { claimed: false, reason: "invalid_id" };
      const ref = orderRef(id);
      try {
        let reason = "storage_error";
        let claimedOrder = null;
        const result = await ref.transaction(current => {
          reason = "storage_error";
          claimedOrder = null;
          if (!current || typeof current !== "object") {
            reason = "missing";
            return;
          }
          const normalized = normalizeOrderRecord(current);
          if (!normalized || normalized.id !== id) {
            reason = "invalid_record";
            return;
          }
          if (!["paid", "cod_advance_paid"].includes(normalized.status)) {
            reason = "not_paid";
            return;
          }
          if (normalized.telegramNotified === true || normalized.telegramNotifyState === "sent") {
            reason = "already_notified";
            return;
          }
          if (
            normalized.telegramNotifyState === "sending" &&
            Number.isFinite(Number(normalized.telegramClaimedAtMs)) &&
            now - Number(normalized.telegramClaimedAtMs) < lockTtlMs
          ) {
            reason = "in_flight";
            return;
          }
          claimedOrder = normalized;
          return stripUndefinedForRtdb({
            ...current,
            telegramNotifyState: "sending",
            telegramClaimedAtMs: now,
            updatedAt: serverTimestamp(),
          });
        });

        if (!result.committed) {
          return { claimed: false, reason };
        }
        return { claimed: true, order: claimedOrder };
      } catch {
        return { claimed: false, reason: "storage_error" };
      }
    },

    async markTelegramNotificationSent(id) {
      if (!isValidOrderId(id)) return false;
      try {
        await orderRef(id).update(
          stripUndefinedForRtdb({
            telegramNotified: true,
            telegramNotifyState: "sent",
            telegramNotifiedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
        return true;
      } catch {
        return false;
      }
    },

    async releaseTelegramNotificationClaim(id) {
      if (!isValidOrderId(id)) return false;
      try {
        await orderRef(id).transaction(current => {
          if (!current || typeof current !== "object") return;
          if (current.telegramNotified === true || current.telegramNotifyState === "sent") return;
          return stripUndefinedForRtdb({
            ...current,
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
  const ctx = await getDatabaseContext(env);
  if (ctx.backend === "rtdb") {
    return createRtdbOrderStore(ctx.rtdb, { serverTimestamp: ctx.serverTimestamp });
  }
  return createFirestoreOrderStore(ctx.db, { serverTimestamp: ctx.serverTimestamp });
}

