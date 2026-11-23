#!/usr/bin/env bash
# One-time Firestore TTL setup for ATTIRE MART request_limits documents.
# Authenticate with a Google Cloud admin account first; never paste service
# account keys into GitHub, a chat, or command history.
set -euo pipefail
: "${FIREBASE_PROJECT_ID:?Set FIREBASE_PROJECT_ID to the existing Firebase project ID}"
database="${FIRESTORE_DATABASE_ID:-(default)}"
command -v gcloud >/dev/null || { echo "Install the Google Cloud CLI first." >&2; exit 1; }
echo "Enabling Firestore TTL for request_limits.expiresAt in database: ${database}"
gcloud firestore fields ttls update expiresAt \
  --project="${FIREBASE_PROJECT_ID}" \
  --database="${database}" \
  --collection-group=request_limits \
  --enable-ttl
echo "Verify the policy status (enablement can take time):"
gcloud firestore fields ttls list --project="${FIREBASE_PROJECT_ID}" \
  --database="${database}" --collection-group=request_limits
