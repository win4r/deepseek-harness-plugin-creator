#!/usr/bin/env node

import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const arguments_ = process.argv.slice(2)
if (arguments_.length > 1 || arguments_.some(value => value.startsWith('-'))) {
  process.stderr.write('Usage: node check_skill.mjs [skill-root]\n')
  process.exit(64)
}
const root = await realpath(arguments_[0] === undefined
  ? fileURLToPath(new URL('..', import.meta.url))
  : resolve(arguments_[0]))
const requiredFiles = [
  'SKILL.md',
  'README.md',
  'README.zh-CN.md',
  'agents/openai.yaml',
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
const failures = []

function fail(message) {
  failures.push(message)
}

function insideRoot(candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !rel.startsWith(sep))
}

async function isFile(path) {
  try {
    const stats = await lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink()) return false
    return insideRoot(await realpath(path))
  } catch {
    return false
  }
}

async function markdownFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await markdownFiles(path))
    else if (entry.isSymbolicLink()) fail(`${relative(root, path)} is a symbolic link; the Skill must be self-contained`)
    else if (entry.isFile() && extname(entry.name) === '.md') files.push(path)
  }
  return files
}

const safeRequired = new Set()
for (const path of requiredFiles) {
  if (!(await isFile(join(root, path)))) fail(`missing, unsafe, or non-regular required file: ${path}`)
  else safeRequired.add(path)
}

const skill = safeRequired.has('SKILL.md') ? await readFile(join(root, 'SKILL.md'), 'utf8') : ''
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1]
if (frontmatter === undefined) {
  fail('SKILL.md has no YAML frontmatter')
} else {
  if (!/^name:\s*deepseek-harness-plugin-creator\s*$/m.test(frontmatter)) fail('SKILL.md name is incorrect')
  if (!/^description:\s*\S.+$/m.test(frontmatter)) fail('SKILL.md description is missing')
}

const agentMetadata = safeRequired.has('agents/openai.yaml')
  ? await readFile(join(root, 'agents/openai.yaml'), 'utf8')
  : ''
if (!/default_prompt:\s*["'][^\n]*\$deepseek-harness-plugin-creator/.test(agentMetadata)) {
  fail('agents/openai.yaml default_prompt must name $deepseek-harness-plugin-creator')
}

for (const path of await markdownFiles(root)) {
  const text = await readFile(path, 'utf8')
  const display = relative(root, path)
  if (/__(?:PLUGIN|TOOL|DESCRIPTION|VERSION|ID)_[A-Z_]*__/.test(text)) {
    fail(`${display} contains an unresolved scaffold placeholder`)
  }
  if (/\/Users\/(?!me(?:\/|\b)|you(?:\/|\b)|user(?:\/|\b)|username(?:\/|\b)|example(?:\/|\b)|<)/.test(text)) {
    fail(`${display} contains a machine-specific macOS home path`)
  }
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '')
    if (rawTarget === '' || rawTarget.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue
    const pathPart = decodeURIComponent(rawTarget.split('#', 1)[0])
    const target = resolve(dirname(path), pathPart)
    if (!insideRoot(target)) fail(`${display} link escapes the skill root: ${rawTarget}`)
    else if (!(await isFile(target))) fail(`${display} link target is missing, unsafe, or symbolic: ${rawTarget}`)
  }
}

if (failures.length > 0) {
  for (const message of failures) process.stderr.write(`ERROR ${message}\n`)
  process.exit(1)
}

process.stdout.write('SKILL_SELF_CHECK_OK\n')
