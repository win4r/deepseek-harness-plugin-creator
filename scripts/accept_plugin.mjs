#!/usr/bin/env node

/**
 * Acceptance helper for external DeepSeek Harness plugins.
 *
 * Default mode delegates only to the static validator and never imports the
 * candidate or runs its package scripts. --trusted-execute is an explicit
 * trust decision: it runs the candidate's check/prepack scripts, creates an
 * exact tarball, and accepts that tarball in a temporary DSH_HOME.
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_FILE = fileURLToPath(import.meta.url)
const VALIDATOR = path.join(SCRIPT_DIR, 'validate_plugin.mjs')
const TREE_ENUMERATOR = path.join(SCRIPT_DIR, 'enumerate_tree.py')
const SYSTEM_PYTHON = '/usr/bin/python3'
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024
const MAX_TREE_CAPTURE_BYTES = 64 * 1024 * 1024
const MAX_PACK_JSON_CANDIDATES = 64
const FILE_COPY_BUFFER_BYTES = 1024 * 1024
const MAX_PACKED_ARTIFACT_BYTES = 512n * 1024n * 1024n
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const FORWARDED_ENVIRONMENT_KEYS = [
  'COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'PATHEXT',
  'SHELL', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'USER', 'WINDIR',
]
const PACKAGE_MANAGER_MANUAL_GATE = 'Automatic trusted acceptance requires package.json#packageManager to be exactly npm@<version> or pnpm@<version>, and the matching CLI must report that exact version. Otherwise keep to static validation and manually review the intended package-manager binary, candidate lifecycle scripts, packed tarball, and fresh-Profile gate.'
const INSTALLED_TREE_SNAPSHOT = Symbol('installedTreeSnapshot')

function safeDiagnostic(value, limit = 8192) {
  const escaped = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]|\p{Cf}/gu, character => {
    if (character === '\n') return '\n'
    if (character === '\t') return '\t'
    const point = character.codePointAt(0)
    return point <= 0xffff
      ? `\\u${point.toString(16).padStart(4, '0')}`
      : `\\u{${point.toString(16)}}`
  })
  return escaped.length <= limit ? escaped : `${escaped.slice(0, limit)}...`
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function fail(message, code = 1) {
  const error = new Error(message)
  error.exitCode = code
  throw error
}

function usage() {
  return `Usage: node accept_plugin.mjs <plugin-dir> [options]

Options:
  --trusted-execute          Run candidate scripts, pack, and isolated DSH boot
  --pack-only                With --trusted-execute, stop after build/pack
  --pack-destination <dir>   Empty directory for the tarball (default: temp dir)
  --dsh-bin <path>           DSH executable or lib/bin.js for fresh acceptance
  --profile <name>           Acceptance Profile (default: web; boot supports web)
  --timeout-ms <number>      Per install/readiness bound (default: 180000)
  --keep-dsh-home            Keep the temporary acceptance DSH_HOME
  --json                     Print the final report as JSON
  -h, --help                 Show this help

Without --trusted-execute this command performs static validation only and does
not import the plugin, run package scripts, pack it, install it, or boot DSH.
`
}

function parseArgs(argv) {
  const options = {
    trustedExecute: false,
    packOnly: false,
    keepDshHome: false,
    json: false,
    profile: 'web',
    timeoutMs: 180_000,
  }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--trusted-execute') options.trustedExecute = true
    else if (argument === '--pack-only') options.packOnly = true
    else if (argument === '--keep-dsh-home') options.keepDshHome = true
    else if (argument === '--json') options.json = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else if (['--pack-destination', '--dsh-bin', '--profile', '--timeout-ms'].includes(argument)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail(`${argument} requires a value`, 64)
      if (argument === '--pack-destination') options.packDestination = value
      else if (argument === '--dsh-bin') options.dshBin = value
      else if (argument === '--profile') options.profile = value
      else options.timeoutMs = Number(value)
      index += 1
    } else if (argument.startsWith('-')) fail(`unknown option: ${safeDiagnostic(argument)}`, 64)
    else positional.push(argument)
  }
  if (!options.help && positional.length !== 1) fail('exactly one plugin directory is required', 64)
  if (positional.length > 1) fail(`unexpected argument: ${safeDiagnostic(positional[1])}`, 64)
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 5_000 || options.timeoutMs > 600_000) {
    fail('--timeout-ms must be an integer from 5000 through 600000', 64)
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(options.profile) || options.profile.includes('..')) {
    fail('--profile must be a short name, not a path', 64)
  }
  if ((options.packOnly || options.packDestination !== undefined || options.keepDshHome || options.dshBin !== undefined) && !options.trustedExecute) {
    fail('execution and packaging options require --trusted-execute', 64)
  }
  if (options.packOnly && options.keepDshHome) {
    fail('--keep-dsh-home cannot be used with --pack-only because no automatic acceptance DSH_HOME is created', 64)
  }
  options.pluginDir = positional[0]
  return options
}

function readManifest(root) {
  const file = path.join(root, 'package.json')
  const stats = lstatSync(file)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1_000_000) fail('package.json must be a small regular file')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  if (manifest === null || Array.isArray(manifest) || typeof manifest !== 'object') fail('package.json must contain an object')
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) fail('package.json name is missing')
  if (typeof manifest.version !== 'string' || !EXACT_VERSION.test(manifest.version)) fail('package.json version must be exact semantic version')
  return manifest
}

/**
 * Package checks still execute trusted host code, but they do not need the
 * caller's provider/API credentials or process-injection variables. Forward a
 * small operating environment and let npm add its own lifecycle variables.
 */
function minimalEnvironment(extra = {}) {
  const environment = { NO_COLOR: '1' }
  for (const key of FORWARDED_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  return { ...environment, ...extra }
}

function boundedRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeoutMs,
    maxBuffer: MAX_CAPTURE_BYTES,
    windowsHide: true,
  })
  if (options.echo && result.stdout) process.stdout.write(result.stdout)
  if (options.echo && result.stderr) process.stderr.write(result.stderr)
  if (result.error !== undefined) fail(`${options.label} failed: ${safeDiagnostic(result.error.message)}`)
  if (result.status !== 0) {
    const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    fail(`${options.label} exited with ${result.status}${details ? `\n${safeDiagnostic(details)}` : ''}`)
  }
  return result
}

function runStaticValidator(root, { built, json, timeoutMs, installedArtifact = false }) {
  const args = [VALIDATOR, root]
  if (built) args.push('--built')
  if (installedArtifact) args.push('--installed-artifact')
  if (json) args.push('--json')
  const result = boundedRun(process.execPath, args, {
    label: built ? 'built static validator' : 'static validator',
    timeoutMs,
    echo: !json,
  })
  if (!json) return undefined
  try {
    return JSON.parse(result.stdout)
  } catch {
    fail('static validator returned invalid JSON')
  }
}

function ensureEmptyPackDestination(value) {
  if (value === undefined) return mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-pack-'))
  const requested = path.resolve(value)
  mkdirSync(requested, { recursive: true })
  const real = realpathSync(requested)
  const stats = lstatSync(real)
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail('pack destination must be a real directory')
  if (readdirSync(real).length !== 0) fail('pack destination must be empty to prevent artifact overwrite')
  return real
}

