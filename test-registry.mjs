/**
 * Integration test against the REAL skill registry (`@deepseek-ai/dsh-skill`)
 * and the REAL cordis plugin lifecycle.
 *
 * `test-host.mjs` proves the provider is internally correct; this file proves:
 *   1. the registry accepts the provider — a real `SkillRegistry` merges the
 *      catalog, resolves skills by name and loads definitions through the same
 *      path the `skill` tool uses;
 *   2. the registration belongs to the plugin's fiber — disposing the plugin
 *      unregisters the provider, and mounting again succeeds.
 *
 * Without (2), disabling or hot-reloading the profile row would keep serving the
 * old catalog and the re-mount would fail on the duplicate provider name.
 * Dev-only: `@deepseek-ai/cordis` / `@deepseek-ai/dsh-skill` are devDependencies;
 * the harness supplies the live instances at runtime.
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { apply } from './lib/index.js'

const cwd = process.cwd()
const tick = () => new Promise((resolve) => setTimeout(resolve, 100))

const root = new Context()
const registry = new SkillRegistry(root, {})
const mount = () => root.plugin(function (ctx) {
  apply(ctx)
})

let fiber = mount()
await tick()

const list = await registry.list({ cwd })
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
assert.equal(summary.resourceBase.kind, 'directory')
assert.equal(summary.resourceBase.path.endsWith('grilling'), true)

const definition = await registry.get('grilling', { cwd })
assert.ok(definition, 'grilling must load by name')
assert.ok(definition.content.startsWith('Interview the user relentlessly'))
assert.ok(definition.content.includes('## DeepSeek Harness notes'))
assert.equal(definition.invocation.modelInvocable, true)

const userOnlyDefinition = await registry.get('grill-me', { cwd })
assert.ok(userOnlyDefinition, 'user-invoked skill must still load by name for the /name path')
assert.equal(userOnlyDefinition.invocation.userInvocable, true)
assert.equal(userOnlyDefinition.invocation.modelInvocable, false)

// ---------------------------------------------------------------- lifecycle
await fiber.dispose()
await tick()
const afterDispose = await registry.list({ cwd })
console.log('after plugin dispose:', afterDispose.length)
assert.equal(afterDispose.length, 0, 'disposing the plugin fiber must unregister the provider')

fiber = mount()
await tick()
const afterRemount = await registry.list({ cwd })
console.log('after re-mount:', afterRemount.length)
assert.equal(afterRemount.length, 27, 're-mounting a disposed plugin must succeed')
await fiber.dispose()

console.log('ALL OK (real registry + lifecycle)')
