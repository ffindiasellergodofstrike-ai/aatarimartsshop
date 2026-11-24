"use strict";

/**
 * Builds and caches the isolated minified IIFE bundle for /attirecheckout.
 * Kept strictly outside publish/ so it is never exposed as a public static asset.
 */
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const privateDir = path.join(root, "dist-private");
const tmpPrivateDir = path.join("/tmp", "dist-private");
const bundleOutFile = path.join(privateDir, "attirecheckout.bundle.js");
const tmpBundleOutFile = path.join(tmpPrivateDir, "attirecheckout.bundle.js");
const entryFile = path.join(root, "lib", "attirecheckout-entry.tsx");

let buildPromise = null;

export async function buildPrivateCheckoutBundle({ force = false } = {}) {
  if (!force && fs.existsSync(bundleOutFile)) {
    return bundleOutFile;
  }
  if (!force && fs.existsSync(tmpBundleOutFile)) {
    return tmpBundleOutFile;
  }
  if (buildPromise) {
    return buildPromise;
  }

  buildPromise = (async () => {
    try {
      let targetDir = privateDir;
      let targetOut = bundleOutFile;
      try {
        fs.mkdirSync(targetDir, { recursive: true });
      } catch {
        targetDir = tmpPrivateDir;
        targetOut = tmpBundleOutFile;
        fs.mkdirSync(targetDir, { recursive: true });
      }
      await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: ["es2020"],
        minify: true,
        sourcemap: false,
        legalComments: "none",
        jsx: "automatic",
        outfile: targetOut,
        define: {
          "process.env.NODE_ENV": '"production"',
        },
        resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
      });
      return targetOut;
    } finally {
      buildPromise = null;
    }
  })();

  return buildPromise;
}

export function getPrivateCheckoutBundlePath() {
  return bundleOutFile;
}