export function parsePackResult(stdout, packageManager) {
  const trimmed = stdout.trimEnd()
  const expectedStart = packageManager === 'npm' ? '[' : '{'
  const starts = []
  // npm and pnpm print their final JSON document at column zero. Retain only a
  // fixed number of such line starts so hostile lifecycle output cannot cause
  // JSON.parse to revisit an unbounded number of overlapping suffixes.
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== expectedStart || (index !== 0 && trimmed[index - 1] !== '\n')) continue
    starts.push(index)
    if (starts.length > MAX_PACK_JSON_CANDIDATES) starts.shift()
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const start = starts[index]
    try {
      const parsed = JSON.parse(trimmed.slice(start))
      if (packageManager === 'npm' && Array.isArray(parsed) && parsed.length === 1 && parsed[0] !== null && typeof parsed[0] === 'object') {
        return parsed[0]
      }
      if (packageManager === 'pnpm' && parsed !== null && !Array.isArray(parsed) && typeof parsed === 'object') {
        return parsed
      }
    } catch {
      // Lifecycle output may precede the package manager's final JSON document.
    }
  }
  fail(`${packageManager} pack did not return its expected single JSON ${packageManager === 'npm' ? 'array result' : 'object result'}`)
}

function fileFingerprint(stats) {
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  }
}

function sameFingerprint(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function metadataSnapshotMatchesStats(snapshot, stats) {
  return snapshot.dev === stats.dev.toString()
    && snapshot.ino === stats.ino.toString()
    && snapshot.mode === stats.mode.toString()
    && snapshot.nlink === stats.nlink.toString()
    && snapshot.size === stats.size.toString()
    && snapshot.mtimeNs === stats.mtimeNs.toString()
    && snapshot.ctimeNs === stats.ctimeNs.toString()
}

function parseInstalledTreeMetadataSnapshot(text) {
  const value = JSON.parse(text)
  if (value === null || Array.isArray(value) || typeof value !== 'object'
    || !Array.isArray(value.directories) || !Array.isArray(value.entries)) {
    fail('installed-tree descriptor helper returned an invalid snapshot')
  }
  const root = value.directories.find(item => item?.path === '')
  const validSnapshot = snapshot => snapshot !== null
    && !Array.isArray(snapshot)
    && typeof snapshot === 'object'
    && ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
      .every(key => typeof snapshot[key] === 'string' && /^-?\d+$/.test(snapshot[key]))
  if (root === undefined || !validSnapshot(root.snapshot)
    || value.directories.some(item => item === null || typeof item !== 'object' || !validSnapshot(item.snapshot))
    || value.entries.some(item => item === null || typeof item !== 'object' || !validSnapshot(item.snapshot))) {
    fail('installed-tree descriptor helper returned malformed metadata')
  }
  return value
}

/** Capture a bounded descriptor-walk metadata snapshot. metadataSha256 hashes
 * only the canonical path/stat JSON; it is deliberately not a file-content
 * digest. The raw snapshot is symbol-keyed so reports cannot serialize it. */
export function captureInstalledTreeMetadataGuard(installedRoot, timeoutMs = 30_000) {
  const canonicalRoot = realpathSync(installedRoot)
  if (canonicalRoot !== installedRoot) fail('installed-tree guard requires the canonical installed package root')
  const rootBefore = lstatSync(canonicalRoot, { bigint: true })
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) fail('installed-tree guard root must be a real directory')
  const result = spawnSync(SYSTEM_PYTHON, ['-I', '-S', TREE_ENUMERATOR, canonicalRoot, '1'], {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' },
    shell: false,
    timeout: Math.min(timeoutMs, 30_000),
    maxBuffer: MAX_TREE_CAPTURE_BYTES,
    windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) {
    fail(`installed-tree descriptor helper failed: ${safeDiagnostic(result.error?.message ?? `exit ${result.status}`)}`)
  }
  const snapshot = parseInstalledTreeMetadataSnapshot(result.stdout)
  const rootEntry = snapshot.directories.find(item => item.path === '')
  const rootAfter = lstatSync(canonicalRoot, { bigint: true })
  if (!metadataSnapshotMatchesStats(rootEntry.snapshot, rootBefore)
    || !metadataSnapshotMatchesStats(rootEntry.snapshot, rootAfter)
    || realpathSync(canonicalRoot) !== canonicalRoot) {
    fail('installed-tree root changed during descriptor-bound metadata capture')
  }
  return {
    root: canonicalRoot,
    metadataSha256: createHash('sha256').update(result.stdout).digest('hex'),
    directoryCount: snapshot.directories.length,
    entryCount: snapshot.entries.length,
    includesDist: true,
    contentBytesHashed: false,
    [INSTALLED_TREE_SNAPSHOT]: result.stdout,
  }
}

function installedTreeStageEvidence(guard, stage) {
  return {
    stage,
    metadataSha256: guard.metadataSha256,
    directoryCount: guard.directoryCount,
    entryCount: guard.entryCount,
  }
}

export function assertInstalledTreeMetadataGuard(expected, installedRoot, timeoutMs, stage) {
  const current = captureInstalledTreeMetadataGuard(installedRoot, timeoutMs)
  if (current.root !== expected.root
    || current.metadataSha256 !== expected.metadataSha256
    || current.directoryCount !== expected.directoryCount
    || current.entryCount !== expected.entryCount
    || current[INSTALLED_TREE_SNAPSHOT] !== expected[INSTALLED_TREE_SNAPSHOT]) {
    fail(`installed-tree descriptor metadata changed ${stage}`)
  }
  return installedTreeStageEvidence(current, stage)
}

function hashOpenFile(fileDescriptor) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(FILE_COPY_BUFFER_BYTES)
  let total = 0n
  for (;;) {
    const bytesRead = readSync(fileDescriptor, buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    if (total + BigInt(bytesRead) > MAX_PACKED_ARTIFACT_BYTES) fail('packed artifact exceeds the 512 MiB acceptance limit')
    hash.update(buffer.subarray(0, bytesRead))
    total += BigInt(bytesRead)
  }
  return { sha256: hash.digest('hex'), size: total }
}

function snapshotSingleLinkArtifact(archive) {
  const pathStats = lstatSync(archive, { bigint: true })
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1n) fail('frozen packed artifact path is not a single-link regular non-symlink file')
  if (pathStats.size > MAX_PACKED_ARTIFACT_BYTES) fail('packed artifact exceeds the 512 MiB acceptance limit')
  let fileDescriptor
  try {
    fileDescriptor = openSync(archive, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const beforeStats = fstatSync(fileDescriptor, { bigint: true })
    if (!beforeStats.isFile() || beforeStats.nlink !== 1n) fail('frozen packed artifact must be a single-link regular file')
    const before = fileFingerprint(beforeStats)
    if (!sameFingerprint(before, fileFingerprint(pathStats))) fail('frozen packed artifact path changed before it could be hashed')
    const content = hashOpenFile(fileDescriptor)
    const afterStats = fstatSync(fileDescriptor, { bigint: true })
    const after = fileFingerprint(afterStats)
    const pathAfterStats = lstatSync(archive, { bigint: true })
    if (!pathAfterStats.isFile()
      || pathAfterStats.isSymbolicLink()
      || pathAfterStats.nlink !== 1n
      || afterStats.nlink !== 1n
      || !sameFingerprint(before, after)
      || !sameFingerprint(after, fileFingerprint(pathAfterStats))
      || content.size !== afterStats.size) {
      fail('frozen packed artifact changed while it was being hashed')
    }
    return { ...after, sha256: content.sha256 }
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor)
  }
}

