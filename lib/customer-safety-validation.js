"use strict";

/**
 * Customer contact safety & policy validation for isolated checkout.
 * Detects exact keywords, substrings, spaced tokens, two-word joins, fuzzy typos,
 * abusive/profanity terms, and script/SQL injection patterns without blocking normal Indian names.
 */

const GATEWAY_KEYWORDS = [
  "cashfree",
  "razorpay",
  "paytm",
  "phonepe",
  "payu",
  "billdesk",
  "ccavenue",
  "easebuzz",
  "instamojo",
  "zaakpay",
  "paykun",
  "stripe",
  "paypal",
  "juspay",
  "bharatpe",
  "mobikwik",
  "freecharge",
  "airtelpay",
  "googlepay",
  "amazonpay",
  "gpay",
  "gateway",
  "payment",
  "merchant",
  "escrow",
  "settlement",
  "payout",
  "nodal",
  "carding",
  "pg",
  "upi",
  "neft",
  "rtgs",
  "imps",
  "cvv",
  "crypto",
  "usdt",
  "binance",
];

const GAMING_TOPUP_KEYWORDS = [
  "garena",
  "freefire",
  "diamond",
  "diamonds",
  "topup",
  "booyah",
  "codashop",
  "unipin",
  "valorant",
  "bgmi",
  "pubg",
  "ffid",
  "uid",
  "uc",
  "betting",
  "casino",
  "gambling",
  "rummy",
  "poker",
  "lottery",
  "dream11",
  "teenpatti",
  "satta",
  "matka",
];

const GOVT_LEGAL_KEYWORDS = [
  "police",
  "cyber",
  "cybercrime",
  "petition",
  "cid",
  "cbi",
  "fbi",
  "cop",
  "govt",
  "government",
  "sarkari",
  "ministry",
  "department",
  "officer",
  "inspector",
  "commissioner",
  "court",
  "judge",
  "advocate",
  "lawyer",
  "crime",
  "vigilance",
  "incometax",
  "gst",
  "rbi",
  "sebi",
  "enforcement",
  "complaint",
  "fir",
  "summon",
  "ncrb",
  "i4c",
  "phishing",
];

const FRAUD_ABUSE_KEYWORDS = [
  "scam",
  "fraud",
  "fake",
  "cheat",
  "chor",
  "hacker",
  "hack",
  "testing",
  "test",
  "demo",
  "dummy",
  "spam",
  "bot",
  "admin",
  "support",
  "refund",
  "chargeback",
  "dispute",
  "abuse",
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "chutiya",
  "madarchod",
  "bhenchod",
  "bhosdike",
  "gaand",
  "harami",
  "kamina",
  "randi",
  "gali",
  "bsdk",
  "gandu",
  "lauda",
];

const ALL_BLOCKED_KEYWORDS = [
  ...GATEWAY_KEYWORDS,
  ...GAMING_TOPUP_KEYWORDS,
  ...GOVT_LEGAL_KEYWORDS,
  ...FRAUD_ABUSE_KEYWORDS,
];

// Words checked only as standalone tokens (never substrings) to avoid false positives on valid names like "Harshit"
const EXACT_TOKEN_ONLY_KEYWORDS = new Set([
  "shit",
  "test",
  "demo",
  "gali",
  "chor",
  "hack",
  "fake",
  "scam",
  "spam",
  "satta",
  "matka",
  "poker",
  "rummy",
  "gpay",
  "bgmi",
  "pubg",
  "ffid",
  "neft",
  "rtgs",
  "imps",
  "usdt",
]);

const ALIAS_PHRASES = {
  "costfree": "cashfree",
  "cashfre": "cashfree",
  "razerpay": "razorpay",
  "rasorpay": "razorpay",
  "paytem": "paytm",
  "fonpe": "phonepe",
  "phonepay": "phonepe",
  "payyou": "payu",
  "cybar": "cyber",
  "polise": "police",
  "polic": "police",
  "goverment": "government",
  "gov": "govt",
  "incometex": "incometax",
  "freefir": "freefire",
  "garenaa": "garena",
  "diamnd": "diamond",
};

const INJECTION_RE = /(<\s*script|javascript:|onerror\s*=|onload\s*=|union\s+select|drop\s+table|alert\s*\(|--\s|\/\*|\*\/)/i;

const ALLOWED_PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "yahoo.co.in",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
]);

const BLOCKED_DOMAIN_KEYWORDS = [
  "gov",
  "nic",
  "mil",
  "ac",
  "edu",
  "police",
  "cyber",
  "cbi",
  "cid",
  "crime",
  "court",
];

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function normalizeLeetspeak(str) {
  return str
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/@/g, "a")
    .replace(/\$/g, "s");
}

