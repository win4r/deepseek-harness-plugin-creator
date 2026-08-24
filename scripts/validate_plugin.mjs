#!/usr/bin/env node

import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TEXT_EXTENSIONS = new Set([
  '.cjs', '.conf', '.crt', '.css', '.cts', '.env', '.graphql', '.gql', '.html', '.ini', '.js', '.json',
  '.jsx', '.key', '.lock', '.log', '.map', '.md', '.mjs', '.mts', '.pem', '.properties', '.sh', '.sql', '.svg',
  '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
])
const TEXT_FILENAMES = new Set([
  '.dockerignore', '.editorconfig', '.env', '.gitattributes', '.gitignore', '.npmrc',
  'Dockerfile', 'LICENSE', 'Makefile', 'NOTICE',
])
const MAX_TEXT_BYTES = 5_000_000
const TREE_ENUMERATOR = fileURLToPath(new URL('./enumerate_tree.py', import.meta.url))
const SYSTEM_PYTHON = '/usr/bin/python3'
const EXACT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SECRET_PATTERNS = [
  ['private-key', /BEGIN [A-Z ]*PRIVATE KEY/i],
  ['github-token', /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,})/i],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['google-api-key', /AIza[0-9A-Za-z_-]{30,}/],
  ['slack-token', /xox[baprs]-[0-9A-Za-z-]+/i],
  ['generic-sk-token', /\bsk-[A-Za-z0-9_-]{20,}\b/i],
]
const LOCAL_PATH_PATTERNS = [
  ['/Users/', /\/Users\/(?!(?:me|you|user|username|example|<[^>]+>)(?:\/|\b))[^/\s"']+/i],
  ['/home/', /\/home\/(?!(?:me|you|user|username|example|<[^>]+>)(?:\/|\b))[^/\s"']+/i],
  ['Windows user profile', /[A-Za-z]:\\Users\\(?!(?:me|you|user|username|example|<[^>]+>)(?:\\|\b))[^\\\s"']+/i],
]
const MODULE_INSPECTOR = String.raw`
const vm = require('node:vm')
let source = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { source += chunk })
process.stdin.on('end', async () => {
  const requested = new Map()
  for (let attempt = 0; attempt < 512; attempt += 1) {
    const root = new vm.SourceTextModule(source, { identifier: 'candidate.mjs' })
    const stubs = new Map()
    try {
      await root.link(specifier => {
        let stub = stubs.get(specifier)
        if (stub === undefined) {
          const names = [...(requested.get(specifier) ?? [])]
          stub = new vm.SyntheticModule(names, function initialize() {
            for (const name of names) this.setExport(name, undefined)
          })
          stubs.set(specifier, stub)
        }
        return stub
      })
      const exports = Reflect.ownKeys(root.namespace).filter(value => typeof value === 'string')
      const imports = root.moduleRequests?.map(request => request.specifier) ?? root.dependencySpecifiers
      process.stdout.write(JSON.stringify({ exports, imports }))
      return
    } catch (error) {
      const match = /The requested module '([^']+)' does not provide an export named '([^']+)'/.exec(String(error?.message ?? ''))
      if (match === null) throw error
      const names = requested.get(match[1]) ?? new Set()
      names.add(match[2])
      requested.set(match[1], names)
    }
  }
  throw new Error('module import surface exceeds inspection bound')
})
`

function safeDiagnostic(value) {
  const escaped = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]|\p{Cf}/gu, character => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 0xffff
      ? '\\u' + codePoint.toString(16).padStart(4, '0')
      : '\\u{' + codePoint.toString(16) + '}'
  })
  return escaped.length <= 4096 ? escaped : escaped.slice(0, 4096) + '...'
}

function validPackageName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 214 || value !== value.toLowerCase()) return false
  const scopeSegment = '[a-z0-9-][a-z0-9._~-]*'
  const packageSegment = '[a-z0-9-][a-z0-9._-]*'
  const match = new RegExp('^(?:@(' + scopeSegment + ')/)?(' + packageSegment + ')$').exec(value)
  return match !== null && !['node_modules', 'favicon.ico'].includes(match[2])
}

function usage(stream = process.stderr) {
  stream.write('Usage: validate_plugin.mjs <plugin-dir> [--built] [--installed-artifact] [--json] [--expect <host-runtime-package>=<exact-version>]...\n')
}

const positional = []
const expectedRuntimeVersions = new Map()
let requireBuilt = false
let installedArtifact = false
let jsonOutput = false
const cliArguments = process.argv.slice(2)
if (cliArguments.includes('--help') || cliArguments.includes('-h')) {
  usage(process.stdout)
  process.exit(0)
}
for (let index = 0; index < cliArguments.length; index += 1) {
  const arg = cliArguments[index]
  if (arg === '--built') requireBuilt = true
  else if (arg === '--installed-artifact') installedArtifact = true
  else if (arg === '--json') jsonOutput = true
  else if (arg === '--expect') {
    const expectation = cliArguments[index + 1]
    if (expectation === undefined || expectation.startsWith('-')) {
      usage()
      process.stderr.write('--expect requires <package>=<exact-version>\n')
      process.exit(64)
    }
    index += 1
    const separator = expectation.lastIndexOf('=')
    const packageName = separator === -1 ? '' : expectation.slice(0, separator)
    const version = separator === -1 ? '' : expectation.slice(separator + 1)
    if (!validPackageName(packageName) || runtimePackageName(packageName) !== packageName || !EXACT_VERSION_PATTERN.test(version)) {
      usage()
      process.stderr.write('Invalid --expect value: ' + safeDiagnostic(expectation) + '\n')
      process.exit(64)
    }
    const existing = expectedRuntimeVersions.get(packageName)
    if (existing !== undefined && existing !== version) {
      usage()
      process.stderr.write('Conflicting --expect values for ' + safeDiagnostic(packageName) + '\n')
      process.exit(64)
    }
    expectedRuntimeVersions.set(packageName, version)
  }
  else if (arg.startsWith('-')) {
    usage()
    process.stderr.write('Unknown option: ' + safeDiagnostic(arg) + '\n')
    process.exit(64)
  } else positional.push(arg)
}
if (positional.length !== 1) {
  usage()
  process.exit(64)
}

const report = {
  root: resolve(positional[0]),
  built: requireBuilt,
  installedArtifact,
  expectations: Object.fromEntries(expectedRuntimeVersions),
  checks: [],
  warnings: [],
  errors: [],
}

function pass(code, message) {
  report.checks.push({ code: safeDiagnostic(code), message: safeDiagnostic(message) })
}
function warn(code, message) {
  report.warnings.push({ code: safeDiagnostic(code), message: safeDiagnostic(message) })
}
function fail(code, message) {
  report.errors.push({ code: safeDiagnostic(code), message: safeDiagnostic(message) })
}

let frozenRoot
let frozenTree
let frozenEntries = new Map()
const observedRuntimeImports = new Set()
const observedShippedImports = new Set()
const clientInjectedDependencies = new Set()
let shippedImportMatchers = []
let releaseScanMatchers = []

function runtimePackageName(specifier) {
  const match = /^(dsh|@deepseek-ai\/(?:cordis(?:-[A-Za-z0-9._-]+)?|dsh(?:-[A-Za-z0-9._-]+)?))(?:\/|$)/.exec(specifier)
  return match?.[1]
}

function validSnapshot(value) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .every(key => typeof value[key] === 'string' && /^-?\d+$/.test(value[key]))
}

function validTreePath(value, { rootAllowed = false } = {}) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || isAbsolute(value)) return false
  if (value === '') return rootAllowed
  const parts = value.split('/')
  return parts.every(part => part !== '' && part !== '.' && part !== '..' && !/[\u0000-\u001f\u007f]/.test(part))
}

function parseTreeSnapshot(text) {
  const parsed = JSON.parse(text)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new TypeError()
  if (!Array.isArray(parsed.directories) || !Array.isArray(parsed.entries)) throw new TypeError()
  const seen = new Set()
  for (const item of parsed.directories) {
    if (item === null || typeof item !== 'object' || !validTreePath(item.path, { rootAllowed: true }) || !validSnapshot(item.snapshot)) {
      throw new TypeError()
    }
    if (seen.has(item.path)) throw new TypeError()
    seen.add(item.path)
  }
  if (!seen.has('')) throw new TypeError()
  for (const item of parsed.entries) {
    if (item === null || typeof item !== 'object' || !validTreePath(item.path) || !validSnapshot(item.snapshot)) {
      throw new TypeError()
    }
    if (!['file', 'skipped-directory', 'special', 'symlink'].includes(item.kind) || seen.has(item.path)) {
      throw new TypeError()
    }
    seen.add(item.path)
  }
  parsed.directories.sort((left, right) => left.path.localeCompare(right.path))
  parsed.entries.sort((left, right) => left.path.localeCompare(right.path))
  return parsed
}