/**
 * Copy the package-manager output into a newly-created private directory. The
 * acceptance path is never the lifecycle-controlled source path, and the new
 * artifact must have exactly one link. The source fingerprint is checked
 * around the copy so a concurrent mutation fails closed.
 */
export function freezePackedArtifact(sourceArchive, destination, expectedSourceFingerprint) {
  const destinationReal = realpathSync(destination)
  const privateDirectory = mkdtempSync(path.join(destinationReal, '.dsh-accepted-'))
  chmodSync(privateDirectory, 0o700)
  const frozenArchive = path.join(privateDirectory, 'artifact.tgz')
  let sourceDescriptor
  let destinationDescriptor
  let complete = false
  try {
    sourceDescriptor = openSync(sourceArchive, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const sourceBeforeStats = fstatSync(sourceDescriptor, { bigint: true })
    if (!sourceBeforeStats.isFile()) fail('packed artifact source is not a regular file')
    if (sourceBeforeStats.size > MAX_PACKED_ARTIFACT_BYTES) fail('packed artifact exceeds the 512 MiB acceptance limit')
    const sourceBefore = fileFingerprint(sourceBeforeStats)
    if (expectedSourceFingerprint !== undefined && !sameFingerprint(sourceBefore, expectedSourceFingerprint)) {
      fail('packed artifact source was replaced before it could be frozen')
    }

    destinationDescriptor = openSync(
      frozenArchive,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o400,
    )
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(FILE_COPY_BUFFER_BYTES)
    let total = 0n
    for (;;) {
      const bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      if (total + BigInt(bytesRead) > MAX_PACKED_ARTIFACT_BYTES) fail('packed artifact exceeds the 512 MiB acceptance limit')
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const bytesWritten = writeSync(destinationDescriptor, buffer, written, bytesRead - written)
        if (bytesWritten === 0) fail('could not finish writing the frozen packed artifact')
        written += bytesWritten
      }
      total += BigInt(bytesRead)
    }
    fsyncSync(destinationDescriptor)

    const sourceAfterStats = fstatSync(sourceDescriptor, { bigint: true })
    const sourceAfter = fileFingerprint(sourceAfterStats)
    if (!sameFingerprint(sourceBefore, sourceAfter) || total !== sourceAfterStats.size) {
      fail('packed artifact source changed while it was being frozen')
    }
    closeSync(destinationDescriptor)
    destinationDescriptor = undefined
    chmodSync(frozenArchive, 0o400)

    const archiveReal = realpathSync(frozenArchive)
    if (path.dirname(archiveReal) !== realpathSync(privateDirectory)) fail('frozen packed artifact escaped its private directory')
    const guard = snapshotSingleLinkArtifact(archiveReal)
    const copiedSha256 = hash.digest('hex')
    if (guard.sha256 !== copiedSha256 || guard.size !== total.toString()) {
      fail('frozen packed artifact does not match the bytes copied from package-manager output')
    }
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail('packed artifact is too large to report safely')
    complete = true
    return {
      archive: archiveReal,
      sha256: guard.sha256,
      size: Number(total),
      artifactGuard: guard,
    }
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor)
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor)
    if (!complete) rmSync(privateDirectory, { recursive: true, force: true })
  }
}

export function assertStablePackedArtifact(artifact, phase = 'acceptance') {
  const current = snapshotSingleLinkArtifact(artifact.archive)
  if (current.sha256 !== artifact.sha256
    || current.size !== String(artifact.size)
    || !sameFingerprint(current, artifact.artifactGuard)) {
    fail(`frozen packed artifact changed ${phase}`)
  }
  return current
}

function safeArchivePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) return false
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function collectExportTargets(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const nested of Object.values(value)) collectExportTargets(nested, output)
  }
  return output
}

function resolvePackageManager(manifest, root, timeoutMs) {
  const declared = manifest.packageManager
  if (typeof declared !== 'string') fail(`package.json packageManager is missing. ${PACKAGE_MANAGER_MANUAL_GATE}`)
  const match = /^(npm|pnpm)@(.+)$/.exec(declared)
  if (match === null || !EXACT_VERSION.test(match[2])) {
    fail(`unsupported or non-exact packageManager ${safeDiagnostic(JSON.stringify(declared))}. ${PACKAGE_MANAGER_MANUAL_GATE}`)
  }
  const [, command, expectedVersion] = match
  let result
  try {
    result = boundedRun(command, ['--version'], {
      cwd: root,
      env: minimalEnvironment(),
      label: `${command} version gate`,
      timeoutMs,
    })
  } catch (error) {
    fail(`${error?.message ?? error}. ${PACKAGE_MANAGER_MANUAL_GATE}`)
  }
  const actualVersion = result.stdout.trim()
  if (!EXACT_VERSION.test(actualVersion) || actualVersion !== expectedVersion) {
    fail(`packageManager declares ${declared}, but ${command} --version reported ${safeDiagnostic(JSON.stringify(actualVersion))}. ${PACKAGE_MANAGER_MANUAL_GATE}`)
  }
  return { command, declared, expectedVersion, actualVersion }
}

