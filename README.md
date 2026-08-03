# ProFX Trading

Deterministic backtesting, journaling, and risk tooling for futures/FX/crypto
traders — with an AI coaching layer that never computes a number, only
explains ones already computed in code.

## Stack
- Public marketing page (`index.html`) — self-contained, no build step, indexable.
  Interactive teasers run on bundled sample data (no API calls, no auth).
- Signed-in app (`app.html`, also reachable at `/app`) — the single-file trading
  desk. Paywalled: a hard Supabase sign-in gate on load; logged-out visitors get
  the auth card and can't dismiss it into the app.
- Netlify Functions (`netlify/functions/`) — Node, zero npm dependencies by design.
  **Every function requires a signed-in Supabase user** (bars.js included, as of
  the paywall model).
- Supabase — auth, Postgres (RLS-scoped), cloud trade sync
- Stripe — subscriptions (Checkout + Billing Portal); post-checkout returns to `/app.html`
- Databento — real CME/CBOT/NYMEX/COMEX futures data
- Alpha Vantage — FX/crypto market data

## Data-source notes (operational — read before wondering why FX/crypto intraday is empty)
- **Alpha Vantage free tier**: `FX_INTRADAY` and `CRYPTO_INTRADAY` are **premium**
  endpoints — on a free key they return an `Information` notice, not data, so
  intraday FX/crypto silently fall back to CSV upload. `FX_DAILY` and
  `DIGITAL_CURRENCY_DAILY` are free. Free limits: 25 req/day, 5 req/min. Upgrade
  the AV plan if intraday FX/crypto must work in-app.
- **Databento GLBX.MDP3** requires a CME data entitlement on the key (Databento
  passes through CME fees). Historical `get_range` serves data older than ~24h;
  the most recent day lags, which is why bars.js anchors "recent" a day back.
- **Cost control**: bars.js caches responses in-memory per warm Lambda container
  (15-min TTL) so repeated "recent ES 5min" requests share one upstream call.

## Environment variables (Netlify → Site configuration → Environment variables)
| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | professor.js |
| `ALPHAVANTAGE_API_KEY` | bars.js (FX/crypto) |
| `DATABENTO_API_KEY` | bars.js (futures) |
| `SUPABASE_URL` | professor.js, checkout.js, portal.js, stripe-webhook.js, bars.js |
| `SUPABASE_ANON_KEY` | professor.js, checkout.js, portal.js, bars.js |
| `SUPABASE_SERVICE_ROLE_KEY` | portal.js, stripe-webhook.js, checkout.js (optional — enables Stripe customer reuse on resubscribe) |
| `STRIPE_SECRET_KEY` | checkout.js, portal.js |
| `STRIPE_PRICE_ID_PRO` | checkout.js |
| `STRIPE_WEBHOOK_SECRET` | stripe-webhook.js |

## Deploy
Push to `main` — Netlify's GitHub integration auto-builds and publishes.
No build command needed; `netlify.toml` points `publish` at the repo root.
`/` serves the marketing page; the app is at `/app.html` (or `/app`).

## AI Professor modes
`live`, `debrief`, `playbook`, `ask`, `tag` (all free-tier, capped 15/mo),
`weekly` (Pro-only), `followup` (Socratic reply after a `live` response).

The Professor discovers the newest Sonnet model via `/v1/models` at runtime and
falls back to `claude-sonnet-5` if discovery fails. Thinking is explicitly
disabled on the request so the deliberately small per-mode token budgets aren't
consumed by an (adaptive-by-default) reasoning pass.

## Testing
There is no automated test suite yet. The functions have no npm dependencies, so
`node --check netlify/functions/<file>.js` catches syntax errors; end-to-end
behavior needs a deploy with the environment variables above populated.
