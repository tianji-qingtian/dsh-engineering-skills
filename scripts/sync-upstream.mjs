#!/usr/bin/env node
/**
 * Vendor Matt Pocock's *published* skills into ./skills and regenerate
 * skills/manifest.json.
 *
 * Source of truth for the shipped set is upstream's own plugin manifest:
 * `.claude-plugin/plugin.json` → `skills: [...]`. Nothing else is vendored:
 * `skills/in-progress`, `skills/deprecated` and `skills/misc` stay upstream.
 *
 * Harness adaptation is deliberately tiny (see ADAPTATIONS). Keep upstream
 * prose intact: a diff against upstream should read as metadata plus these
 * substitutions, nothing else.
 *
 * Usage:
 *   node scripts/sync-upstream.mjs --source /path/to/mp-skills
 *   node scripts/sync-upstream.mjs                       # clone the pinned commit
 *   node scripts/sync-upstream.mjs --check               # fail if vendored output is stale
 *
 * `--check` exits 1 when ./skills differs from what this script would write,
 * so CI can catch a forgotten re-sync after the pin moves.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = join(ROOT, 'skills')
const MANIFEST = join(SKILLS_DIR, 'manifest.json')
const PIN = JSON.parse(readFileSync(join(ROOT, 'UPSTREAM.json'), 'utf8'))

/**
 * The complete list of prose rewrites. Everything else is upstream verbatim.
 * - `Skill tool`: Claude Code's capitalised tool name. DeepSeek Harness exposes
 *   the same operation as the lowercase `skill` tool, and its catalog tells the
 *   model to call `skill`, so a skill that names "the Skill tool" must be
 *   re-pointed or the model reaches for a tool that does not exist.
 */
const ADAPTATIONS = [
  [/\bSkill tool\b/g, '`skill` tool'],
]

/** Frontmatter keys this harness understands. Everything else is dropped. */
const KEPT_FRONTMATTER = new Set(['name', 'description', 'disable-model-invocation', 'user-invocable', 'whenToUse'])

function parseArgs(argv) {
  const args = { source: undefined, check: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') args.source = argv[++i]
    else if (argv[i] === '--check') args.check = true
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  return args
}

function clonePinned() {
  const dir = mkdtempSync(join(tmpdir(), 'engineering-skills-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString()
  git('init', '--quiet')
  git('remote', 'add', 'origin', PIN.repo)
  git('fetch', '--quiet', '--depth', '1', 'origin', PIN.commit)
  git('checkout', '--quiet', 'FETCH_HEAD')
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function readSource(source) {
  if (source !== undefined) return { dir: source, cleanup: () => {} }
  return clonePinned()
}

/** Split `---\n...\n---\n` frontmatter from the markdown body. */
function splitFrontmatter(raw, where) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) throw new Error(`${where}: missing YAML frontmatter`)
  return { yaml: match[1], body: raw.slice(match[0].length) }
}

/** Single-line YAML scalars are all upstream uses; quoted values may contain escapes. */
function scalar(yaml, key) {
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'mu').exec(yaml)
  if (match === null) return undefined
  const raw = match[1].trim()
  if (raw.length === 0) return undefined
  if (raw.startsWith('"')) {
    // Descriptions are JSON-compatible double-quoted scalars upstream.
    try { return JSON.parse(raw) } catch { return raw.slice(1, -1) }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'")
  return raw
}

function listFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === '.DS_Store') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) listFiles(full, out)
    else out.push(full)
  }
  return out
}

/** Keep only the keys this harness reads, in a stable order. */
function normalizeFrontmatter(yaml, where) {
  const lines = []
  const name = scalar(yaml, 'name')
  const description = scalar(yaml, 'description')
  if (name === undefined || description === undefined) throw new Error(`${where}: name and description are required`)
  lines.push(`name: ${name}`)
  const disable = scalar(yaml, 'disable-model-invocation')
  const user = scalar(yaml, 'user-invocable')
  if (disable !== undefined) lines.push(`disable-model-invocation: ${disable}`)
  if (user !== undefined) lines.push(`user-invocable: ${user}`)
  const whenToUse = scalar(yaml, 'whenToUse')
  if (whenToUse !== undefined) lines.push(`whenToUse: ${whenToUse}`)
  // `description` last when it is long, so the diff stays readable? No: keep
  // YAML key order stable and identical to upstream's first two keys.
  lines.splice(1, 0, `description: ${JSON.stringify(description)}`)
  const extra = yaml
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !/^\s/u.test(line) && line.includes(':'))
    .map((line) => line.slice(0, line.indexOf(':')))
    .filter((key) => key.length > 0 && !KEPT_FRONTMATTER.has(key))
  for (const key of extra) console.warn(`  ${where}: dropped frontmatter key "${key}"`)
  return lines.join('\n')
}