function enumerateTree(root, { initial = false } = {}) {
  const result = spawnSync(SYSTEM_PYTHON, ['-I', '-S', TREE_ENUMERATOR, root, requireBuilt ? '1' : '0'], {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30000,
    windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) {
    fail('tree-snapshot', 'Plugin tree could not be enumerated through the descriptor-bound helper')
    return undefined
  }
  try {
    const snapshot = parseTreeSnapshot(result.stdout)
    if (initial) pass('tree-snapshot', 'Plugin tree was frozen through descriptor-bound traversal')
    return snapshot
  } catch {
    fail('tree-snapshot', 'Descriptor-bound helper returned an invalid bounded snapshot')
    return undefined
  }
}

function treeRelativePath(path) {
  if (frozenRoot === undefined) return undefined
  const value = relative(frozenRoot, path)
  if (value === '' || value === '..' || value.startsWith('..' + sep) || isAbsolute(value)) return undefined
  return value.split(sep).join('/')
}

function treeEntry(path) {
  const value = treeRelativePath(path)
  return value === undefined ? undefined : frozenEntries.get(value)
}

async function exists(path) {
  return treeEntry(path)?.kind === 'file'
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value) || value.includes('\0')) {
    fail('unsafe-path', label + ' must be a non-empty relative path')
    return undefined
  }
  const normalized = value.replace(/^\.\//, '').replaceAll('\\', '/')
  const parts = normalized.split(/[\\/]/)
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    fail('unsafe-path', label + ' contains an empty, dot, or parent segment')
    return undefined
  }
  return normalized
}

function withinRoot(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function matchesFrozenSnapshot(value, expected) {
  return value.dev.toString() === expected.dev
    && value.ino.toString() === expected.ino
    && value.mode.toString() === expected.mode
    && value.nlink.toString() === expected.nlink
    && value.size.toString() === expected.size
    && value.mtimeNs.toString() === expected.mtimeNs
    && value.ctimeNs.toString() === expected.ctimeNs
}

async function inspectVerifiedFile(root, path, label, { expected, readText = false } = {}) {
  let initial
  let canonical
  try {
    initial = await lstat(path, { bigint: true })
    canonical = await realpath(path)
  } catch {
    fail('file-boundary', label + ' is missing or unreadable')
    return undefined
  }
  if (!initial.isFile() || initial.nlink !== 1n) {
    fail('file-boundary', label + ' must be a single-link regular file, not a symlink, hardlink, or special file')
    return undefined
  }
  if (!withinRoot(root, canonical)) {
    fail('file-boundary', label + ' resolves outside the plugin root')
    return undefined
  }
  if (expected === undefined || !matchesFrozenSnapshot(initial, expected)) {
    fail('file-race', label + ' does not match the frozen tree snapshot')
    return undefined
  }

  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    fail('file-boundary', label + ' could not be opened without following links')
    return undefined
  }

  let text
  let valid = true
  try {
    const before = await handle.stat({ bigint: true })
    if (!sameFileSnapshot(initial, before)) {
      fail('file-race', label + ' changed while its boundary was being verified')
      valid = false
    } else if (readText && before.size > BigInt(MAX_TEXT_BYTES)) {
      fail('file-size', label + ' exceeds the 5000000-byte validator limit')
      valid = false
    } else {
      if (readText) text = await handle.readFile({ encoding: 'utf8' })
      const after = await handle.stat({ bigint: true })
      if (!sameFileSnapshot(initial, after)) {
        fail('file-race', label + ' changed while it was being read')
        valid = false
      }
    }
  } catch {
    fail('file-boundary', label + ' could not be verified safely')
    valid = false
  } finally {
    await handle.close().catch(() => {})
  }
  if (!valid) return undefined

  try {
    const final = await lstat(path, { bigint: true })
    const finalCanonical = await realpath(path)
    if (!sameFileSnapshot(initial, final) || finalCanonical !== canonical) {
      fail('file-race', label + ' changed before validation completed')
      return undefined
    }
  } catch {
    fail('file-race', label + ' disappeared before validation completed')
    return undefined
  }
  return { text }
}

async function regularFileWithinRoot(root, path, label) {
  const expected = treeEntry(path)
  if (expected?.kind !== 'file') {
    fail('file-boundary', label + ' is absent or non-regular in the frozen tree snapshot')
    return false
  }
  return await inspectVerifiedFile(root, path, label, { expected: expected.snapshot }) !== undefined
}

async function readSafeText(root, path, label) {
  const expected = treeEntry(path)
  if (expected?.kind !== 'file') {
    fail('file-boundary', label + ' is absent or non-regular in the frozen tree snapshot')
    return undefined
  }
  const result = await inspectVerifiedFile(root, path, label, { expected: expected.snapshot, readText: true })
  return result?.text
}

async function readJson(root, path, label) {
  const text = await readSafeText(root, path, label)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    fail('invalid-json', label + ' is invalid JSON')
    return undefined
  }
}

function isTextFile(name) {
  return TEXT_FILENAMES.has(name) || /^\.env(?:\.|rc$)/.test(name) || TEXT_EXTENSIONS.has(extname(name).toLowerCase())
}

function textFilesFromFrozenTree(root) {
  const output = []
  for (const entry of frozenTree?.entries ?? []) {
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
    const environmentFile = /^\.env(?:\.|rc$)/.test(name)
    const environmentTemplate = /^\.env\.(?:example|template)$/i.test(name)
    if (environmentFile && !environmentTemplate) {
      fail('env-file', 'Environment file must not be present in a release candidate: ' + entry.path)
    }
    if (!environmentFile && !shouldReleaseScan(entry.path)) continue
    if (entry.kind === 'symlink') {
      fail('scan-boundary', 'Symbolic link cannot be release-scanned: ' + entry.path)
      continue
    }
    if (entry.kind === 'special') {
      fail('scan-boundary', 'Special file cannot be release-scanned: ' + entry.path)
      continue
    }
    if (entry.kind !== 'file' || entry.path.endsWith('.tgz')) continue
    if (isTextFile(name)) output.push(resolve(root, entry.path))
  }
  return output
}

async function firstExisting(paths) {
  for (const path of paths) {
    if (await exists(path)) return path
  }
  return undefined
}

function maskCommentsAndStrings(source, { preserveQuotes = false } = {}) {
  let output = ''
  let state = 'code'
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') {
        output += '  '
        index += 1
        state = 'line-comment'
      } else if (char === '/' && next === '*') {
        output += '  '
        index += 1
        state = 'block-comment'
      } else if (char === "'") {
        output += preserveQuotes ? char : ' '
        state = 'single-quote'
        escaped = false
      } else if (char === '"') {
        output += preserveQuotes ? char : ' '
        state = 'double-quote'
        escaped = false
      } else if (char === '`') {
        output += ' '
        state = 'template'
        escaped = false
      } else if (char === '/' && (
        /(?:^|[=([{,:;!&|?+\-*%^~<>])\s*$/.test(output)
        || /\b(?:await|case|delete|in|instanceof|of|return|throw|typeof|void|yield)\s*$/.test(output)
      )) {
        output += ' '
        state = 'regex'
        escaped = false
      } else {
        output += char
      }
      continue
    }

    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') {
        output += char
        state = 'code'
      } else output += ' '
      continue
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  '
        index += 1
        state = 'code'
      } else output += char === '\n' || char === '\r' ? char : ' '
      continue
    }

    if (state === 'regex') {
      output += char === '\n' || char === '\r' ? char : ' '
      if (char === '\n' || char === '\r') {
        state = 'code'
        escaped = false
      } else if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '/') {
        while (/[A-Za-z]/.test(source[index + 1] ?? '')) {
          output += ' '
          index += 1
        }
        state = 'code'
      }
      continue
    }

    const preserveCurrentQuote = preserveQuotes && (state === 'single-quote' || state === 'double-quote')
    output += char === '\n' || char === '\r' ? char : preserveCurrentQuote ? char : ' '
    if (escaped) {
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (
      (state === 'single-quote' && char === "'")
      || (state === 'double-quote' && char === '"')
      || (state === 'template' && char === '`')
    ) {
      state = 'code'
    }
  }
  return output
}

function exportedNames(code) {
  const names = new Set()
  for (const match of code.matchAll(/(?:^|[;}])\s*export\s*\{([^}]*)\}/gm)) {
    for (const rawSpecifier of match[1].split(',')) {
      const specifier = rawSpecifier.trim()
      if (specifier.length === 0 || /^type\b/.test(specifier)) continue
      const alias = /^(?:[$\w]+)\s+as\s+([$\w]+)$/.exec(specifier)
      if (alias !== null) names.add(alias[1])
      else if (/^[$\w]+$/.test(specifier)) names.add(specifier)
    }
  }
  return names
}

function shouldInspectRuntimeImports(path) {
  const extension = extname(path).toLowerCase()
  if (!['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'].includes(extension)) return false
  const normalized = path.replaceAll('\\', '/')
  return shippedImportMatchers.some(matcher => matcher.prefix
    ? matcher.path === '' || normalized === matcher.path || normalized.startsWith(matcher.path + '/')
    : normalized === matcher.path)
}

