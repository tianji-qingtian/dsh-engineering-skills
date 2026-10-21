/**
 * Behavioral test for dsh-engineering-skills.
 *
 * Runs the real `apply()` against a fake `skills` service, then validates every
 * candidate with the SAME rules the real registry applies (dsh-skill
 * `validateCandidate`) plus this plugin's own invariants. That is the regression
 * gate: a skill whose frontmatter stops parsing, a name that stops being
 * kebab-case, or a catalog that silently shrinks fails here.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config, apply, readManifest, selectSkills } from './lib/index.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const manifest = JSON.parse(readFileSync(join(ROOT, 'skills/manifest.json'), 'utf8'))

/** Mirrors @deepseek-ai/dsh-skill: SKILL_NAME + validateCandidate. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const BUNDLED_SKILL_RANK = 600

/** Fake context: capture the provider factory `registerProvider` receives. */
function makeCtx() {
  const providers = []
  const ctx = {
    skills: {
      registerProvider(create) {
        providers.push(create({ signal: new AbortController().signal, invalidate() {} }))
        return () => {}
      },
    },
  }
  return { ctx, providers }
}

/** The exact candidate validation dsh-skill runs before caching a catalog. */
function validateCandidate(candidate, providerName) {
  assert.equal(typeof candidate.name, 'string', 'candidate name must be a string')
  assert.ok(SKILL_NAME.test(candidate.name), `invalid skill name "${candidate.name}"`)
  assert.equal(typeof candidate.description, 'string', `${candidate.name}: description must be a string`)
  assert.ok(candidate.description.length > 0, `${candidate.name}: description must not be empty`)
  assert.equal(typeof candidate.invocation, 'object', `${candidate.name}: invocation must be an object`)
  assert.equal(typeof candidate.invocation.modelInvocable, 'boolean', `${candidate.name}: invocation.modelInvocable must be boolean`)
  assert.equal(typeof candidate.invocation.userInvocable, 'boolean', `${candidate.name}: invocation.userInvocable must be boolean`)
  assert.equal(typeof candidate.source, 'string', `${candidate.name}: source must be a string`)
  assert.ok(Number.isFinite(candidate.rank), `${candidate.name}: rank must be finite`)
  assert.equal(candidate.provider, providerName, `${candidate.name}: candidate.provider must equal provider.name`)
}

const results = []
function check(label, fn) {
  try {
    fn()
    results.push(['ok  ', label])
  } catch (error) {
    results.push(['FAIL', `${label}: ${error instanceof Error ? error.message : String(error)}`])
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------- upstream set
check(`vendored set matches upstream plugin.json (${manifest.skills.length} skills)`, () => {
  assert.equal(manifest.skills.length, 27)
  const userInvoked = manifest.skills.filter((skill) => !skill.modelInvocable)
  const modelInvoked = manifest.skills.filter((skill) => skill.modelInvocable)
  assert.equal(userInvoked.length, 16)
  assert.equal(modelInvoked.length, 11)
  assert.equal(new Set(manifest.skills.map((skill) => skill.name)).size, 27, 'names must be unique')
})

check('every manifest skill has its files on disk', () => {
  for (const skill of manifest.skills) {
    for (const file of skill.files) {
      assert.ok(existsSync(join(ROOT, 'skills', ...skill.dir.split('/'), ...file.split('/'))), `${skill.name}/${file} missing`)
    }
    assert.ok(skill.files.includes('SKILL.md'), `${skill.name} has no SKILL.md`)
    assert.ok(['engineering', 'productivity'].includes(skill.category), `${skill.name} has an unknown category`)
  }
})

// ------------------------------------------------------------------ registry
{
  const { ctx, providers } = makeCtx()
  apply(ctx)
  check('registers exactly one provider on the injected skills service', () => {
    assert.equal(providers.length, 1)
  })
  const [provider] = providers
  check('provider is named engineering-skills by default', () => {
    assert.equal(provider.name, 'engineering-skills')
  })

  const candidates = await provider.list()
  check('advertises all 27 skills as registry-valid candidates', () => {
    assert.equal(candidates.length, 27)
    for (const candidate of candidates) validateCandidate(candidate, provider.name)
  })
  check('candidate names are unique and kebab-case', () => {
    const names = candidates.map((candidate) => candidate.name)
    assert.deepEqual(names, [...new Set(names)].sort())
    for (const name of names) assert.ok(SKILL_NAME.test(name), name)
  })
  check('invocation policy carries upstream disable-model-invocation through', () => {
    for (const candidate of candidates) {
      const skill = manifest.skills.find((entry) => entry.name === candidate.name)
      assert.equal(candidate.invocation.modelInvocable, skill.modelInvocable, candidate.name)
      assert.equal(candidate.invocation.userInvocable, true, candidate.name)
    }
    // user-invoked skills must be invisible to the catalog, i.e. modelInvocable false
    const userOnly = candidates.filter((candidate) => !candidate.invocation.modelInvocable).map((candidate) => candidate.name)
    assert.deepEqual(userOnly.sort(), [
      'ask-matt', 'grill-me', 'grill-with-docs', 'handoff', 'implement', 'implement-spec',
      'improve-codebase-architecture', 'retro', 'setup-matt-pocock-skills', 'teach',
      'to-questionnaire', 'to-spec', 'to-tickets', 'triage', 'wait-what', 'wayfinder',
    ])
  })
  check('every candidate is bundled-rank, bundled-source and points at a directory resource', () => {
    for (const candidate of candidates) {
      assert.equal(candidate.rank, BUNDLED_SKILL_RANK, candidate.name)
      assert.equal(candidate.source, 'bundled', candidate.name)
      assert.equal(candidate.resourceBase.kind, 'directory', candidate.name)
      assert.ok(candidate.resourceBase.path.length > 0, candidate.name)
      assert.ok(existsSync(candidate.locator), `${candidate.name}: ${candidate.locator} does not exist`)
    }
  })

  const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]))

  check('loads a model-invoked skill: frontmatter stripped, body intact, guide appended', async () => {
    const content = (await provider.get(byName.get('grilling'))).content
    assert.ok(content.startsWith('Interview the user relentlessly'), content.slice(0, 60))
    assert.ok(!content.includes('description:'), 'frontmatter must not leak into the body')
    assert.ok(content.includes('## DeepSeek Harness notes'))
  })
  check('a user-invoked skill body has its Skill-tool reference rewritten', async () => {
    const content = (await provider.get(byName.get('grill-me'))).content
    assert.equal(content.split('\n')[0], 'Call the `skill` tool with "grilling".')
  })
  check('loaded definitions keep the candidate summary and only add content', async () => {
    const candidate = byName.get('tdd')
    const definition = await provider.get(candidate)
    assert.equal(definition.name, candidate.name)
    assert.equal(definition.description, candidate.description)
    assert.deepEqual(definition.invocation, candidate.invocation)
    assert.equal(definition.provider, provider.name)
    assert.equal(definition.rank, undefined, 'rank is candidate-only')
  })
  check('every skill loads and no body still says "Skill tool"', async () => {
    for (const candidate of candidates) {
      const { content } = await provider.get(candidate)
      assert.ok(content.length > 200, `${candidate.name}: body looks empty`)
      assert.ok(!/\bSkill tool\b/.test(content), `${candidate.name}: unadapted "Skill tool" reference`)
    }
  })
}

