import {XMLParser} from 'fast-xml-parser'

import {type ComponentRef, componentOf, PERMISSION_CONTAINERS, uniqueComponents} from './components.js'
import type {VersionSource} from './sources.js'

export type Severity = 'BLOCK' | 'INFO' | 'REVIEW'

export type Finding = {
  check: 'already-in-target' | 'collision' | 'destructive-diff' | 'health-check' | 'missing-in-target' | 'name-clash' | 'picklist-removal' | 'stale-base' | 'test-impact'
  component: string
  detail?: string
  evidence?: string[]
  fix?: string
  lastModifiedBy?: string
  lastModifiedDate?: string
  severity: Severity
  title: string
}

const SEVERITY_RANK: Record<Severity, number> = {BLOCK: 2, INFO: 0, REVIEW: 1}

export function bySeverity(a: Finding, b: Finding): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.component.localeCompare(b.component)
}

/** Ignores BOMs, line endings and trailing whitespace, which differ between tools but never change behavior. */
export function normalize(content: string | undefined): string | undefined {
  if (content === undefined) return undefined
  return content
    .replace(/^﻿/, '')
    .replaceAll(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** Lines present in `from` but not anywhere in `to`: what deploying `to` over `from` would erase. */
function linesLost(from: string, to: string, limit = 6): string[] {
  const kept = new Set(to.split('\n').map((line) => line.trim()))
  const lost = [...new Set(from.split('\n').map((line) => line.trim()))].filter((line) => line && !kept.has(line))
  return lost.length > limit ? [...lost.slice(0, limit), `... and ${lost.length - limit} more line(s)`] : lost
}

function groupByComponent(keys: string[]): Map<string, {component: ComponentRef; keys: string[]}> {
  const groups = new Map<string, {component: ComponentRef; keys: string[]}>()
  for (const key of keys) {
    const component = componentOf(key)
    if (!groups.has(component.id)) groups.set(component.id, {component, keys: []})
    groups.get(component.id)!.keys.push(key)
  }

  return groups
}

/**
 * Three-way check per changed component. `base` is what the developer started from, `story` is what will be deployed,
 * `target` is what the environment has now. If the target moved away from the base, deploying the story erases that change.
 */
export function staleBaseCheck(changed: string[], base: VersionSource, story: VersionSource, target: VersionSource): Finding[] {
  const findings: Finding[] = []
  for (const {component, keys} of groupByComponent(changed).values()) {
    let stale = false
    let clash = false
    let missing = 0
    let alreadyThere = 0
    const evidence: string[] = []
    for (const key of keys) {
      const b = normalize(base.read(key))
      const s = normalize(story.read(key))
      const t = normalize(target.read(key))
      if (s === undefined) continue
      if (t === undefined) {
        missing++
      } else if (t === s) {
        alreadyThere++
      } else if (b === undefined) {
        clash = true
        evidence.push(`${key}: ${target.label} already has a different version of this new file`)
      } else if (t !== b) {
        stale = true
        if (PERMISSION_CONTAINERS.has(component.type)) {
          evidence.push(`${key}: ${target.label} changed since your base; see destructive-diff for the exact access that would be removed`)
          continue
        }

        const lost = linesLost(t, s)
        evidence.push(`${key}: ${target.label} changed since your base${lost.length > 0 ? '; these lines would be lost:' : ''}`, ...lost.map((line) => `  - ${line}`))
      }
    }

    const info = target.modifiedInfo(component.id)
    const who = info?.lastModifiedBy ? ` by ${info.lastModifiedBy}${info.lastModifiedDate ? ` on ${formatDate(info.lastModifiedDate)}` : ''}` : ''
    if (stale || clash) {
      findings.push({
        check: stale ? 'stale-base' : 'name-clash',
        component: component.id,
        detail: stale
          ? `${target.label} has a newer version than the one this story was built on (last changed${who || ' by someone else'}). Deploying will overwrite that change.`
          : `This story adds ${component.id}, but ${target.label} already has a different component with that name${who}.`,
        evidence,
        fix: stale
          ? `Pull the current ${component.id} from ${target.label}, re-apply your change on top of it, commit, and run preflight again.`
          : 'Rename the new component, or bring the existing one into the story.',
        lastModifiedBy: info?.lastModifiedBy,
        lastModifiedDate: info?.lastModifiedDate,
        severity: 'BLOCK',
        title: stale ? `Will overwrite a newer change in ${target.label}${who}` : `Name already used in ${target.label}`,
      })
    } else if (missing === keys.length) {
      findings.push({
        check: 'missing-in-target',
        component: component.id,
        severity: 'INFO',
        title: `New in ${target.label}`,
      })
    } else if (alreadyThere === keys.length) {
      findings.push({
        check: 'already-in-target',
        component: component.id,
        severity: 'INFO',
        title: `${target.label} already has this exact version`,
      })
    }
  }

  return findings
}

const parser = new XMLParser({
  ignoreAttributes: true,
  // Every child of the root element is a list (fieldPermissions, classAccesses, ...), even when it appears once.
  isArray: (_name, jpath) => String(jpath).split('.').length === 2,
  parseTagValue: false,
})

type XmlNode = Record<string, unknown>

function rootOf(xml: string): XmlNode {
  const parsed = parser.parse(xml) as XmlNode
  const rootName = Object.keys(parsed).find((key) => key !== '?xml')
  return (rootName ? parsed[rootName] : {}) as XmlNode
}

/** How each permission section is identified and which flags in it grant access. */
const PERMISSION_SECTIONS: Record<string, {grants?: string[]; key: string; visibility?: string}> = {
  agentAccesses: {grants: ['enabled'], key: 'agentName'},
  applicationVisibilities: {grants: ['visible'], key: 'application'},
  classAccesses: {grants: ['enabled'], key: 'apexClass'},
  customMetadataTypeAccesses: {grants: ['enabled'], key: 'name'},
  customPermissions: {grants: ['enabled'], key: 'name'},
  customSettingAccesses: {grants: ['enabled'], key: 'name'},
  externalDataSourceAccesses: {grants: ['enabled'], key: 'externalDataSource'},
  fieldPermissions: {grants: ['readable', 'editable'], key: 'field'},
  flowAccesses: {grants: ['enabled'], key: 'flow'},
  objectPermissions: {
    grants: ['allowRead', 'allowCreate', 'allowEdit', 'allowDelete', 'viewAllRecords', 'modifyAllRecords', 'viewAllFields'],
    key: 'object',
  },
  pageAccesses: {grants: ['enabled'], key: 'apexPage'},
  recordTypeVisibilities: {grants: ['visible'], key: 'recordType'},
  tabSettings: {key: 'tab', visibility: 'visibility'},
  tabVisibilities: {key: 'tab', visibility: 'visibility'},
  userPermissions: {grants: ['enabled'], key: 'name'},
}

const FALLBACK_KEYS = ['name', 'fullName', 'field', 'object', 'apexClass', 'application', 'tab', 'recordType', 'flow', 'agentName']
const NO_ACCESS = new Set(['Hidden', 'None'])

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Access that exists in the target's copy of a permission set/profile but not in the story's copy. */
export function permissionRemovals(targetXml: string, storyXml: string): string[] {
  const target = rootOf(targetXml)
  const story = rootOf(storyXml)
  const removals: string[] = []
  for (const [section, value] of Object.entries(target)) {
    if (!Array.isArray(value) || typeof value[0] !== 'object') continue
    const entries = value as XmlNode[]
    const known = PERMISSION_SECTIONS[section]
    const keyField = known?.key ?? FALLBACK_KEYS.find((field) => text(entries[0][field]) !== undefined)
    if (!keyField) continue
    const storyEntries = new Map<string, XmlNode>()
    for (const entry of (Array.isArray(story[section]) ? story[section] : []) as XmlNode[]) {
      const key = text(entry[keyField])
      if (key !== undefined) storyEntries.set(key, entry)
    }

    for (const entry of entries) {
      const key = text(entry[keyField])
      if (key === undefined) continue
      const mine = storyEntries.get(key)
      if (known?.visibility) {
        const had = text(entry[known.visibility])
        const now = mine ? text(mine[known.visibility]) : undefined
        if (had && !NO_ACCESS.has(had) && (!now || NO_ACCESS.has(now))) removals.push(`${section} ${key}: ${had} -> ${now ?? 'removed'}`)
        continue
      }

      const grants = known?.grants ?? Object.keys(entry).filter((field) => entry[field] === 'true')
      const lost = grants.filter((grant) => entry[grant] === 'true' && mine?.[grant] !== 'true')
      if (lost.length > 0) removals.push(`${section} ${key}: loses ${lost.join(', ')}${mine ? '' : ' (entry missing from story)'}`)
    }
  }

  return removals
}

function picklistValues(fieldXml: string): string[] {
  const valueSet = rootOf(fieldXml).valueSet as XmlNode[] | undefined
  const definition = valueSet?.[0]?.valueSetDefinition as XmlNode | undefined
  const values = definition?.value
  const list = (Array.isArray(values) ? values : values ? [values] : []) as XmlNode[]
  return list.map((value) => text(value.fullName)).filter((name): name is string => name !== undefined)
}

/** Things the deploy would take away in the target even though validation passes: permissions and picklist values. */
export function destructiveDiffCheck(changed: string[], story: VersionSource, target: VersionSource, allowRemovals: boolean): Finding[] {
  const findings: Finding[] = []
  for (const key of changed) {
    const component = componentOf(key)
    const isPermissionFile = PERMISSION_CONTAINERS.has(component.type)
    const isField = component.type === 'CustomField'
    if (!isPermissionFile && !isField) continue
    const storyXml = story.read(key)
    const targetXml = target.read(key)
    if (storyXml === undefined || targetXml === undefined) continue
    const info = target.modifiedInfo(component.id)
    if (isPermissionFile) {
      const removals = permissionRemovals(targetXml, storyXml)
      if (removals.length === 0) continue
      findings.push({
        check: 'destructive-diff',
        component: component.id,
        detail: `${component.type} files are deployed as a whole. Access that exists in ${target.label} but not in this story's file can be removed from every user who has it, even though validation passes.`,
        evidence: removals.length > 15 ? [...removals.slice(0, 15), `... and ${removals.length - 15} more`] : removals,
        fix: `Retrieve ${component.id} from ${target.label}, add your change to that copy, and commit it. If the removals are intended, re-run with --allow-removals.`,
        lastModifiedBy: info?.lastModifiedBy,
        lastModifiedDate: info?.lastModifiedDate,
        severity: allowRemovals ? 'REVIEW' : 'BLOCK',
        title: `Deploy would remove ${removals.length} permission(s) that exist in ${target.label}`,
      })
    } else {
      const kept = new Set(picklistValues(storyXml))
      const removed = picklistValues(targetXml).filter((value) => !kept.has(value))
      if (removed.length === 0) continue
      findings.push({
        check: 'picklist-removal',
        component: component.id,
        detail: `Records in ${target.label} may still use these values. Reports, flows and integrations that filter on them can break.`,
        evidence: removed.map((value) => `picklist value removed: ${value}`),
        fix: 'Confirm the values are unused (or migrate the data) before promoting, or keep them and deactivate them instead.',
        severity: 'REVIEW',
        title: `Removes ${removed.length} picklist value(s) that exist in ${target.label}`,
      })
    }
  }

  return findings
}

export type OtherStory = Readonly<{keys: Set<string>; story: string}>

/** Other in-flight user stories that change the same components, so their promotions will collide with this one. */
export function collisionCheck(changed: string[], others: OtherStory[]): Finding[] {
  const mine = uniqueComponents(changed)
  const findings: Finding[] = []
  for (const component of mine) {
    const overlapping = others.filter((other) => uniqueComponents(other.keys).some((theirs) => theirs.id === component.id)).map((other) => other.story)
    if (overlapping.length === 0) continue
    findings.push({
      check: 'collision',
      component: component.id,
      detail: 'Whichever story is promoted second will either conflict or silently replace the first one.',
      evidence: overlapping.map((story) => `also changed in ${story}`),
      fix: `Agree an order with the owner(s) of ${overlapping.join(', ')}, and rebase the later story on the earlier one.`,
      severity: 'REVIEW',
      title: `Also changed by ${overlapping.length} other in-flight stor${overlapping.length === 1 ? 'y' : 'ies'}`,
    })
  }

  return findings
}

export type TestImpact = Readonly<{findings: Finding[]; tests: string[]}>

/** Finds the Apex test classes that exercise the changed Apex, so only those need to run. */
export function testImpact(changed: string[], story: VersionSource): TestImpact {
  const testClasses = new Map<string, string>()
  for (const key of story.keys()) {
    const match = /^classes\/([^/]+)\.cls$/.exec(key)
    // Reading only likely test classes keeps this fast on large repositories.
    if (!match || !/test/i.test(match[1])) continue
    const source = story.read(key) ?? ''
    if (/@istest/i.test(source)) testClasses.set(match[1], source)
  }

  const tests = new Set<string>()
  const findings: Finding[] = []
  for (const component of uniqueComponents(changed)) {
    if (component.type !== 'ApexClass' && component.type !== 'ApexTrigger') continue
    if (testClasses.has(component.name)) {
      tests.add(component.name)
      continue
    }

    let pattern = new RegExp(`\\b${component.name}\\b`, 'i')
    if (component.type === 'ApexTrigger') {
      const sObject = /trigger\s+\w+\s+on\s+(\w+)/i.exec(story.read(`triggers/${component.name}.trigger`) ?? '')?.[1]
      if (sObject) pattern = new RegExp(`\\bnew\\s+${sObject}\\s*\\(|\\b${component.name}\\b`, 'i')
    }

    const covering = [...testClasses].filter(([, source]) => pattern.test(source)).map(([name]) => name)
    for (const name of covering) tests.add(name)
    if (covering.length === 0) {
      findings.push({
        check: 'test-impact',
        component: component.id,
        detail: 'No test class in the story branch references this Apex, so its behavior change is not verified before promotion.',
        fix: `Add or extend a test class that exercises ${component.name}.`,
        severity: 'REVIEW',
        title: 'No test covers this change',
      })
    }
  }

  return {findings, tests: [...tests].sort()}
}