function adaptBody(body) {
  let adapted = body
  for (const [pattern, replacement] of ADAPTATIONS) adapted = adapted.replace(pattern, replacement)
  return adapted.trim() + '\n'
}

/** The upstream `.claude-plugin/plugin.json` `skills` array, as [category, name] pairs. */
function shippedSkills(sourceDir) {
  const plugin = JSON.parse(readFileSync(join(sourceDir, '.claude-plugin', 'plugin.json'), 'utf8'))
  const listed = plugin.skills ?? []
  if (listed.length === 0) throw new Error('upstream plugin.json lists no skills')
  return listed.map((entry) => {
    const dir = entry.replace(/^\.\//u, '')
    const parts = dir.split('/')
    // e.g. skills/engineering/tdd -> { category: 'engineering', name: 'tdd', dir: 'skills/engineering/tdd' }
    if (parts.length !== 3 || parts[0] !== 'skills') throw new Error(`unexpected skill path: ${entry}`)
    return { category: parts[1], name: parts[2], sourceDir: join(sourceDir, dir) }
  })
}

function build(sourceDir) {
  const skills = shippedSkills(sourceDir).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  const out = new Map() // relative path -> UTF-8 content
  const manifestSkills = []
  for (const skill of skills) {
    const files = listFiles(skill.sourceDir)
      // agents/openai.yaml is Codex UI metadata; this harness reads nothing from it.
      .filter((file) => !relative(skill.sourceDir, file).startsWith(`agents${sep}`))
    const skillMd = files.find((file) => relative(skill.sourceDir, file) === 'SKILL.md')
    if (skillMd === undefined) throw new Error(`${skill.name}: no SKILL.md`)
    const raw = readFileSync(skillMd, 'utf8')
    const { yaml, body } = splitFrontmatter(raw, skill.name)
    const description = scalar(yaml, 'description')
    const disableModel = scalar(yaml, 'disable-model-invocation')
    const userInvocable = scalar(yaml, 'user-invocable') !== 'false'
    const modelInvocable = disableModel !== 'true'
    const targetDir = `${skill.category}/${skill.name}`
    for (const file of files) {
      const rel = relative(skill.sourceDir, file)
      const content = rel === 'SKILL.md'
        ? `---\n${normalizeFrontmatter(yaml, skill.name)}\n---\n\n${adaptBody(body)}`
        : readFileSync(file, 'utf8')
      out.set(`${targetDir}/${rel}`, content)
    }
    manifestSkills.push({
      name: skill.name,
      category: skill.category,
      dir: targetDir,
      description,
      modelInvocable,
      userInvocable,
      files: files.map((file) => relative(skill.sourceDir, file)).sort(),
    })
  }
  const manifest = {
    schemaVersion: 1,
    upstream: {
      repo: PIN.repo,
      version: PIN.version,
      commit: PIN.commit,
      publishedVia: '.claude-plugin/plugin.json#skills',
    },
    generatedBy: 'scripts/sync-upstream.mjs',
    skills: manifestSkills,
  }
  out.set('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  return out
}

function writeOutputs(outputs) {
  rmSync(SKILLS_DIR, { recursive: true, force: true })
  for (const [rel, content] of outputs) {
    const dest = join(SKILLS_DIR, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, content)
  }
}

function checkOutputs(outputs) {
  const current = listFiles(SKILLS_DIR).map((file) => relative(SKILLS_DIR, file).split(sep).join('/'))
  const expected = [...outputs.keys()]
  const missing = expected.filter((path) => !current.includes(path))
  const extra = current.filter((path) => !expected.includes(path))
  const changed = expected
    .filter((path) => current.includes(path))
    .filter((path) => readFileSync(join(SKILLS_DIR, path), 'utf8') !== outputs.get(path))
  if (missing.length + extra.length + changed.length === 0) {
    console.log(`skills/ up to date with upstream ${PIN.version} (${PIN.commit.slice(0, 7)})`)
    return
  }
  console.error('skills/ is stale; run `node scripts/sync-upstream.mjs`')
  for (const path of missing) console.error('  missing:', path)
  for (const path of extra) console.error('  extra:  ', path)
  for (const path of changed) console.error('  changed:', path)
  process.exitCode = 1
}

const args = parseArgs(process.argv.slice(2))
const { dir, cleanup } = readSource(args.source)
try {
  const outputs = build(dir)
  if (args.check) checkOutputs(outputs)
  else {
    writeOutputs(outputs)
    const manifest = JSON.parse(outputs.get('manifest.json'))
    const userInvoked = manifest.skills.filter((skill) => !skill.modelInvocable).length
    console.log(
      `vendored ${manifest.skills.length} skills (${manifest.skills.length - userInvoked} model-invoked, ${userInvoked} user-invoked) ` +
      `from upstream ${PIN.version} (${PIN.commit.slice(0, 7)})`,
    )
  }
} finally {
  cleanup()
}