function pathMatchers(values) {
  const directories = new Set((frozenTree?.directories ?? []).map(item => item.path))
  const seen = new Set()
  const matchers = []
  for (const rawValue of values) {
    if (typeof rawValue !== 'string' || rawValue.startsWith('!')) continue
    const value = rawValue.replace(/^\.\//, '').replaceAll('\\', '/').replace(/\/$/, '')
    const wildcard = value.search(/[?*\[]/)
    const path = wildcard === -1 ? value : value.slice(0, wildcard).replace(/\/$/, '')
    const prefix = wildcard !== -1 || directories.has(path)
    const key = (prefix ? 'prefix:' : 'exact:') + path
    if (!seen.has(key)) {
      seen.add(key)
      matchers.push({ path, prefix })
    }
  }
  return matchers
}

function configureShippedImportMatchers(values) {
  shippedImportMatchers = pathMatchers(values)
}

function configureReleaseScanMatchers(values) {
  releaseScanMatchers = pathMatchers(values)
}

function shouldReleaseScan(path) {
  const normalized = path.replaceAll('\\', '/')
  if (!normalized.includes('/')) return true
  return releaseScanMatchers.some(matcher => matcher.prefix
    ? matcher.path === '' || normalized === matcher.path || normalized.startsWith(matcher.path + '/')
    : normalized === matcher.path)
}

function safeExportPath(value, label) {
  if (typeof value !== 'string' || !value.startsWith('./')) {
    fail('unsafe-export-path', label + ' must start with ./')
    return undefined
  }
  return safeRelativePath(value, label)
}

function collectExportTargets(value, label, output = new Set(), depth = 0, wildcardValue) {
  if (depth > 16 || output.size > 512) {
    fail('exports-size', 'package.json exports exceeds the bounded traversal limit')
    return output
  }
  if (typeof value === 'string') {
    const materialized = wildcardValue === undefined ? value : value.replaceAll('*', wildcardValue)
    const target = safeExportPath(materialized, label)
    if (target !== undefined) output.add(target)
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectExportTargets(item, label + '[' + index + ']', output, depth + 1, wildcardValue))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectExportTargets(item, label + '.' + key, output, depth + 1, wildcardValue)
    }
  }
  return output
}

function collectRuntimeExportTargets(value, label, output = new Set(), depth = 0, wildcardValue) {
  if (depth > 16 || output.size > 512) {
    fail('exports-size', 'package.json exports exceeds the bounded traversal limit')
    return output
  }
  if (typeof value === 'string') {
    const materialized = wildcardValue === undefined ? value : value.replaceAll('*', wildcardValue)
    const target = safeExportPath(materialized, label)
    if (target !== undefined) output.add(target)
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectRuntimeExportTargets(item, label + '[' + index + ']', output, depth + 1, wildcardValue))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'types') continue
      collectRuntimeExportTargets(item, label + '.' + key, output, depth + 1, wildcardValue)
    }
  }
  return output
}

function resolveExportKey(exportsField, exportKey, label) {
  if (exportsField === undefined) return { found: false, targets: new Set() }
  if (exportKey === '.') {
    if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
      return { found: true, targets: collectRuntimeExportTargets(exportsField, label) }
    }
    if (exportsField !== null && typeof exportsField === 'object') {
      if (Object.hasOwn(exportsField, '.')) {
        return { found: true, targets: collectRuntimeExportTargets(exportsField['.'], label) }
      }
      if (Object.keys(exportsField).every(key => !key.startsWith('.'))) {
        return { found: true, targets: collectRuntimeExportTargets(exportsField, label) }
      }
    }
    return { found: false, targets: new Set() }
  }
  if (exportsField === null || Array.isArray(exportsField) || typeof exportsField !== 'object') {
    return { found: false, targets: new Set() }
  }
  if (Object.hasOwn(exportsField, exportKey)) {
    return { found: true, targets: collectRuntimeExportTargets(exportsField[exportKey], label) }
  }
  const matches = []
  for (const [pattern, value] of Object.entries(exportsField)) {
    const star = pattern.indexOf('*')
    if (star === -1 || star !== pattern.lastIndexOf('*')) continue
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (!exportKey.startsWith(prefix) || !exportKey.endsWith(suffix) || exportKey.length < prefix.length + suffix.length) continue
    matches.push({ pattern, value, prefix, suffix, wildcard: exportKey.slice(prefix.length, exportKey.length - suffix.length) })
  }
  matches.sort((left, right) => right.prefix.length - left.prefix.length
    || right.suffix.length - left.suffix.length
    || right.pattern.length - left.pattern.length)
  if (matches.length === 0) return { found: false, targets: new Set() }
  const match = matches[0]
  return {
    found: true,
    targets: collectRuntimeExportTargets(match.value, label + ' via ' + match.pattern, new Set(), 0, match.wildcard),
  }
}

function validateClientStringArray(value, label, { packageNames = false, collect } = {}) {
  if (value === undefined) return true
  if (!Array.isArray(value)) {
    fail('client-manifest', label + ' must be an array when present')
    return false
  }
  let valid = true
  const seen = new Set()
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      fail('client-manifest', label + '[' + index + '] must be a non-empty string')
      valid = false
      continue
    }
    if (packageNames && !validPackageName(item)) {
      fail('client-manifest', label + '[' + index + '] must be an exact npm package name, not a subpath or request')
      valid = false
      continue
    }
    if (seen.has(item)) {
      fail('client-manifest', label + ' contains a duplicate entry: ' + item)
      valid = false
    }
    seen.add(item)
    collect?.add(item)
  }
  if (valid) pass('client-manifest', label + ' is a unique non-empty string array')
  return valid
}

function resolveClientExportTarget(exportsField) {
  if (exportsField === null || Array.isArray(exportsField) || typeof exportsField !== 'object'
    || !Object.hasOwn(exportsField, './client')) {
    fail('client-export', 'dsh.client requires an explicit exports["./client"] entry')
    return undefined
  }
  const declaration = exportsField['./client']
  let target
  if (typeof declaration === 'string') target = declaration
  else if (declaration !== null && !Array.isArray(declaration) && typeof declaration === 'object'
    && typeof declaration.default === 'string') target = declaration.default
  else {
    fail('client-export', 'exports["./client"] must be a string or an object with a string default')
    return undefined
  }
  const relativeTarget = safeExportPath(target, 'exports["./client"]')
  if (relativeTarget !== undefined) pass('client-export', 'dsh.client resolves through exports["./client"]')
  return relativeTarget
}

function stripYamlComment(line) {
  let output = ''
  let quote
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote === undefined) {
      if (char === '#') break
      if (char === "'" || char === '"') quote = char
      output += char
    } else {
      output += char
      if (quote === '"' && escaped) {
        escaped = false
      } else if (quote === '"' && char === '\\') {
        escaped = true
      } else if (quote === "'" && char === "'" && line[index + 1] === "'") {
        output += line[index + 1]
        index += 1
      } else if (char === quote) {
        quote = undefined
      }
    }
  }
  return output
}

function yamlScalar(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed)
      return typeof parsed === 'string' ? parsed : undefined
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  return trimmed.length === 0 ? undefined : trimmed
}

