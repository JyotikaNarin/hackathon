import {AgentiaCommand, type AgentiaPluginHost, getAgentiaHost, type PluginWorkItem, type PluginWorkspace} from '@copado/agentia-plugin-sdk'
import {Flags, ux} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import {bySeverity, collisionCheck, destructiveDiffCheck, type Finding, normalize, type OtherStory, staleBaseCheck, testImpact} from '../../lib/checks.js'
import {uniqueComponents} from '../../lib/components.js'
import {aiPrompt, nextSteps, type PreflightResult, toMarkdown, verdictOf, verdictText} from '../../lib/report.js'
import {DirSource, gitBranches, gitChanges, GitSource, retrieveFromOrg, type VersionSource} from '../../lib/sources.js'
import {STANDALONE_CLI_VERSION} from '../../standalone-host.js'

const COLORS = {BLOCK: 'red', INFO: 'dim', PASS: 'green', REVIEW: 'yellow'} as const

/** Host methods newer than the plugin's minimum CLI are used only when the running CLI provides them. */
function has(host: AgentiaPluginHost, namespace: string, method: string): boolean {
  const api = (host as unknown as Record<string, Record<string, unknown> | undefined>)[namespace]
  return typeof api?.[method] === 'function'
}

export default class GuardPreflight extends AgentiaCommand {
  static override description = `Check a user story for silent overwrites, permission removals and collisions before it is submitted or promoted.

Compares three versions of every component the story changes: the base the developer started from, the story itself, and the target environment as it is now. Blocks when the target has changed since the base (the deploy would overwrite someone's work), or when a whole-file Permission Set/Profile deploy would remove access. Also flags other in-flight stories that touch the same components and lists the Apex tests to run.

Story and base come from Git (--repo) or from folders (--base-dir/--story-dir). The target comes from an org (--target-org, via the Salesforce CLI) or a folder snapshot (--target-dir).`

  static override examples = [
    '<%= config.bin %> <%= command.id %> --story US-0001234 --repo . --target-org uat',
    '<%= config.bin %> <%= command.id %> --repo . --branch feature/US-0001234 --base main --target-org uat --report preflight.md',
    '<%= config.bin %> <%= command.id %> --story US-0001234 --base-dir demo/base --story-dir demo/stories/US-0001234 --target-dir demo/uat-org --other-stories demo/stories',
    '<%= config.bin %> <%= command.id %> --story US-0001234 --repo . --target-org uat --json',
  ]

  static override flags = {
    'ai-brief': Flags.boolean({description: 'Ask the Copado AI release agent for a plain-English risk brief (needs a Copado AI key).'}),
    'allow-removals': Flags.boolean({description: 'Treat permission removals as REVIEW instead of BLOCK (for intended clean-ups).'}),
    'api-version': Flags.string({default: '62.0', description: 'Metadata API version used to retrieve from --target-org.'}),
    base: Flags.string({description: 'Base branch the story was created from. Default: the story\'s base branch in Copado, or main.'}),
    'base-dir': Flags.string({description: 'Folder with the version the developer started from (folder mode).', exclusive: ['repo']}),
    branch: Flags.string({description: 'Story branch. Default: feature/<story>.'}),
    'collision-pattern': Flags.string({default: 'feature/*', description: 'Branches checked for collisions in Git mode.'}),
    'fail-on': Flags.option({default: 'block', description: 'Exit with a non-zero code on this verdict or worse.', options: ['block', 'review', 'never'] as const})(),
    'other-stories': Flags.string({description: 'Folder of other in-flight stories, one sub-folder per story (folder mode collision check).'}),
    repo: Flags.string({description: 'Git repository with the story branch (Git mode).', exclusive: ['base-dir', 'story-dir']}),
    report: Flags.string({description: 'Write a Markdown report to this file (for the user story, PR or release notes).'}),
    story: Flags.string({char: 's', description: 'Copado user story name or Id, for example US-0001234. Default: the active work item.'}),
    'story-dir': Flags.string({dependsOn: ['base-dir'], description: 'Folder with the story version to deploy (folder mode).', exclusive: ['repo']}),
    'target-dir': Flags.string({description: 'Folder snapshot of the target environment.', exclusive: ['target-org']}),
    'target-org': Flags.string({description: 'Salesforce CLI alias of the target environment, for example uat.', exclusive: ['target-dir']}),
  }