function packCandidate(root, manifest, destination, timeoutMs, packageManager) {
  const result = boundedRun(packageManager.command, ['pack', '--json', '--pack-destination', destination], {
    cwd: root,
    env: minimalEnvironment(),
    label: `${packageManager.command} pack`,
    timeoutMs,
  })
  const pack = parsePackResult(result.stdout, packageManager.command)
  if (pack.name !== manifest.name || pack.version !== manifest.version) {
    fail(`${packageManager.command} pack reported ${safeDiagnostic(`${pack.name}@${pack.version}`)}, expected frozen identity ${safeDiagnostic(`${manifest.name}@${manifest.version}`)}`)
  }
  if (typeof pack.filename !== 'string' || pack.filename.length === 0 || pack.filename.includes('\0')) {
    fail(`${packageManager.command} pack returned an unsafe archive filename`)
  }
  let archive
  if (path.isAbsolute(pack.filename)) {
    archive = pack.filename
  } else {
    if (!safeArchivePath(pack.filename) || pack.filename.includes('/')) {
      fail(`${packageManager.command} pack returned an unsafe relative archive filename`)
    }
    archive = path.join(destination, pack.filename)
  }
  const archiveEntryStats = lstatSync(archive)
  if (!archiveEntryStats.isFile() || archiveEntryStats.isSymbolicLink()) fail('packed artifact path is not a regular non-symlink file')
  const archiveReal = realpathSync(archive)
  if (path.dirname(archiveReal) !== realpathSync(destination)) fail(`${packageManager.command} packed artifact escaped its destination`)
  const archiveStats = lstatSync(archiveReal, { bigint: true })
  if (!archiveStats.isFile() || archiveStats.isSymbolicLink()) fail('packed artifact is not a regular file')
  if (!Array.isArray(pack.files) || pack.files.length === 0) fail(`${packageManager.command} pack returned no archive manifest`)
  const packedPaths = new Set()
  for (const item of pack.files) {
    if (item === null || typeof item !== 'object' || !safeArchivePath(item.path)) fail(`${packageManager.command} pack returned an unsafe archive member`)
    if (packedPaths.has(item.path)) fail(`${packageManager.command} pack returned duplicate archive member ${safeDiagnostic(item.path)}`)
    packedPaths.add(item.path)
  }
  const required = new Set([
    'package.json',
    manifest.main,
    manifest.types,
    manifest.dsh?.bundle?.patch,
    ...collectExportTargets(manifest.exports),
  ].filter(value => typeof value === 'string').map(value => value.replace(/^\.\//, '')))
  for (const file of required) {
    if (!safeArchivePath(file) || file.includes('*')) continue
    if (!packedPaths.has(file)) fail(`packed artifact is missing declared file ${safeDiagnostic(file)}`)
  }
  const frozen = freezePackedArtifact(archiveReal, destination, fileFingerprint(archiveStats))
  return {
    ...frozen,
    name: pack.name,
    version: pack.version,
    packageManager: packageManager.declared,
    files: [...packedPaths].sort(),
  }
}

function resolveDshBin(explicit) {
  const candidate = explicit === undefined
    ? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : path.resolve(explicit)
  let real
  try {
    real = realpathSync(candidate)
  } catch {
    fail(`DSH binary was not found: ${safeDiagnostic(candidate)}; pass --dsh-bin`)
  }
  const stats = lstatSync(real)
  if (!stats.isFile()) fail('DSH binary must resolve to a regular file')
  return real
}

function dshInvocation(bin, args) {
  return bin.endsWith('.js') || bin.endsWith('.mjs')
    ? { command: process.execPath, args: [bin, ...args] }
    : { command: bin, args }
}

function parseFileSpecifier(value) {
  if (typeof value !== 'string' || !value.startsWith('file:')) return undefined
  try {
    return realpathSync(decodeURIComponent(value.slice('file:'.length)))
  } catch {
    return undefined
  }
}

function parseYamlScalar(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return undefined
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'")
  if (/^[A-Za-z0-9@/_.-]+$/.test(trimmed)) return trimmed
  return undefined
}

function exportTargetAvailable(value) {
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.some(exportTargetAvailable)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(exportTargetAvailable)
  }
  return false
}

function patternMatchesExportKey(key, requested) {
  const firstStar = key.indexOf('*')
  if (firstStar === -1 || firstStar !== key.lastIndexOf('*')) return false
  const prefix = key.slice(0, firstStar)
  const suffix = key.slice(firstStar + 1)
  return requested.startsWith(prefix)
    && requested.endsWith(suffix)
    && requested.length >= prefix.length + suffix.length
}

/**
 * Return whether a package export map exposes the Loader mount name. An absent
 * exports field is inconclusive (legacy main resolution is still legal), so it
 * is accepted. A present exports field is authoritative, including null
 * exclusions and exact or single-star subpath entries.
 */
export function manifestAllowsBundleMount(manifest, mountName) {
  const packageName = manifest?.name
  if (typeof packageName !== 'string') return false
  let requested
  if (mountName === packageName) requested = '.'
  else if (mountName.startsWith(`${packageName}/`) && mountName.length > packageName.length + 1) {
    requested = `.${mountName.slice(packageName.length)}`
  } else return false

  const exportsField = manifest.exports
  if (exportsField === undefined) return true
  if (typeof exportsField === 'string' || Array.isArray(exportsField) || exportsField === null) {
    return requested === '.' && exportTargetAvailable(exportsField)
  }
  if (typeof exportsField !== 'object') return false

  const entries = Object.entries(exportsField)
  const subpathEntries = entries.filter(([key]) => key.startsWith('.'))
  if (subpathEntries.length === 0) {
    // An object whose keys are conditions is the root export itself.
    return requested === '.' && exportTargetAvailable(exportsField)
  }
  // Mixing condition keys with subpath keys is not a valid Node exports map.
  if (subpathEntries.length !== entries.length) return false

  if (Object.hasOwn(exportsField, requested)) {
    return exportTargetAvailable(exportsField[requested])
  }
  const matchingPatterns = subpathEntries
    .filter(([key]) => patternMatchesExportKey(key, requested))
    .sort(([left], [right]) => {
      const leftSpecificity = left.replace('*', '').length
      const rightSpecificity = right.replace('*', '').length
      return rightSpecificity - leftSpecificity || right.length - left.length
    })
  return matchingPatterns.length > 0 && exportTargetAvailable(matchingPatterns[0][1])
}

export function assertComposedBundle(dump, manifest) {
  const packageName = manifest?.name
  if (typeof packageName !== 'string' || packageName.length === 0) fail('package manifest name is missing')
  const sections = []
  let active
  for (const line of dump.split(/\r?\n/)) {
    if (line.startsWith('# == ')) {
      active = { source: line.slice('# == '.length).trim(), lines: [] }
      sections.push(active)
    } else if (active !== undefined) active.lines.push(line)
  }
  const ownSections = sections.filter(section => section.source.split(', patched by ')[0] === packageName)
  if (ownSections.length !== 1) fail(`dump-config must contain exactly one source block for ${safeDiagnostic(packageName)}`)
  const rows = []
  let row
  for (const line of ownSections[0].lines) {
    const idMatch = /^- id:\s+(.+)$/.exec(line)
    if (idMatch !== null) {
      row = { id: parseYamlScalar(idMatch[1]) }
      rows.push(row)
      continue
    }
    const nameMatch = /^  name:\s+(.+)$/.exec(line)
    if (nameMatch !== null && row !== undefined) row.name = parseYamlScalar(nameMatch[1])
  }
  const packageRows = rows.filter(candidate => (
    typeof candidate.name === 'string'
      && (candidate.name === packageName || candidate.name.startsWith(`${packageName}/`))
  ))
  for (const candidate of packageRows) {
    if (!manifestAllowsBundleMount(manifest, candidate.name)) {
      fail(`dump-config mounted ${safeDiagnostic(candidate.name)}, but package exports do not expose that entry`)
    }
  }
  const ownRows = packageRows.filter(candidate => typeof candidate.id === 'string')
  if (ownRows.length === 0) {
    fail(`automatic acceptance supports only Bundles mounting their own package root or an exported package subpath; dump-config source block for ${safeDiagnostic(packageName)} contains no such mounted row. Use --pack-only and manually inspect patch-only or config-composition behavior`)
  }
  return ownRows.map(candidate => candidate.id)
}

export function httpStatus(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let request
    let response
    let settled = false
    const deadline = setTimeout(() => {
      finish(new Error('HTTP readiness request exceeded its total deadline'))
    }, timeoutMs)
    function finish(error, statusCode) {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error !== undefined) {
        response?.destroy()
        request?.destroy()
        reject(error)
      } else {
        resolve(statusCode)
      }
    }
    request = http.get({ hostname: '127.0.0.1', port, path: '/' }, incoming => {
      response = incoming
      response.once('error', finish)
      response.resume()
      response.once('end', () => finish(undefined, response.statusCode))
    })
    request.once('error', finish)
  })
}

function pathIsStrictDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Resolve an installed package root while keeping pnpm's symlinked store
 * layout legal only when its canonical target remains inside the Profile. */
export function canonicalInstalledArtifactRoot(dshHome, profileRoot, installedManifestPath) {
  const canonicalHome = realpathSync(dshHome)
  const canonicalProfile = realpathSync(profileRoot)
  if (!pathIsStrictDescendant(canonicalHome, canonicalProfile)) {
    fail('fresh Profile root resolved outside the temporary DSH_HOME')
  }
  if (path.basename(installedManifestPath) !== 'package.json') {
    fail('installed package manifest path must end at package.json')
  }
  const requestedPackageRoot = path.dirname(installedManifestPath)
  const installedRoot = realpathSync(requestedPackageRoot)
  if (!pathIsStrictDescendant(canonicalProfile, installedRoot)) {
    fail('fresh Profile installed artifact resolved outside the temporary Profile root')
  }
  const expectedManifestPath = path.join(installedRoot, 'package.json')
  let rootDescriptor
  let manifestDescriptor
  try {
    const rootPathBeforeStats = lstatSync(installedRoot, { bigint: true })
    if (!rootPathBeforeStats.isDirectory() || rootPathBeforeStats.isSymbolicLink()) {
      fail('canonical installed package root must be a real directory')
    }
    rootDescriptor = openSync(
      installedRoot,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    )
    const rootDescriptorBeforeStats = fstatSync(rootDescriptor, { bigint: true })
    const rootGuard = fileFingerprint(rootDescriptorBeforeStats)
    if (!rootDescriptorBeforeStats.isDirectory()
      || !sameFingerprint(rootGuard, fileFingerprint(rootPathBeforeStats))) {
      fail('canonical installed package root changed before manifest inspection')
    }

    // lstat follows a legal pnpm package-directory symlink but not a final
    // package.json symlink. The manifest itself must belong directly to the
    // canonical package root and must not share an inode with a decoy file.
    const requestedManifestStats = lstatSync(installedManifestPath, { bigint: true })
    const expectedManifestStats = lstatSync(expectedManifestPath, { bigint: true })
    if (!requestedManifestStats.isFile()
      || requestedManifestStats.isSymbolicLink()
      || requestedManifestStats.nlink !== 1n
      || !expectedManifestStats.isFile()
      || expectedManifestStats.isSymbolicLink()
      || expectedManifestStats.nlink !== 1n
      || !sameFingerprint(fileFingerprint(requestedManifestStats), fileFingerprint(expectedManifestStats))) {
      fail('installed package.json must be a regular single-link file directly inside the canonical package root')
    }
    const canonicalManifest = realpathSync(installedManifestPath)
    if (canonicalManifest !== expectedManifestPath || realpathSync(expectedManifestPath) !== expectedManifestPath) {
      fail('installed package.json canonical path does not match the canonical package root')
    }

    manifestDescriptor = openSync(
      expectedManifestPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    const manifestDescriptorStats = fstatSync(manifestDescriptor, { bigint: true })
    const manifestGuard = fileFingerprint(manifestDescriptorStats)
    if (!manifestDescriptorStats.isFile()
      || manifestDescriptorStats.nlink !== 1n
      || !sameFingerprint(manifestGuard, fileFingerprint(expectedManifestStats))) {
      fail('installed package.json changed before descriptor-bound inspection')
    }

    const manifestPathAfterStats = lstatSync(expectedManifestPath, { bigint: true })
    const rootDescriptorAfterStats = fstatSync(rootDescriptor, { bigint: true })
    const rootPathAfterStats = lstatSync(installedRoot, { bigint: true })
    if (!manifestPathAfterStats.isFile()
      || manifestPathAfterStats.isSymbolicLink()
      || manifestPathAfterStats.nlink !== 1n
      || !sameFingerprint(manifestGuard, fileFingerprint(manifestPathAfterStats))
      || !sameFingerprint(rootGuard, fileFingerprint(rootDescriptorAfterStats))
      || !sameFingerprint(rootGuard, fileFingerprint(rootPathAfterStats))) {
      fail('installed package root or package.json changed during descriptor-bound inspection')
    }
    return installedRoot
  } finally {
    if (manifestDescriptor !== undefined) closeSync(manifestDescriptor)
    if (rootDescriptor !== undefined) closeSync(rootDescriptor)
  }
}

export function recheckInstalledTreeMetadataGuard({
  expected,
  dshHome,
  profileRoot,
  installedManifestPath,
  timeoutMs,
  stage,
}) {
  const installedRoot = canonicalInstalledArtifactRoot(dshHome, profileRoot, installedManifestPath)
  if (installedRoot !== expected.root) fail(`canonical installed package root changed ${stage}`)
  return assertInstalledTreeMetadataGuard(expected, installedRoot, timeoutMs, stage)
}

function waitForReadiness(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`DSH readiness timed out; stdout=${safeDiagnostic(stdout)} stderr=${safeDiagnostic(stderr)}`)), timeoutMs)
    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error === undefined) resolve({ ...value, stdout, stderr })
      else reject(error)
    }
    function inspect() {
      if (Buffer.byteLength(stdout) > MAX_CAPTURE_BYTES || Buffer.byteLength(stderr) > MAX_CAPTURE_BYTES) {
        finish(new Error('DSH startup output exceeded the bounded capture limit'))
        return
      }
      const match = /(?:^|\n)dsh web: http:\/\/127\.0\.0\.1:(\d+)(?:\r?\n|$)/.exec(stdout)
      if (match !== null) finish(undefined, { port: Number(match[1]) })
    }
    function onError(error) {
      finish(new Error(`DSH startup failed: ${safeDiagnostic(error.message)}`))
    }
    function onExit(code, signal) {
      finish(new Error(`DSH exited before readiness (code=${code}, signal=${signal}); stdout=${safeDiagnostic(stdout)} stderr=${safeDiagnostic(stderr)}`))
    }
    function onStdout(chunk) {
      // Keep draining the pipe after readiness, but stop retaining output in
      // memory once the bounded evidence needed for readiness is complete.
      if (settled) return
      stdout += chunk
      inspect()
    }
    function onStderr(chunk) {
      if (settled) return
      stderr += chunk
      inspect()
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('DSH did not exit after SIGTERM and was killed'))
    }, timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function portIsClosed(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(500)
    socket.once('connect', () => { socket.destroy(); resolve(false) })
    socket.once('timeout', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(true))
  })
}

async function waitForPortRelease(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portIsClosed(port)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  fail(`port ${port} remained reachable after DSH shutdown`)
}

