#!/usr/bin/env bash
# Reconnaissance on Stripe test mode: create a minimal billing world on a test clock, then probe
# the invoice preview. Outputs raw JSON under ./out (git-ignored; scrubbed before any commit).
set -euo pipefail
source "${STRIPE_ENV:-$(dirname "$0")/../../../.env}"
[[ "$STRIPE_SECRET_KEY" == sk_test_* ]] || { echo "refusing: not a test key" >&2; exit 1; }
OUT="$(dirname "$0")/out"; mkdir -p "$OUT"
api() { local m=$1 p=$2; shift 2; curl -sS -X "$m" "https://api.stripe.com/v1/$p" -u "$STRIPE_SECRET_KEY:" "$@"; }

T0=1790000000   # fixed frozen time (2026-09-21T14:13:20Z) so every run starts at the same instant
api POST products -d name="Recon plan" > "$OUT/product.json"
PROD=$(jq -r .id "$OUT/product.json")
api POST prices -d product="$PROD" -d currency=usd -d unit_amount=1000 -d "recurring[interval]=month" > "$OUT/price_a.json"
api POST prices -d product="$PROD" -d currency=usd -d unit_amount=3000 -d "recurring[interval]=month" > "$OUT/price_b.json"
PA=$(jq -r .id "$OUT/price_a.json"); PB=$(jq -r .id "$OUT/price_b.json")
api POST coupons -d percent_off=20 -d duration=forever > "$OUT/coupon_pct.json"
CP=$(jq -r .id "$OUT/coupon_pct.json")
api POST test_helpers/test_clocks -d frozen_time=$T0 > "$OUT/clock.json"
CLK=$(jq -r .id "$OUT/clock.json")
api POST customers -d test_clock="$CLK" -d payment_method=pm_card_visa \
  -d "invoice_settings[default_payment_method]=pm_card_visa" > "$OUT/customer.json" || true
CUS=$(jq -r .id "$OUT/customer.json")
api POST subscriptions -d customer="$CUS" -d "items[0][price]=$PA" > "$OUT/subscription.json"
SUB=$(jq -r .id "$OUT/subscription.json"); SI=$(jq -r '.items.data[0].id' "$OUT/subscription.json")

# Preview: upgrade A -> B ten days into the period, with and without a coupon, each run twice.
PD=$((T0 + 10*86400))
for run in 1 2; do
  api POST invoices/create_preview -d subscription="$SUB" \
    -d "subscription_details[items][0][id]=$SI" -d "subscription_details[items][0][price]=$PB" \
    -d "subscription_details[proration_date]=$PD" > "$OUT/preview_upgrade_$run.json"
  api POST invoices/create_preview -d subscription="$SUB" \
    -d "subscription_details[items][0][id]=$SI" -d "subscription_details[items][0][price]=$PB" \
    -d "subscription_details[proration_date]=$PD" -d "discounts[0][coupon]=$CP" > "$OUT/preview_upgrade_coupon_$run.json"
done

# Portal: configuration allowing plan switch, and a session deep-linked to the update-confirm flow.
api POST billing_portal/configurations \
  -d "features[subscription_update][enabled]=true" \
  -d "features[subscription_update][default_allowed_updates][0]=price" \
  -d "features[subscription_update][default_allowed_updates][1]=quantity" \
  -d "features[subscription_update][proration_behavior]=create_prorations" \
  -d "features[subscription_update][products][0][product]=$PROD" \
  -d "features[subscription_update][products][0][prices][0]=$PA" \
  -d "features[subscription_update][products][0][prices][1]=$PB" > "$OUT/portal_config.json"
CFG=$(jq -r .id "$OUT/portal_config.json")
api POST billing_portal/sessions -d customer="$CUS" -d configuration="$CFG" \
  -d "flow_data[type]=subscription_update_confirm" \
  -d "flow_data[subscription_update_confirm][subscription]=$SUB" \
  -d "flow_data[subscription_update_confirm][items][0][id]=$SI" \
  -d "flow_data[subscription_update_confirm][items][0][price]=$PB" > "$OUT/portal_session.json"
echo "done: $OUT"
