---
name: driftguard-preflight
description: Run before submitting, promoting or deploying a Copado user story, or when the user asks "is this safe to promote?". Checks the story for silent overwrites of newer changes in the target environment, Permission Set/Profile deploys that would remove access, picklist values that would disappear, other in-flight stories touching the same components, and the Apex tests to run. Use it with the Agentia CLI (`agentia guard preflight`).
---

# DriftGuard pre-flight for Copado user stories

Validation only proves metadata is valid. It does not prove it is the right version. Run this check before every `agentia cicd work submit` or promotion.

## 1. Run the pre-flight

Always use `--json` so you can read the result.

Inside a Copado project with an active story (Git mode):

```sh
agentia guard preflight --story <US-number> --repo . --target-org <target-alias> --json --report preflight.md
```

- `--target-org` is a Salesforce CLI alias of the next environment in the pipeline (for example `uat`). If the user doesn't know it, run `sf org list` and ask.
- The story branch defaults to `feature/<US-number>` and the base branch to the story's base branch in Copado. Override with `--branch` / `--base`.
- If a Copado AI key is configured, add `--ai-brief`.

Without Git (folders):

```sh
agentia guard preflight --story <US-number> --base-dir <what the developer started from> --story-dir <story version> --target-dir <target snapshot> --json
```

The exit code is 0 for PASS, 2 for BLOCK, and 1 for REVIEW only with `--fail-on review`.

## 2. Act on the verdict

Read `result.verdict` and `result.findings` (each has `severity`, `check`, `component`, `title`, `evidence`, `fix`).

| Verdict | What to do |
| --- | --- |
| `BLOCK` | Do **not** run `agentia cicd work submit` or any promotion. Explain each BLOCK finding in one or two plain sentences, quote the evidence, and propose the `fix`. |
| `REVIEW` | Summarize the findings and ask the user to confirm before submitting. |
| `PASS` | Tell the user it is safe, run the impacted tests, then submit if they ask. |

By check:

- `stale-base`: the target changed after the story branch was created. `lastModifiedBy` and `lastModifiedDate` say who changed it. Offer to retrieve the current version (`sf project retrieve start --metadata <Type:Name> --target-org <target>`), re-apply the story's change on top of it, and commit. Never resolve this by deploying anyway.
- `destructive-diff`: deploying the Permission Set/Profile file would remove the listed access from users. Re-apply the story's change to the target's copy. Use `--allow-removals` only when the user confirms that the removal is intended.
- `picklist-removal`: ask whether records still use the removed values.
- `collision`: name the other stories and suggest agreeing a promotion order with their owners.
- `test-impact`: offer to write or extend a test for the listed class.
- `health-check`: a failing Copado governance check; show its `fix`.

## 3. Run the impacted tests

Use `result.impactedTests`:

```sh
sf project deploy validate --test-level RunSpecifiedTests --tests <Test1> --tests <Test2> --target-org <target-alias> --source-dir force-app
```

If the project uses Copado Robotic Testing, also run the regression job for the story:

```sh
agentia testing build run <job-id> --project <project-id> --branch <story-branch> --wait-for-result --json
```

## 4. Risk brief for the release manager

If the pre-flight didn't produce `result.aiBrief`, ask the Copado AI release agent with the prepared prompt:

```sh
agentia ai agent ask --agent release --user-story <US-number> -p "<result.aiPrompt>" --json
```

Share the brief together with `preflight.md`. A person makes the promotion decision.

## Rules

- Never submit, promote or deploy a story whose latest pre-flight is `BLOCK`.
- Re-run the pre-flight after every fix. The verdict is only valid for the commit it ran on.
- Don't edit files in the target org to make the check pass.