async function freshProfileAcceptance({ artifact, manifest, profile, dshBin, timeoutMs, keepDshHome }) {
  if (profile !== 'web') fail('automatic boot/readiness currently supports only --profile web; use --pack-only and perform the app-specific gate manually')
  const archive = artifact.archive
  const freshHome = mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-accept-home-'))
  const agentsHome = path.join(freshHome, '.agents')
  mkdirSync(agentsHome, { recursive: true })
  const environment = minimalEnvironment({ DSH_HOME: freshHome, DSH_AGENTS_HOME: agentsHome })
  let server
  try {
    const artifactBeforeInstall = assertStablePackedArtifact(artifact, 'before fresh Profile install')
    const add = dshInvocation(dshBin, ['plugin', '--profile', profile, 'add', '-w', archive])
    boundedRun(add.command, add.args, {
      label: 'fresh Profile tarball install',
      env: environment,
      timeoutMs,
    })
    const artifactAfterInstall = assertStablePackedArtifact(artifact, 'during fresh Profile install')

    const profileManifestPath = path.join(freshHome, 'profiles', profile, 'package.json')
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
    const bundles = profileManifest.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || !bundles.includes(manifest.name)) fail('fresh Profile manifest does not list the candidate Bundle')
    const installedSpecifier = profileManifest.dependencies?.[manifest.name]
    if (parseFileSpecifier(installedSpecifier) !== archive) fail('fresh Profile dependency does not reference the exact packed tarball')

    const profileRoot = path.join(freshHome, 'profiles', profile)
    const installedManifestPath = path.join(profileRoot, 'node_modules', ...manifest.name.split('/'), 'package.json')
    const installedRoot = canonicalInstalledArtifactRoot(freshHome, profileRoot, installedManifestPath)
    const installedTreeGuard = captureInstalledTreeMetadataGuard(installedRoot, timeoutMs)
    const installedTreeGuardStages = [
      installedTreeStageEvidence(installedTreeGuard, 'before-installed-static-validation'),
    ]
    const installedManifestReal = path.join(installedRoot, 'package.json')
    const installedManifest = JSON.parse(readFileSync(installedManifestReal, 'utf8'))
    if (installedManifest.name !== manifest.name || installedManifest.version !== manifest.version) {
      fail('fresh Profile resolved a different package identity or version')
    }
    // npm pack runs lifecycle hooks after the source-tree validator. Validate
    // the package pnpm actually unpacked from the exact tarball before booting
    // it, so a prepack mutation cannot hide behind an earlier clean result.
    const installedArtifactValidation = runStaticValidator(installedRoot, {
      built: true,
      json: true,
      timeoutMs,
      installedArtifact: true,
    })
    installedTreeGuardStages.push(recheckInstalledTreeMetadataGuard({
      expected: installedTreeGuard,
      dshHome: freshHome,
      profileRoot,
      installedManifestPath,
      timeoutMs,
      stage: 'after-installed-static-validation',
    }))

    const dump = dshInvocation(dshBin, ['--profile', profile, '--dump-config'])
    installedTreeGuardStages.push(recheckInstalledTreeMetadataGuard({
      expected: installedTreeGuard,
      dshHome: freshHome,
      profileRoot,
      installedManifestPath,
      timeoutMs,
      stage: 'before-dump-config',
    }))
    const dumpResult = boundedRun(dump.command, dump.args, {
      label: 'fresh Profile dump-config',
      env: environment,
      timeoutMs,
    })
    const rowIds = assertComposedBundle(dumpResult.stdout, manifest)

    const boot = dshInvocation(dshBin, ['--profile', profile, '--no-open', '--port', '0'])
    installedTreeGuardStages.push(recheckInstalledTreeMetadataGuard({
      expected: installedTreeGuard,
      dshHome: freshHome,
      profileRoot,
      installedManifestPath,
      timeoutMs,
      stage: 'before-web-boot',
    }))
    server = spawn(boot.command, boot.args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
    const ready = await waitForReadiness(server, timeoutMs)
    if (!Number.isSafeInteger(ready.port) || ready.port < 1 || ready.port > 65535) fail('DSH reported an invalid readiness port')
    const status = await httpStatus(ready.port, Math.min(timeoutMs, 10_000))
    if (status !== 200) fail(`DSH readiness endpoint returned HTTP ${status}`)

    if (!server.kill('SIGTERM')) fail('could not send SIGTERM to DSH')
    const exit = await waitForExit(server, Math.min(timeoutMs, 10_000))
    if (exit.code !== 0 || exit.signal !== null) {
      fail(`top-level DSH did not complete a normal exit after SIGTERM (code=${exit.code}, signal=${exit.signal})`)
    }
    server = undefined
    await waitForPortRelease(ready.port, Math.min(timeoutMs, 5_000))
    installedTreeGuardStages.push(recheckInstalledTreeMetadataGuard({
      expected: installedTreeGuard,
      dshHome: freshHome,
      profileRoot,
      installedManifestPath,
      timeoutMs,
      stage: 'after-shutdown-and-port-release',
    }))
    return {
      dshHome: freshHome,
      packageName: manifest.name,
      packageVersion: manifest.version,
      rowIds,
      readinessUrl: `http://127.0.0.1:${ready.port}`,
      httpStatus: status,
      artifactBeforeInstall,
      artifactAfterInstall,
      installedArtifactValidation,
      installedTreeMetadataGuard: {
        kind: 'descriptor-bound path/stat metadata snapshot; file contents are not hashed',
        metadataSha256: installedTreeGuard.metadataSha256,
        directoryCount: installedTreeGuard.directoryCount,
        entryCount: installedTreeGuard.entryCount,
        includesDist: installedTreeGuard.includesDist,
        contentBytesHashed: installedTreeGuard.contentBytesHashed,
        skippedSubtrees: ['.git', 'node_modules'],
        stages: installedTreeGuardStages,
      },
      topLevelDshExit: exit,
      reportedHttpPortReleased: true,
      acceptanceScope: {
        verified: [
          'single-link frozen tarball matched its reported SHA-256 before and after Profile install',
          'exact packed package identity and version installed in the temporary Profile',
          'the descriptor-bound installed path/stat metadata snapshot, including dist, matched before and after static validation, before composition, before boot, and after shutdown/port release',
          'top-level DSH process reported an HTTP URL and returned HTTP 200',
          'top-level DSH process exited after SIGTERM',
          'the reported top-level HTTP listener port stopped accepting connections',
        ],
        notVerified: [
          'descendant process-tree termination',
          'capability-specific resources such as workers, subprocesses, timers, files, or remote sessions',
          'patch-only Bundles that do not mount their own package root or exported subpath',
          'non-own Bundle overrides or composed config values',
          'unmatched-patch diagnostics',
          'transient same-UID installed-tree mutations made and restored between metadata guard checks',
          'cross-stage cryptographic identity of installed file contents; the guard hashes path/stat metadata, not content bytes',
          'changes inside skipped .git or node_modules subtrees',
        ],
      },
      retained: keepDshHome,
    }
  } finally {
    if (server !== undefined && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM')
      try {
        await waitForExit(server, 5_000)
      } catch {
        // waitForExit escalates to SIGKILL; preserve the acceptance error.
      }
    }
    if (!keepDshHome) rmSync(freshHome, { recursive: true, force: true })
  }
}

function manualGate(command, label) {
  return `${command} || { DSH_ACCEPT_STATUS=$?; printf "%s (exit %s). Evidence retained at %s\\n" ${shellQuote(`${label} failed`)} "$DSH_ACCEPT_STATUS" "$DSH_ACCEPT_HOME" >&2; exit "$DSH_ACCEPT_STATUS"; }`
}