function patchNameScalar(value) {
  const trimmed = value.trim()
  if (trimmed.length === 0 || /^[|>&*!\[{]/.test(trimmed)) {
    fail('patch-syntax', 'Bundle patch name values must use a direct plain or quoted scalar')
    return undefined
  }
  return yamlScalar(trimmed)
}

function directMappingName(text) {
  const match = /^(?:"name"|'name'|name)\s*:\s*(.*?)\s*$/.exec(text.trim())
  return match === null ? undefined : patchNameScalar(match[1])
}

function flowMappingNames(text, names) {
  const states = []
  let brace = 0
  let bracket = 0
  let quote
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    states.push({ brace, bracket, quoted: quote !== undefined })
    const character = text[index]
    if (quote !== undefined) {
      if (quote === '"' && escaped) escaped = false
      else if (quote === '"' && character === '\\') escaped = true
      else if (quote === "'" && character === "'" && text[index + 1] === "'") {
        states.push({ brace, bracket, quoted: true })
        index += 1
      } else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '{') brace += 1
    else if (character === '}') brace -= 1
    else if (character === '[') bracket += 1
    else if (character === ']') bracket -= 1
  }
  const pattern = /(?:^|[{,])\s*(?:"name"|'name'|name)\s*:\s*("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,}\]]+)/g
  for (const match of text.matchAll(pattern)) {
    const keyOffset = match[0].search(/(?:"name"|'name'|\bname\b)/)
    const state = states[match.index + keyOffset]
    if (state?.quoted || state?.brace !== 1 || state.bracket > 1) continue
    const value = patchNameScalar(match[1])
    if (value !== undefined) names.add(value)
  }
}

function patchPackageNames(patchText) {
  const names = new Set()
  const mountingNames = new Set()
  const lines = patchText.split(/\r?\n/).map(raw => stripYamlComment(raw))
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const operation = /^(\s*)-\s+(?:(['"])(insert|remove|replace|patch)\2|(insert|remove|replace|patch))\s*:\s*(.*?)\s*$/.exec(line)
    if (operation === null || operation[1].length !== 0) continue
    const operationName = operation[3] ?? operation[4]
    const operationNames = new Set()
    const tail = operation[5]
    if (tail.length > 0) {
      if (/^[{[]/.test(tail)) flowMappingNames(tail, operationNames)
      else {
        const value = directMappingName(tail)
        if (value !== undefined) operationNames.add(value)
      }
      for (const value of operationNames) {
        names.add(value)
        if (operationName === 'insert' || operationName === 'replace') mountingNames.add(value)
      }
      continue
    }
    let end = index + 1
    while (end < lines.length) {
      const candidate = lines[end]
      if (candidate.trim().length > 0 && /^\S/.test(candidate)) break
      end += 1
    }
    const body = lines.slice(index + 1, end).filter(value => value.trim().length > 0)
    if (body.length === 0) continue
    const baseIndent = Math.min(...body.map(value => /^\s*/.exec(value)[0].length))
    const sequence = body.some(value => /^\s*/.exec(value)[0].length === baseIndent && value.trimStart().startsWith('-'))
    for (const value of body) {
      const indent = /^\s*/.exec(value)[0].length
      const trimmed = value.trimStart()
      let mapping
      if (sequence && indent === baseIndent && trimmed.startsWith('-')) mapping = trimmed.slice(1).trimStart()
      else if (sequence && indent === baseIndent + 2) mapping = trimmed
      else if (!sequence && indent === baseIndent) mapping = trimmed
      else continue
      if (/^[{[]/.test(mapping)) flowMappingNames(mapping, operationNames)
      else {
        const name = directMappingName(mapping)
        if (name !== undefined) operationNames.add(name)
      }
    }
    for (const value of operationNames) {
      names.add(value)
      if (operationName === 'insert' || operationName === 'replace') mountingNames.add(value)
    }
    index = end - 1
  }
  return { names, mountingNames }
}

function recordRuntimeImports(source) {
  const code = maskCommentsAndStrings(source, { preserveQuotes: true })
  const patterns = [
    /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]{0,4096}?\bfrom\s+)?(['"])((?:dsh|@deepseek-ai\/(?:cordis(?:-[A-Za-z0-9._-]+)?|dsh(?:-[A-Za-z0-9._-]+)?))(?:\/[^'"]*)?)\1/gm,
    /\bimport\s*\(\s*(['"])((?:dsh|@deepseek-ai\/(?:cordis(?:-[A-Za-z0-9._-]+)?|dsh(?:-[A-Za-z0-9._-]+)?))(?:\/[^'"]*)?)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])((?:dsh|@deepseek-ai\/(?:cordis(?:-[A-Za-z0-9._-]+)?|dsh(?:-[A-Za-z0-9._-]+)?))(?:\/[^'"]*)?)\1\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const dependency = runtimePackageName(match[2])
      if (dependency !== undefined) observedRuntimeImports.add(dependency)
    }
  }
  const schemasteryPatterns = [
    /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]{0,4096}?\bfrom\s+)?(['"])(@deepseek-ai\/schemastery(?:\/[^'"]*)?)\1/gm,
    /\bimport\s*\(\s*(['"])(@deepseek-ai\/schemastery(?:\/[^'"]*)?)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])(@deepseek-ai\/schemastery(?:\/[^'"]*)?)\1\s*\)/g,
  ]
  for (const pattern of schemasteryPatterns) {
    for (const match of code.matchAll(pattern)) observedShippedImports.add('@deepseek-ai/schemastery')
  }
}

function parseExactVersion(value) {
  if (typeof value !== 'string') return undefined
  const match = EXACT_VERSION_PATTERN.exec(value)
  if (match === null) return undefined
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4]?.split('.'),
  }
}

function comparePrerelease(left, right) {
  if (left === undefined) return right === undefined ? 0 : 1
  if (right === undefined) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index]
    const rightPart = right[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

function sameVersionCore(left, right) {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch
}

// npm SemVer excludes a prerelease from a comparator set unless that set has
// at least one prerelease comparator on the same major/minor/patch tuple.
function prereleaseAllowedByComparators(candidate, comparators) {
  if (candidate.prerelease === undefined) return true
  return comparators.some(comparator => (
    comparator.prerelease !== undefined && sameVersionCore(candidate, comparator)
  ))
}

function rangeContainsExact(range, version) {
  const candidate = parseExactVersion(version)
  if (candidate === undefined) return { supported: false, contains: false }
  const trimmed = range.trim()
  const exact = parseExactVersion(trimmed)
  if (exact !== undefined) return { supported: true, contains: compareVersions(candidate, exact) === 0 }

  const shorthand = /^([~^])(.*)$/.exec(trimmed)
  if (shorthand !== null) {
    const lower = parseExactVersion(shorthand[2])
    if (lower === undefined) return { supported: false, contains: false }
    let upper
    if (shorthand[1] === '~') {
      upper = { major: lower.major, minor: lower.minor + 1n, patch: 0n }
    } else if (lower.major > 0n) {
      upper = { major: lower.major + 1n, minor: 0n, patch: 0n }
    } else if (lower.minor > 0n) {
      upper = { major: 0n, minor: lower.minor + 1n, patch: 0n }
    } else {
      upper = { major: 0n, minor: 0n, patch: lower.patch + 1n }
    }
    return {
      supported: true,
      contains: compareVersions(candidate, lower) >= 0
        && compareVersions(candidate, upper) < 0
        && prereleaseAllowedByComparators(candidate, [lower]),
    }
  }

  if (trimmed.length === 0 || trimmed.includes('||') || /(?:^|[.\s])(?:x|X|\*)(?:$|[.\s])/.test(trimmed)) {
    return { supported: false, contains: false }
  }
  const comparators = trimmed.split(/\s+/)
  if (comparators.length === 0) return { supported: false, contains: false }
  let hasLowerBound = false
  let hasUpperBound = false
  const comparatorBounds = []
  for (const comparator of comparators) {
    const match = /^(<=|>=|<|>|=)?(.+)$/.exec(comparator)
    const bound = match === null ? undefined : parseExactVersion(match[2])
    if (match === null || bound === undefined) return { supported: false, contains: false }
    comparatorBounds.push(bound)
    const comparison = compareVersions(candidate, bound)
    const operator = match[1] ?? '='
    if (operator === '>' || operator === '>=') hasLowerBound = true
    else if (operator === '<' || operator === '<=') hasUpperBound = true
    else {
      hasLowerBound = true
      hasUpperBound = true
    }
    if (
      (operator === '<' && comparison >= 0)
      || (operator === '<=' && comparison > 0)
      || (operator === '>' && comparison <= 0)
      || (operator === '>=' && comparison < 0)
      || (operator === '=' && comparison !== 0)
    ) return { supported: true, contains: false }
  }
  if (!hasLowerBound || !hasUpperBound) return { supported: false, contains: false }
  return { supported: true, contains: prereleaseAllowedByComparators(candidate, comparatorBounds) }
}

function validateRuntimeDependencyPairs(manifest) {
  const peerDependencies = manifest.peerDependencies ?? {}
  const devDependencies = manifest.devDependencies ?? {}
  const declaredPeers = Object.keys(peerDependencies).filter(dependency => runtimePackageName(dependency) === dependency)
  const relevant = new Set([...declaredPeers, ...observedRuntimeImports, ...clientInjectedDependencies])
  const checkedDevDependencies = new Set()
  for (const dependency of relevant) {
    const clientDependency = clientInjectedDependencies.has(dependency)
    const pairCode = clientDependency ? 'client-inject-dependency' : 'runtime-pair'
    const peerSpecifier = peerDependencies[dependency]
    const hasPeer = typeof peerSpecifier === 'string'
    if (!hasPeer) {
      const reason = clientDependency ? 'is listed in dsh.client.inject' : 'is imported by shipped code'
      fail(pairCode, dependency + ' ' + reason + ' but is missing from peerDependencies')
    } else if (peerSpecifier.trim() === '*') {
      fail('runtime-version', 'peerDependencies.' + dependency + ' must not use the unrestricted * range')
    }
    const devSpecifier = devDependencies[dependency]
    checkedDevDependencies.add(dependency)
    if (typeof devSpecifier !== 'string') {
      fail(pairCode, dependency + ' must have an exact devDependency paired with its peerDependency')
      continue
    }
    if (parseExactVersion(devSpecifier) === undefined) {
      fail('runtime-version', 'devDependencies.' + dependency + ' must use one exact version')
      continue
    }
    if (hasPeer) {
      const compatibility = rangeContainsExact(peerSpecifier, devSpecifier)
      if (!compatibility.supported) {
        fail('runtime-range', 'peerDependencies.' + dependency + ' uses an unsupported or unbounded range; use exact, ^, ~, or a simple comparator set')
      } else if (!compatibility.contains) {
        fail(pairCode, 'peerDependencies.' + dependency + ' does not include devDependencies version ' + devSpecifier)
      } else {
        pass(pairCode, dependency + ' peer range includes exact dev version ' + devSpecifier)
      }
    }
    const expectedVersion = expectedRuntimeVersions.get(dependency)
    if (expectedVersion !== undefined && devSpecifier !== expectedVersion) {
      fail('runtime-baseline', 'devDependencies.' + dependency + ' is ' + devSpecifier + ' but --expect requires ' + expectedVersion)
    }
  }
  for (const [dependency, devSpecifier] of Object.entries(devDependencies)) {
    if (runtimePackageName(dependency) !== dependency) continue
    if (!checkedDevDependencies.has(dependency) && parseExactVersion(devSpecifier) === undefined) {
      fail('runtime-version', 'devDependencies.' + dependency + ' must use one exact version')
    }
    const expectedVersion = expectedRuntimeVersions.get(dependency)
    if (!checkedDevDependencies.has(dependency) && expectedVersion !== undefined && devSpecifier !== expectedVersion) {
      fail('runtime-baseline', 'devDependencies.' + dependency + ' is ' + devSpecifier + ' but --expect requires ' + expectedVersion)
    }
    if (peerDependencies[dependency] === undefined && !observedRuntimeImports.has(dependency)) {
      warn('runtime-dev-only', dependency + ' is dev-only; verify that it is limited to tests/build tooling and absent from shipped code')
    }
  }
  for (const [dependency, expectedVersion] of expectedRuntimeVersions) {
    if (!relevant.has(dependency) && devDependencies[dependency] === undefined) {
      warn('runtime-baseline-unused', '--expect ' + dependency + '=' + expectedVersion + ' did not match a relevant runtime dependency')
    }
  }

  if (observedShippedImports.has('@deepseek-ai/schemastery')) {
    const specifier = manifest.dependencies?.['@deepseek-ai/schemastery']
    if (parseExactVersion(specifier) === undefined) {
      fail('schemastery-dependency', 'Shipped @deepseek-ai/schemastery imports require dependencies["@deepseek-ai/schemastery"] to use one exact version')
    } else {
      pass('schemastery-dependency', 'Shipped @deepseek-ai/schemastery import is backed by exact dependency ' + specifier)
    }
  }
}

function inspectJavaScriptExports(source, label) {
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--experimental-vm-modules',
    '--input-type=commonjs',
    '-e',
    MODULE_INSPECTOR,
  ], {
    input: source,
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' },
    maxBuffer: 64 * 1024,
    timeout: 5000,
    windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) {
    fail('module-inspection', label + ' could not be parsed and linked without executing project code')
    return undefined
  }
  try {
    const value = JSON.parse(result.stdout)
    if (value === null || typeof value !== 'object' || !Array.isArray(value.exports) || !Array.isArray(value.imports)) {
      throw new TypeError()
    }
    if ([...value.exports, ...value.imports].some(name => typeof name !== 'string')) throw new TypeError()
    for (const specifier of value.imports) {
      const dependency = runtimePackageName(specifier)
      if (dependency !== undefined) observedRuntimeImports.add(dependency)
      if (specifier === '@deepseek-ai/schemastery' || specifier.startsWith('@deepseek-ai/schemastery/')) {
        observedShippedImports.add('@deepseek-ai/schemastery')
      }
    }
    pass('module-inspection', label + ' export surface was parsed without executing project code')
    return new Set(value.exports)
  } catch {
    fail('module-inspection', label + ' returned an invalid bounded-inspection result')
    return undefined
  }
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function defaultExportBinding(code) {
  const direct = /(?:^|[;}])\s*export\s+default\s+([A-Za-z_$][\w$]*)\b/m.exec(code)
  if (direct !== null && !['class', 'function', 'async'].includes(direct[1])) return direct[1]
  for (const match of code.matchAll(/(?:^|[;}])\s*export\s*\{([^}]*)\}/gm)) {
    for (const rawSpecifier of match[1].split(',')) {
      const alias = /^([A-Za-z_$][\w$]*)\s+as\s+default$/.exec(rawSpecifier.trim())
      if (alias !== null) return alias[1]
    }
  }
  return undefined
}

function callableBinding(code, binding) {
  const identifier = escapedRegExp(binding)
  return new RegExp('(?:^|[;}])\\s*(?:export\\s+)?(?:(?:abstract\\s+)?class|(?:async\\s+)?function)\\s+' + identifier + '\\b', 'm').test(code)
    || new RegExp('(?:^|[;}])\\s*(?:export\\s+)?(?:const|let|var)\\s+' + identifier
      + '(?:\\s*:\\s*[^=;\\n]{1,1024})?\\s*=\\s*(?:(?:async\\s+)?function\\b|class\\b|(?:async\\s+)?(?:\\([^;]{0,4096}\\)|[A-Za-z_$][\\w$]*)\\s*=>)', 'm').test(code)
}

function callableFunctionBinding(code, binding) {
  const identifier = escapedRegExp(binding)
  return new RegExp('(?:^|[;}])\\s*(?:export\\s+)?(?:async\\s+)?function\\s+' + identifier + '\\b', 'm').test(code)
    || new RegExp('(?:^|[;}])\\s*(?:export\\s+)?(?:const|let|var)\\s+' + identifier
      + '(?:\\s*:\\s*[^=;\\n]{1,1024})?\\s*=\\s*(?:(?:async\\s+)?function\\b|(?:async\\s+)?(?:\\([^;]{0,4096}\\)|[A-Za-z_$][\\w$]*)\\s*=>)', 'm').test(code)
}

function hasCallableNamedApply(code) {
  if (callableFunctionBinding(code, 'apply')
    && /(?:^|[;}])\s*export\s+(?:(?:async\s+)?function\s+apply\b|(?:const|let|var)\s+apply\b)/m.test(code)) {
    return true
  }
  for (const match of code.matchAll(/(?:^|[;}])\s*export\s*\{([^}]*)\}(\s*from\b)?/gm)) {
    if (match[2] !== undefined) continue
    for (const rawSpecifier of match[1].split(',')) {
      const specifier = rawSpecifier.trim()
      if (/^type\b/.test(specifier)) continue
      const alias = /^([A-Za-z_$][\w$]*)\s+as\s+apply$/.exec(specifier)
      const binding = alias?.[1] ?? (specifier === 'apply' ? 'apply' : undefined)
      if (binding !== undefined && callableFunctionBinding(code, binding)) return true
    }
  }
  return false
}

