# PromiseProof Build Week Log

## Project baseline — 2026-07-14

PromiseProof begins as a new OpenAI Build Week project. `AGENTS.md` is the canonical product and engineering specification.

### Decisions

- Enter the Developer Tools track as a solo entrant.
- Prove one narrow, observable promise before expanding scope.
- Keep verdict ownership deterministic: models may later investigate and propose repairs, but they may not declare verification success.
- Use a synthetic recommendation product and synthetic identifiers only.
- Preserve an authentic frontend-to-backend HTTP boundary for activity evidence.
- Keep the ordinary health suite green while exposing the seeded contract violation through a separate non-zero promise verifier.
- Defer GPT-5.6 diagnosis and Codex repair automation until the canonical Playwright loop is deterministic.

### Baseline contents

- `AGENTS.md` — canonical promise, constraints, architecture, and milestone scope.
- `README.md` — repository orientation.
- `BUILD_WEEK.md` — decisions, commands, and verified milestone history.

### Next milestone

Implement and verify the initialization-race milestone defined in `AGENTS.md`, including five clean OFF and ON repetitions.
