# DriftGuard: pre-promotion overwrite and regression radar for Copado user stories

`agentia guard preflight` is an Agentia™ Headless CLI plugin and Agent Skill. It answers one question before a user story is submitted or promoted: **is this the right version to ship?**

```text
$ agentia guard preflight --story US-0001234 --repo . --target-org uat

Severity  Check             Component                     Finding
BLOCK     stale-base        ApexClass:AccountService      Will overwrite a newer change in uat by Priya Shah on 2026-10-20 14:32 UTC
BLOCK     stale-base        PermissionSet:Sales_Ops       Will overwrite a newer change in uat by Sam Rivera on 2026-10-21 09:05 UTC
BLOCK     destructive-diff  PermissionSet:Sales_Ops       Deploy would remove 3 permission(s) that exist in uat
REVIEW    collision         ApexClass:LeadScoringService  Also changed by 1 other in-flight story
REVIEW    test-impact       ApexClass:LeadScoringService  No test covers this change
REVIEW    picklist-removal  CustomField:Account.Tier__c   Removes 1 picklist value(s) that exist in uat

BLOCK: do not submit or promote this story until the blocking findings are fixed.
```

## The problem

The most damaging Salesforce deployment bugs are not compile errors. They are **silent overwrites**:

- Several developers change the same Apex classes, flows and permission sets, and hotfixes land directly in shared environments. A story branch created last week carries last week's copy, and promoting it quietly erases the hotfix.
- Permission Sets and Profiles deploy as whole files. Access that an admin added in Setup (an Agentforce agent, an app, a field) vanishes after an unrelated deploy.
- Validation passes in every one of these cases, because the metadata is valid. It is just the wrong version.

Teams find out from users after the release.

## What DriftGuard checks

For every component the story changes, DriftGuard compares three versions: the **base** the developer started from, the **story**, and the **target** environment as it is now.

| Check | Severity | What it catches |
| --- | --- | --- |
| `stale-base` | BLOCK | The target changed after the story was branched. Shows who changed it, when, and the exact lines that would be lost. |
| `name-clash` | BLOCK | The story adds a component that already exists in the target with different content. |
| `destructive-diff` | BLOCK (REVIEW with `--allow-removals`) | Permissions a Permission Set, Muting Permission Set or Profile deploy would remove: object, field, Apex class, page, app, tab, record type, custom permission, flow and agent access. |
| `picklist-removal` | REVIEW | Picklist values that exist in the target but not in the story. |
| `collision` | REVIEW | Other in-flight stories (`feature/*` branches) that change the same components. |
| `test-impact` | REVIEW | Changed Apex with no test class referencing it. The Apex tests that do cover the change are listed so you can run only those. |
| `health-check` | REVIEW | Failing Copado governance checks (`host.organization.healthCheck`). |

The verdict is `BLOCK`, `REVIEW` or `PASS`. The exit code is `2` on BLOCK, so the check works as a local quality gate, a Git hook, or a CI step.

## How it uses Agentia extensibility

| Agentia piece | How DriftGuard uses it |
| --- | --- |
| Plugin SDK `AgentiaCommand` | `--json` envelope, spinners, transaction attribution |
| `host.work.getWorkItem` / `host.workspace.current` | Story title, status, assignee, base branch and Git branch, so `agentia guard preflight` works with no flags inside a story |
| `host.ai.ask` (`--ai-brief`) | Sends the evidence to the Copado AI **release** agent and adds a plain-English risk brief for the release manager |
| `host.organization.healthCheck` | Adds failing governance checks to the verdict |
| `host.format.table` | Same table look as built-in commands |
| Agent Skill ([skills/driftguard-preflight/SKILL.md](skills/driftguard-preflight/SKILL.md)) | Teaches any AI coding agent that reads Agent Skills to run the pre-flight before `agentia cicd work submit`, refuse to promote on BLOCK, explain findings, then run the impacted tests (`sf` and `agentia testing build run`) |
| Git hook ([hooks/pre-push](hooks/pre-push)) | Blocks pushing a story branch that would overwrite newer work |

