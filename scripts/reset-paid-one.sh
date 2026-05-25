#!/usr/bin/env bash
# Roll back the paid state on a SINGLE reading by id.
# Resets unlocked + clears all Stripe metadata (migration 0003 columns).
# Reading content (form_data, sections) is untouched.
#
# Usage:
#   ./scripts/reset-paid-one.sh <reading_id>            # LOCAL D1 (default)
#   ./scripts/reset-paid-one.sh <reading_id> --remote   # PRODUCTION D1
#
# Or via npm:
#   npm run db:reset-paid:one -- <reading_id>
#   npm run db:reset-paid:one -- <reading_id> --remote
#
# The --remote path prompts for confirmation before touching prod data.
#
# Use case (prod): you refunded a test transaction in the Stripe Dashboard
# and want to flip the reading back to its locked, pre-payment state so the
# row mirrors the post-refund reality. The webhook does NOT auto-roll back
# on refund — Stripe sends charge.refunded but our handler only listens for
# checkout.session.completed.

set -euo pipefail

if [ $# -lt 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  cat >&2 <<USAGE
usage: $0 <reading_id> [--remote]

  <reading_id>    The id of the reading to roll back (column readings.id).
  --remote        Apply to PRODUCTION D1 instead of local. Will prompt
                  for confirmation before running.

examples:
  $0 abc123xyz                  # local rollback
  $0 abc123xyz --remote         # prod rollback (with confirm)
USAGE
  exit 1
fi

ID="$1"
shift || true

LOCATION_FLAG="--local"
LOCATION_LABEL="local"
for arg in "$@"; do
  case "$arg" in
    --remote)
      LOCATION_FLAG="--remote"
      LOCATION_LABEL="REMOTE (PRODUCTION)"
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

# Strict ID validation prevents SQL injection by construction — no quotes,
# semicolons, or whitespace can pass this gate, so inline interpolation
# into the SQL below is safe.
if ! [[ "$ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "error: '$ID' doesn't look like a valid reading id" >&2
  echo "       (expected: alphanumeric / dash / underscore, max 64 chars)" >&2
  exit 1
fi

if [ "$LOCATION_FLAG" = "--remote" ]; then
  echo ""
  echo "⚠️  About to roll back reading '$ID' on PRODUCTION D1."
  echo "    This sets unlocked=0 and clears Stripe metadata for that row."
  printf "    Type the reading id again to confirm: "
  read -r CONFIRM
  if [ "$CONFIRM" != "$ID" ]; then
    echo "aborted (confirmation didn't match)"
    exit 1
  fi
  echo ""
fi

UPDATE_SQL="UPDATE readings
   SET unlocked = 0,
       stripe_session_id = NULL,
       stripe_payment_intent_id = NULL,
       paid_at = NULL,
       invoice_hosted_url = NULL,
       invoice_pdf_url = NULL
 WHERE id = '$ID';"

VERIFY_SQL="SELECT id, unlocked, paid_at, stripe_session_id
              FROM readings
             WHERE id = '$ID';"

echo "→ rolling back '$ID' on $LOCATION_LABEL D1..."
npx wrangler d1 execute yildizname-db "$LOCATION_FLAG" --command "$UPDATE_SQL"

echo ""
echo "→ verifying new state:"
npx wrangler d1 execute yildizname-db "$LOCATION_FLAG" --command "$VERIFY_SQL"
