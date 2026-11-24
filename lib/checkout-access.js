"use strict";

/**
 * Validates incoming query parameters for the isolated checkout route.
 * Rejects duplicate query keys, invalid ranges, and control characters.
 */

const REQUIRED_KEYS = ["pkg", "diamonds", "uid", "nick", "level", "status"];

function hasDuplicateRawQueryKeys(rawQueryString) {
  if (!rawQueryString || typeof rawQueryString !== "string") return false;
  const seen = new Set();
  const clean = rawQueryString.startsWith("?") ? rawQueryString.slice(1) : rawQueryString;
  if (!clean) return false;
  for (const part of clean.split("&")) {
    if (!part) continue;
    const eqIdx = part.indexOf("=");
    const rawKey = eqIdx === -1 ? part : part.slice(0, eqIdx);
    let key;
    try {
      key = decodeURIComponent(rawKey).trim();
    } catch {
      return true;
    }
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
}

function readSingleValue(queryObj, key) {
  if (!queryObj) return { present: false, duplicate: false, value: "" };
  if (typeof queryObj.getAll === "function") {
    const all = queryObj.getAll(key);
    if (all.length > 1) return { present: true, duplicate: true, value: "" };
    if (all.length === 0) return { present: false, duplicate: false, value: "" };
    return { present: true, duplicate: false, value: String(all[0] ?? "").trim() };
  }
  if (!(key in queryObj)) {
    return { present: false, duplicate: false, value: "" };
  }
  const raw = queryObj[key];
  if (Array.isArray(raw)) {
    return { present: true, duplicate: true, value: "" };
  }
  return { present: true, duplicate: false, value: String(raw ?? "").trim() };
}

export function readCheckoutParameters(query, rawUrlOrQuery = "") {
  const rawSearch =
    typeof rawUrlOrQuery === "string" && rawUrlOrQuery.includes("?")
      ? rawUrlOrQuery.slice(rawUrlOrQuery.indexOf("?"))
      : rawUrlOrQuery;

  if (hasDuplicateRawQueryKeys(rawSearch)) {
    return { valid: false, isCallback: false, reason: "duplicate_query_keys", params: {} };
  }

  const parsed = {};
  for (const key of REQUIRED_KEYS) {
    const entry = readSingleValue(query, key);
    if (entry.duplicate) {
      return { valid: false, isCallback: false, reason: `duplicate_${key}`, params: {} };
    }
    if (entry.present) {
      parsed[key] = entry.value;
    }
  }

  // Validate optional status
  if ("status" in parsed && parsed.status !== "success" && parsed.status !== "failed") {
    return { valid: false, isCallback: false, reason: "invalid_status", params: {} };
  }

  // Validate pkg if present
  if ("pkg" in parsed) {
    if (!/^\d+(?:\.\d{1,2})?$/.test(parsed.pkg)) {
      return { valid: false, isCallback: false, reason: "invalid_pkg", params: {} };
    }
    const pkgNum = Number(parsed.pkg);
    if (!Number.isFinite(pkgNum) || pkgNum <= 0 || pkgNum > 1000000) {
      return { valid: false, isCallback: false, reason: "pkg_out_of_range", params: {} };
    }
  }

  // Validate diamonds if present (digits 1-9 in length)
  if ("diamonds" in parsed) {
    if (!/^\d{1,9}$/.test(parsed.diamonds) || Number(parsed.diamonds) <= 0) {
      return { valid: false, isCallback: false, reason: "invalid_diamonds", params: {} };
    }
  }

  // Validate uid if present (digits 1-20, not all zeros)
  if ("uid" in parsed) {
    if (!/^\d{1,20}$/.test(parsed.uid) || /^0+$/.test(parsed.uid)) {
      return { valid: false, isCallback: false, reason: "invalid_uid", params: {} };
    }
  }

  // Validate nick if present (1-60 chars, no control chars)
  if ("nick" in parsed) {
    if (
      parsed.nick.length < 1 ||
      parsed.nick.length > 60 ||
      /[\u0000-\u001F\u007F]/.test(parsed.nick)
    ) {
      return { valid: false, isCallback: false, reason: "invalid_nick", params: {} };
    }
  }

  // Validate level if present (digits 1-999)
  if ("level" in parsed) {
    if (!/^\d{1,3}$/.test(parsed.level)) {
      return { valid: false, isCallback: false, reason: "invalid_level", params: {} };
    }
    const lvl = Number(parsed.level);
    if (!Number.isInteger(lvl) || lvl < 1 || lvl > 999) {
      return { valid: false, isCallback: false, reason: "level_out_of_range", params: {} };
    }
  }

  const isCallback = parsed.status === "success" || parsed.status === "failed";
  if (isCallback) {
    if (!parsed.pkg && !parsed.uid) {
      return { valid: false, isCallback: true, reason: "callback_missing_ref", params: {} };
    }
    return { valid: true, isCallback: true, params: parsed };
  }

  // Normal checkout access requires a valid pkg (and validates optional uid/diamonds/nick/level above)
  if (!parsed.pkg) {
    return { valid: false, isCallback: false, reason: "missing_required_params", params: {} };
  }

  return { valid: true, isCallback: false, params: parsed };
}