Methods newer than the minimum CLI (`ai.ask`, `workspace.current`, `organization.healthCheck`) are used only when the running CLI provides them. Only `auth.status` and `format.table` are required.

## Install

Requirements: Node.js 22.12+, [Agentia CLI](https://developer.copado.com/#install) 1.1.0 or later, the Salesforce CLI (`sf`) for `--target-org`, and Git for `--repo`.

```sh
git clone <this repo> && cd driftguard
npm install
npm run build
agentia plugins link .
agentia guard preflight --help
```

### Try it in 30 seconds (no org, no Copado account)

The `demo/` folder holds a fictional Acme project: a base, UAT as it is today (with a hotfix and admin changes made in Setup), story US-0001234 built on the old base, another in-flight story US-0001240, and US-0001234 after re-syncing.

```sh
npm run demo          # BLOCK: hotfix overwrite, 3 permissions removed, collision, untested change, picklist removal
npm run demo:fixed    # PASS after re-syncing the story with UAT
npm test              # unit tests for every check
```

The plugin also runs without Agentia (`node bin/driftguard.js guard preflight ...`). The Copado-backed features are skipped in that case.

## Usage

```sh
# Git mode: story branch vs its base, target org through the Salesforce CLI
agentia guard preflight --story US-0001234 --repo . --target-org uat
agentia guard preflight --repo . --branch feature/US-0001234 --base main --target-org uat --report preflight.md

# Folder mode: no Git needed (snapshots, CI artifacts, local project copies)
agentia guard preflight --story US-0001234 --base-dir base --story-dir force-app-copy --target-dir uat-snapshot --other-stories in-flight/

# Automation
agentia guard preflight --story US-0001234 --repo . --target-org uat --json --fail-on review
agentia guard preflight --story US-0001234 --repo . --target-org uat --ai-brief
```

| Flag | Meaning |
| --- | --- |
| `--story` | Copado user story (default: the active work item) |
| `--repo`, `--branch`, `--base` | Git mode. The branch defaults to `feature/<story>`, the base to the story's base branch in Copado or `main` |
| `--base-dir`, `--story-dir` | Folder mode |
| `--target-org` / `--target-dir` | Target environment: an `sf` alias (components are retrieved into a temp folder, with last-modified-by) or a snapshot folder |
| `--other-stories`, `--collision-pattern` | Collision check sources |
| `--allow-removals` | Permission removals become REVIEW (for intended clean-ups) |
| `--fail-on block\|review\|never` | When to exit non-zero |
| `--report <file>` | Markdown report for the story, the PR or release notes |
| `--ai-brief` | Risk brief from the Copado AI release agent |

## Git hook

```sh
cp hooks/pre-push .git/hooks/pre-push
git config driftguard.targetOrg uat
```

## Layout

```text
src/commands/guard/preflight.ts   the command
src/lib/checks.ts                 stale-base, destructive diff, picklist, collision, test impact
src/lib/sources.ts                Git, folder and org (sf retrieve) versions
src/lib/components.ts             source path -> metadata component
src/lib/report.ts                 verdict, Markdown report, AI prompt
src/standalone-host.ts            lets the plugin run outside the Agentia CLI
skills/driftguard-preflight/      Agent Skill
hooks/pre-push                    Git hook
demo/                             fictional Acme fixtures
test/                             unit tests
```

## Limitations and roadmap

- Test impact is a static reference search (fast, no org needed). It doesn't measure code coverage.
- Picklist removal is reported as REVIEW. Whether the Metadata API deletes or deactivates a removed value depends on the field.
- When the plugin host exposes story metadata and promotions, collisions will come from Copado's own in-flight user stories instead of Git branches.
- Next: Flow version and layout diffs, Slack and Teams notifications, and a gate step for Copado pipelines.

## License

MIT
