import assert from 'node:assert/strict'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {collisionCheck, destructiveDiffCheck, staleBaseCheck, testImpact} from '../dist/lib/checks.js'
import {componentOf, fileKey} from '../dist/lib/components.js'
import {DirSource} from '../dist/lib/sources.js'

const demo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo')
const base = new DirSource(path.join(demo, 'base'), 'base')
const story = new DirSource(path.join(demo, 'stories', 'US-0001234'), 'US-0001234')
const uat = new DirSource(path.join(demo, 'uat-org'), 'uat-org')
const changed = story.keys().filter((key) => story.read(key) !== base.read(key))

test('maps source paths to metadata components', () => {
  assert.equal(fileKey('force-app/main/default/classes/Foo.cls'), 'classes/Foo.cls')
  assert.equal(fileKey('README.md'), undefined)
  assert.equal(componentOf('classes/Foo.cls-meta.xml').id, 'ApexClass:Foo')
  assert.equal(componentOf('objects/Account/fields/Tier__c.field-meta.xml').id, 'CustomField:Account.Tier__c')
  assert.equal(componentOf('lwc/myCard/myCard.js').id, 'LightningComponentBundle:myCard')
  assert.equal(componentOf('layouts/Account-Account Layout.layout-meta.xml').id, 'Layout:Account-Account Layout')
})

test('blocks a story built on an older version than the target', () => {
  const findings = staleBaseCheck(changed, base, story, uat)
  const stale = findings.find((finding) => finding.component === 'ApexClass:AccountService')
  assert.equal(stale?.severity, 'BLOCK')
  assert.equal(stale?.lastModifiedBy, 'Priya Shah')
  assert.ok(stale?.evidence?.some((line) => line.includes('HOTFIX US-0001198')))
  assert.equal(findings.find((finding) => finding.component === 'ApexClass:LeadScoringService'), undefined)
})

test('lists permissions a whole-file permission set deploy would remove', () => {
  const findings = destructiveDiffCheck(changed, story, uat, false)
  const removal = findings.find((finding) => finding.check === 'destructive-diff')
  assert.equal(removal?.severity, 'BLOCK')
  assert.deepEqual(removal?.evidence, [
    'agentAccesses Sales_Assistant: loses enabled (entry missing from story)',
    'applicationVisibilities Sales_Console: loses visible (entry missing from story)',
    'fieldPermissions Account.Credit_Limit__c: loses readable (entry missing from story)',
  ])
  assert.equal(destructiveDiffCheck(changed, story, uat, true).find((finding) => finding.check === 'destructive-diff')?.severity, 'REVIEW')
  assert.deepEqual(findings.find((finding) => finding.check === 'picklist-removal')?.evidence, ['picklist value removed: Platinum'])
})

test('flags other stories that change the same component', () => {
  const findings = collisionCheck(changed, [{keys: new Set(['classes/LeadScoringService.cls']), story: 'US-0001240'}])
  assert.deepEqual(findings.map((finding) => finding.component), ['ApexClass:LeadScoringService'])
})

test('finds the tests that cover changed Apex', () => {
  const impact = testImpact(changed, story)
  assert.deepEqual(impact.tests, ['AccountServiceTest'])
  assert.deepEqual(impact.findings.map((finding) => finding.component), ['ApexClass:LeadScoringService'])
})

test('passes once the story is re-synced with the target', () => {
  const resynced = new DirSource(path.join(demo, 'resynced', 'US-0001234'), 'US-0001234')
  const keys = resynced.keys().filter((key) => resynced.read(key) !== uat.read(key))
  const blocking = [...staleBaseCheck(keys, uat, resynced, uat), ...destructiveDiffCheck(keys, resynced, uat, false)].filter(
    (finding) => finding.severity !== 'INFO',
  )
  assert.deepEqual(blocking, [])
})
