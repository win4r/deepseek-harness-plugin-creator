#!/usr/bin/env node

/**
 * Generate the deliberately small, low-authority DSH Tool Bundle in
 * ../assets/scaffold. The generator itself has no third-party dependencies.
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = path.resolve(SCRIPT_DIR, '..', 'assets', 'scaffold')
const REQUIRED_RUNTIME_PACKAGES = [
  { option: 'cordisVersion', packageName: '@deepseek-ai/cordis', token: 'CORDIS', ownership: 'peer+dev' },
  { option: 'dshToolsVersion', packageName: '@deepseek-ai/dsh-tools', token: 'DSH_TOOLS', ownership: 'peer+dev' },
  { option: 'schemasteryVersion', packageName: '@deepseek-ai/schemastery', token: 'SCHEMASTERY', ownership: 'dependency' },
]
const FAST_SCAFFOLD_AUDITS = {
  '0.1.1-rc.2': {
    nodeEngine: '^22.19.0 || >=24.0.0',
    nodeTypesVersion: '22.20.0',
    typescriptVersion: '6.0.3',
    runtimeVersions: {
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-tools': '0.1.1-rc.2',
      '@deepseek-ai/schemastery': '3.18.1',
    },
    packageOwnership: {
      '@deepseek-ai/cordis': 'peer+dev',
      '@deepseek-ai/dsh-tools': 'peer+dev',
      '@deepseek-ai/schemastery': 'dependency',
    },
    source: 'DeepSeek Harness 0.1.1-rc.2 official package manifests and pnpm-lock.yaml audit',
  },
}
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PACKAGE_NAME = /^(?:@([a-z0-9-][a-z0-9._~-]*)\/)?([a-z0-9-][a-z0-9._-]*)$/

function safeDiagnostic(value) {
  const escaped = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]|\p{Cf}/gu, character => {
    const point = character.codePointAt(0)
    return point <= 0xffff
      ? `\\u${point.toString(16).padStart(4, '0')}`
      : `\\u{${point.toString(16)}}`
  })
  return escaped.length <= 2048 ? escaped : `${escaped.slice(0, 2048)}...`
}

function fail(message, code = 1) {
  const error = new Error(message)
  error.exitCode = code
  throw error
}

function usage() {
  return `Usage: node scaffold_plugin.mjs <package-name> [options]

Generate a simple, pure-string DeepSeek Harness Tool Bundle.

Options:
  --dir <parent>                 Parent of the generated package (default: cwd)
  --profile <name>               Installed DSH Profile to inspect (default: web)
  --dsh-home <path>              DSH home (default: DSH_HOME or ~/.dsh)
  --dsh-repo <path>              Pinned official checkout; supplies root version/engines.node
  --node-engine <range>          Explicit audited engines.node contract
  --tool <lower_snake_name>      Registered tool name (default: derived)
  --id <kebab-id>                Patch row id (default: derived)
  --description <text>           Package and tool description
  --cordis-version <exact>       Explicit audited contract override
  --dsh-tools-version <exact>    Explicit audited contract override
  --schemastery-version <exact>  Explicit audited contract override
  --typescript-version <exact>   Exact toolchain override (rc.2 snapshot: 6.0.3)
  --node-types-version <exact>   Exact @types/node override (rc.2 snapshot: 22.20.0)
  --npm-version <exact>          Exact packageManager override (default: detected npm)
  --json                         Print a machine-readable result
  -h, --help                     Show this help

The target must not exist or must be an empty real directory. There is no
--force mode: this command never overwrites an existing file.
`
}

function parseArgs(argv) {
  const options = { dir: process.cwd(), profile: 'web', json: false }
  const positional = []
  const keyMap = new Map([
    ['--dir', 'dir'],
    ['--profile', 'profile'],
    ['--dsh-home', 'dshHome'],
    ['--dsh-repo', 'dshRepo'],
    ['--node-engine', 'nodeEngine'],
    ['--tool', 'tool'],
    ['--id', 'id'],
    ['--description', 'description'],
    ['--cordis-version', 'cordisVersion'],
    ['--dsh-tools-version', 'dshToolsVersion'],
    ['--schemastery-version', 'schemasteryVersion'],
    ['--typescript-version', 'typescriptVersion'],
    ['--node-types-version', 'nodeTypesVersion'],
    ['--npm-version', 'npmVersion'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--json') options.json = true
    else if (keyMap.has(argument)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail(`${argument} requires a value`, 64)
      options[keyMap.get(argument)] = value
      index += 1
    } else if (argument.startsWith('-')) {
      fail(`unknown option: ${safeDiagnostic(argument)}`, 64)
    } else positional.push(argument)
  }
  if (positional.length !== 1 && !options.help) fail('exactly one package name is required', 64)
  if (positional.length > 1) fail(`unexpected argument: ${safeDiagnostic(positional[1])}`, 64)
  options.packageName = positional[0]
  return options
}

function parseExactVersion(value, label) {
  if (typeof value !== 'string' || !EXACT_VERSION.test(value)) {
    fail(`${label} must be an exact semantic version; ranges, tags, URLs, and "*" are not allowed`)
  }
  return value
}

function validatePackageName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 214 || value !== value.toLowerCase()) {
    fail('package name must be lowercase, npm-compatible, and no longer than 214 characters')
  }
  const match = PACKAGE_NAME.exec(value)
  if (match === null || ['node_modules', 'favicon.ico'].includes(match[2])) {
    fail(`invalid npm package name: ${safeDiagnostic(value)}`)
  }
  const packageSegment = match[2]
  if (!/^dsh-[a-z0-9][a-z0-9-]*$/.test(packageSegment)) {
    fail('the package segment must follow the dsh-<kebab-case> convention')
  }
  return { packageName: value, packageSegment, scope: match[1] }
}

function validateDescription(value, packageName) {
  const description = value ?? `A pure string-transformation Tool Bundle for DeepSeek Harness (${packageName}).`
  if (typeof description !== 'string' || description.trim().length === 0 || description.length > 500) {
    fail('description must contain 1 to 500 characters')
  }
  if (/\0|[\ud800-\udfff]/u.test(description)) fail('description contains an invalid Unicode or NUL character')
  return description
}

function readInstalledPackage(packageName, profile, dshHome) {
  const segments = packageName.split('/')
  const candidates = [
    path.join(dshHome, 'profiles', profile, 'node_modules', ...segments, 'package.json'),
    path.join(dshHome, 'profiles', 'node_modules', ...segments, 'package.json'),
  ]
  for (const candidate of candidates) {
    let realManifest
    try {
      realManifest = realpathSync(candidate)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      fail(`cannot resolve installed manifest for ${packageName}: ${safeDiagnostic(candidate)}`)
    }
    const stats = lstatSync(realManifest)
    if (!stats.isFile() || stats.size > 1_000_000) fail(`installed manifest for ${packageName} must be a small regular file`)
    const text = readFileSync(realManifest, 'utf8')
    let manifest
    try {
      manifest = JSON.parse(text)
    } catch {
      fail(`installed manifest for ${packageName} is invalid JSON: ${safeDiagnostic(realManifest)}`)
    }
    if (manifest?.name !== packageName) fail(`installed manifest identity does not match ${packageName}`)
    return {
      manifest,
      version: parseExactVersion(manifest.version, `${packageName} installed version`),
      source: realManifest,
    }
  }
  return undefined
}

function readPackageVersion(packageName, profile, dshHome) {
  const installed = readInstalledPackage(packageName, profile, dshHome)
  if (installed === undefined) return undefined
  return { version: installed.version, source: installed.source }
}

function validateNodeEngine(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    fail(`${label} must be a non-empty Node.js semver range no longer than 256 characters`)
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value) || !/^[0-9vVxX<>=~^| .+()-]+$/.test(value) || !/\d/.test(value)) {
    fail(`${label} is not a supported Node.js semver range`)
  }
  const branchMinimums = value.split('||').map(branch => {
    // Ignore upper-bound-only comparators (< / <=). Every accepted branch must
    // expose a concrete lower major through an exact, >, >=, ^, ~, or = term.
    const lowerMajors = [...branch.matchAll(/(?:^|[\s(])(?:>=|>|~|\^|=)?\s*[vV]?(\d+)(?:\.\d+){0,2}/g)]
      .map(match => Number(match[1]))
    if (lowerMajors.length === 0 || lowerMajors.some(major => !Number.isSafeInteger(major))) {
      fail(`${label} has a branch without a parseable minimum Node.js major`)
    }
    return Math.min(...lowerMajors)
  })
  if (branchMinimums.length === 0) {
    fail(`${label} does not expose a parseable minimum Node.js major`)
  }
  return { range: value, minimumMajor: Math.min(...branchMinimums) }
}

function validateFastScaffoldAudit(version, audit) {
  const node = validateNodeEngine(audit?.nodeEngine, `DSH ${version} audit engines.node`)
  parseExactVersion(audit?.typescriptVersion, `DSH ${version} audit TypeScript version`)
  parseExactVersion(audit?.nodeTypesVersion, `DSH ${version} audit @types/node version`)
  if (typeof audit?.source !== 'string' || audit.source.length === 0) {
    fail(`DSH ${version} fast-scaffold audit has no evidence source`)
  }
  for (const spec of REQUIRED_RUNTIME_PACKAGES) {
    parseExactVersion(
      audit.runtimeVersions?.[spec.packageName],
      `DSH ${version} audit ${spec.packageName} version`,
    )
    if (audit.packageOwnership?.[spec.packageName] !== spec.ownership) {
      fail(`DSH ${version} fast-scaffold audit has no verified ${spec.packageName} ownership`)
    }
  }
  return node
}

function readDshRepository(value) {
  let root
  try {
    root = realpathSync(path.resolve(value))
  } catch {
    fail(`--dsh-repo cannot be resolved: ${safeDiagnostic(value)}`)
  }
  if (!lstatSync(root).isDirectory()) fail('--dsh-repo must resolve to a directory')
  const manifestPath = path.join(root, 'package.json')
  let manifestReal
  try {
    manifestReal = realpathSync(manifestPath)
  } catch {
    fail('--dsh-repo does not contain a readable root package.json')
  }
  if (path.dirname(manifestReal) !== root || !lstatSync(manifestReal).isFile()) {
    fail('--dsh-repo root package.json must be a regular file inside the checkout root')
  }
  const text = readFileSync(manifestReal, 'utf8')
  if (Buffer.byteLength(text) > 1_000_000) fail('--dsh-repo root package.json is unexpectedly large')
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    fail('--dsh-repo root package.json is invalid JSON')
  }
  if (manifest?.name !== '@deepseek-ai/dsh-root') {
    fail('--dsh-repo root package must be @deepseek-ai/dsh-root')
  }
  const version = parseExactVersion(manifest.version, '--dsh-repo root version')
  const node = validateNodeEngine(manifest.engines?.node, '--dsh-repo engines.node')
  return { root, version, node, source: manifestReal }
}

function detectNpmVersion() {
  const result = spawnSync('npm', ['--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  })
  if (result.status !== 0) fail('npm --version failed; pass --npm-version with an exact version')
  return parseExactVersion(result.stdout.trim(), 'detected npm version')
}

function listTemplates(root, base = root, output = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isSymbolicLink()) fail(`scaffold assets must not contain symlinks: ${safeDiagnostic(absolute)}`)
    if (entry.isDirectory()) listTemplates(absolute, base, output)
    else if (entry.isFile() && entry.name.endsWith('.tmpl')) output.push(path.relative(base, absolute))
  }
  return output
}

function outputRelativePath(templateRelative) {
  const withoutSuffix = templateRelative.replace(/\.tmpl$/, '')
  const dirname = path.dirname(withoutSuffix)
  const basename = path.basename(withoutSuffix) === 'gitignore'
    ? '.gitignore'
    : path.basename(withoutSuffix)
  const result = dirname === '.' ? basename : path.join(dirname, basename)
  if (path.isAbsolute(result) || result.split(path.sep).some(part => part === '..' || part === '')) {
    fail(`unsafe scaffold asset path: ${safeDiagnostic(templateRelative)}`)
  }
  return result
}

function markdownText(value) {
  return String(value)
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/([\\`*_{}\[\]()<>#+.!|~-])/g, '\\$1')
}

function renderTemplate(text, values, label) {
  let rendered = text
  for (const [name, value] of Object.entries(values)) {
    rendered = rendered.split(`__${name}__`).join(value)
  }
  const unresolved = rendered.match(/__[A-Z][A-Z0-9_]*__/g)
  if (unresolved !== null) fail(`${label} has unresolved placeholder ${safeDiagnostic(unresolved[0])}`)
  return rendered
}

function ensureParent(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail('output parent is invalid')
  const requested = path.resolve(value)
  mkdirSync(requested, { recursive: true })
  const canonical = realpathSync(requested)
  if (!lstatSync(canonical).isDirectory()) fail('output parent is not a directory')
  return canonical
}

function targetState(target) {
  try {
    const stats = lstatSync(target)
    if (stats.isSymbolicLink()) fail(`target is a symlink and will not be used: ${safeDiagnostic(target)}`)
    if (!stats.isDirectory()) fail(`target exists and is not a directory: ${safeDiagnostic(target)}`)
    const entries = readdirSync(target)
    if (entries.length !== 0) fail(`target directory is not empty: ${safeDiagnostic(target)}`)
    return 'empty-directory'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return
  }

  const identity = validatePackageName(options.packageName)
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(options.profile) || options.profile.includes('..')) {
    fail('profile must be a short name, not a path')
  }
  const pluginId = options.id ?? identity.packageSegment.slice('dsh-'.length)
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(pluginId)) fail('patch row id must be 1-63 characters of kebab-case')
  const toolName = options.tool ?? `${pluginId.replace(/-/g, '_')}_transform`
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(toolName)) fail('tool name must be 1-64 characters of lower_snake_case')
  if (toolName === 'run_code') fail('run_code is reserved by DeepSeek Harness')

  const description = validateDescription(options.description, identity.packageName)
  const requestedHome = options.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  if (typeof requestedHome !== 'string' || requestedHome.length === 0 || requestedHome.includes('\0')) fail('DSH home is invalid')
  const dshHome = path.resolve(requestedHome)
  const installedDsh = readInstalledPackage('@deepseek-ai/dsh', options.profile, dshHome)
  const repositoryDsh = options.dshRepo === undefined ? undefined : readDshRepository(options.dshRepo)
  if (installedDsh !== undefined && repositoryDsh !== undefined && installedDsh.version !== repositoryDsh.version) {
    fail(`--dsh-repo version ${repositoryDsh.version} does not match installed @deepseek-ai/dsh ${installedDsh.version}`)
  }
  if (installedDsh === undefined && repositoryDsh === undefined) {
    fail(`@deepseek-ai/dsh was not found in Profile ${safeDiagnostic(options.profile)} and no --dsh-repo was supplied; the target DSH version is unknown`)
  }
  const dshVersion = installedDsh?.version ?? repositoryDsh.version
  const audit = FAST_SCAFFOLD_AUDITS[dshVersion]
  if (audit === undefined) {
    fail(`DSH ${dshVersion} has no complete fast-scaffold audit snapshot; use the manual capability path even if explicit toolchain versions are available`)
  }
  const auditedNode = validateFastScaffoldAudit(dshVersion, audit)

  let installedNode
  if (installedDsh?.manifest?.engines?.node !== undefined) {
    installedNode = validateNodeEngine(installedDsh.manifest.engines.node, 'installed @deepseek-ai/dsh engines.node')
  }
  if (installedNode !== undefined && repositoryDsh !== undefined && installedNode.range !== repositoryDsh.node.range) {
    fail(`installed @deepseek-ai/dsh engines.node ${safeDiagnostic(installedNode.range)} does not match the pinned --dsh-repo contract ${safeDiagnostic(repositoryDsh.node.range)}`)
  }
  const explicitNode = options.nodeEngine === undefined
    ? undefined
    : validateNodeEngine(options.nodeEngine, '--node-engine')
  if (explicitNode !== undefined && repositoryDsh !== undefined && explicitNode.range !== repositoryDsh.node.range) {
    fail(`--node-engine ${safeDiagnostic(explicitNode.range)} does not match the pinned --dsh-repo contract ${safeDiagnostic(repositoryDsh.node.range)}`)
  }
  if (explicitNode !== undefined && installedNode !== undefined && explicitNode.range !== installedNode.range) {
    fail(`--node-engine ${safeDiagnostic(explicitNode.range)} does not match the installed @deepseek-ai/dsh contract ${safeDiagnostic(installedNode.range)}`)
  }
  const nodeContract = explicitNode ?? repositoryDsh?.node ?? installedNode
  const nodeEngineSource = explicitNode !== undefined
    ? 'explicit --node-engine override'
    : repositoryDsh !== undefined
      ? `${repositoryDsh.source}#engines.node`
      : installedDsh !== undefined && installedNode !== undefined
        ? `${installedDsh.source}#engines.node`
        : undefined
  if (nodeContract === undefined) {
    fail('the target @deepseek-ai/dsh manifest has no engines.node; pass --dsh-repo for a matching pinned official checkout or --node-engine explicitly')
  }
  if (nodeContract.range !== auditedNode.range) {
    fail(`target engines.node ${safeDiagnostic(nodeContract.range)} does not match the audited DSH ${dshVersion} fast-scaffold contract ${safeDiagnostic(auditedNode.range)}`)
  }

  const versions = {}
  const versionSources = {}
  for (const spec of REQUIRED_RUNTIME_PACKAGES) {
    const override = options[spec.option]
    const installed = readPackageVersion(spec.packageName, options.profile, dshHome)
    if (override !== undefined) {
      const version = parseExactVersion(override, `--${spec.option}`)
      if (installed !== undefined && installed.version !== version) {
        fail(`--${spec.option} ${version} does not match installed ${spec.packageName} ${installed.version} in Profile ${safeDiagnostic(options.profile)}`)
      }
      versions[spec.token] = version
      versionSources[spec.token] = installed === undefined
        ? 'explicit audited override'
        : `explicit audited override matching ${installed.source}`
    } else {
      if (installed === undefined) {
        fail(`${spec.packageName} was not found in Profile ${safeDiagnostic(options.profile)} under ${safeDiagnostic(dshHome)}; install the Profile or pass its exact version explicitly`)
      }
      versions[spec.token] = installed.version
      versionSources[spec.token] = installed.source
    }
    const auditedVersion = audit.runtimeVersions[spec.packageName]
    if (versions[spec.token] !== auditedVersion) {
      fail(`${spec.packageName} ${versions[spec.token]} does not match the audited DSH ${dshVersion} fast-scaffold contract ${auditedVersion}`)
    }
  }

  if (nodeContract.minimumMajor !== 22 && options.nodeTypesVersion === undefined) {
    fail(`the target engines.node minimum major is ${nodeContract.minimumMajor}, not 22; pass a matching --node-types-version explicitly`)
  }
  const typescriptVersion = parseExactVersion(options.typescriptVersion ?? audit.typescriptVersion, 'TypeScript version')
  const nodeTypesVersion = parseExactVersion(options.nodeTypesVersion ?? audit.nodeTypesVersion, '@types/node version')
  const nodeTypesMajor = Number(EXACT_VERSION.exec(nodeTypesVersion)[1])
  if (nodeTypesMajor !== nodeContract.minimumMajor) {
    fail(`@types/node major ${nodeTypesMajor} does not match the target engines.node minimum major ${nodeContract.minimumMajor}`)
  }
  const toolchainSources = {
    typescript: options.typescriptVersion === undefined ? audit.source : 'explicit audited --typescript-version override',
    '@types/node': options.nodeTypesVersion === undefined ? audit.source : 'explicit audited --node-types-version override',
  }
  const npmVersion = options.npmVersion === undefined
    ? detectNpmVersion()
    : parseExactVersion(options.npmVersion, 'npm version')
  const parent = ensureParent(options.dir)
  const target = path.join(parent, identity.packageSegment)
  if (path.dirname(target) !== parent) fail('derived target escaped the requested output parent')
  const originalTargetState = targetState(target)
  const templates = listTemplates(ASSET_DIR).sort()
  if (templates.length === 0) fail(`no scaffold templates found in ${safeDiagnostic(ASSET_DIR)}`)

  const values = {
    PACKAGE_NAME_JSON: JSON.stringify(identity.packageName),
    PACKAGE_NAME_TS: JSON.stringify(identity.packageName),
    PACKAGE_NAME_YAML: JSON.stringify(identity.packageName),
    PACKAGE_NAME_MD: identity.packageName,
    PACKAGE_DIR_MD: identity.packageSegment,
    PLUGIN_ID_TS: JSON.stringify(pluginId),
    PLUGIN_ID_YAML: JSON.stringify(pluginId),
    PLUGIN_ID_MD: pluginId,
    TOOL_NAME_TS: JSON.stringify(toolName),
    TOOL_NAME_MD: toolName,
    DESCRIPTION_JSON: JSON.stringify(description),
    DESCRIPTION_TS: JSON.stringify(description),
    DESCRIPTION_MD: markdownText(description),
    CORDIS_VERSION_JSON: JSON.stringify(versions.CORDIS),
    CORDIS_PEER_JSON: JSON.stringify(versions.CORDIS),
    DSH_TOOLS_VERSION_JSON: JSON.stringify(versions.DSH_TOOLS),
    DSH_TOOLS_PEER_JSON: JSON.stringify(versions.DSH_TOOLS),
    SCHEMASTERY_VERSION_JSON: JSON.stringify(versions.SCHEMASTERY),
    NODE_TYPES_VERSION_JSON: JSON.stringify(nodeTypesVersion),
    TYPESCRIPT_VERSION_JSON: JSON.stringify(typescriptVersion),
    NPM_VERSION_JSON: JSON.stringify(`npm@${npmVersion}`),
    NODE_ENGINE_JSON: JSON.stringify(nodeContract.range),
    YEAR: String(new Date().getUTCFullYear()),
  }

  const staging = mkdtempSync(path.join(parent, '.dsh-scaffold-'))
  let targetRemoved = false
  try {
    for (const templateRelative of templates) {
      const outputRelative = outputRelativePath(templateRelative)
      const output = path.join(staging, outputRelative)
      if (!output.startsWith(`${staging}${path.sep}`)) fail(`asset escaped staging root: ${safeDiagnostic(outputRelative)}`)
      const source = path.join(ASSET_DIR, templateRelative)
      const rendered = renderTemplate(readFileSync(source, 'utf8'), values, templateRelative)
      mkdirSync(path.dirname(output), { recursive: true })
      writeFileSync(output, rendered, { encoding: 'utf8', flag: 'wx', mode: 0o644 })
    }

    const manifest = JSON.parse(readFileSync(path.join(staging, 'package.json'), 'utf8'))
    if (manifest.name !== identity.packageName || manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
      fail('generated package manifest failed its post-render invariant')
    }
    if (Object.values(manifest.devDependencies ?? {}).some(value => !EXACT_VERSION.test(value))) {
      fail('generated devDependencies must all use exact semantic versions')
    }
    for (const packageName of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']) {
      const peer = manifest.peerDependencies?.[packageName]
      const development = manifest.devDependencies?.[packageName]
      if (!EXACT_VERSION.test(peer) || peer !== development) {
        fail(`generated ${packageName} peer dependency must exactly match its development dependency`)
      }
    }
    if (manifest.dependencies?.['@deepseek-ai/schemastery'] !== versions.SCHEMASTERY) {
      fail('generated Schemastery dependency must use the exact selected runtime version')
    }
    if (manifest.engines?.node !== nodeContract.range) {
      fail('generated engines.node must preserve the target DSH contract exactly')
    }

    if (originalTargetState === 'empty-directory') {
      rmdirSync(target)
      targetRemoved = true
    }
    renameSync(staging, target)
  } catch (error) {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // Preserve the original failure.
    }
    if (targetRemoved) {
      try {
        mkdirSync(target)
      } catch {
        // The rename may have raced with another creator; never overwrite it.
      }
    }
    throw error
  }

  const result = {
    target,
    packageName: identity.packageName,
    profile: options.profile,
    dshVersion,
    dshVersionSources: [installedDsh?.source, repositoryDsh?.source].filter(Boolean),
    nodeEngine: nodeContract.range,
    nodeEngineMinimumMajor: nodeContract.minimumMajor,
    nodeEngineSource,
    toolchainVersions: {
      typescript: typescriptVersion,
      '@types/node': nodeTypesVersion,
    },
    toolchainSources,
    toolName,
    pluginId,
    runtimeVersions: {
      '@deepseek-ai/cordis': versions.CORDIS,
      '@deepseek-ai/dsh-tools': versions.DSH_TOOLS,
      '@deepseek-ai/schemastery': versions.SCHEMASTERY,
    },
    versionSources,
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`Created ${target}\n`)
    process.stdout.write(`Package: ${identity.packageName}\nTool: ${toolName}\nProfile contract: ${options.profile}\nDSH: ${dshVersion}\nNode engine: ${nodeContract.range}\n`)
    for (const [packageName, version] of Object.entries(result.runtimeVersions)) {
      process.stdout.write(`  ${packageName} ${version}\n`)
    }
    process.stdout.write(`\nNext:\n  cd ${JSON.stringify(target)}\n  npm install\n  # npm install creates package-lock.json; review and commit it.\n  npm run check\n  node ${JSON.stringify(path.join(SCRIPT_DIR, 'validate_plugin.mjs'))} . --built\n`)
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`scaffold_plugin: ${safeDiagnostic(error?.message ?? error)}\n`)
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1
}
