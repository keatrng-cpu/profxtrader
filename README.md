# ProFX Trading

Deterministic backtesting, journaling, and risk tooling for futures/FX/crypto
traders — with an AI coaching layer that never computes a number, only
explains ones already computed in code.

## Stack
- Static single-file front end (`index.html`) — no build step
- Netlify Functions (`netlify/functions/`) — Node, zero npm dependencies by design
- Supabase — auth, Postgres (RLS-scoped), cloud trade sync
- Stripe — subscriptions (Checkout + Billing Portal)
- Databento — real CME/CBOT/NYMEX/COMEX futures data
- Alpha Vantage — FX/crypto market data

## Environment variables (Netlify → Site configuration → Environment variables)
| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | professor.js |
| `ALPHAVANTAGE_API_KEY` | bars.js (FX/crypto) |
| `DATABENTO_API_KEY` | bars.js (futures) |
| `SUPABASE_URL` | professor.js, checkout.js, portal.js, stripe-webhook.js |
| `SUPABASE_ANON_KEY` | professor.js, checkout.js, portal.js |
| `SUPABASE_SERVICE_ROLE_KEY` | portal.js, stripe-webhook.js, checkout.js (optional — enables Stripe customer reuse on resubscribe) |
| `STRIPE_SECRET_KEY` | checkout.js, portal.js |
| `STRIPE_PRICE_ID_PRO` | checkout.js |
| `STRIPE_WEBHOOK_SECRET` | stripe-webhook.js |

## Deploy
Push to `main` — Netlify's GitHub integration auto-builds and publishes.
No build command needed; `netlify.toml` points `publish` at the repo root.

## AI Professor modes
`live`, `debrief`, `playbook`, `ask`, `tag` (all free-tier, capped 15/mo),
`weekly` (Pro-only), `followup` (Socratic reply after a `live` response).

## Local testing
Every function has a matching `*_test.js` alongside it in
`netlify/functions/`. Run with plain `node <file>_test.js` — no test
framework dependency.
