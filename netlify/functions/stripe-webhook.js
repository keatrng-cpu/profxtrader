// stripe-webhook.js — ProFX Trading
//
// Listens for Stripe subscription lifecycle events and writes the result to
// profx_profiles via the Supabase service role key. This function has NO
// user session — it authenticates the REQUEST ITSELF by verifying Stripe's
// webhook signature (HMAC-SHA256 over `timestamp.rawBody`), which is the
// only thing standing between this endpoint and anyone on the internet who
// wants to mark themselves "Pro" for free. Get this wrong and the whole
// subscription system is worthless.
//
// Netlify config note: this function needs the RAW, unparsed request body
// to verify the signature — Stripe signs the exact bytes it sent. Netlify's
// standard Lambda-compatible event.body is what we use; if it arrives
// base64-encoded (event.isBase64Encoded), decode before verifying.

'use strict';

const crypto = require('crypto');

const HANDLER_BUDGET_MS = 9000;
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function ok(status, body) { return { statusCode: status, headers: HEADERS, body: JSON.stringify(body || { received: true }) }; }

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, Math.max(1, timeoutMs));
  return fetch(url, Object.assign({}, options || {}, { signal: controller.signal }))
    .finally(function () { clearTimeout(timer); });
}

/**
 * Verifies a Stripe webhook signature without the Stripe SDK. Stripe sends
 * `Stripe-Signature: t=<timestamp>,v1=<hex hmac>`. The signed payload is
 * exactly `<timestamp>.<raw body>`, HMAC-SHA256 with the endpoint's signing
 * secret. Uses timingSafeEqual to avoid a timing side-channel on comparison.
 */
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = {};
  sigHeader.split(',').forEach(function (kv) {
    const i = kv.indexOf('=');
    if (i === -1) return;
    parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  if (!parts.t || !parts.v1) return false;

  // Reject stale signatures (replay protection) — 5 minute tolerance, same
  // default Stripe's own SDK uses.
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!isFinite(age) || age > 300) return false;

  const expected = crypto.createHmac('sha256', secret).update(parts.t + '.' + rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function updateProfile(userId, patch, deadline) {
  const url = process.env.SUPABASE_URL + '/rest/v1/profx_profiles?id=eq.' + encodeURIComponent(userId);
  const r = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(patch)
  }, Math.min(6000, deadline - Date.now()));
  return r.ok;
}

/** Maps Stripe's subscription status vocabulary onto our own narrower set. */
function mapStatus(stripeStatus) {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') return stripeStatus;
  if (stripeStatus === 'past_due') return 'past_due';
  if (stripeStatus === 'canceled' || stripeStatus === 'unpaid' || stripeStatus === 'incomplete_expired') return 'canceled';
  return 'inactive';
}
function tierFor(status) {
  return (status === 'active' || status === 'trialing' || status === 'past_due') ? 'pro' : 'free';
}

exports.handler = async function (event) {
  const deadline = Date.now() + HANDLER_BUDGET_MS;
  if (event.httpMethod !== 'POST') return ok(405, { received: false });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    // Fail closed: if we can't verify or can't write, do NOT report success —
    // Stripe will retry, which is the correct behavior for a misconfigured site.
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ received: false, reason: 'not configured' }) };
  }

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  if (!verifyStripeSignature(rawBody, sig, secret)) {
    // Wrong signature = not actually from Stripe. Reject loudly; do not process.
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ received: false, reason: 'bad signature' }) };
  }

  let evt;
  try { evt = JSON.parse(rawBody); } catch (e) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ received: false, reason: 'bad json' }) };
  }

  try {
    const type = evt.type;
    const obj = evt.data && evt.data.object;

    if (type === 'checkout.session.completed' && obj && obj.mode === 'subscription') {
      const userId = obj.client_reference_id || (obj.metadata && obj.metadata.supabase_user_id);
      if (userId) {
        await updateProfile(userId, {
          stripe_customer_id: obj.customer,
          stripe_subscription_id: obj.subscription,
          subscription_status: 'active',
          subscription_tier: 'pro',
          updated_at: new Date().toISOString()
        }, deadline);
      }
    } else if (type === 'customer.subscription.updated' || type === 'customer.subscription.created') {
      const userId = obj.metadata && obj.metadata.supabase_user_id;
      if (userId) {
        const status = mapStatus(obj.status);
        await updateProfile(userId, {
          stripe_subscription_id: obj.id,
          subscription_status: status,
          subscription_tier: tierFor(status),
          updated_at: new Date().toISOString()
        }, deadline);
      }
    } else if (type === 'customer.subscription.deleted') {
      const userId = obj.metadata && obj.metadata.supabase_user_id;
      if (userId) {
        await updateProfile(userId, {
          subscription_status: 'canceled',
          subscription_tier: 'free',
          updated_at: new Date().toISOString()
        }, deadline);
      }
    }
    // Every other event type: acknowledge without action. Returning 200 for
    // events we don't handle is correct — it tells Stripe not to retry.
    return ok(200, { received: true });
  } catch (e) {
    // A real processing failure: return non-200 so Stripe retries this event.
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ received: false }) };
  }
};