function objectLiteralHasCallableApply(code, start) {
  if (code[start] !== '{') return false
  const segments = []
  let segmentStart = start + 1
  let braces = 1
  let brackets = 0
  let parentheses = 0
  for (let index = start + 1; index < code.length && index - start <= 64 * 1024; index += 1) {
    const character = code[index]
    if (character === '{') braces += 1
    else if (character === '}') {
      braces -= 1
      if (braces === 0) {
        segments.push(code.slice(segmentStart, index))
        break
      }
    } else if (character === '[') brackets += 1
    else if (character === ']') brackets -= 1
    else if (character === '(') parentheses += 1
    else if (character === ')') parentheses -= 1
    else if (character === ',' && braces === 1 && brackets === 0 && parentheses === 0) {
      segments.push(code.slice(segmentStart, index))
      segmentStart = index + 1
    }
  }
  return segments.some(rawSegment => {
    const segment = rawSegment.trim()
    if (/^(?:async\s+)?(?:\*\s*)?apply\s*\([^)]{0,4096}\)\s*\{/m.test(segment)) return true
    if (/^apply\s*:\s*(?:async\s+)?function\b/m.test(segment)) return true
    if (/^apply\s*:\s*(?:async\s+)?(?:\([^)]{0,4096}\)|[A-Za-z_$][\w$]*)\s*=>/m.test(segment)) return true
    return segment === 'apply' && callableBinding(code, 'apply')
  })
}

function hasDefaultObjectPlugin(code) {
  const direct = /(?:^|[;}])\s*export\s+default\s*\{/gm.exec(code)
  if (direct !== null) {
    const brace = direct.index + direct[0].lastIndexOf('{')
    if (objectLiteralHasCallableApply(code, brace)) return true
  }
  const binding = defaultExportBinding(code)
  if (binding === undefined) return false
  const declaration = new RegExp('(?:^|[;}])\\s*(?:export\\s+)?(?:const|let|var)\\s+' + escapedRegExp(binding)
    + '(?:\\s*:\\s*[^=;\\n]{1,1024})?\\s*=\\s*\\{', 'gm').exec(code)
  if (declaration === null) return false
  return objectLiteralHasCallableApply(code, declaration.index + declaration[0].lastIndexOf('{'))
}

function hasCallableDefaultExport(code) {
  if (/(?:^|[;}])\s*export\s+default\s+(?:(?:async\s+)?function\b|class\b)/m.test(code)) return true
  if (/(?:^|[;}])\s*export\s+default\s+(?:async\s+)?(?:\([^;]{0,4096}\)|[A-Za-z_$][\w$]*)\s*=>/m.test(code)) return true
  const binding = defaultExportBinding(code)
  return (binding !== undefined && callableBinding(code, binding)) || hasDefaultObjectPlugin(code)
}

