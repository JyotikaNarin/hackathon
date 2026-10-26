# Demo video script (about 4 minutes)

Before recording: `npm install`, `npm run build`, `agentia plugins link .`, and use a large terminal font.

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | Title slide | "Validation tells you your metadata is valid. It doesn't tell you it's the right version. DriftGuard does." |
| 0:20 | `demo/uat-org/.../AccountService.cls`, the HOTFIX line | "Last Tuesday Priya hot-fixed AccountService in UAT. Then an admin gave Sales Ops access to the Sales Assistant agent, directly in Setup." |
| 0:45 | `demo/stories/US-0001234/...` | "My story US-0001234 adds a Diamond tier, but my branch was created before both changes." |
| 1:00 | `agentia guard preflight --help` | "DriftGuard is an Agentia plugin: `agentia guard preflight`." |
| 1:10 | `npm run demo` | Walk through the table: the hotfix overwrite (who, when, the lost lines), the 3 permissions that would be removed (agent, app, field), the collision with US-0001240, the untested LeadScoringService change, the removed Platinum value. "Exit code 2: this blocks submit." |
| 2:10 | `demo/preflight-report.md` in a Markdown preview | "The same evidence as a report for the story or the PR, plus a prompt for the Copado AI release agent. With `--ai-brief`, the plugin asks the release agent through the host API." |
| 2:35 | `skills/driftguard-preflight/SKILL.md` | "The Agent Skill makes any AI coding agent run this before `agentia cicd work submit` and refuse to promote on BLOCK." |
| 2:55 | `npm run demo:fixed` | "I re-sync from UAT, re-apply my change and keep Platinum. PASS, and it tells me exactly which tests to run." |
| 3:15 | `--json`, `hooks/pre-push`, `--target-org uat` | "It works against real orgs through the Salesforce CLI, as JSON for pipelines, and as a Git hook." |
| 3:35 | Closing slide | "60 seconds before submit instead of a regression after release." |

# Slide outline (8 slides)

1. **DriftGuard**: pre-promotion overwrite and regression radar for Copado user stories.
2. **The problem**: "valid but wrong version." Silent overwrites, permission loss from whole-file deploys, parallel stories. Found by users after release.
3. **The idea**: a three-way compare (base, story, target), per component, before submit.
4. **Checks**: the stale-base, destructive-diff, picklist, collision, test-impact and health-check table with severities.
5. **Built on Agentia extensibility**: plugin SDK host APIs (work, workspace, ai.ask, healthCheck, format), Agent Skill, `--json`, exit-code gate, Git hook.
6. **Demo**: screenshot of BLOCK and then PASS.
7. **Impact**: no lost hotfixes, no silent access loss, earlier conflict detection, only the relevant tests run, evidence-based release approvals.
8. **Roadmap**: Copado-native collisions from in-flight stories, Flow and layout diffs, Slack/Teams alerts, pipeline gate step.
