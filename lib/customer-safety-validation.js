"use strict";

/**
 * Customer contact safety & policy validation for isolated checkout.
 * Detects exact keywords, substrings, spaced tokens, two-word joins, and fuzzy typos.
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
  "gateway",
  "payment",
  "merchant",
  "pg",
];

const GOVT_LEGAL_KEYWORDS = [
  "police",
  "cyber",
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
];

const FRAUD_SUSPICIOUS_KEYWORDS = [
  "scam",
  "fraud",
  "fake",
  "cheat",
  "chor",
  "hacker",
  "hack",
  "testing",
  "admin",
  "support",
  "refund",
  "chargeback",
  "dispute",
];

const ALL_BLOCKED_KEYWORDS = [
  ...GATEWAY_KEYWORDS,
  ...GOVT_LEGAL_KEYWORDS,
  ...FRAUD_SUSPICIOUS_KEYWORDS,
];

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
};

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

function containsBlockedKeyword(rawInput) {
  const lowered = String(rawInput || "").toLowerCase().trim();
  if (!lowered) return null;

  // Tokenize words separated by whitespace/punctuation
  const rawTokens = lowered
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  // Build candidate strings: single tokens, adjacent 2-word joins, 3-word joins,
  // and full collapsed alphanumeric string (catches "c y b e r", "p o l i c e", "p.g")
  const collapsed = lowered.replace(/[^a-z0-9]/g, "");
  const candidates = new Set([collapsed, ...rawTokens]);

  // Adjacent pairs and triples (e.g. "cost free" -> "costfree", "c y b e r" -> "cyber")
  for (let i = 0; i < rawTokens.length - 1; i++) {
    candidates.add(rawTokens[i] + rawTokens[i + 1]);
  }
  for (let i = 0; i < rawTokens.length - 2; i++) {
    candidates.add(rawTokens[i] + rawTokens[i + 1] + rawTokens[i + 2]);
  }

  // Sliding window of single-char runs (e.g. "p o l i c e" inside a longer name)
  let charRun = "";
  for (const tok of rawTokens) {
    if (tok.length === 1) {
      charRun += tok;
      if (charRun.length >= 2) candidates.add(charRun);
    } else {
      charRun = "";
    }
  }

  for (const candidate of [...candidates]) {
    if (ALIAS_PHRASES[candidate]) {
      return ALIAS_PHRASES[candidate];
    }
    // Check if candidate matches an alias via substring
    for (const [alias, mapped] of Object.entries(ALIAS_PHRASES)) {
      if (alias.length >= 5 && candidate.includes(alias)) {
        return mapped;
      }
    }
  }

  for (const keyword of ALL_BLOCKED_KEYWORDS) {
    // Exact standalone check for short 2-3 letter terms ("pg", "cid", "cbi", "fbi", "cop", "gst", "rbi")
    if (keyword.length <= 3) {
      if (rawTokens.includes(keyword) || collapsed === keyword) {
        return keyword;
      }
      // Also catch spaced single letters like "c i d" or "p g"
      for (const candidate of candidates) {
        if (candidate === keyword) return keyword;
      }
      continue;
    }

    // Substring match in collapsed string or tokens
    if (collapsed.includes(keyword)) {
      return keyword;
    }

    // Fuzzy typo matching on candidate tokens
    const maxDist = keyword.length <= 6 ? 1 : 2;
    for (const candidate of candidates) {
      if (candidate.length < 3) continue;
      if (Math.abs(candidate.length - keyword.length) > maxDist) continue;
      if (levenshtein(candidate, keyword) <= maxDist) {
        return keyword;
      }
    }
  }

  return null;
}

export function validateCustomerName(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length < 2 || trimmed.length > 50) {
    return {
      valid: false,
      message: "Please enter a full name between 2 and 50 characters.",
    };
  }
  if (!/^[a-zA-Z\s.]+$/.test(trimmed)) {
    return {
      valid: false,
      message: "Name can only contain letters, spaces, and dots.",
    };
  }
  if (trimmed.replace(/[^a-zA-Z]/g, "").length < 2) {
    return {
      valid: false,
      message: "Please enter a valid personal name.",
    };
  }

  const blocked = containsBlockedKeyword(trimmed);
  if (blocked) {
    return {
      valid: false,
      message: "Please enter a valid personal name without restricted words.",
    };
  }

  return { valid: true };
}

export function validateCustomerEmail(email) {
  const trimmed = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!trimmed || trimmed.length > 120) {
    return {
      valid: false,
      message: "Please enter a valid personal email address.",
    };
  }

  const emailRegex = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
  if (!emailRegex.test(trimmed)) {
    return {
      valid: false,
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
        message: "Official or institutional email domains are not permitted. Use a personal email.",
      };
    }
  }

  if (!ALLOWED_PERSONAL_DOMAINS.has(domain)) {
    return {
      valid: false,
      message:
        "Please use a personal email address (gmail.com, yahoo.com, yahoo.co.in, hotmail.com, outlook.com, or icloud.com).",
    };
  }

  if (!username || username.length < 2) {
    return {
      valid: false,
      message: "Please enter a valid personal email username.",
    };
  }

  const blockedUserTerm = containsBlockedKeyword(username);
  if (blockedUserTerm) {
    return {
      valid: false,
      message: "Please enter a valid personal email without restricted terms.",
    };
  }

  return { valid: true };
}
