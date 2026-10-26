# Submission text

## Solution title

DriftGuard: Pre-Promotion Overwrite & Regression Radar for Copado User Stories

## Abstract

DriftGuard adds `agentia guard preflight`, an Agentia Headless plugin with a matching Agent Skill. Before a user story is submitted or promoted, it compares three versions of every changed component: the base the developer started from, the story, and the target environment as it is now. It returns a BLOCK / REVIEW / PASS verdict with evidence.

It blocks when the target changed after the story was branched, so the deploy would erase a colleague's hotfix. The finding names who changed it, when, and the exact lines that would be lost. It also blocks when a whole-file Permission Set or Profile deploy would remove access, listing every object, field, app, class and agent permission that would disappear. It flags removed picklist values, other in-flight stories touching the same components, and changed Apex that no test exercises, and it lists the Apex tests to run.

The plugin reads the story and workspace from the Agentia host API, adds failing Copado health checks, and with `--ai-brief` asks the Copado AI release agent for a plain-English risk brief. Output is a terminal table, `--json`, and a Markdown report. The exit code makes it a quality gate or Git pre-push hook. The Agent Skill teaches AI coding agents to run the pre-flight before `agentia cicd work submit`, refuse to promote on BLOCK, and explain each fix.

## Problem the solution addresses

Validation only proves metadata is valid, not that it is the right version. On busy Salesforce teams, developers change the same components in parallel, hotfixes land directly in shared environments, and admins change permission sets in Setup. A story branch built on last week's copy passes validation and silently overwrites that work on promotion. Permission Set and Profile deploys replace the whole file, so access added in Setup (for example to an Agentforce agent) disappears after an unrelated deploy. Teams find out from users after the release. DriftGuard moves that discovery to a 60-second check before submit, with the evidence and the fix.

## Tools used

Agentia Headless CLI 1.1 and the plugin SDK (`AgentiaCommand`, `host.work`, `host.workspace`, `host.ai.ask` with the release agent, `host.organization.healthCheck`, `host.format.table`), an Agent Skill (SKILL.md), Salesforce CLI (`sf project retrieve`, `sf project deploy validate`), Git, TypeScript, oclif, fast-xml-parser, and node:test.

## Links

- Repository: <public GitHub URL>
- Demo video: <URL>
- Slides: <URL>