function applyAppearsToReceiveConfig(code) {
  const declarations = [
    /\bfunction\s+apply\s*\(([^)]{0,4096})\)/m,
    /\b(?:const|let|var)\s+apply\s*=\s*(?:async\s*)?\(([^)]{0,4096})\)\s*=>/m,
  ]
  return declarations.some(pattern => {
    const match = pattern.exec(code)
    return match !== null && match[1].includes(',')
  })
}

function likelyContextServices(code) {
  const contextMembers = new Set([
    'baseDir', 'caller', 'effect', 'emit', 'events', 'fiber', 'fork', 'get', 'inject', 'logger', 'on', 'parallel',
    'plugin', 'registry', 'root', 'scope', 'serial', 'set', 'state', 'waterfall',
  ])
  const candidates = new Set()
  for (const match of code.matchAll(/\bctx\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    if (!contextMembers.has(match[1])) candidates.add(match[1])
  }
  return [...candidates].sort()
}

function validateNamespaceModule(source, label, { allowEmptyPatchOnly = false, checkSyntax = false } = {}) {
  const inspectedNames = checkSyntax ? inspectJavaScriptExports(source, label) : undefined
  const code = maskCommentsAndStrings(source)
  const compact = code.replace(/\s+/g, '')
  if (allowEmptyPatchOnly && /^export\{\};?$/.test(compact)) {
    pass('patch-only-shim', label + ' is an explicit empty ESM shim for a patch-only Bundle')
    return 'patch-only'
  }

  const names = inspectedNames ?? exportedNames(code)
  const useInspectedNames = inspectedNames !== undefined
  const hasName = names.has('name') || (!useInspectedNames && /(?:^|[;}])\s*export\s+(?:declare\s+)?const\s+name\b/m.test(code))
  const hasApply = names.has('apply') || (!useInspectedNames && /(?:^|[;}])\s*export\s+(?:(?:async\s+)?function\s+apply\b|(?:const|let|var)\s+apply\b)/m.test(code))
  const hasDefault = names.has('default') || (!useInspectedNames && /(?:^|[;}])\s*export\s+default\b/m.test(code))
  const hasInject = names.has('inject') || (!useInspectedNames && /(?:^|[;}])\s*export\s+const\s+inject\b/m.test(code))
  const hasConfig = names.has('Config') || (!useInspectedNames && /(?:^|[;}])\s*export\s+(?:declare\s+)?const\s+Config\b/m.test(code))

  if (hasDefault) {
    if (hasApply) {
      fail('mixed-plugin-exports', label + ' combines a default Loader entry with a named apply export')
      return 'invalid'
    }
    if (!hasCallableDefaultExport(code)) {
      fail('default-plugin', label + ' default export could not be statically confirmed as a class, function, or object with callable apply')
      return 'invalid'
    }
    pass('default-plugin', label + ' has a default class/function or an object with callable apply')
    if (hasInject || hasConfig) {
      const siblings = [hasInject ? 'inject' : undefined, hasConfig ? 'Config' : undefined].filter(Boolean)
      warn('default-sibling-metadata', label + ' exports default with sibling named ' + siblings.join(' and ')
        + '; the Loader uses the default entry and does not attach sibling metadata, so move required metadata onto the default')
    }
    if (hasConfig) {
      warn('config-static-only', label + ' visibly exports Config, but static validation cannot prove Standard Schema conformance or runtime normalization')
    }
    return 'default-plugin'
  }

  if (!hasApply) {
    fail('plugin-export', label + ' must be an explicit patch-only shim, a named apply namespace, or a valid default plugin')
    return 'invalid'
  }
  if (!hasCallableNamedApply(code)) {
    fail('namespace-apply', label + ' named apply export could not be statically confirmed as a local function or arrow function')
    return 'invalid'
  }
  pass('namespace-apply', label + ' has a statically callable local named apply export')
  if (hasName) pass('namespace-name', label + ' has an optional name export')
  else pass('namespace-name', label + ' omits the optional name export')
  if (!hasInject) {
    const candidates = likelyContextServices(code)
    if (candidates.length > 0) {
      warn('service-inject-heuristic', label + ' accesses possible ctx services without a visible inject export: ' + candidates.join(', '))
    } else {
      warn('inject', label + ' has no inject export; verify that it accesses no injected service')
    }
  }
  if (!hasConfig && applyAppearsToReceiveConfig(code)) {
    warn('config-heuristic', label + ' apply appears to accept configuration but has no visible Config export')
  } else if (hasConfig) {
    warn('config-static-only', label + ' visibly exports Config, but static validation cannot prove Standard Schema conformance or runtime normalization')
  }
  return 'namespace-plugin'
}

let root
try {
  root = await realpath(report.root)
  report.root = root
  const rootStats = await lstat(root)
  if (!rootStats.isDirectory()) {
    fail('plugin-root', 'Plugin root is not a directory')
    root = undefined
  }
} catch {
  fail('plugin-root', 'Plugin directory cannot be resolved')
}