// ------------------------------------------------------------------ selection
{
  const { ctx, providers } = makeCtx()
  apply(ctx, { categories: ['productivity'] })
  const names = (await providers[0].list()).map((candidate) => candidate.name)
  check('categories: [productivity] narrows the catalog to that bucket', () => {
    assert.deepEqual(names.sort(), ['grill-me', 'grilling', 'handoff', 'teach', 'to-questionnaire', 'wait-what', 'writing-for-agents'])
  })
}
{
  const { ctx, providers } = makeCtx()
  apply(ctx, { skills: ['tdd', 'grilling'] })
  const names = (await providers[0].list()).map((candidate) => candidate.name)
  check('an explicit skills subset wins over categories', () => {
    assert.deepEqual(names.sort(), ['grilling', 'tdd'])
  })
}
{
  const { ctx, providers } = makeCtx()
  apply(ctx, { categories: ['engineering'], skills: ['tdd'], appendHarnessGuide: false })
  const [candidate] = await providers[0].list()
  const { content } = await providers[0].get(candidate)
  check('appendHarnessGuide: false loads the upstream body verbatim', () => {
    assert.equal(candidate.name, 'tdd')
    assert.ok(!content.includes('## DeepSeek Harness notes'))
  })
}
{
  const { ctx } = makeCtx()
  check('an unknown skill name fails the mount instead of silently shrinking the catalog', () => {
    assert.throws(() => apply(ctx, { skills: ['gril-me'] }), /unknown skill "gril-me"/)
  })
}
{
  const { ctx } = makeCtx()
  check('an unknown category fails the mount', () => {
    assert.throws(() => apply(ctx, { categories: ['misc'] }), /unknown category/)
  })
}

// -------------------------------------------------------------------- schema
check('Config exposes defaults for every field', () => {
  const resolved = Config({})
  assert.equal(resolved.providerName, 'engineering-skills')
  assert.deepEqual(resolved.categories, ['engineering', 'productivity'])
  assert.deepEqual(resolved.skills, [])
  assert.equal(resolved.appendHarnessGuide, true)
})
check('readManifest/selectSkills agree with the default apply() catalog', () => {
  assert.equal(selectSkills(readManifest(), {}).length, 27)
})

for (const [status, label] of results) console.log(status, label)
console.log(process.exitCode ? 'FAILURES' : 'ALL OK')