export function manualFreshProfileCommands(report, dshBin, profile) {
  if (typeof report?.archive !== 'string' || report.archive.length === 0 || report.archive.includes('\0')) {
    fail('manual fresh-Profile commands require a safe packed artifact path')
  }
  if (typeof report.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(report.sha256)) {
    fail('manual fresh-Profile commands require the frozen artifact SHA-256')
  }
  const executable = dshBin === undefined
    ? 'dsh'
    : dshBin.endsWith('.js') || dshBin.endsWith('.mjs')
    ? `node ${shellQuote(dshBin)}`
    : shellQuote(dshBin)
  const cleanEnvironment = [
    'env', '-i',
    ...FORWARDED_ENVIRONMENT_KEYS
      .filter(key => process.env[key] !== undefined)
      .map(key => shellQuote(`${key}=${process.env[key]}`)),
    shellQuote('NO_COLOR=1'),
  ].join(' ')
  const isolatedDsh = `${cleanEnvironment} DSH_HOME="$DSH_ACCEPT_HOME" DSH_AGENTS_HOME="$DSH_ACCEPT_AGENTS_HOME" ${executable}`
  const installGate = `${isolatedDsh} plugin --profile ${shellQuote(profile)} add -w "$DSH_ACCEPT_ARCHIVE"`
  const compositionGate = `${isolatedDsh} --profile ${shellQuote(profile)} --dump-config`
  const commands = [
    `DSH_ACCEPT_ARCHIVE=${shellQuote(report.archive)}`,
    `DSH_ACCEPT_EXPECTED_SHA256=${shellQuote(report.sha256)}`,
    'if command -v sha256sum >/dev/null 2>&1; then DSH_ACCEPT_HASH_OUTPUT="$(sha256sum -- "$DSH_ACCEPT_ARCHIVE")" || { DSH_ACCEPT_STATUS=$?; printf "%s\\n" "sha256sum could not hash the frozen artifact; installation was not attempted." >&2; exit "$DSH_ACCEPT_STATUS"; }; elif command -v shasum >/dev/null 2>&1; then DSH_ACCEPT_HASH_OUTPUT="$(shasum -a 256 -- "$DSH_ACCEPT_ARCHIVE")" || { DSH_ACCEPT_STATUS=$?; printf "%s\\n" "shasum could not hash the frozen artifact; installation was not attempted." >&2; exit "$DSH_ACCEPT_STATUS"; }; else printf "%s\\n" "No SHA-256 utility found; install sha256sum or shasum and rerun this verification before installation." >&2; exit 1; fi',
    'DSH_ACCEPT_ACTUAL_SHA256="${DSH_ACCEPT_HASH_OUTPUT%% *}"',
    'test "$DSH_ACCEPT_ACTUAL_SHA256" = "$DSH_ACCEPT_EXPECTED_SHA256" || { printf "%s\\n" "Packed artifact SHA-256 mismatch; refusing installation." >&2; exit 1; }',
    'DSH_ACCEPT_ROOT="${TMPDIR:-/tmp}"',
    'DSH_ACCEPT_HOME="$(mktemp -d "$DSH_ACCEPT_ROOT/dsh-plugin-accept.XXXXXX")" || { DSH_ACCEPT_STATUS=$?; printf "%s\\n" "Could not create the isolated acceptance directory; installation was not attempted." >&2; exit "$DSH_ACCEPT_STATUS"; }',
    'test -n "$DSH_ACCEPT_HOME" || { printf "%s\\n" "mktemp returned an empty acceptance path; installation was not attempted." >&2; exit 1; }',
    'DSH_ACCEPT_AGENTS_HOME="$DSH_ACCEPT_HOME/.agents"',
    'mkdir -p -- "$DSH_ACCEPT_AGENTS_HOME" || { DSH_ACCEPT_STATUS=$?; printf "%s (exit %s). Evidence retained at %s\\n" "Acceptance-directory setup failed" "$DSH_ACCEPT_STATUS" "$DSH_ACCEPT_HOME" >&2; exit "$DSH_ACCEPT_STATUS"; }',
    ': > "$DSH_ACCEPT_HOME/.dsh-plugin-accept-sentinel" || { DSH_ACCEPT_STATUS=$?; printf "%s (exit %s). Evidence retained at %s\\n" "Acceptance sentinel creation failed" "$DSH_ACCEPT_STATUS" "$DSH_ACCEPT_HOME" >&2; exit "$DSH_ACCEPT_STATUS"; }',
    manualGate(installGate, 'DSH plugin installation gate'),
    manualGate(compositionGate, 'DSH configuration-composition gate'),
  ]
  if (profile === 'web') {
    const bootGate = `${isolatedDsh} --profile ${shellQuote(profile)} --no-open --port 0`
    commands.push(
      manualGate(bootGate, 'DSH Web boot/shutdown gate'),
      '# In another terminal, GET the printed 127.0.0.1 URL; require HTTP 200.',
      '# Send SIGTERM to the top-level DSH process, require its exit, then verify only its reported HTTP port is closed.',
      '# This does not prove descendant processes or capability-specific resources were released.',
      '# Before cleanup, separately confirm no descendant or capability process still uses the temporary tree.',
    )
  } else {
    commands.push(
      `# Non-Web Profile ${shellQuote(profile)}: use the pinned Profile's documented startup, behavior/readiness, and shutdown contract manually.`,
      '# Do not reuse Web-specific startup flags, readiness assumptions, or shutdown behavior for this Profile.',
      '# Before cleanup, separately confirm the Profile and all descendant or capability processes released the temporary tree.',
    )
  }
  commands.push(
    '# Path-safe cleanup then requires the canonical temp parent, mktemp-shaped basename, and our sentinel.',
    'DSH_ACCEPT_PARENT="$(CDPATH= cd -- "$(dirname -- "$DSH_ACCEPT_HOME")" && pwd -P)" || { DSH_ACCEPT_STATUS=$?; printf "%s (exit %s). Evidence retained at %s\\n" "Could not canonicalize the acceptance parent for cleanup" "$DSH_ACCEPT_STATUS" "$DSH_ACCEPT_HOME" >&2; exit "$DSH_ACCEPT_STATUS"; }',
    'DSH_ACCEPT_ROOT_REAL="$(CDPATH= cd -- "$DSH_ACCEPT_ROOT" && pwd -P)" || { DSH_ACCEPT_STATUS=$?; printf "%s (exit %s). Evidence retained at %s\\n" "Could not canonicalize the acceptance temp root for cleanup" "$DSH_ACCEPT_STATUS" "$DSH_ACCEPT_HOME" >&2; exit "$DSH_ACCEPT_STATUS"; }',
    'case "$(basename -- "$DSH_ACCEPT_HOME")" in dsh-plugin-accept.*) if test "$DSH_ACCEPT_PARENT" = "$DSH_ACCEPT_ROOT_REAL" && test -f "$DSH_ACCEPT_HOME/.dsh-plugin-accept-sentinel"; then rm -rf -- "$DSH_ACCEPT_HOME" || { DSH_ACCEPT_STATUS=$?; printf "%s (exit %s). Evidence may remain at %s\\n" "Acceptance evidence cleanup failed" "$DSH_ACCEPT_STATUS" "$DSH_ACCEPT_HOME" >&2; exit "$DSH_ACCEPT_STATUS"; }; test ! -e "$DSH_ACCEPT_HOME" && test ! -L "$DSH_ACCEPT_HOME" || { printf "%s\\n" "Acceptance evidence cleanup reported success but the path still exists: $DSH_ACCEPT_HOME" >&2; exit 1; }; else printf "%s\\n" "Refusing cleanup because the canonical parent or acceptance sentinel did not match: $DSH_ACCEPT_HOME" >&2; exit 1; fi ;; *) printf "%s\\n" "Refusing unsafe cleanup target: $DSH_ACCEPT_HOME" >&2; exit 1 ;; esac',
    'unset DSH_ACCEPT_ROOT_REAL DSH_ACCEPT_PARENT DSH_ACCEPT_AGENTS_HOME DSH_ACCEPT_HOME DSH_ACCEPT_ROOT DSH_ACCEPT_ACTUAL_SHA256 DSH_ACCEPT_HASH_OUTPUT DSH_ACCEPT_EXPECTED_SHA256 DSH_ACCEPT_ARCHIVE',
  )
  return commands
}

