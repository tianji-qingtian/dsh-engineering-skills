/**
 * Bundle / package contract test.
 *
 * Proves the things a consumer of the published package depends on but the
 * behavior tests cannot see: the `dsh plugin add` bundle patch is well-formed
 * and points at this package, the runtime files are inside the npm `files`
 * whitelist, the generated manifest matches the shipped tree, and the module
 * still exports the cordis plugin shape after packaging.
 *
 * Run by `pnpm test` and by CI (`tarball` smoke additionally imports the packed
 * copy). No harness needed.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
const pkg = readJson('package.json')
const manifest = readJson('skills/manifest.json')

// ---------------------------------------------------------------- bundle patch
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'package.json must declare dsh.bundle.patch')
const patchPath = join(ROOT, 'cordis.patch.yml')
assert.ok(existsSync(patchPath), 'cordis.patch.yml missing')
const patch = parse(readFileSync(patchPath, 'utf8'))
assert.ok(Array.isArray(patch), 'cordis.patch.yml must be a YAML array of patch entries')
const insert = patch.find((entry) => entry !== null && typeof entry === 'object' && Array.isArray(entry.insert))
assert.ok(insert, 'cordis.patch.yml must contain an insert list')
const row = insert.insert.find((entry) => entry !== null && typeof entry === 'object' && entry.name === pkg.name)
assert.ok(row, `cordis.patch.yml must insert a row named "${pkg.name}"`)
assert.equal(row.id, 'engineering-skills', 'patch row id is stable (users override config by id)')

// ------------------------------------------------------------- pack whitelist
const requiredFiles = ['lib', 'skills', 'cordis.patch.yml', 'UPSTREAM.json', 'NOTICE', 'LICENSE', 'LICENSE-upstream']
for (const required of requiredFiles) {
  assert.ok(pkg.files.includes(required), `package.json files must include "${required}"`)
}
assert.ok(existsSync(join(ROOT, 'lib/index.js')), 'entry point lib/index.js missing')
assert.ok(existsSync(join(ROOT, 'UPSTREAM.json')), 'UPSTREAM.json missing')

// --------------------------------------------------------- manifest vs. tree
assert.equal(manifest.schemaVersion, 1)
assert.equal(manifest.skills.length, 27)
const categories = new Set(manifest.skills.map((skill) => skill.category))
assert.deepEqual([...categories].sort(), ['engineering', 'productivity'])
for (const skill of manifest.skills) {
  assert.ok(skill.description.length > 0, `${skill.name}: empty description`)
  assert.equal(typeof skill.modelInvocable, 'boolean', `${skill.name}: modelInvocable must be boolean`)
  assert.equal(skill.userInvocable, true, `${skill.name}: every shipped skill is user-invocable`)
  assert.ok(skill.files.includes('SKILL.md'), `${skill.name}: SKILL.md missing from file list`)
  for (const file of skill.files) {
    const path = join(ROOT, 'skills', ...skill.dir.split('/'), ...file.split('/'))
    assert.ok(existsSync(path), `${skill.name}/${file} missing`)
  }
}

// ------------------------------------------------------------ peers / license
assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-skill'], 'dsh-skill peer dependency missing')
assert.ok(pkg.peerDependencies['@deepseek-ai/cordis'], 'cordis peer dependency missing')
assert.ok(readFileSync(join(ROOT, 'LICENSE-upstream'), 'utf8').includes('Matt Pocock'), 'LICENSE-upstream must carry upstream copyright')
assert.ok(readFileSync(join(ROOT, 'NOTICE'), 'utf8').includes('LICENSE-upstream'), 'NOTICE must point at LICENSE-upstream')

// ------------------------------------------------------------ module exports
const plugin = await import('./lib/index.js')
assert.equal(plugin.name, 'engineering-skills')
assert.deepEqual(plugin.inject, ['skills'], 'the skills registry must be a hard injection')
assert.equal(typeof plugin.apply, 'function')
assert.equal(typeof plugin.Config, 'function')
assert.equal(plugin.Config({}).providerName, 'engineering-skills')
assert.deepEqual(plugin.CATEGORIES, ['engineering', 'productivity'])

console.log('ALL OK (bundle/package contract)')