  public async run(): Promise<PreflightResult> {
    const {flags} = await this.parse(GuardPreflight)
    if (!flags.repo && !flags['story-dir']) this.error('Pass --repo (Git mode) or --base-dir and --story-dir (folder mode).')
    if (!flags['target-org'] && !flags['target-dir']) this.error('Pass --target-org (an sf alias) or --target-dir (a folder snapshot).')

    // Keep this list in sync with "agentia.requires" in package.json. Everything else is optional and checked with `has`.
    const host = getAgentiaHost({requires: ['auth.status', 'format.table']})
    const auth = host.auth.status()
    const copado = host.cliVersion !== STANDALONE_CLI_VERSION && auth.cicd.configured

    let workItem: PluginWorkItem | undefined
    let workspace: PluginWorkspace | undefined
    if (copado && has(host, 'workspace', 'current')) workspace = await host.workspace.current().catch(() => undefined)
    if (copado && has(host, 'work', 'getWorkItem') && (flags.story || workspace?.workItemId)) {
      workItem = await this.withSpinner('Reading the user story from Copado', () => host.work.getWorkItem(flags.story)).catch((error: Error) => {
        this.warn(`Could not read the user story from Copado: ${error.message}`)
        return undefined
      })
    }

    const storyName = workItem?.name ?? flags.story ?? workspace?.workItemName ?? flags.branch?.split('/').pop() ?? 'local-change'

    let base: VersionSource
    let story: VersionSource
    let changed: string[]
    let others: OtherStory[] = []
    let branch: string | undefined
    let baseBranch: string | undefined
    if (flags.repo) {
      const repo = path.resolve(flags.repo)
      branch = flags.branch ?? (workspace?.workItemName === storyName ? workspace.branch : undefined) ?? `feature/${storyName}`
      baseBranch = flags.base ?? workItem?.baseBranch ?? workspace?.baseBranch ?? 'main'
      const changes = await this.withSpinner(`Diffing ${branch} against ${baseBranch}`, async () => gitChanges(repo, baseBranch!, branch!))
      changed = changes.changed
      base = new GitSource(repo, changes.mergeBase, `base (${baseBranch})`)
      story = new GitSource(repo, branch, storyName)
      others = gitBranches(repo, flags['collision-pattern'])
        .filter((other) => other !== branch && !other.endsWith(`/${branch}`) && other.split('/').pop() !== storyName)
        .map((other) => ({keys: new Set(gitChanges(repo, baseBranch!, other).changed), story: other}))
    } else {
      base = new DirSource(path.resolve(flags['base-dir']!), 'base')
      story = new DirSource(path.resolve(flags['story-dir']!), storyName)
      changed = story.keys().filter((key) => normalize(story.read(key)) !== normalize(base.read(key)))
      if (flags['other-stories']) others = this.otherStoryFolders(path.resolve(flags['other-stories']), path.resolve(flags['story-dir']!), base)
    }

    const components = uniqueComponents(changed)
    const target: VersionSource = flags['target-org']
      ? await this.withSpinner(`Retrieving ${components.length} component(s) from ${flags['target-org']}`, async () =>
          retrieveFromOrg(flags['target-org']!, components, flags['api-version']),
        )
      : new DirSource(path.resolve(flags['target-dir']!), path.basename(flags['target-dir']!))

    const tests = testImpact(changed, story)
    const findings: Finding[] = [
      ...staleBaseCheck(changed, base, story, target),
      ...destructiveDiffCheck(changed, story, target, flags['allow-removals']),
      ...collisionCheck(changed, others),
      ...tests.findings,
      ...(await this.healthFindings(host, copado)),
    ].sort(bySeverity)

    const verdict = verdictOf(findings)
    const partial = {
      changedComponents: components.map((component) => component.id),
      findings,
      impactedTests: tests.tests,
      mode: flags.repo ? ('git' as const) : ('folders' as const),
      story: {
        assignee: workItem?.assigneeName,
        baseBranch,
        branch,
        name: storyName,
        source: workItem ? ('agentia' as const) : ('flag' as const),
        status: workItem?.status,
        title: workItem?.title,
      },
      summary: {
        block: findings.filter((finding) => finding.severity === 'BLOCK').length,
        info: findings.filter((finding) => finding.severity === 'INFO').length,
        review: findings.filter((finding) => finding.severity === 'REVIEW').length,
      },
      target: target.label,
      verdict,
    }
    const result: PreflightResult = {...partial, aiPrompt: aiPrompt(partial), nextSteps: nextSteps(partial, flags['target-org'])}
    if (flags['ai-brief']) result.aiBrief = await this.aiBrief(host, auth.ai.configured, result.aiPrompt)

    if (flags.report) fs.writeFileSync(flags.report, toMarkdown(result), 'utf8')
    this.display(() => this.render(result, host.format.table, flags.report))

    const failOn = flags['fail-on']
    if ((verdict === 'BLOCK' && failOn !== 'never') || (verdict === 'REVIEW' && failOn === 'review')) process.exitCode = verdict === 'BLOCK' ? 2 : 1
    return result
  }

