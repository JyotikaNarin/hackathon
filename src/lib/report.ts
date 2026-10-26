import type {Finding} from './checks.js'

export type Verdict = 'BLOCK' | 'PASS' | 'REVIEW'

export type PreflightResult = {
  aiBrief?: string
  aiPrompt: string
  changedComponents: string[]
  findings: Finding[]
  impactedTests: string[]
  mode: 'folders' | 'git'
  nextSteps: string[]
  story: {
    assignee?: string
    baseBranch?: string
    branch?: string
    name: string
    source: 'agentia' | 'flag'
    status?: string
    title?: string
  }
  summary: {block: number; info: number; review: number}
  target: string
  verdict: Verdict
}

export function verdictOf(findings: Finding[]): Verdict {
  if (findings.some((finding) => finding.severity === 'BLOCK')) return 'BLOCK'
  return findings.some((finding) => finding.severity === 'REVIEW') ? 'REVIEW' : 'PASS'
}

const VERDICT_TEXT: Record<Verdict, string> = {
  BLOCK: 'BLOCK: do not submit or promote this story until the blocking findings are fixed.',
  PASS: 'PASS: no overwrite, removal or collision risk found.',
  REVIEW: 'REVIEW: safe to deploy technically, but a person should look at the findings first.',
}

export function verdictText(verdict: Verdict): string {
  return VERDICT_TEXT[verdict]
}

export function nextSteps(result: Omit<PreflightResult, 'aiBrief' | 'aiPrompt' | 'nextSteps'>, targetOrg?: string): string[] {
  const steps: string[] = []
  if (result.impactedTests.length > 0) {
    steps.push(
      `sf project deploy validate --test-level RunSpecifiedTests ${result.impactedTests.map((test) => `--tests ${test}`).join(' ')} --target-org ${targetOrg ?? '<target-org>'} --source-dir force-app`,
    )
  }

  steps.push(`agentia ai agent ask --agent release --user-story ${result.story.name} -p "<aiPrompt from the --json output>"`)
  if (result.verdict === 'PASS') steps.push(`agentia cicd work submit`)
  else steps.push(`agentia guard preflight --story ${result.story.name}   # re-run after fixing`)
  return steps
}

/** A prompt that turns the evidence into a short, plain-English risk brief from the Copado AI release agent. */
export function aiPrompt(result: Omit<PreflightResult, 'aiBrief' | 'aiPrompt' | 'nextSteps'>): string {
  const lines = result.findings
    .filter((finding) => finding.severity !== 'INFO')
    .map((finding) => `- [${finding.severity}] ${finding.component}: ${finding.title}. ${(finding.evidence ?? []).slice(0, 4).join('; ')}`)
  return [
    `You are reviewing Copado user story ${result.story.name}${result.story.title ? ` ("${result.story.title}")` : ''} before it is promoted to ${result.target}.`,
    `A pre-flight check returned ${result.verdict} for ${result.changedComponents.length} changed component(s).`,
    lines.length > 0 ? `Findings:\n${lines.join('\n')}` : 'There were no blocking or review findings.',
    `Impacted Apex tests: ${result.impactedTests.join(', ') || 'none found'}.`,
    'Write a risk brief for the release manager in under 150 words: what could break for users, who should be contacted, and the single recommended action (promote, fix first, or coordinate). Do not invent facts beyond the findings.',
  ].join('\n\n')
}

export function toMarkdown(result: PreflightResult): string {
  const icon: Record<string, string> = {BLOCK: '🛑', INFO: 'ℹ️', PASS: '✅', REVIEW: '⚠️'}
  const out = [
    `# DriftGuard pre-flight: ${result.story.name}${result.story.title ? ` (${result.story.title})` : ''}`,
    '',
    `**Verdict: ${icon[result.verdict]} ${verdictText(result.verdict)}**`,
    '',
    `| Target | Changed components | Blocking | Review | Info |`,
    `| --- | --- | --- | --- | --- |`,
    `| ${result.target} | ${result.changedComponents.length} | ${result.summary.block} | ${result.summary.review} | ${result.summary.info} |`,
    '',
    '## Findings',
    '',
  ]
  if (result.aiBrief) out.splice(out.length - 2, 0, '## AI risk brief (Copado AI release agent)', '', result.aiBrief, '')
  if (result.findings.length === 0) out.push('None.', '')
  for (const finding of result.findings) {
    out.push(`### ${icon[finding.severity]} ${finding.severity} · \`${finding.component}\` · ${finding.check}`, '', `**${finding.title}**`, '')
    if (finding.detail) out.push(finding.detail, '')
    if (finding.evidence?.length) out.push('```text', ...finding.evidence, '```', '')
    if (finding.fix) out.push(`**Fix:** ${finding.fix}`, '')
  }

  out.push(
    '## Impacted Apex tests',
    '',
    result.impactedTests.length > 0 ? result.impactedTests.map((test) => `- ${test}`).join('\n') : 'None found.',
    '',
    '## Changed components',
    '',
    ...result.changedComponents.map((component) => `- ${component}`),
    '',
    '## Next steps',
    '',
    '```sh',
    ...result.nextSteps,
    '```',
    '',
    '## Prompt for the Copado AI release agent',
    '',
    '```text',
    result.aiPrompt,
    '```',
    '',
  )
  return out.join('\n')
}
