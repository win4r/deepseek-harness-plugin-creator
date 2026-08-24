import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CHECKER = fileURLToPath(new URL('../scripts/check_skill.mjs', import.meta.url))
const REQUIRED = [
  'README.md',
  'README.zh-CN.md',
  'assets/scaffold/package.json.tmpl',
  'assets/scaffold/src/index.ts.tmpl',
  'references/contract-discovery.md',
  'references/api-quick-reference.md',
  'references/tool-authority.md',
  'references/sandboxed-workers.md',
  'references/durable-runtime.md',
  'references/client-extensions.md',
  'references/troubleshooting.md',
  'references/release-gates.md',
  'scripts/scaffold_plugin.mjs',
  'scripts/validate_plugin.mjs',
  'scripts/accept_plugin.mjs',
  'scripts/enumerate_tree.py',
]

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const relativePath of REQUIRED) {
    const target = join(root, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, relativePath.endsWith('.md') ? '# Fixture\n' : 'fixture\n')
  }
  await mkdir(join(root, 'agents'), { recursive: true })
  await writeFile(join(root, 'agents', 'openai.yaml'), 'interface:\n  default_prompt: "Use $deepseek-harness-plugin-creator."\n')
  await writeFile(join(root, 'SKILL.md'), [
    '---',
    'name: deepseek-harness-plugin-creator',
    'description: Fixture description.',
    '---',
    '',
    '# Fixture',
    '',
  ].join('\n'))
  return root
}

test('Skill self-check accepts a self-contained regular-file fixture', async t => {
  const root = await fixture(t)
  const result = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /SKILL_SELF_CHECK_OK/)
})

test('Skill self-check rejects a required file replaced by an external symlink', async t => {
  const root = await fixture(t)
  const outside = join(dirname(root), `${root.split('/').at(-1)}-outside.md`)
  t.after(() => rm(outside, { force: true }))
  await writeFile(outside, '# External\n')
  await rm(join(root, 'README.md'))
  await symlink(outside, join(root, 'README.md'))

  const result = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /missing, unsafe, or non-regular required file: README\.md/)
  assert.match(result.stderr, /README\.md is a symbolic link/)
})
