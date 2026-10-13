# DECISIONS — profxtrader (append-only)

Newest last. Never edit or delete entries.

## 2026-10-13 — auto-memory protocol adopted
Agents (Claude Code via hooks, Grok/Codex via AGENTS.md / .grok/GROK.md) read `ai/NOW.md` + a graph slice at task start and update NOW/DECISIONS at task end; graph refresh by post-commit hook and the `graphify-refresh` Action (writes only to the `graph` branch). Why: shared memory without being asked, low token use (graph query, not GRAPH_REPORT).
