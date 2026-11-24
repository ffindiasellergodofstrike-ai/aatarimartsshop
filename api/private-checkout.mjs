"use strict";

import fs from "node:fs";
import path from "node:path";
import { handlePrivateCheckoutRequest } from "../lib/private-checkout-handler.mjs";

const PREBUILT_BUNDLE = path.join(process.cwd(), "dist-private", "attirecheckout.bundle.js");

function readStaticBundle() {
  try {
    if (fs.existsSync(PREBUILT_BUNDLE)) {
      return fs.readFileSync(PREBUILT_BUNDLE);
    }
  } catch {
    // Fall back to on-demand bundle builder in handler
  }
  return null;
}

export default {
  fetch(request) {
    return handlePrivateCheckoutRequest(request, { readStaticBundle });
  },
};
