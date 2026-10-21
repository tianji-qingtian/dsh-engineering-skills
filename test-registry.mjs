/**
 * Integration test against the REAL skill registry (`@deepseek-ai/dsh-skill`).
 *
 * `test-host.mjs` proves the provider is internally correct; this file proves the
 * registry accepts it: a real `SkillRegistry` merges the provider catalog, resolves
 * `grilling` by name and returns the loaded definition through the same path the
 * `skill` tool uses. Dev-only — `@deepseek-ai/dsh-skill` is a devDependency here,
 * and the harness supplies the live instance at runtime.
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { apply } from './lib/index.js'

const root = new Context()
const registry = new SkillRegistry(root, {})
apply({ skills: registry })

const list = await registry.list({ cwd: process.cwd() })
console.log('catalog size:', list.length)
assert.equal(list.length, 27)

const modelInvocable = list.filter((summary) => summary.invocation.modelInvocable)
const userOnly = list.filter((summary) => !summary.invocation.modelInvocable)
console.log('model-invocable:', modelInvocable.length, '| user-invocable only:', userOnly.length)
assert.equal(modelInvocable.length, 11)
assert.equal(userOnly.length, 16)

const summary = list.find((entry) => entry.name === 'grilling')
assert.ok(summary, 'grilling must be listed')
assert.equal(summary.provider, 'engineering-skills')
assert.equal(summary.source, 'bundled')
assert.equal(summary.description.startsWith('Grill the user relentlessly'), true)
assert.equal(summary.path.endsWith('grilling/SKILL.md'), true)

const definition = await registry.get('grilling', { cwd: process.cwd() })
assert.ok(definition, 'grilling must load by name')
assert.ok(definition.content.startsWith('Interview the user relentlessly'))
assert.ok(definition.content.includes('## DeepSeek Harness notes'))
assert.equal(definition.invocation.modelInvocable, true)

const userOnlyDefinition = await registry.get('grill-me', { cwd: process.cwd() })
assert.ok(userOnlyDefinition, 'user-invoked skill must still load by name for the /name path')
assert.equal(userOnlyDefinition.invocation.userInvocable, true)
assert.equal(userOnlyDefinition.invocation.modelInvocable, false)

console.log('ALL OK (real registry)')