function collectCandidatesFromText(text) {
  const rawTokens = text
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const collapsed = text.replace(/[^a-z0-9]/g, "");
  const candidates = new Set(collapsed ? [collapsed, ...rawTokens] : rawTokens);

  for (let i = 0; i < rawTokens.length - 1; i++) {
    candidates.add(rawTokens[i] + rawTokens[i + 1]);
  }
  for (let i = 0; i < rawTokens.length - 2; i++) {
    candidates.add(rawTokens[i] + rawTokens[i + 1] + rawTokens[i + 2]);
  }

  let charRun = "";
  for (const tok of rawTokens) {
    if (tok.length === 1) {
      charRun += tok;
      if (charRun.length >= 2) candidates.add(charRun);
    } else {
      charRun = "";
    }
  }

  return { rawTokens, collapsed, candidates };
}

export function containsBlockedKeyword(rawInput) {
  const lowered = String(rawInput || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase()
    .trim();
  if (!lowered) return null;

  if (INJECTION_RE.test(lowered)) {
    return "injection";
  }

  const primary = collectCandidatesFromText(lowered);
  const leet = collectCandidatesFromText(normalizeLeetspeak(lowered));

  const allCandidates = new Set([...primary.candidates, ...leet.candidates]);
  const allRawTokens = new Set([...primary.rawTokens, ...leet.rawTokens]);

  for (const candidate of [...allCandidates]) {
    if (ALIAS_PHRASES[candidate]) {
      return ALIAS_PHRASES[candidate];
    }
    for (const [alias, mapped] of Object.entries(ALIAS_PHRASES)) {
      if (alias.length >= 5 && candidate.includes(alias)) {
        return mapped;
      }
    }
  }

  for (const keyword of ALL_BLOCKED_KEYWORDS) {
    if (keyword.length <= 3 || EXACT_TOKEN_ONLY_KEYWORDS.has(keyword)) {
      if (
        allRawTokens.has(keyword) ||
        primary.collapsed === keyword ||
        leet.collapsed === keyword ||
        allCandidates.has(keyword)
      ) {
        return keyword;
      }
      continue;
    }

    if (primary.collapsed.includes(keyword) || leet.collapsed.includes(keyword)) {
      return keyword;
    }

    if (keyword.length >= 5) {
      const maxDist = keyword.length <= 6 ? 1 : 2;
      for (const candidate of allCandidates) {
        if (candidate.length < 4) continue;
        if (Math.abs(candidate.length - keyword.length) > maxDist) continue;
        if (levenshtein(candidate, keyword) <= maxDist) {
          return keyword;
        }
      }
    }
  }

  return null;
}

export function validateCustomerName(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (containsBlockedKeyword(trimmed)) {
    return {
      valid: false,
      restricted: true,
      message: "Please enter a valid personal name without restricted words.",
    };
  }
  if (trimmed.length < 2 || trimmed.length > 50) {
    return {
      valid: false,
      restricted: false,
      message: "Please enter a full name between 2 and 50 characters.",
    };
  }
  if (!/^[a-zA-Z\s.]+$/.test(trimmed)) {
    return {
      valid: false,
      restricted: false,
      message: "Name can only contain letters, spaces, and dots.",
    };
  }
  if (trimmed.replace(/[^a-zA-Z]/g, "").length < 2) {
    return {
      valid: false,
      restricted: false,
      message: "Please enter a valid personal name.",
    };
  }

  return { valid: true, restricted: false };
}

export function validateCustomerPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!/^[6-9]\d{9}$/.test(digits) || /^(\d)\1{9}$/.test(digits)) {
    return {
      valid: false,
      restricted: false,
      message: "Please enter a valid 10-digit Indian mobile number.",
    };
  }
  return { valid: true, restricted: false, phone: digits };
}

export function validateCustomerEmail(email) {
  const trimmed = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (INJECTION_RE.test(trimmed)) {
    return {
      valid: false,
      restricted: true,
      message: "Please enter a valid personal email without restricted terms.",
    };
  }
  if (!trimmed || trimmed.length > 120) {
    return {
      valid: false,
      restricted: false,
      message: "Please enter a valid personal email address.",
    };
  }

  const emailRegex = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
  if (!emailRegex.test(trimmed)) {
    return {
      valid: false,
      restricted: false,
      message: "Please enter a valid email address.",
    };
  }

  const atIndex = trimmed.lastIndexOf("@");
  const username = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  const domainParts = domain.split(".");

  for (const blockedDomainTerm of BLOCKED_DOMAIN_KEYWORDS) {
    if (
      domainParts.includes(blockedDomainTerm) ||
      domain.includes(blockedDomainTerm)
    ) {
      return {
        valid: false,
        restricted: true,
        message: "Official or institutional email domains are not permitted. Use a personal email.",
      };
    }
  }

  if (!ALLOWED_PERSONAL_DOMAINS.has(domain)) {
    return {
      valid: false,
      restricted: false,
      message:
        "Please use a personal email address (gmail.com, yahoo.com, yahoo.co.in, hotmail.com, outlook.com, or icloud.com).",
    };
  }

  if (!username || username.length < 2) {
    return {
      valid: false,
      restricted: false,
      message: "Please enter a valid personal email username.",
    };
  }

  const blockedUserTerm = containsBlockedKeyword(username);
  if (blockedUserTerm) {
    return {
      valid: false,
      restricted: true,
      message: "Please enter a valid personal email without restricted terms.",
    };
  }

  return { valid: true, restricted: false };
}
