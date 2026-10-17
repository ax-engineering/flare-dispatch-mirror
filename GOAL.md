# GOAL — make this repo the source of truth

**Mission.** This repo becomes the canonical FlareDispatch implementation; the prior reference implementation is deprecated once parity is reached. Architecture and design decisions live in [`REWRITE.md`](./REWRITE.md); this file is the _mission and sequencing_ — what "done" means and the order we build it.

## Definition of done

1. **100% feature parity** with the reference implementation — every run, recipe, capability, trigger, and deploy surface it has, this repo has.
2. **Dogfooding gate (north star):** this repo runs **AI code review on its own pull requests** — the deployed `pr-review` run triggers on a PR here and posts its review back. This is the acceptance test that proves the stack is real, not just compiled.

All work lands on branch **`alpha`** (keep committing/merging there).

## Strategy — vertical slice first, parity behind it

100% parity is many sessions. The fastest _verifiable_ signal is the dogfooding slice, so we build a thin end-to-end path first (foundation → `pr-review` → deploy → review a real PR), then broaden to full parity on the same substrate. Parity does not block dogfooding; dogfooding de-risks parity.

## Execution order

| Phase | What                                                                                                                                                                                                                                                                                                 | REWRITE.md     | Task |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---- |
| 1     | Monorepo foundation (pnpm workspace, tsconfig, vitest, oxlint, wrangler, `@fractalboxdev/flare-dispatch-*` skeletons)                                                                                                                                                                                | §1–§2          | #1   |
| 2     | PR1 core — `defineRun<O,E,R>` + erased registry; protocol (dedup fingerprint + branded `InstanceId`); `DispatchEvent` + router skeleton; typed `instantiateRun`                                                                                                                                      | §5 PR1, §7, §8 | #2   |
| 3     | PR1 core — `completeStructured` over `@effect/ai`; four-way `RunOutcome` verdict; `RunError` infra/finding partition                                                                                                                                                                                 | §5 PR1, §8     | #3   |
| 4     | Capabilities for the slice — `github` (PR diff + post review), `model` (`@effect/ai`), `config`/secrets (`Config`+`Redacted`)                                                                                                                                                                        | §6             | #4   |
| 5     | `pr-review` run end-to-end (raw `defineRun`) + its test                                                                                                                                                                                                                                              | §3             | #5   |
| 6     | Trigger + dispatch (`pull_request`) + deploy the dispatcher; wire secrets                                                                                                                                                                                                        | §5 PR1         | #6   |
| 7     | **Dogfood** — AI review on a real PR of this repo (acceptance gate)                                                                                                                                                                                                                                  | —              | #7   |
| 8     | Broaden to parity — remaining runs/recipes, `commandRun`/`fanoutRun` (PR2), `reportPrRun`/`runToCompletion` (PR3), `@effect/sql-d1` + `capture`/image-build/`AccessSession` (PR4), full `@effect/ai` adapters (PR5), `SandboxPool` + auth boundary + `HealBudget` (§8); then deprecate the reference | §5 PR2–5, §8   | #8   |

## Guardrails

- **Effect-first:** built-ins over hand-rolled control flow; adopt `@effect/ai` and `@effect/sql-d1` (proven on our CF Workers) over bespoke stacks (REWRITE.md §6).
- **Each builder/run ships a test.** The dogfooding gate is the integration proof; unit fakes are the fast loop.
- **Every merge to `alpha` keeps the tree building** (typecheck + lint + test green) — parity is worthless if the slice regresses.
