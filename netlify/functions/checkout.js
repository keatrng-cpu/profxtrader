// checkout.js — ProFX Trading
//
// Creates a Stripe Checkout Session for the $19/mo Pro subscription.
// The caller must present a valid Supabase access token (Authorization:
// Bearer <token>) — verified against Supabase's own /auth/v1/user endpoint
// rather than decoding the JWT locally, so a stolen/expired/tampered token
// is rejected by Supabase itself, not by our own (weaker) verification.
//
// client_reference_id carries the Supabase user id through Checkout, so the
// webhook handler can attribute the resulting subscription to the right
// profx_profiles row without any other lookup.

'use strict';

const STRIPE_URL = 'https://api.stripe.com/v1/checkout/sessions';
const HANDLER_BUDGET_MS = 9000;

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function ok(status, body) { return { statusCode: status, headers: HEADERS, body: JSON.stringify(body) }; }

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, Math.max(1, timeoutMs));
  return fetch(url, Object.assign({}, options || {}, { signal: controller.signal }))
    .finally(function () { clearTimeout(timer); });
}

async function verifySupabaseUser(token, deadline) {
  const url = process.env.SUPABASE_URL + '/auth/v1/user';
  const r = await fetchWithTimeout(url, {
    headers: { Authorization: 'Bearer ' + token, apikey: process.env.SUPABASE_ANON_KEY }
  }, Math.min(5000, deadline - Date.now()));
  if (!r.ok) return null;
  const d = await r.json();
  return d && d.id ? d : null;
}

// Mirrors portal.js's lookup: if this user already has a Stripe customer
// (from a previous subscription, even a lapsed one), reuse it instead of
// letting Checkout create a new one off customer_email. Without this,
// every resubscribe mints a fresh Stripe customer object for the same
// person — their payment history fragments across customers in the Stripe
// dashboard, which is confusing for support and for any future "billing
// history" page. A missing/failed lookup isn't fatal here — fall back to
// customer_email so checkout still works for a first-time subscriber.
async function getExistingStripeCustomerId(userId, deadline) {
  const url = process.env.SUPABASE_URL + '/rest/v1/profx_profiles?id=eq.' + encodeURIComponent(userId) +
    '&select=stripe_customer_id';
  const r = await fetchWithTimeout(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
    }
  }, Math.min(5000, deadline - Date.now()));
  if (!r.ok) return null;
  const rows = await r.json();
  return rows && rows[0] ? rows[0].stripe_customer_id : null;
}

exports.handler = async function (event) {
  const deadline = Date.now() + HANDLER_BUDGET_MS;
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return ok(405, { ok: false, reason: 'Send a POST.' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return ok(401, { ok: false, reason: 'Sign in first.' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID_PRO;
  const siteUrl = process.env.URL || process.env.SITE_URL;
  if (!stripeKey || !priceId) {
    return ok(500, { ok: false, reason: 'Billing is not configured on this site yet.' });
  }

  let user;
  try {
    user = await verifySupabaseUser(token, deadline);
  } catch (e) {
    return ok(502, { ok: false, reason: 'Could not verify your session. Try again.' });
  }
  if (!user) return ok(401, { ok: false, reason: 'Your session has expired — sign in again.' });

  let existingCustomerId = null;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try { existingCustomerId = await getExistingStripeCustomerId(user.id, deadline); }
    catch (e) { /* non-fatal — fall back to customer_email below */ }
  }

  try {
    const params = new URLSearchParams();
    params.set('mode', 'subscription');
    params.set('line_items[0][price]', priceId);
    params.set('line_items[0][quantity]', '1');
    params.set('client_reference_id', user.id);
    if (existingCustomerId) {
      params.set('customer', existingCustomerId);
    } else {
      params.set('customer_email', user.email);
    }
    params.set('metadata[supabase_user_id]', user.id);
    params.set('subscription_data[metadata][supabase_user_id]', user.id);
    params.set('success_url', (siteUrl || '') + '/?checkout=success');
    params.set('cancel_url', (siteUrl || '') + '/?checkout=cancelled');
    params.set('allow_promotion_codes', 'true');

    const r = await fetchWithTimeout(STRIPE_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    }, Math.min(6000, deadline - Date.now()));

    const d = await r.json();
    if (!r.ok) {
      return ok(502, { ok: false, reason: (d && d.error && d.error.message) || 'Stripe could not start checkout.' });
    }
    return ok(200, { ok: true, url: d.url });
  } catch (e) {
    const timedOut = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return ok(504, { ok: false, reason: timedOut ? 'Checkout timed out. Try again.' : 'Could not reach Stripe.' });
  }
};
