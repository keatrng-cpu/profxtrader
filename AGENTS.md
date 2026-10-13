# AGENTS.md

<!-- auto-memory:begin v1 -->
## Memory protocol (auto, every task — do not wait to be asked)
**Start:** read `ai/.context.md` (NOW summary + graph slice, refreshed by git hooks; Claude Code gets it via hook; if missing: `python3 ai/memory/mem.py context`). For more: `mem.py slice "<topic>"` (graph query, ~450 tokens). Never load all of `GRAPH_REPORT.md`. Pick the model: `mem.py route "<task>"`.
**End:** overwrite `ai/NOW.md` with current truth (≤150 lines, no history); append one dated entry to `ai/DECISIONS.md` (`## YYYY-MM-DD — title` + why; never edit old entries). Never write `ai/HANDOFF.md` (Dual Desk owns it). Graph + context refresh are automatic (git hooks: `python3 ai/memory/mem.py install-hook` once per clone).
<!-- auto-memory:end -->
