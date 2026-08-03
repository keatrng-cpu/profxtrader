// portal.js — ProFX Trading
//
// Opens the Stripe-hosted Billing Portal for a subscriber to change or
// cancel their plan. Requires the user's stripe_customer_id, which only
// exists once they've completed Checkout at least once (written by the
// webhook handler, never by the client).

'use strict';

const STRIPE_URL = 'https://api.stripe.com/v1/billing_portal/sessions';
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

async function getStripeCustomerId(userId, deadline) {
  // Service role bypasses RLS — safe here because this function derives the
  // user id from a verified Supabase token, not from client-supplied input.
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
  const siteUrl = process.env.URL || process.env.SITE_URL;
  if (!stripeKey || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return ok(500, { ok: false, reason: 'Billing is not configured on this site yet.' });
  }

  let user;
  try { user = await verifySupabaseUser(token, deadline); }
  catch (e) { return ok(502, { ok: false, reason: 'Could not verify your session. Try again.' }); }
  if (!user) return ok(401, { ok: false, reason: 'Your session has expired — sign in again.' });

  let customerId;
  try { customerId = await getStripeCustomerId(user.id, deadline); }
  catch (e) { return ok(502, { ok: false, reason: 'Could not look up your billing account.' }); }
  if (!customerId) {
    return ok(400, { ok: false, reason: 'No billing account yet — subscribe first.' });
  }

  try {
    const params = new URLSearchParams();
    params.set('customer', customerId);
    params.set('return_url', (siteUrl || '') + '/app.html');

    const r = await fetchWithTimeout(STRIPE_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + stripeKey, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    }, Math.min(6000, deadline - Date.now()));

    const d = await r.json();
    if (!r.ok) return ok(502, { ok: false, reason: (d && d.error && d.error.message) || 'Stripe could not open the billing portal.' });
    return ok(200, { ok: true, url: d.url });
  } catch (e) {
    const timedOut = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return ok(504, { ok: false, reason: timedOut ? 'Timed out. Try again.' : 'Could not reach Stripe.' });
  }
};