/** Recheck the frozen bytes at the final pack-only handoff boundary, then
 * generate commands that independently verify the same digest before install. */
export function preparePackOnlyHandoff(artifact, dshBin, profile) {
  const packOnlyFinalArtifactValidation = assertStablePackedArtifact(
    artifact,
    'before pack-only report and manual handoff',
  )
  return {
    packOnlyFinalArtifactValidation,
    manualCommands: manualFreshProfileCommands(artifact, dshBin, profile),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  let root
  try {
    root = realpathSync(path.resolve(options.pluginDir))
  } catch {
    fail(`plugin directory cannot be resolved: ${safeDiagnostic(options.pluginDir)}`)
  }
  if (!lstatSync(root).isDirectory()) fail('plugin root must be a directory')
  const manifest = readManifest(root)
  const report = {
    root,
    mode: options.trustedExecute ? 'trusted-execute' : 'static-only',
    packageName: manifest.name,
    packageVersion: manifest.version,
  }
  // Resolve the trusted execution engine before any candidate lifecycle runs,
  // and before generic validation can obscure the manual-gate explanation for
  // a missing, unsupported, or non-exact packageManager declaration.
  const packageManager = options.trustedExecute
    ? resolvePackageManager(manifest, root, options.timeoutMs)
    : undefined

  report.staticValidation = runStaticValidator(root, {
    built: false,
    json: options.json,
    timeoutMs: options.timeoutMs,
  }) ?? 'passed'
  if (!options.trustedExecute) {
    report.projectCodeExecuted = false
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else process.stdout.write('STATIC_ACCEPTANCE_OK: no project code was imported or executed. Re-run with --trusted-execute only after reviewing and trusting the candidate.\n')
    return
  }

  if (typeof manifest.scripts?.check !== 'string' || manifest.scripts.check.trim().length === 0) {
    fail('trusted acceptance requires a non-empty package-manager run check script')
  }
  report.packageManager = packageManager
  if (!options.json) process.stderr.write('accept_plugin: trusted mode will execute candidate package scripts and install its exact tarball in a temporary DSH_HOME.\n')
  boundedRun(packageManager.command, ['run', 'check'], {
    cwd: root,
    env: minimalEnvironment(),
    label: `${packageManager.command} run check`,
    timeoutMs: options.timeoutMs,
    echo: !options.json,
  })
  report.builtValidation = runStaticValidator(root, {
    built: true,
    json: options.json,
    timeoutMs: options.timeoutMs,
  }) ?? 'passed'

  const packDestination = ensureEmptyPackDestination(options.packDestination)
  report.package = packCandidate(root, manifest, packDestination, options.timeoutMs, packageManager)
  // Package-manager pack executes prepack and may rebuild or otherwise mutate shipped
  // files. Re-freeze and inspect the post-hook source tree even in pack-only
  // mode; full Web acceptance additionally validates pnpm's exact unpacked
  // tarball below.
  const postPackManifest = readManifest(root)
  if (postPackManifest.name !== manifest.name || postPackManifest.version !== manifest.version) {
    fail(`package identity/version changed during pack lifecycle: expected ${safeDiagnostic(`${manifest.name}@${manifest.version}`)}, found ${safeDiagnostic(`${postPackManifest.name}@${postPackManifest.version}`)}`)
  }
  if (postPackManifest.packageManager !== manifest.packageManager) {
    fail('packageManager changed during pack lifecycle; the frozen package-manager gate is no longer valid')
  }
  report.postPackSourceValidation = runStaticValidator(root, {
    built: true,
    json: true,
    timeoutMs: options.timeoutMs,
  })
  report.projectCodeExecuted = true
  let packOnlyDshBin
  if (options.packOnly) {
    try {
      packOnlyDshBin = resolveDshBin(options.dshBin)
    } catch (error) {
      if (options.dshBin !== undefined) throw error
    }
    report.freshProfile = 'manual-required'
  } else {
    const dshBin = resolveDshBin(options.dshBin)
    report.freshProfile = await freshProfileAcceptance({
      artifact: report.package,
      manifest,
      profile: options.profile,
      dshBin,
      timeoutMs: options.timeoutMs,
      keepDshHome: options.keepDshHome,
    })
    report.freshProfile.artifactAfterAcceptance = assertStablePackedArtifact(report.package, 'during fresh Profile acceptance')
  }

  // This is deliberately the last operation before serializing or printing a
  // pack-only handoff. Post-pack validation may take time, so do not rely only
  // on the fingerprint captured when the artifact was first frozen.
  if (options.packOnly) Object.assign(report, preparePackOnlyHandoff(report.package, packOnlyDshBin, options.profile))

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    process.stdout.write(`${options.packOnly ? 'PACKED_ARTIFACT_CREATED' : 'PACKED_ARTIFACT_ACCEPTANCE_OK'} exact package ${report.packageName}@${report.packageVersion}: ${report.package.archive}\n`)
    process.stdout.write(`SHA256 ${report.package.sha256}\n`)
    if (options.packOnly) {
      process.stdout.write('MANUAL_FRESH_PROFILE_ACCEPTANCE_REQUIRED: creating and inspecting the tarball is not artifact or runtime acceptance.\n')
      process.stdout.write('Fresh Profile acceptance remains manual:\n')
      for (const command of report.manualCommands) process.stdout.write(`  ${command}\n`)
    } else {
      process.stdout.write(`FRESH_PROFILE_TOP_LEVEL_DSH_ACCEPTANCE_OK exact package ${report.packageName}@${report.packageVersion}; ${report.freshProfile.readinessUrl} HTTP ${report.freshProfile.httpStatus}; top-level DSH exit after SIGTERM confirmed; its reported HTTP port closed\n`)
      process.stdout.write('NOT_VERIFIED: descendant process-tree termination; capability-specific resource cleanup; patch-only Bundles without an own-package mount; non-own overrides or composed config values; unmatched-patch diagnostics.\n')
    }
  }
}

let isMain = false
try {
  isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(SCRIPT_FILE)
} catch {
  // Imported modules and unresolved launch paths are not the CLI entry point.
}
if (isMain) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`accept_plugin: ${safeDiagnostic(error?.message ?? error)}\n`)
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1
  }
}
