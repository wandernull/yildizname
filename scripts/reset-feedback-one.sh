#!/usr/bin/env bash
# Clear the feedback on a SINGLE reading by id, WITHOUT touching its paid
# state. The reading stays unlocked=1 — only the rating/comment + feedback
# funnel flags are wiped. This is the rapid-iteration helper for testing
# the feedback flow: pay once, then run this between each attempt so the
# "Müneccime bir söz bırak" sticky reappears (feedbackGiven flips back to
# false) without going through Stripe again.
#
# Clears (migration 0006 columns):
#   feedback_rating, feedback_text, feedback_at,
#   viewed_feedback_cta, clicked_feedback_cta
# Leaves untouched: unlocked, all Stripe metadata, the funnel flags from
# migration 0004, and the reading content.
#
# Usage:
#   ./scripts/reset-feedback-one.sh <reading_id>            # LOCAL D1 (default)
#   ./scripts/reset-feedback-one.sh <reading_id> --remote   # PRODUCTION D1
#
# Or via npm:
#   npm run db:reset-feedback:one -- <reading_id>
#   npm run db:reset-feedback:one -- <reading_id> --remote
#
# The --remote path prompts for confirmation before touching prod data.

set -euo pipefail

if [ $# -lt 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  cat >&2 <<USAGE
usage: $0 <reading_id> [--remote]

  <reading_id>    The id of the reading whose feedback to clear.
  --remote        Apply to PRODUCTION D1 instead of local. Will prompt
                  for confirmation before running.

examples:
  $0 abc123xyz                  # local feedback reset (keeps paid)
  $0 abc123xyz --remote         # prod feedback reset (with confirm)
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

# Strict ID validation prevents SQL injection by construction.
if ! [[ "$ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  echo "error: '$ID' doesn't look like a valid reading id" >&2
  echo "       (expected: alphanumeric / dash / underscore, max 64 chars)" >&2
  exit 1
fi

if [ "$LOCATION_FLAG" = "--remote" ]; then
  echo ""
  echo "⚠️  About to clear feedback for reading '$ID' on PRODUCTION D1."
  echo "    This wipes the rating + comment but keeps the reading paid."
  printf "    Type the reading id again to confirm: "
  read -r CONFIRM
  if [ "$CONFIRM" != "$ID" ]; then
    echo "aborted (confirmation didn't match)"
    exit 1
  fi
  echo ""
fi

UPDATE_SQL="UPDATE readings
   SET feedback_rating = NULL,
       feedback_text = NULL,
       feedback_at = NULL,
       viewed_feedback_cta = 0,
       clicked_feedback_cta = 0
 WHERE id = '$ID';"

VERIFY_SQL="SELECT id, unlocked, feedback_rating, feedback_at
              FROM readings
             WHERE id = '$ID';"

echo "→ clearing feedback for '$ID' on $LOCATION_LABEL D1 (paid state untouched)..."
npx wrangler d1 execute yildizname-db "$LOCATION_FLAG" --command "$UPDATE_SQL"

echo ""
echo "→ verifying new state:"
npx wrangler d1 execute yildizname-db "$LOCATION_FLAG" --command "$VERIFY_SQL"
