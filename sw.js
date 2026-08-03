// sw.js — ProFX Trading service worker
//
// Caches ONLY the static app shell (app.html, index.html, icon, manifest) so
// an installed/home-screen copy can launch instantly, and still load
// something if the network is down. It never intercepts, caches, or serves
// from cache: /.netlify/functions/* (billable market data, auth, Stripe,
// the Professor) or any cross-origin request (Supabase, Stripe, the CDN
// scripts) — those always hit the network untouched. Caching a market-data
// or auth response would be actively wrong, not just stale.

'use strict';

const CACHE = 'profx-shell-v2';
const SHELL = ['/', '/app.html', '/index.html', '/icon.svg', '/manifest.json'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }).catch(function () {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;          // Supabase/Stripe/CDN — untouched
  if (url.pathname.startsWith('/.netlify/functions/')) return; // bars/professor/checkout/portal — untouched

  // Network-first: always serve the freshest deploy when online (this app
  // ships new commits often and correctness matters more than raw speed
  // here), falling back to whatever shell is cached when the network fails.
  event.respondWith(
    fetch(req)
      .then(function (res) {
        const copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); }).catch(function () {});
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (cached) { return cached || caches.match('/app.html'); });
      })
  );
});
