# Graph Report - profxtrader  (2026-10-13)

## Corpus Check
- 16 files · ~78,685 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 2, .toml 1)

## Summary
- 140 nodes · 212 edges · 15 communities (10 shown, 5 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `86dcb14f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- bars.js
- mem.py
- professor.js
- manifest.json
- stripe-webhook.js
- ProFX Trading
- checkout.js
- portal.js
- package.json
- NOW — profxtrader current truth
- AGENTS.md
- 2026-10-13 — auto-memory protocol adopted
- CLAUDE.md
- GROK.md
- sw.js

## God Nodes (most connected - your core abstractions)
1. `handler()` - 13 edges
2. `sh()` - 8 edges
3. `post_commit()` - 8 edges
4. `handler()` - 8 edges
5. `ProFX Trading` - 8 edges
6. `slice_()` - 6 edges
7. `build()` - 6 edges
8. `context()` - 6 edges
9. `stop()` - 6 edges
10. `fetchDatabento()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `2026-10-13 — auto-memory protocol adopted` --references--> `graph()`  [INFERRED]
  ai/DECISIONS.md → ai/memory/mem.py

## Import Cycles
- None detected.

## Communities (15 total, 5 thin omitted)

### Community 0 - "bars.js"
Cohesion: 0.15
Nodes (23): buildDatabentoUrl(), buildUrl(), _cache, cacheGet(), cacheKey(), cacheSet(), CATALOG, clean() (+15 more)

### Community 1 - "mem.py"
Cohesion: 0.23
Nodes (15): build(), changed(), context(), gbin(), graph(), install_hook(), last_decisions(), post_commit() (+7 more)

### Community 2 - "professor.js"
Cohesion: 0.16
Nodes (20): cachedModel, callClaude(), CHARACTER, clean(), coalesceMessages(), createdMs(), FALLBACK, fetchProfile() (+12 more)

### Community 3 - "manifest.json"
Cohesion: 0.15
Nodes (12): background_color, categories, description, display, icons, id, name, orientation (+4 more)

### Community 4 - "stripe-webhook.js"
Cohesion: 0.29
Nodes (9): crypto, fetchWithTimeout(), handler(), HEADERS, mapStatus(), ok(), tierFor(), updateProfile() (+1 more)

### Community 5 - "ProFX Trading"
Cohesion: 0.22
Nodes (8): AI Professor modes, Bench tab — performance dashboards, Data-source notes (operational — read before wondering why FX/crypto intraday is empty), Deploy, Environment variables (Netlify → Site configuration → Environment variables), ProFX Trading, Stack, Testing

### Community 6 - "checkout.js"
Cohesion: 0.57
Nodes (6): fetchWithTimeout(), getExistingStripeCustomerId(), handler(), HEADERS, ok(), verifySupabaseUser()

### Community 7 - "portal.js"
Cohesion: 0.57
Nodes (6): fetchWithTimeout(), getStripeCustomerId(), handler(), HEADERS, ok(), verifySupabaseUser()

### Community 8 - "package.json"
Cohesion: 0.29
Nodes (6): description, engines, node, name, private, version

### Community 9 - "NOW — profxtrader current truth"
Cohesion: 0.40
Nodes (4): Goal, In flight, Known facts / constraints, NOW — profxtrader current truth

## Knowledge Gaps
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `graph()` connect `mem.py` to `2026-10-13 — auto-memory protocol adopted`?**
  _High betweenness centrality (0.007) - this node is a cross-community bridge._
- **Why does `2026-10-13 — auto-memory protocol adopted` connect `2026-10-13 — auto-memory protocol adopted` to `mem.py`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._