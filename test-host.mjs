/**
 * Behavioral test for dsh-engineering-skills.
 *
 * Runs the real `apply()` against a fake `skills` service, then validates every
 * candidate with the SAME rules the real registry applies (dsh-skill
 * `validateCandidate`) plus this plugin's own invariants. That is the regression
 * gate: a skill whose frontmatter stops parsing, a name that stops being
 * kebab-case, a config filter that silently drops skills, or a provider that
 * isn't tied to the plugin fiber all fail here.
 *
 * Every check is awaited — an async assertion that is not awaited would record
 * `ok` and only surface as an unhandled rejection after `ALL OK`.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATEGORIES, Config, apply, readManifest, selectSkills } from './lib/index.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const manifest = JSON.parse(readFileSync(join(ROOT, 'skills/manifest.json'), 'utf8'))

/** Mirrors @deepseek-ai/dsh-skill: SKILL_NAME + validateCandidate. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const BUNDLED_SKILL_RANK = 600

/**
 * Fake context: captures the provider factory and runs `ctx.effect` the way
 * cordis does for a generator effect (collect the yielded disposers).
 */
function makeCtx() {
  const providers = []
  const effects = []
  const ctx = {
    effect(execute) {
      const iterator = execute()
      const disposers = []
      let step = iterator.next()
      while (!step.done) {
        if (typeof step.value === 'function') disposers.push(step.value)
        step = iterator.next()
      }
      effects.push(() => { for (const dispose of disposers.splice(0).reverse()) dispose() })
      return effects[effects.length - 1]
    },
    skills: {
      registerProvider(create) {
        const provider = create({ signal: new AbortController().signal, invalidate() {} })
        providers.push(provider)
        return () => {
          const index = providers.indexOf(provider)
          if (index >= 0) providers.splice(index, 1)
        }
      },
    },
  }
  return { ctx, providers, effects }
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
async function check(label, fn) {
  try {
    await fn()
    results.push(['ok  ', label])
  } catch (error) {
    results.push(['FAIL', `${label}: ${error instanceof Error ? error.message : String(error)}`])
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------- upstream set
await check(`vendored set matches upstream plugin.json (${manifest.skills.length} skills)`, () => {
  assert.equal(manifest.skills.length, 27)
  const userInvoked = manifest.skills.filter((skill) => !skill.modelInvocable)
  const modelInvoked = manifest.skills.filter((skill) => skill.modelInvocable)
  assert.equal(userInvoked.length, 16)
  assert.equal(modelInvoked.length, 11)
  assert.equal(new Set(manifest.skills.map((skill) => skill.name)).size, 27, 'names must be unique')
  assert.equal(manifest.skills.reduce((total, skill) => total + skill.files.length, 0), 52)
})

await check('every manifest skill has its files on disk', () => {
  for (const skill of manifest.skills) {
    for (const file of skill.files) {
      assert.ok(existsSync(join(ROOT, 'skills', ...skill.dir.split('/'), ...file.split('/'))), `${skill.name}/${file} missing`)
    }
    assert.ok(skill.files.includes('SKILL.md'), `${skill.name} has no SKILL.md`)
    assert.ok(CATEGORIES.includes(skill.category), `${skill.name} has an unknown category`)
  }
})

// ------------------------------------------------------------------ registry
{
  const { ctx, providers, effects } = makeCtx()
  apply(ctx)

  await check('registers exactly one provider on the injected skills service', () => {
    assert.equal(providers.length, 1)
  })
  await check('registration is tied to the plugin fiber (ctx.effect, not a bare register)', () => {
    assert.equal(effects.length, 1, 'apply() must register through ctx.effect')
    effects[0]()
    assert.equal(providers.length, 0, 'fiber teardown must remove the provider')
  })
}
{
  const { ctx, providers } = makeCtx()
  apply(ctx)
  const [provider] = providers

  await check('provider is named engineering-skills by default', () => {
    assert.equal(provider.name, 'engineering-skills')
  })

  const candidates = await provider.list()
  await check('advertises all 27 skills as registry-valid candidates', () => {
    assert.equal(candidates.length, 27)
    for (const candidate of candidates) validateCandidate(candidate, provider.name)
  })
  await check('candidate names are unique and kebab-case', () => {
    const names = candidates.map((candidate) => candidate.name)
    assert.deepEqual(names, [...new Set(names)].sort())
    for (const name of names) assert.ok(SKILL_NAME.test(name), name)
  })
  await check('invocation policy carries upstream disable-model-invocation through', () => {
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
  await check('every candidate is bundled-rank, bundled-source, directory-backed and locatable', () => {
    for (const candidate of candidates) {
      assert.equal(candidate.rank, BUNDLED_SKILL_RANK, candidate.name)
      assert.equal(candidate.source, 'bundled', candidate.name)
      assert.equal(candidate.resourceBase.kind, 'directory', candidate.name)
      assert.ok(candidate.resourceBase.path.length > 0, candidate.name)
      assert.ok(existsSync(candidate.locator), `${candidate.name}: ${candidate.locator} does not exist`)
      assert.equal(candidate.path, undefined, `${candidate.name}: bundled providers must not set path`)
    }
  })

  const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]))

  await check('loads a model-invoked skill: frontmatter stripped, body intact, guide appended', async () => {
    const content = (await provider.get(byName.get('grilling'))).content
    assert.ok(content.startsWith('Interview the user relentlessly'), content.slice(0, 60))
    assert.ok(!content.includes('description:'), 'frontmatter must not leak into the body')
    assert.ok(content.includes('## DeepSeek Harness notes'))
  })
  await check('a user-invoked skill body has its Skill-tool reference rewritten', async () => {
    const content = (await provider.get(byName.get('grill-me'))).content
    assert.equal(content.split('\n')[0], 'Call the `skill` tool with "grilling".')
  })
  await check('loaded definitions keep the candidate summary and only add content', async () => {
    const candidate = byName.get('tdd')
    const definition = await provider.get(candidate)
    assert.equal(definition.name, candidate.name)
    assert.equal(definition.description, candidate.description)
    assert.deepEqual(definition.invocation, candidate.invocation)
    assert.equal(definition.provider, provider.name)
    assert.equal(definition.rank, undefined, 'rank is candidate-only')
    assert.ok(definition.content.length > 200)
  })
  await check('every skill loads and no body still says "Skill tool"', async () => {
    for (const candidate of candidates) {
      const { content } = await provider.get(candidate)
      assert.ok(content.length > 200, `${candidate.name}: body looks empty`)
      assert.ok(!/\bSkill tool\b/.test(content), `${candidate.name}: unadapted "Skill tool" reference`)
    }
  })
}

// ------------------------------------------------------------------ selection
await check('categories: [productivity] narrows the catalog to that bucket', async () => {
  const { ctx, providers } = makeCtx()
  apply(ctx, { categories: ['productivity'] })
  const names = (await providers[0].list()).map((candidate) => candidate.name)
  assert.deepEqual(names.sort(), ['grill-me', 'grilling', 'handoff', 'teach', 'to-questionnaire', 'wait-what', 'writing-for-agents'])
})
await check('an explicit skills subset selects exactly those skills', async () => {
  const { ctx, providers } = makeCtx()
  apply(ctx, { skills: ['tdd', 'grilling'] })
  const names = (await providers[0].list()).map((candidate) => candidate.name)
  assert.deepEqual(names.sort(), ['grilling', 'tdd'])
})
await check('a non-empty skills subset overrides categories (README example)', async () => {
  const { ctx, providers } = makeCtx()
  apply(ctx, { categories: ['productivity'], skills: ['tdd'] })
  const names = (await providers[0].list()).map((candidate) => candidate.name)
  assert.deepEqual(names, ['tdd'])
})
await check('skills keep working across categories when both buckets are listed', async () => {
  const { ctx, providers } = makeCtx()
  apply(ctx, { categories: ['productivity', 'engineering'], skills: ['tdd', 'grilling'] })
  const names = (await providers[0].list()).map((candidate) => candidate.name).sort()
  assert.deepEqual(names, ['grilling', 'tdd'])
})
await check('appendHarnessGuide: false loads the vendored body without the guide', async () => {
  const { ctx, providers } = makeCtx()
  apply(ctx, { categories: ['engineering'], skills: ['tdd'], appendHarnessGuide: false })
  const [candidate] = await providers[0].list()
  const { content } = await providers[0].get(candidate)
  assert.equal(candidate.name, 'tdd')
  assert.ok(!content.includes('## DeepSeek Harness notes'))
})
await check('an unknown skill name fails the mount instead of silently shrinking the catalog', () => {
  const { ctx } = makeCtx()
  assert.throws(() => apply(ctx, { skills: ['gril-me'] }), /unknown skill "gril-me"/)
})
await check('an unknown category fails the mount when no skill list overrides it', () => {
  const { ctx } = makeCtx()
  assert.throws(() => apply(ctx, { categories: ['misc'] }), /unknown category/)
})

// -------------------------------------------------------------------- schema
await check('Config exposes defaults for every field', () => {
  const resolved = Config({})
  assert.equal(resolved.providerName, 'engineering-skills')
  assert.deepEqual(resolved.categories, ['engineering', 'productivity'])
  assert.deepEqual(resolved.skills, [])
  assert.equal(resolved.appendHarnessGuide, true)
})
await check('Config accepts a category subset and rejects an unknown category', () => {
  assert.deepEqual(Config({ categories: ['productivity'] }).categories, ['productivity'])
  assert.throws(() => Config({ categories: ['misc'] }), /expected "engineering" \| "productivity"/)
})
await check('readManifest/selectSkills agree with the default apply() catalog', () => {
  assert.equal(selectSkills(readManifest(), {}).length, 27)
})

for (const [status, label] of results) console.log(status, label)
console.log(process.exitCode ? 'FAILURES' : 'ALL OK')