if (root !== undefined) {
  frozenRoot = root
  frozenTree = enumerateTree(root, { initial: true })
  if (frozenTree !== undefined) {
    frozenEntries = new Map(frozenTree.entries.map(entry => [entry.path, entry]))
  }
  const parsedManifest = frozenTree === undefined
    ? undefined
    : await readJson(root, join(root, 'package.json'), 'package.json')
  const manifest = parsedManifest !== null && !Array.isArray(parsedManifest) && typeof parsedManifest === 'object'
    ? parsedManifest
    : undefined
  if (parsedManifest !== undefined && manifest === undefined) {
    fail('manifest-shape', 'package.json must contain a JSON object')
  }
  if (manifest !== undefined) {
    if (!validPackageName(manifest.name)) {
      fail('package-name', 'package.json name must be a lowercase npm-compatible package name')
    } else {
      pass('package-name', 'Package name: ' + manifest.name)
    }

    if (parseExactVersion(manifest.version) === undefined) {
      fail('package-version', 'package.json version must be one exact semantic version')
    } else {
      pass('package-version', 'Package version: ' + manifest.version)
    }

    for (const groupName of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const group = manifest[groupName]
      if (group !== undefined && (group === null || Array.isArray(group) || typeof group !== 'object')) {
        fail('dependency-shape', 'package.json ' + groupName + ' must be an object when present')
      }
    }

    if (manifest.type !== 'module') fail('esm', 'package.json must declare "type": "module"')
    else pass('esm', 'Package is ESM')

    const ownPackageMounts = new Set()
    const mountingOwnPackageMounts = new Set()
    let patchReferencesOwnPackage = false
    let patchReferencesOwnRoot = false
    let dshManifest
    if (manifest.dsh !== undefined) {
      if (manifest.dsh === null || Array.isArray(manifest.dsh) || typeof manifest.dsh !== 'object') {
        fail('dsh-manifest', 'package.json dsh must be an object when present')
      } else {
        dshManifest = manifest.dsh
      }
    }
    let clientDeclaration
    let clientManifestValid = false
    if (dshManifest !== undefined && Object.hasOwn(dshManifest, 'client')) {
      if (dshManifest.client === null || Array.isArray(dshManifest.client) || typeof dshManifest.client !== 'object') {
        fail('client-manifest', 'dsh.client must be an object')
      } else {
        clientDeclaration = dshManifest.client
        let declarationValid = true
        if (clientDeclaration.platform !== 'web') {
          fail('client-platform', 'dsh.client.platform must be "web"')
          declarationValid = false
        } else {
          pass('client-platform', 'dsh.client.platform is web')
        }
        declarationValid = validateClientStringArray(clientDeclaration.inject, 'dsh.client.inject', {
          packageNames: true,
          collect: clientInjectedDependencies,
        }) && declarationValid
        declarationValid = validateClientStringArray(clientDeclaration.external, 'dsh.client.external') && declarationValid
        if (clientDeclaration.immediately !== undefined && typeof clientDeclaration.immediately !== 'boolean') {
          fail('client-manifest', 'dsh.client.immediately must be a boolean when present')
          declarationValid = false
        }
        clientManifestValid = declarationValid
      }
    }
    let patchRelative
    if (dshManifest !== undefined && Object.hasOwn(dshManifest, 'bundle')) {
      const bundleDeclaration = dshManifest.bundle
      if (bundleDeclaration === null || Array.isArray(bundleDeclaration) || typeof bundleDeclaration !== 'object') {
        fail('bundle-manifest', 'dsh.bundle must be an object')
      } else if (!Object.hasOwn(bundleDeclaration, 'patch')) {
        fail('bundle-manifest', 'dsh.bundle.patch is required when dsh.bundle is declared')
      } else {
        patchRelative = safeRelativePath(bundleDeclaration.patch, 'dsh.bundle.patch')
      }
    }
    if (patchRelative !== undefined) {
      const patchPath = resolve(root, patchRelative)
      if (!withinRoot(root, patchPath)) {
        fail('bundle-patch', 'Bundle patch resolves outside the package root')
      } else {
        const patchText = await readSafeText(root, patchPath, 'Bundle patch')
        if (patchText !== undefined) {
          pass('bundle-patch', 'Bundle patch exists and passed the file-boundary check')
          if (typeof manifest.name === 'string') {
            const patchNames = patchPackageNames(patchText)
            for (const specifier of patchNames.names) {
              if (specifier === manifest.name || specifier.startsWith(manifest.name + '/')) ownPackageMounts.add(specifier)
            }
            for (const specifier of patchNames.mountingNames) {
              if (specifier === manifest.name || specifier.startsWith(manifest.name + '/')) mountingOwnPackageMounts.add(specifier)
            }
          }
          patchReferencesOwnPackage = ownPackageMounts.size > 0
          patchReferencesOwnRoot = typeof manifest.name === 'string' && ownPackageMounts.has(manifest.name)
          if (typeof manifest.name === 'string' && !patchReferencesOwnPackage) {
            warn('patch-package-name', 'Bundle patch does not visibly reference its own package name; verify this is an intentional patch-only bundle')
          }
          if (!/^\s*-\s+(?:(['"])(?:insert|remove|replace|patch)\1|(?:insert|remove|replace|patch))\s*:/m.test(patchText)) {
            warn('patch-shape', 'Bundle patch lacks an obvious top-level patch operation; validate it through the real DSH loader')
          }
        }
      }
    }

    if (clientManifestValid && mountingOwnPackageMounts.size === 0) {
      fail('client-bundle', 'A valid dsh.client declaration requires a Bundle patch that inserts or replaces this package root or an exported package subpath')
    } else if (clientManifestValid) {
      pass('client-bundle', 'Bundle patch mounts this client package root or an exported package subpath')
    }

    const mainRelative = manifest.main === undefined ? undefined : safeRelativePath(manifest.main, 'main')
    const typesRelative = manifest.types === undefined ? undefined : safeRelativePath(manifest.types, 'types')
    let defaultExportRelative
    let typesExportRelative
    let clientExportRelative
    let dotExport
    let exportsShapeHandled = false
    const exportsField = manifest.exports
    const hasClientExport = exportsField !== null && !Array.isArray(exportsField) && typeof exportsField === 'object'
      && Object.hasOwn(exportsField, './client')
    if (hasClientExport && !clientManifestValid) {
      fail('client-manifest', 'exports["./client"] requires a valid dsh.client declaration')
    }
    if (clientDeclaration !== undefined) {
      clientExportRelative = resolveClientExportTarget(exportsField)
    }
    const allExportTargets = exportsField === undefined
      ? new Set()
      : collectExportTargets(exportsField, 'exports')
    if (typeof exportsField === 'string') {
      dotExport = exportsField
    } else if (exportsField === null || Array.isArray(exportsField) || (exportsField !== undefined && typeof exportsField !== 'object')) {
      fail('exports', 'package.json exports must be a string or object when present')
      exportsShapeHandled = true
    } else if (exportsField !== undefined) {
      if (Object.hasOwn(exportsField, '.')) {
        dotExport = exportsField['.']
      } else if (Object.keys(exportsField).every(key => !key.startsWith('.'))) {
        dotExport = exportsField
      } else {
        const message = 'package.json exports has subpaths but no root export'
        if (patchReferencesOwnRoot) fail('exports-root', message)
        else if (!patchReferencesOwnPackage) warn('exports-root', message + '; verify this is an intentional patch-only Bundle')
        exportsShapeHandled = true
      }
    }
    if (exportsShapeHandled) {
      // The root export outcome was already reported above.
    } else if (dotExport === undefined) {
      warn('exports', 'package.json exports["."] is recommended for a typed or multi-entry package')
    } else if (typeof dotExport === 'string') {
      defaultExportRelative = safeExportPath(dotExport, 'exports["."]')
      if (mainRelative !== undefined && defaultExportRelative !== undefined && defaultExportRelative !== mainRelative) {
        warn('exports-default', 'String exports["."] does not match main')
      }
    } else if (dotExport === null || Array.isArray(dotExport) || typeof dotExport !== 'object') {
      fail('exports', 'package.json exports["."] must be a string or object when present')
    } else {
      if (typeof dotExport.default !== 'string') {
        fail('exports-default', 'exports["."].default is missing')
      } else {
        defaultExportRelative = safeExportPath(dotExport.default, 'exports["."].default')
        if (mainRelative !== undefined && defaultExportRelative !== undefined && defaultExportRelative !== mainRelative) {
          warn('exports-default', 'exports["."].default does not match main')
        }
      }
      if (typesRelative !== undefined && typeof dotExport.types !== 'string') {
        fail('exports-types', 'types is declared but exports["."].types is missing')
      } else if (typeof dotExport.types === 'string') {
        typesExportRelative = safeExportPath(dotExport.types, 'exports["."].types')
        if (typesRelative !== undefined && typesExportRelative !== undefined && typesExportRelative !== typesRelative) {
          warn('exports-types', 'exports["."].types does not match types')
        }
      }
    }

    const mountedModuleTargets = new Map()
    for (const specifier of ownPackageMounts) {
      const exportKey = specifier === manifest.name ? '.' : './' + specifier.slice(manifest.name.length + 1)
      let resolved
      if (exportsField === undefined && exportKey === '.' && mainRelative !== undefined) {
        resolved = { found: true, targets: new Set([mainRelative]) }
      } else {
        resolved = resolveExportKey(exportsField, exportKey, 'exports[' + JSON.stringify(exportKey) + ']')
      }
      if (!resolved.found || resolved.targets.size === 0) {
        fail('mounted-export', 'Bundle patch mounts ' + specifier + ' but package.json exports does not resolve that module')
        continue
      }
      for (const target of resolved.targets) {
        mountedModuleTargets.set(target, 'mounted module ' + specifier)
      }
    }

    if (patchReferencesOwnPackage && !patchReferencesOwnRoot) {
      pass('subpath-entry', 'Bundle mounts only explicitly exported plugin subpaths')
    } else {
      const sourceCandidates = [
        join(root, 'src', 'index.ts'),
        join(root, 'src', 'index.mts'),
        join(root, 'src', 'index.js'),
        join(root, 'index.mjs'),
        join(root, 'index.js'),
      ]
      for (const value of [mainRelative, defaultExportRelative]) {
        if (value !== undefined) sourceCandidates.push(resolve(root, value))
      }
      const sourceEntry = await firstExisting(sourceCandidates)
      if (sourceEntry === undefined && mainRelative === undefined && defaultExportRelative === undefined) {
        if (patchReferencesOwnRoot) {
          fail('source-entry', 'Bundle patch references its own package but no plugin module entry is declared')
        } else if (patchRelative !== undefined) {
          pass('patch-only', 'Bundle intentionally has no plugin module entry')
        } else {
          fail('source-entry', 'Package declares neither a Loader module entry nor a Bundle patch')
        }
      } else if (sourceEntry === undefined) {
        fail('source-entry', 'No declared or conventional plugin source entry was found')
      } else {
        if (mainRelative === undefined && defaultExportRelative === undefined) {
          const message = 'Plugin source exists but package.json declares no main or exports["."] entry'
          if (requireBuilt) fail('module-entry', message)
          else warn('module-entry', message)
        }
        const source = await readSafeText(root, sourceEntry, 'Plugin source entry')
        if (source !== undefined) {
          validateNamespaceModule(source, 'Plugin source entry', {
            allowEmptyPatchOnly: patchRelative !== undefined && !patchReferencesOwnPackage,
          })
        }
      }
    }

    if (!requireBuilt) {
      for (const [value, label] of mountedModuleTargets) {
        const target = resolve(root, value)
        if (!(await exists(target))) {
          warn('mounted-module', label + ' is not built yet; rerun with --built after packaging')
          continue
        }
        const source = await readSafeText(root, target, label)
        if (source !== undefined) validateNamespaceModule(source, label, { allowEmptyPatchOnly: false })
      }
    }

    const files = Array.isArray(manifest.files) ? manifest.files : []
    if (manifest.files === undefined) {
      const message = 'package.json needs an explicit files allowlist for release-surface validation'
      if (requireBuilt) fail('files-allowlist', message)
      else warn('files-allowlist', message)
    } else if (!Array.isArray(manifest.files)) {
      fail('files-shape', 'package.json files must be an array when present')
    }
    const normalizedFiles = new Set()
    const normalizedFileValues = []
    for (const [index, value] of files.entries()) {
      const candidate = typeof value === 'string' ? value.replace(/[\\/]+$/, '') : value
      const normalized = safeRelativePath(candidate, 'files[' + index + ']')
      if (normalized !== undefined) {
        const fileValue = normalized.replace(/\/$/, '')
        normalizedFiles.add(fileValue)
        normalizedFileValues.push(fileValue)
      }
    }
    const binField = manifest.bin
    const rawBinTargets = typeof binField === 'string'
      ? [binField]
      : binField !== null && typeof binField === 'object' && !Array.isArray(binField)
        ? Object.values(binField)
        : []
    const binTargets = rawBinTargets
      .map((value, index) => safeRelativePath(value, 'bin[' + index + ']'))
      .filter(value => value !== undefined)
    configureShippedImportMatchers([
      ...normalizedFileValues,
      ...allExportTargets,
      ...binTargets,
      mainRelative,
      typesRelative,
    ].filter(value => value !== undefined))
    configureReleaseScanMatchers([
      ...normalizedFileValues,
      ...allExportTargets,
      ...binTargets,
      ...mountedModuleTargets.keys(),
      mainRelative,
      typesRelative,
      patchRelative,
      ...(requireBuilt ? ['dist'] : []),
    ].filter(value => value !== undefined))
    if (mainRelative?.startsWith('dist/') && !normalizedFiles.has('dist')) {
      warn('files-dist', 'Built entry is under dist but package.json files does not include dist')
    }
    if (patchRelative !== undefined && !normalizedFiles.has(patchRelative)) {
      warn('files-patch', 'package.json files does not explicitly include the bundle patch')
    }

    if (requireBuilt) {
      const builtTargets = new Map()
      for (const [label, value, moduleEntry] of [
        ['main', mainRelative, true],
        ['types', typesRelative, false],
        ['exports default', defaultExportRelative, true],
        ['exports types', typesExportRelative, false],
        ['client export', clientExportRelative, false],
      ]) {
        if (value === undefined) continue
        const existing = builtTargets.get(value)
        if (existing === undefined) builtTargets.set(value, { label, moduleEntry })
        else existing.moduleEntry ||= moduleEntry
      }
      for (const value of allExportTargets) {
        if (value.includes('*')) continue
        if (!builtTargets.has(value)) builtTargets.set(value, { label: 'exports target', moduleEntry: false })
      }
      for (const [value, label] of mountedModuleTargets) {
        const existing = builtTargets.get(value)
        if (existing === undefined) builtTargets.set(value, { label, moduleEntry: true })
        else existing.moduleEntry = true
      }
      for (const value of binTargets) {
        if (!builtTargets.has(value)) builtTargets.set(value, { label: 'bin target', moduleEntry: false })
      }
      for (const [value, targetInfo] of builtTargets) {
        const { label, moduleEntry } = targetInfo
        const target = resolve(root, value)
        if (!withinRoot(root, target)) fail('built-path', label + ' resolves outside the package root')
        else if (moduleEntry) {
          const builtSource = await readSafeText(root, target, 'Built ' + label + ' artifact')
          if (builtSource !== undefined) {
            pass('built-artifact', 'Built ' + label + ' artifact exists')
            validateNamespaceModule(builtSource, 'Built ' + label + ' artifact', {
              allowEmptyPatchOnly: patchRelative !== undefined && !patchReferencesOwnPackage,
              checkSyntax: true,
            })
          }
        } else if (await regularFileWithinRoot(root, target, 'Built ' + label + ' artifact')) {
          pass('built-artifact', 'Built ' + label + ' artifact exists')
        }
      }
    }

    const scripts = manifest.scripts ?? {}
    for (const name of ['build', 'typecheck', 'test', 'check', 'prepare', 'prepack']) {
      if (typeof scripts[name] !== 'string' || scripts[name].trim().length === 0) {
        warn('script', 'Recommended package script is missing: ' + name)
      }
    }

    const isRuntimePackage = dependency => runtimePackageName(dependency) === dependency
    const dependencies = manifest.dependencies ?? {}
    for (const dependency of Object.keys(dependencies)) {
      if (isRuntimePackage(dependency)) {
        fail('runtime-dependency', dependency + ' is in dependencies; Harness runtime packages belong in a compatible peerDependency plus an exact devDependency')
      }
    }
    for (const groupName of ['dependencies', 'optionalDependencies']) {
      const group = manifest[groupName] ?? {}
      for (const [dependency, specifier] of Object.entries(group)) {
        if (parseExactVersion(specifier) === undefined) {
          fail('dependency-version', groupName + '.' + dependency + ' is plugin-owned runtime code and must use one exact semantic version')
        } else {
          pass('dependency-version', groupName + '.' + dependency + ' uses exact version ' + specifier)
        }
      }
    }
    for (const groupName of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const group = manifest[groupName] ?? {}
      for (const [dependency, specifier] of Object.entries(group)) {
        if (dependency === '@deepseek-ai/schemastery' && typeof specifier === 'string' && specifier.trim() === '*') {
          fail('runtime-version', groupName + '.' + dependency + ' must not use the unrestricted * range')
        }
        if (typeof specifier === 'string' && /^(?:file:|git\+file:|link:|workspace:|portal:|catalog:|patch:|\.{1,2}(?:[\\/]|$)|[\\/]{1,2}|[A-Za-z]:[\\/])/i.test(specifier)) {
          fail('local-dependency', groupName + '.' + dependency + ' uses a local-only specifier')
        }
      }
    }

    for (const recommended of ['README.md', 'LICENSE']) {
      if (!(await exists(join(root, recommended)))) warn('recommended-file', recommended + ' is missing')
    }
    const packageManagerMatch = typeof manifest.packageManager === 'string'
      ? /^([a-z0-9][a-z0-9._-]*)@(.+)$/.exec(manifest.packageManager)
      : undefined
    if (manifest.packageManager !== undefined
      && (packageManagerMatch == null || parseExactVersion(packageManagerMatch[2]) === undefined)) {
      fail('package-manager', 'packageManager must pin one exact semantic version, for example npm@10.9.3 or pnpm@10.4.1')
    }
    const expectedLockfile = packageManagerMatch?.[1] === 'npm'
      ? 'package-lock.json'
      : packageManagerMatch?.[1] === 'pnpm'
        ? 'pnpm-lock.yaml'
        : packageManagerMatch?.[1] === 'yarn'
          ? 'yarn.lock'
          : undefined
    if (!installedArtifact) {
      if (expectedLockfile !== undefined) {
        if (!(await exists(join(root, expectedLockfile)))) warn('recommended-file', expectedLockfile + ' is missing for ' + manifest.packageManager)
      } else if (!(await exists(join(root, 'package-lock.json')))
        && !(await exists(join(root, 'pnpm-lock.yaml')))
        && !(await exists(join(root, 'yarn.lock')))) {
        warn('recommended-file', 'a committed package-manager lockfile is missing')
      }
    }
    if (!(await exists(join(root, 'SECURITY.md')))) {
      warn('security-doc', 'SECURITY.md is recommended for plugins using host powers, credentials, persistence, or providers')
    }
  }

  const scanErrorsBeforeWalk = report.errors.length
  const textFiles = frozenTree === undefined ? [] : textFilesFromFrozenTree(root)
  let scanComplete = frozenTree !== undefined && report.errors.length === scanErrorsBeforeWalk
  let scannedFiles = 0
  for (const path of textFiles) {
    const text = await readSafeText(root, path, 'Scan file ' + relative(root, path))
    if (text === undefined) {
      scanComplete = false
      continue
    }
    scannedFiles += 1
    const relativePath = relative(root, path)
    if (shouldInspectRuntimeImports(relativePath)) recordRuntimeImports(text)
    for (const [label, pattern] of SECRET_PATTERNS) {
      if (pattern.test(text)) fail('secret-pattern', label + ' pattern found in ' + relativePath)
    }
    for (const [label, pattern] of LOCAL_PATH_PATTERNS) {
      if (pattern.test(text)) fail('local-path', label + ' path found in ' + relativePath)
    }
  }
  if (manifest !== undefined) validateRuntimeDependencyPairs(manifest)
  if (frozenTree !== undefined) {
    const finalTree = enumerateTree(root)
    if (finalTree === undefined || JSON.stringify(finalTree) !== JSON.stringify(frozenTree)) {
      if (finalTree !== undefined) fail('tree-race', 'Plugin tree changed during validation')
      scanComplete = false
    } else {
      pass('tree-stability', 'Plugin tree matched the frozen snapshot after validation')
    }
  }
  if (scanComplete && !report.errors.some(item => item.code === 'secret-pattern')) {
    pass('secret-scan', 'No high-confidence secret pattern found in ' + scannedFiles + ' scanned text files')
  }
  if (scanComplete && !report.errors.some(item => item.code === 'local-path')) {
    pass('local-path-scan', 'No user-home absolute path found in ' + scannedFiles + ' scanned text files')
  }
}

if (jsonOutput) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} else {
  const lines = []
  for (const item of report.checks) lines.push('PASS ' + item.code + ': ' + item.message)
  for (const item of report.warnings) lines.push('WARN ' + item.code + ': ' + item.message)
  for (const item of report.errors) lines.push('ERROR ' + item.code + ': ' + item.message)
  lines.push(report.errors.length === 0 ? 'DSH_PLUGIN_VALIDATION_OK' : 'DSH_PLUGIN_VALIDATION_FAILED')
  process.stdout.write(lines.join('\n') + '\n')
}

process.exit(report.errors.length === 0 ? 0 : 1)
