import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {type ComponentRef, fileKey} from './components.js'

export type ModifiedInfo = Readonly<{lastModifiedBy?: string; lastModifiedDate?: string}>

/** One version of the metadata: the developer's base, the story, or a target environment. */
export interface VersionSource {
  keys(): string[]
  readonly label: string
  modifiedInfo(componentId: string): ModifiedInfo | undefined
  read(key: string): string | undefined
}

/** Optional sidecar file with "who changed it last" per component, written for org retrievals and usable in snapshots. */
export const MODIFIED_INFO_FILE = '.driftguard-org.json'

const SKIPPED_FOLDERS = new Set(['.git', '.sf', '.sfdx', '.vscode', 'dist', 'node_modules'])

function walk(directory: string, visit: (file: string) => void): void {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) walk(full, visit)
    } else if (entry.isFile()) {
      visit(full)
    }
  }
}

/** A folder in Salesforce source format: a checkout, a project copy, or a snapshot of an org. */
export class DirSource implements VersionSource {
  private readonly index = new Map<string, string>()
  private readonly info: Record<string, ModifiedInfo> = {}

  constructor(readonly root: string, readonly label: string) {
    if (!fs.existsSync(root)) throw new Error(`${label}: folder not found: ${root}`)
    walk(root, (file) => {
      const key = fileKey(path.relative(root, file))
      if (key && !this.index.has(key)) this.index.set(key, file)
    })
    const infoFile = path.join(root, MODIFIED_INFO_FILE)
    if (fs.existsSync(infoFile)) this.info = JSON.parse(fs.readFileSync(infoFile, 'utf8'))
  }

  keys(): string[] {
    return [...this.index.keys()]
  }

  modifiedInfo(componentId: string): ModifiedInfo | undefined {
    return this.info[componentId]
  }

  read(key: string): string | undefined {
    const file = this.index.get(key)
    return file === undefined ? undefined : fs.readFileSync(file, 'utf8')
  }
}

export function git(repo: string, args: string[]): string {
  const result = spawnSync('git', args, {cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024})
  if (result.error) throw new Error(`Could not run git (${result.error.message}). Install Git or use --base-dir/--story-dir.`)
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

/** A Git ref, for example the user story branch `feature/US-0001234` or its merge base. */
export class GitSource implements VersionSource {
  private readonly index = new Map<string, string>()

  constructor(readonly repo: string, readonly ref: string, readonly label: string) {
    for (const file of git(repo, ['ls-tree', '-r', '--name-only', ref]).split('\n')) {
      const key = fileKey(file)
      if (key && !this.index.has(key)) this.index.set(key, file)
    }
  }

  keys(): string[] {
    return [...this.index.keys()]
  }

  modifiedInfo(): ModifiedInfo | undefined {
    return undefined
  }

  read(key: string): string | undefined {
    const file = this.index.get(key)
    return file === undefined ? undefined : git(this.repo, ['show', `${this.ref}:${file}`])
  }
}

export type GitChanges = Readonly<{changed: string[]; deleted: string[]; mergeBase: string}>

/** Metadata keys changed on `branch` since it forked from `base` (what the user story will deploy). */
export function gitChanges(repo: string, base: string, branch: string): GitChanges {
  const mergeBase = git(repo, ['merge-base', base, branch]).trim()
  const changed: string[] = []
  const deleted: string[] = []
  for (const line of git(repo, ['diff', '--name-status', '--no-renames', mergeBase, branch]).split('\n')) {
    const [status, file] = line.split('\t')
    const key = file ? fileKey(file) : undefined
    if (key) (status === 'D' ? deleted : changed).push(key)
  }

  return {changed, deleted, mergeBase}
}

export function gitBranches(repo: string, pattern: string): string[] {
  const regex = new RegExp(`^(?:[^/]+/)?${pattern.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`)
  const refs = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
  return [...new Set(refs.split('\n').map((ref) => ref.trim()).filter((ref) => ref && regex.test(ref)))]
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function quoteForShell(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`
}

/**
 * Retrieves the given components from a Salesforce org with the Salesforce CLI into a temporary project, and returns it
 * as a source together with who last modified each component in that org.
 */
export function retrieveFromOrg(alias: string, components: ComponentRef[], apiVersion: string): DirSource & {folder: string} {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'driftguard-'))
  fs.mkdirSync(path.join(folder, 'force-app'))
  fs.writeFileSync(
    path.join(folder, 'sfdx-project.json'),
    JSON.stringify({packageDirectories: [{default: true, path: 'force-app'}], sourceApiVersion: apiVersion}),
  )

  const byType = new Map<string, Set<string>>()
  for (const component of components) {
    if (!byType.has(component.type)) byType.set(component.type, new Set())
    byType.get(component.type)!.add(component.name)
  }

  const types = [...byType]
    .map(([type, names]) => `  <types>\n${[...names].map((name) => `    <members>${escapeXml(name)}</members>\n`).join('')}    <name>${type}</name>\n  </types>\n`)
    .join('')
  fs.writeFileSync(
    path.join(folder, 'package.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types}  <version>${apiVersion}</version>\n</Package>\n`,
  )

  const args = ['project', 'retrieve', 'start', '--manifest', 'package.xml', '--target-org', alias, '--json']
  const options = {cwd: folder, encoding: 'utf8' as const, maxBuffer: 512 * 1024 * 1024}
  // On Windows `sf` is a .cmd shim, which only runs through a shell, so pass one fully quoted command line.
  const result =
    process.platform === 'win32'
      ? spawnSync(['sf', ...args].map((arg) => quoteForShell(arg)).join(' '), {...options, shell: true})
      : spawnSync('sf', args, options)
  if (result.error) throw new Error(`Could not run the Salesforce CLI (${result.error.message}). Install sf or use --target-dir.`)

  let output: {message?: string; result?: {fileProperties?: Array<Record<string, string>>}; status?: number}
  try {
    output = JSON.parse(result.stdout)
  } catch {
    throw new Error(`sf project retrieve failed for ${alias}: ${(result.stderr || result.stdout).trim()}`)
  }

  if (output.status !== 0 || !output.result) throw new Error(`sf project retrieve failed for ${alias}: ${output.message ?? 'unknown error'}`)

  const info: Record<string, ModifiedInfo> = {}
  for (const property of output.result.fileProperties ?? []) {
    if (property.type && property.fullName && property.type !== 'Package') {
      info[`${property.type}:${property.fullName}`] = {lastModifiedBy: property.lastModifiedByName, lastModifiedDate: property.lastModifiedDate}
    }
  }

  fs.writeFileSync(path.join(folder, 'force-app', MODIFIED_INFO_FILE), JSON.stringify(info, null, 2))
  return Object.assign(new DirSource(path.join(folder, 'force-app'), `org ${alias}`), {folder})
}