  /** Turns the evidence into a plain-English risk brief from the Copado AI release agent. A person still decides. */
  private async aiBrief(host: AgentiaPluginHost, configured: boolean, prompt: string): Promise<string | undefined> {
    if (!configured || !has(host, 'ai', 'ask')) {
      this.warn('Skipped the AI risk brief: it needs an Agentia CLI with host.ai and a Copado AI key (agentia auth set --ai ...).')
      return undefined
    }

    try {
      const answer = await this.withSpinner('Asking the Copado AI release agent for a risk brief', () => host.ai.ask({agent: 'release', prompt}))
      return answer.content
    } catch (error) {
      this.warn(`Skipped the AI risk brief: ${(error as Error).message}`)
      return undefined
    }
  }

  private async healthFindings(host: AgentiaPluginHost, copado: boolean): Promise<Finding[]> {
    if (!copado || !has(host, 'organization', 'healthCheck')) return []
    try {
      const report = await this.withSpinner('Running the Copado health check', () => host.organization.healthCheck())
      return report.checks
        .filter((check) => check.status === 'fail')
        .map((check) => ({
          check: 'health-check' as const,
          component: `HealthCheck:${check.checkId}`,
          detail: check.impact ?? check.description,
          fix: check.fixGuidance,
          severity: 'REVIEW' as const,
          title: check.name,
        }))
    } catch (error) {
      this.warn(`Skipped the Copado health check: ${(error as Error).message}`)
      return []
    }
  }

  /** Each sub-folder is another in-flight story; what differs from the base is what it will deploy. */
  private otherStoryFolders(root: string, storyDir: string, base: VersionSource): OtherStory[] {
    return fs
      .readdirSync(root, {withFileTypes: true})
      .filter((entry) => entry.isDirectory() && path.join(root, entry.name) !== storyDir)
      .map((entry) => {
        const other = new DirSource(path.join(root, entry.name), entry.name)
        return {keys: new Set(other.keys().filter((key) => normalize(other.read(key)) !== normalize(base.read(key)))), story: entry.name}
      })
  }

  private render(result: PreflightResult, table: AgentiaPluginHost['format']['table'], reportPath?: string): void {
    const {story} = result
    this.log('')
    this.log(ux.colorize('bold', `DriftGuard pre-flight · ${story.name}${story.title ? ` · ${story.title}` : ''}`))
    this.log(
      ux.colorize(
        'dim',
        `${result.mode === 'git' ? `${story.branch} vs ${story.baseBranch}` : 'folder mode'} → ${result.target} · ${result.changedComponents.length} changed component(s)`,
      ),
    )
    this.log('')

    const actionable = result.findings.filter((finding) => finding.severity !== 'INFO')
    if (actionable.length > 0) {
      this.log(
        table(
          [
            {field: 'severity', header: 'Severity'},
            {field: 'check', header: 'Check'},
            {field: 'component', header: 'Component'},
            {field: 'title', header: 'Finding', wrap: true},
          ],
          actionable.map((finding) => ({...finding, severity: ux.colorize(COLORS[finding.severity], finding.severity)})),
        ),
      )
      this.log('')
      for (const finding of actionable) {
        this.log(ux.colorize(COLORS[finding.severity], `${finding.severity} ${finding.component}`))
        if (finding.detail) this.log(`  ${finding.detail}`)
        for (const line of finding.evidence ?? []) this.log(ux.colorize('dim', `    ${line}`))
        if (finding.fix) this.log(`  Fix: ${finding.fix}`)
        this.log('')
      }
    }

    const info = result.findings.filter((finding) => finding.severity === 'INFO')
    if (info.length > 0) this.log(ux.colorize('dim', `Info: ${info.map((finding) => `${finding.component} (${finding.title})`).join('; ')}`))
    this.log(`Impacted Apex tests: ${result.impactedTests.join(', ') || 'none found'}`)
    this.log('')
    this.log(ux.colorize(COLORS[result.verdict], ux.colorize('bold', verdictText(result.verdict))))
    this.log('')
    if (result.aiBrief) this.log(`${ux.colorize('bold', 'AI risk brief (Copado AI release agent):')}\n${result.aiBrief}\n`)
    this.log('Next:')
    for (const step of result.nextSteps) this.log(`  ${step}`)
    if (reportPath) this.log(ux.colorize('dim', `\nReport written to ${reportPath}`))
  }
}
