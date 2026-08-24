import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  assertStablePackedArtifact,
  assertInstalledTreeMetadataGuard,
  assertComposedBundle,
  canonicalInstalledArtifactRoot,
  captureInstalledTreeMetadataGuard,
  freezePackedArtifact,
  httpStatus,
  manifestAllowsBundleMount,
  manualFreshProfileCommands,
  parsePackResult,
  preparePackOnlyHandoff,
  recheckInstalledTreeMetadataGuard,
} from '../scripts/accept_plugin.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAFFOLD = path.join(ROOT, 'scripts', 'scaffold_plugin.mjs')
const ACCEPT = path.join(ROOT, 'scripts', 'accept_plugin.mjs')
const VALIDATOR = path.join(ROOT, 'scripts', 'validate_plugin.mjs')
const BASELINE = {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-tools': '0.1.1-rc.2',
  '@deepseek-ai/schemastery': '3.18.1',
}
const DSH_VERSION = '0.1.1-rc.2'
const NODE_ENGINE = '^22.19.0 || >=24.0.0'

function temporary(t, prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function createFakeDshHome(root, packages = BASELINE, dshManifest = {
  name: '@deepseek-ai/dsh',
  version: DSH_VERSION,
  engines: { node: NODE_ENGINE },
}) {
  for (const [packageName, version] of Object.entries(packages)) {
    const manifest = path.join(root, 'profiles', 'node_modules', ...packageName.split('/'), 'package.json')
    mkdirSync(path.dirname(manifest), { recursive: true })
    writeFileSync(manifest, `${JSON.stringify({ name: packageName, version })}\n`)
  }
  if (dshManifest != null) {
    const manifest = path.join(root, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    mkdirSync(path.dirname(manifest), { recursive: true })
    writeFileSync(manifest, `${JSON.stringify(dshManifest)}\n`)
  }
}

function createFakeDshRepo(root, { version = DSH_VERSION, nodeEngine = NODE_ENGINE } = {}) {
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-root',
    version,
    engines: { node: nodeEngine },
  })}\n`)
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeout ?? 240_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
}

function assertSuccess(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`)
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
}

function scaffoldArgs(packageName, parent, dshHome, extra = []) {
  return [
    SCAFFOLD,
    packageName,
    '--dir', parent,
    '--dsh-home', dshHome,
    '--profile', 'web',
    '--npm-version', '10.9.3',
    '--json',
    ...extra,
  ]
}

function allTextFiles(root, current = root, output = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name)
    if (entry.isDirectory()) allTextFiles(root, file, output)
    else if (entry.isFile()) output.push(path.relative(root, file))
  }
  return output
}

function createAcceptanceFixture(root, { packageManager, postpack } = {}) {
  mkdirSync(path.join(root, 'dist'), { recursive: true })
  mkdirSync(path.join(root, 'src'), { recursive: true })
  const manifest = {
    name: 'dsh-package-manager-probe',
    version: '1.2.3',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    },
    files: ['dist', 'src', 'README.md', 'SECURITY.md', 'LICENSE'],
    scripts: {
      check: 'node check-env.mjs',
      prepack: 'node check-env.mjs',
      ...(postpack === undefined ? {} : { postpack }),
    },
    ...(packageManager === undefined ? {} : { packageManager }),
  }
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(path.join(root, 'dist', 'index.js'), 'export function apply() {}\n')
  writeFileSync(path.join(root, 'dist', 'index.d.ts'), 'export declare function apply(): void\n')
  writeFileSync(path.join(root, 'src', 'index.js'), 'export function apply() {}\n')
  writeFileSync(path.join(root, 'check-env.mjs'), [
    "const forbidden = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DSH_PROVIDER_TOKEN']",
    "for (const key of forbidden) if (process.env[key] !== undefined) throw new Error(`credential leaked: ${key}`)",
    '',
  ].join('\n'))
  writeFileSync(path.join(root, 'README.md'), '# Package manager probe\n')
  writeFileSync(path.join(root, 'SECURITY.md'), 'Report vulnerabilities privately.\n')
  writeFileSync(path.join(root, 'LICENSE'), 'Test fixture only.\n')
}

test('scaffold safely renders scoped names and hostile punctuation into a complete package', t => {
  const root = temporary(t, 'dsh-scaffold-render-')
  const home = path.join(root, 'dsh-home')
  const output = path.join(root, 'output')
  createFakeDshHome(home)
  const description = 'Quotes " and \' and `, slash \\, ${notCode}, colon: #hash, 中文\nnext line'
  const result = run(process.execPath, scaffoldArgs('@win-4r/dsh-escape-probe', output, home, [
    '--description', description,
    '--tool', 'escape_transform',
    '--id', 'escape-probe',
  ]))
  assertSuccess(result, 'scaffold special-character package')
  const report = JSON.parse(result.stdout)
  const plugin = path.join(output, 'dsh-escape-probe')
  assert.equal(report.target, realpathSync(plugin))
  assert.equal(report.packageName, '@win-4r/dsh-escape-probe')

  const manifest = JSON.parse(readFileSync(path.join(plugin, 'package.json'), 'utf8'))
  assert.equal(manifest.description, description)
  assert.deepEqual(manifest.exports['.'], { types: './dist/index.d.ts', default: './dist/index.js' })
  assert.deepEqual(manifest.files, ['dist', 'cordis.patch.yml', 'README.md', 'SECURITY.md', 'LICENSE'])
  assert.equal(manifest.dependencies['@deepseek-ai/schemastery'], BASELINE['@deepseek-ai/schemastery'])
  assert.equal(manifest.devDependencies['@deepseek-ai/cordis'], BASELINE['@deepseek-ai/cordis'])
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-tools'], BASELINE['@deepseek-ai/dsh-tools'])
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], BASELINE['@deepseek-ai/cordis'])
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], BASELINE['@deepseek-ai/dsh-tools'])
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], manifest.devDependencies['@deepseek-ai/cordis'])
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], manifest.devDependencies['@deepseek-ai/dsh-tools'])
  assert.equal(manifest.devDependencies.typescript, '6.0.3')
  assert.equal(manifest.devDependencies['@types/node'], '22.20.0')
  assert.equal(manifest.engines.node, NODE_ENGINE)
  assert.ok(['build', 'typecheck', 'test', 'check', 'prepare', 'prepack'].every(name => manifest.scripts[name]))
  assert.equal(report.dshVersion, DSH_VERSION)
  assert.equal(report.nodeEngine, NODE_ENGINE)
  assert.equal(report.nodeEngineMinimumMajor, 22)
  assert.equal(report.toolchainVersions.typescript, '6.0.3')
  assert.equal(report.toolchainVersions['@types/node'], '22.20.0')

  const expected = [
    '.gitignore', 'LICENSE', 'README.md', 'SECURITY.md', 'cordis.patch.yml',
    'package.json', 'src/config.ts', 'src/index.ts', 'test/plugin.test.mjs', 'tsconfig.json',
  ]
  assert.deepEqual(allTextFiles(plugin).sort(), expected)
  const combined = expected.map(file => readFileSync(path.join(plugin, file), 'utf8')).join('\n')
  assert.doesNotMatch(combined, /__[A-Z][A-Z0-9_]*__/)
  assert.doesNotMatch(combined, /\/Users\/|\/home\/[a-z0-9]/i)
  assert.match(readFileSync(path.join(plugin, 'src', 'index.ts'), 'utf8'), /TRUNCATED:/)
  assert.match(readFileSync(path.join(plugin, 'src', 'config.ts'), 'utf8'), /unknown config key/)
  assert.match(readFileSync(path.join(plugin, 'cordis.patch.yml'), 'utf8'), /name: "@win-4r\/dsh-escape-probe"/)
  const readme = readFileSync(path.join(plugin, 'README.md'), 'utf8')
  assert.match(readme, /Profile or an explicit audited override/)
  assert.match(readme, /exact peer defaults are deliberate/i)
  assert.match(readme, /compatibility evidence for every admitted host version/i)
})

test('scaffold fails closed when an installed runtime version is missing', t => {
  const root = temporary(t, 'dsh-scaffold-missing-')
  const home = path.join(root, 'dsh-home')
  const output = path.join(root, 'output')
  createFakeDshHome(home, {
    '@deepseek-ai/cordis': BASELINE['@deepseek-ai/cordis'],
    '@deepseek-ai/dsh-tools': BASELINE['@deepseek-ai/dsh-tools'],
  })
  const result = run(process.execPath, scaffoldArgs('dsh-missing-version', output, home))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /schemastery.*was not found/i)
  assert.equal(existsSync(path.join(output, 'dsh-missing-version')), false)

  const wildcard = run(process.execPath, scaffoldArgs('dsh-wildcard-version', output, home, [
    '--schemastery-version', '*',
  ]))
  assert.notEqual(wildcard.status, 0)
  assert.match(wildcard.stderr, /exact semantic version/)

  const auditedOverride = run(process.execPath, scaffoldArgs('dsh-missing-version', output, home, [
    '--schemastery-version', BASELINE['@deepseek-ai/schemastery'],
  ]))
  assertSuccess(auditedOverride, 'explicit audited override for absent Profile package')
  const report = JSON.parse(auditedOverride.stdout)
  assert.equal(report.versionSources.SCHEMASTERY, 'explicit audited override')
})

test('explicit runtime overrides must exactly match packages installed in the target Profile', t => {
  const root = temporary(t, 'dsh-scaffold-override-mismatch-')
  const home = path.join(root, 'dsh-home')
  const output = path.join(root, 'output')
  createFakeDshHome(home)

  for (const [option, packageName, conflictingVersion] of [
    ['--cordis-version', '@deepseek-ai/cordis', '4.0.2'],
    ['--dsh-tools-version', '@deepseek-ai/dsh-tools', '0.1.1-rc.1'],
    ['--schemastery-version', '@deepseek-ai/schemastery', '3.18.0'],
  ]) {
    const suffix = packageName.split('/').at(-1).replace(/[^a-z0-9]+/g, '-')
    const result = run(process.execPath, scaffoldArgs(`dsh-${suffix}-override-conflict`, output, home, [
      option, conflictingVersion,
    ]))
    assert.notEqual(result.status, 0, packageName)
    assert.match(result.stderr, /does not match installed/i, packageName)
    assert.equal(existsSync(path.join(output, `dsh-${suffix}-override-conflict`)), false)
  }

  const matching = run(process.execPath, scaffoldArgs('dsh-matching-overrides', output, home, [
    '--cordis-version', BASELINE['@deepseek-ai/cordis'],
    '--dsh-tools-version', BASELINE['@deepseek-ai/dsh-tools'],
    '--schemastery-version', BASELINE['@deepseek-ai/schemastery'],
  ]))
  assertSuccess(matching, 'matching installed runtime overrides')
  const report = JSON.parse(matching.stdout)
  assert.match(report.versionSources.CORDIS, /explicit audited override matching/)
  assert.match(report.versionSources.DSH_TOOLS, /explicit audited override matching/)
  assert.match(report.versionSources.SCHEMASTERY, /explicit audited override matching/)
})

test('fast scaffold rejects runtime versions outside the selected DSH audit snapshot', t => {
  const root = temporary(t, 'dsh-scaffold-runtime-audit-mismatch-')
  const home = path.join(root, 'dsh-home')
  const output = path.join(root, 'output')
  createFakeDshHome(home, {
    ...BASELINE,
    '@deepseek-ai/cordis': '4.0.2',
  })

  const result = run(process.execPath, scaffoldArgs('dsh-runtime-audit-mismatch', output, home))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /cordis 4\.0\.2 does not match the audited DSH 0\.1\.1-rc\.2 fast-scaffold contract 4\.0\.1/i)
  assert.equal(existsSync(path.join(output, 'dsh-runtime-audit-mismatch')), false)
})

test('scaffold rejects non-canonical semantic-version overrides', t => {
  const root = temporary(t, 'dsh-scaffold-invalid-semver-')
  const home = path.join(root, 'dsh-home')
  const output = path.join(root, 'output')
  createFakeDshHome(home)

  for (const [option, value] of [
    ['--typescript-version', '6.0.3-01'],
    ['--node-types-version', '22.20.0-00'],
    ['--npm-version', '10.9.3-01'],
  ]) {
    const result = run(process.execPath, scaffoldArgs(`dsh-invalid-semver-${option.slice(2)}`, output, home, [option, value]))
    assert.notEqual(result.status, 0, option)
    assert.match(result.stderr, /exact semantic version/i, option)
  }
})

test('scaffold derives Node contract from installed DSH or a matching pinned repository and otherwise fails closed', t => {
  const root = temporary(t, 'dsh-scaffold-node-contract-')
  const output = path.join(root, 'output')

  const noDshHome = path.join(root, 'no-dsh-home')
  createFakeDshHome(noDshHome, BASELINE, null)
  const unknownTarget = run(process.execPath, scaffoldArgs('dsh-target-unknown', output, noDshHome, [
    '--node-engine', NODE_ENGINE,
  ]))
  assert.notEqual(unknownTarget.status, 0)
  assert.match(unknownTarget.stderr, /target DSH version is unknown/)

  const noEngineHome = path.join(root, 'no-engine-home')
  createFakeDshHome(noEngineHome, BASELINE, { name: '@deepseek-ai/dsh', version: DSH_VERSION })
  const missing = run(process.execPath, scaffoldArgs('dsh-node-missing', output, noEngineHome))
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /no engines\.node|--dsh-repo|--node-engine/i)

  const explicit = run(process.execPath, scaffoldArgs('dsh-node-explicit', output, noEngineHome, [
    '--node-engine', NODE_ENGINE,
  ]))
  assertSuccess(explicit, 'explicit node engine')
  const explicitReport = JSON.parse(explicit.stdout)
  assert.equal(explicitReport.nodeEngineSource, 'explicit --node-engine override')

  const repo = path.join(root, 'official-repo')
  createFakeDshRepo(repo)
  const fromRepo = run(process.execPath, scaffoldArgs('dsh-node-repo', output, noEngineHome, [
    '--dsh-repo', repo,
  ]))
  assertSuccess(fromRepo, 'matching DSH repository')
  const repoReport = JSON.parse(fromRepo.stdout)
  assert.equal(repoReport.nodeEngine, NODE_ENGINE)
  assert.match(repoReport.nodeEngineSource, /package\.json#engines\.node$/)

  const conflictingEngine = run(process.execPath, scaffoldArgs('dsh-node-conflict', output, noEngineHome, [
    '--dsh-repo', repo,
    '--node-engine', '>=24.0.0',
    '--node-types-version', '24.0.0',
  ]))
  assert.notEqual(conflictingEngine.status, 0)
  assert.match(conflictingEngine.stderr, /does not match the pinned --dsh-repo contract/)

  const mismatchRepo = path.join(root, 'mismatch-repo')
  createFakeDshRepo(mismatchRepo, { version: '0.1.1-rc.1' })
  const mismatch = run(process.execPath, scaffoldArgs('dsh-node-mismatch', output, noEngineHome, [
    '--dsh-repo', mismatchRepo,
  ]))
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /does not match installed/)

  const conflictingInstalledHome = path.join(root, 'conflicting-installed-engine-home')
  createFakeDshHome(conflictingInstalledHome, BASELINE, {
    name: '@deepseek-ai/dsh',
    version: DSH_VERSION,
    engines: { node: '>=22.0.0' },
  })
  const engineMismatch = run(process.execPath, scaffoldArgs('dsh-installed-repo-engine-mismatch', output, conflictingInstalledHome, [
    '--dsh-repo', repo,
  ]))
  assert.notEqual(engineMismatch.status, 0)
  assert.match(engineMismatch.stderr, /installed.*engines\.node.*does not match.*--dsh-repo/i)
})

test('fast scaffold rejects DSH versions without a complete audit snapshot even with explicit toolchain versions', t => {
  const root = temporary(t, 'dsh-scaffold-toolchain-')
  const home = path.join(root, 'dsh-home')
  const output = path.join(root, 'output')
  createFakeDshHome(home, BASELINE, {
    name: '@deepseek-ai/dsh',
    version: '0.2.0',
    engines: { node: '>=24.0.0' },
  })
  const defaults = run(process.execPath, scaffoldArgs('dsh-new-defaults', output, home))
  assert.notEqual(defaults.status, 0)
  assert.match(defaults.stderr, /no complete fast-scaffold audit snapshot/)

  const explicit = run(process.execPath, scaffoldArgs('dsh-new-explicit-toolchain', output, home, [
    '--typescript-version', '6.0.3',
    '--node-types-version', '24.0.0',
  ]))
  assert.notEqual(explicit.status, 0)
  assert.match(explicit.stderr, /manual capability path/)
  assert.equal(existsSync(path.join(output, 'dsh-new-explicit-toolchain')), false)
})

test('acceptance mount inspection recognizes exported package subpaths and rejects hidden ones', () => {
  const manifest = {
    name: '@win-4r/dsh-subpath-probe',
    exports: {
      '.': './dist/index.js',
      './worker': './dist/worker.js',
      './adapters/*': './dist/adapters/*.js',
      './private/*': null,
    },
  }
  assert.equal(manifestAllowsBundleMount(manifest, manifest.name), true)
  assert.equal(manifestAllowsBundleMount(manifest, `${manifest.name}/worker`), true)
  assert.equal(manifestAllowsBundleMount(manifest, `${manifest.name}/adapters/git`), true)
  assert.equal(manifestAllowsBundleMount(manifest, `${manifest.name}/private/token`), false)
  assert.equal(manifestAllowsBundleMount(manifest, `${manifest.name}/missing`), false)
  assert.equal(manifestAllowsBundleMount(manifest, `${manifest.name}-lookalike/worker`), false)

  const validDump = `# == ${manifest.name}\n- id: root\n  name: ${manifest.name}\n- id: worker\n  name: ${manifest.name}/worker\n`
  assert.deepEqual(assertComposedBundle(validDump, manifest), ['root', 'worker'])
  const hiddenDump = `# == ${manifest.name}\n- id: hidden\n  name: ${manifest.name}/private/token\n`
  assert.throws(() => assertComposedBundle(hiddenDump, manifest), /exports do not expose/)
  const patchOnlyDump = `# == ${manifest.name}\n- id: existing-host-row\n  name: some-other-package\n`
  assert.throws(
    () => assertComposedBundle(patchOnlyDump, manifest),
    /automatic acceptance supports only Bundles mounting their own package root.*--pack-only/i,
  )
})

test('pack result parsing stays bounded with hostile lifecycle output', () => {
  const hostilePrefix = '{not-json lifecycle output}\n'.repeat(100_000)
  const pnpmResult = {
    name: 'dsh-parser-probe',
    version: '1.0.0',
    filename: '/tmp/dsh-parser-probe-1.0.0.tgz',
    files: [{ path: 'package.json' }],
  }
  assert.deepEqual(parsePackResult(`${hostilePrefix}${JSON.stringify(pnpmResult)}\n`, 'pnpm'), pnpmResult)

  const npmResult = { ...pnpmResult, filename: 'dsh-parser-probe-1.0.0.tgz' }
  assert.deepEqual(parsePackResult(`prepack log\n${JSON.stringify([npmResult], null, 2)}\n`, 'npm'), npmResult)
})

test('frozen packed artifacts detach hardlinks and reject later link or byte changes', t => {
  const root = temporary(t, 'dsh-artifact-freeze-')
  const destination = path.join(root, 'pack')
  mkdirSync(destination)
  const source = path.join(root, 'source.tgz')
  const sourceLink = path.join(root, 'source-hardlink.tgz')
  writeFileSync(source, 'original packed bytes')
  linkSync(source, sourceLink)

  const frozen = freezePackedArtifact(source, destination)
  assert.equal(readFileSync(frozen.archive, 'utf8'), 'original packed bytes')
  assert.equal(frozen.artifactGuard.size, String(Buffer.byteLength('original packed bytes')))
  assert.match(frozen.sha256, /^[0-9a-f]{64}$/)
  assert.doesNotThrow(() => assertStablePackedArtifact(frozen, 'after freeze'))

  writeFileSync(sourceLink, 'mutated source bytes')
  assert.equal(readFileSync(frozen.archive, 'utf8'), 'original packed bytes')
  assert.doesNotThrow(() => assertStablePackedArtifact(frozen, 'after source mutation'))

  linkSync(frozen.archive, path.join(root, 'unauthorized-artifact-link.tgz'))
  assert.throws(() => assertStablePackedArtifact(frozen, 'after hardlink creation'), /single-link/)
  unlinkSync(path.join(root, 'unauthorized-artifact-link.tgz'))
  chmodSync(frozen.archive, 0o600)
  writeFileSync(frozen.archive, 'replacement packed bytes')
  assert.throws(() => assertStablePackedArtifact(frozen, 'after byte replacement'), /changed/)
})

test('pack-only handoff rechecks bytes after freeze and before report generation', t => {
  const root = temporary(t, 'dsh-pack-only-final-guard-')
  const destination = path.join(root, 'pack')
  mkdirSync(destination)
  const source = path.join(root, 'source.tgz')
  writeFileSync(source, 'initial packed bytes')
  const frozen = freezePackedArtifact(source, destination)

  chmodSync(frozen.archive, 0o600)
  writeFileSync(frozen.archive, 'mutated after freeze')
  assert.throws(
    () => preparePackOnlyHandoff(frozen, '/usr/bin/true', 'web'),
    /frozen packed artifact changed before pack-only report and manual handoff/,
  )
})

test('artifact freezing rejects oversized candidates at a fixed byte limit', t => {
  const root = temporary(t, 'dsh-artifact-limit-')
  const destination = path.join(root, 'pack')
  mkdirSync(destination)
  const oversized = path.join(root, 'oversized.tgz')
  writeFileSync(oversized, '')
  truncateSync(oversized, 512 * 1024 * 1024 + 1)
  assert.throws(() => freezePackedArtifact(oversized, destination), /512 MiB acceptance limit/)
  assert.deepEqual(readdirSync(destination), [])
})

test('HTTP readiness uses a total deadline even when the response keeps streaming', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.write('ready-but-not-finished')
    const timer = setInterval(() => response.write('.'), 10)
    response.once('close', () => clearInterval(timer))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    assert.notEqual(address, null)
    const started = Date.now()
    await assert.rejects(httpStatus(address.port, 100), /total deadline/)
    assert.ok(Date.now() - started < 2_000, 'streaming response exceeded the bounded total deadline')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('canonical installed root permits pnpm layout only inside the temporary Profile', t => {
  const root = temporary(t, 'dsh-installed-root-')
  const dshHome = path.join(root, 'home')
  const profile = path.join(dshHome, 'profiles', 'web')
  const nodeModules = path.join(profile, 'node_modules')
  const pnpmPackage = path.join(nodeModules, '.pnpm', 'dsh-probe@1.0.0', 'node_modules', 'dsh-probe')
  mkdirSync(pnpmPackage, { recursive: true })
  writeFileSync(path.join(pnpmPackage, 'package.json'), '{"name":"dsh-probe","version":"1.0.0"}\n')
  symlinkSync(path.relative(nodeModules, pnpmPackage), path.join(nodeModules, 'dsh-probe'), 'dir')
  assert.equal(
    canonicalInstalledArtifactRoot(dshHome, profile, path.join(nodeModules, 'dsh-probe', 'package.json')),
    realpathSync(pnpmPackage),
  )

  const decoyPackage = path.join(nodeModules, 'in-profile-decoy')
  const redirectedPackage = path.join(nodeModules, 'redirected-package')
  mkdirSync(decoyPackage)
  mkdirSync(redirectedPackage)
  writeFileSync(path.join(decoyPackage, 'package.json'), '{"name":"decoy","version":"9.9.9"}\n')
  symlinkSync(
    path.relative(redirectedPackage, path.join(decoyPackage, 'package.json')),
    path.join(redirectedPackage, 'package.json'),
  )
  assert.throws(
    () => canonicalInstalledArtifactRoot(
      dshHome,
      profile,
      path.join(redirectedPackage, 'package.json'),
    ),
    /package\.json must be a regular single-link file directly inside the canonical package root/,
  )

  const hardlinkedPackage = path.join(nodeModules, 'hardlinked-package')
  const hardlinkSource = path.join(nodeModules, 'hardlink-source.json')
  mkdirSync(hardlinkedPackage)
  writeFileSync(hardlinkSource, '{"name":"hardlink-decoy","version":"9.9.9"}\n')
  linkSync(hardlinkSource, path.join(hardlinkedPackage, 'package.json'))
  assert.throws(
    () => canonicalInstalledArtifactRoot(
      dshHome,
      profile,
      path.join(hardlinkedPackage, 'package.json'),
    ),
    /package\.json must be a regular single-link file directly inside the canonical package root/,
  )

  const outsidePackage = path.join(root, 'outside-package')
  mkdirSync(outsidePackage)
  writeFileSync(path.join(outsidePackage, 'package.json'), '{"name":"escape","version":"1.0.0"}\n')
  symlinkSync(outsidePackage, path.join(nodeModules, 'escape'), 'dir')
  assert.throws(
    () => canonicalInstalledArtifactRoot(dshHome, profile, path.join(nodeModules, 'escape', 'package.json')),
    /outside the temporary Profile root/,
  )

  const outsideProfile = path.join(root, 'outside-profile')
  const escapedPackage = path.join(outsideProfile, 'node_modules', 'escaped')
  mkdirSync(escapedPackage, { recursive: true })
  writeFileSync(path.join(escapedPackage, 'package.json'), '{"name":"escaped","version":"1.0.0"}\n')
  symlinkSync(outsideProfile, path.join(dshHome, 'profiles', 'escaped'), 'dir')
  assert.throws(
    () => canonicalInstalledArtifactRoot(
      dshHome,
      path.join(dshHome, 'profiles', 'escaped'),
      path.join(dshHome, 'profiles', 'escaped', 'node_modules', 'escaped', 'package.json'),
    ),
    /outside the temporary DSH_HOME/,
  )
})

test('installed-tree metadata guard rejects persistent mutation and package-root redirection', t => {
  const root = temporary(t, 'dsh-installed-tree-guard-')
  const dshHome = path.join(root, 'home')
  const profile = path.join(dshHome, 'profiles', 'web')
  const packageRoot = path.join(profile, 'node_modules', 'dsh-tree-probe')
  const installedManifestPath = path.join(packageRoot, 'package.json')
  mkdirSync(path.join(packageRoot, 'dist'), { recursive: true })
  writeFileSync(installedManifestPath, '{"name":"dsh-tree-probe","version":"1.0.0"}\n')
  writeFileSync(path.join(packageRoot, 'dist', 'index.js'), 'export const value = 1\n')

  const canonicalRoot = canonicalInstalledArtifactRoot(dshHome, profile, installedManifestPath)
  const guard = captureInstalledTreeMetadataGuard(canonicalRoot, 10_000)
  assert.match(guard.metadataSha256, /^[0-9a-f]{64}$/)
  assert.equal(guard.includesDist, true)
  assert.equal(guard.contentBytesHashed, false)
  assert.ok(guard.entryCount >= 2)
  assert.ok(JSON.stringify(guard).length < 1_000, 'symbol-keyed raw snapshot must not serialize into reports')
  assert.deepEqual(
    assertInstalledTreeMetadataGuard(guard, canonicalRoot, 10_000, 'at-unchanged-gate'),
    {
      stage: 'at-unchanged-gate',
      metadataSha256: guard.metadataSha256,
      directoryCount: guard.directoryCount,
      entryCount: guard.entryCount,
    },
  )

  writeFileSync(path.join(packageRoot, 'dist', 'index.js'), 'export const value = 2\n')
  assert.throws(
    () => assertInstalledTreeMetadataGuard(guard, canonicalRoot, 10_000, 'after-content-mutation'),
    /installed-tree descriptor metadata changed after-content-mutation/,
  )

  const redirectPackageRoot = path.join(profile, 'node_modules', 'dsh-redirect-probe')
  const redirectManifestPath = path.join(redirectPackageRoot, 'package.json')
  mkdirSync(path.join(redirectPackageRoot, 'dist'), { recursive: true })
  writeFileSync(redirectManifestPath, '{"name":"dsh-redirect-probe","version":"1.0.0"}\n')
  writeFileSync(path.join(redirectPackageRoot, 'dist', 'index.js'), 'export const real = true\n')
  const redirectRoot = canonicalInstalledArtifactRoot(dshHome, profile, redirectManifestPath)
  const redirectGuard = captureInstalledTreeMetadataGuard(redirectRoot, 10_000)
  renameSync(redirectPackageRoot, path.join(profile, 'node_modules', 'dsh-redirect-probe-original'))
  mkdirSync(path.join(redirectPackageRoot, 'dist'), { recursive: true })
  writeFileSync(redirectManifestPath, '{"name":"dsh-redirect-probe","version":"1.0.0"}\n')
  writeFileSync(path.join(redirectPackageRoot, 'dist', 'index.js'), 'export const decoy = 1\n')
  assert.throws(
    () => recheckInstalledTreeMetadataGuard({
      expected: redirectGuard,
      dshHome,
      profileRoot: profile,
      installedManifestPath: redirectManifestPath,
      timeoutMs: 10_000,
      stage: 'after-package-root-redirection',
    }),
    /installed-tree descriptor metadata changed after-package-root-redirection/,
  )
})

test('--keep-dsh-home fails closed with --pack-only because no automatic home exists', () => {
  const result = run(process.execPath, [
    ACCEPT,
    '/path/need/not/exist',
    '--trusted-execute',
    '--pack-only',
    '--keep-dsh-home',
  ])
  assert.equal(result.status, 64)
  assert.match(result.stderr, /--keep-dsh-home cannot be used with --pack-only.*no automatic acceptance DSH_HOME/i)
})

test('pack-only manual commands isolate both homes and include guarded cleanup', t => {
  const fixtureRoot = temporary(t, 'dsh-manual-command-root-')
  const archive = path.join(fixtureRoot, 'plugin.tgz')
  const archiveBytes = 'manual acceptance packed bytes'
  writeFileSync(archive, archiveBytes)
  const sha256 = createHash('sha256').update(archiveBytes).digest('hex')
  const commands = manualFreshProfileCommands({ archive, sha256 }, '/usr/bin/true', 'web')
  const joined = commands.join('\n')
  assert.match(joined, /command -v sha256sum/)
  assert.match(joined, /command -v shasum/)
  assert.match(joined, /shasum -a 256 --/)
  assert.match(joined, /Packed artifact SHA-256 mismatch; refusing installation/)
  assert.match(joined, /plugin .* add -w "\$DSH_ACCEPT_ARCHIVE"/)
  assert.match(joined, /DSH_ACCEPT_AGENTS_HOME="\$DSH_ACCEPT_HOME\/\.agents"/)
  assert.match(joined, /mkdir -p -- "\$DSH_ACCEPT_AGENTS_HOME"/)
  const dshCommands = commands.filter(command => command.includes(' --profile ') && command.includes('DSH_HOME='))
  assert.equal(dshCommands.length, 3)
  for (const command of dshCommands) {
    assert.match(command, /^env -i /)
    assert.match(command, /DSH_HOME="\$DSH_ACCEPT_HOME"/)
    assert.match(command, /DSH_AGENTS_HOME="\$DSH_ACCEPT_AGENTS_HOME"/)
  }
  assert.doesNotMatch(joined, /OPENAI_API_KEY|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|DSH_PROVIDER_TOKEN/)
  assert.match(joined, /\.dsh-plugin-accept-sentinel/)
  assert.match(joined, /case "\$\(basename/)
  assert.match(joined, /NOT|does not prove descendant/i)

  const tempRoot = path.join(fixtureRoot, 'tmp')
  mkdirSync(tempRoot)
  const fakeDsh = path.join(fixtureRoot, 'fake-dsh.mjs')
  writeFileSync(fakeDsh, [
    "for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DSH_PROVIDER_TOKEN']) {",
    "  if (process.env[key] !== undefined) throw new Error(`credential leaked to DSH: ${key}`)",
    '}',
    "if (!process.env.DSH_HOME || !process.env.DSH_AGENTS_HOME) throw new Error('isolated homes missing')",
    '',
  ].join('\n'))
  const isolatedCommands = manualFreshProfileCommands({ archive, sha256 }, fakeDsh, 'web').join('\n')
  const executed = run('/bin/sh', ['-c', joined], {
    env: {
      ...process.env,
      TMPDIR: tempRoot,
      OPENAI_API_KEY: 'must-not-reach-dsh',
      ANTHROPIC_API_KEY: 'must-not-reach-dsh',
      DEEPSEEK_API_KEY: 'must-not-reach-dsh',
      DSH_PROVIDER_TOKEN: 'must-not-reach-dsh',
    },
  })
  assertSuccess(executed, 'manual isolated Profile command transcript')
  assert.deepEqual(readdirSync(tempRoot), [])

  const credentialProbe = run('/bin/sh', ['-c', isolatedCommands], {
    env: {
      ...process.env,
      TMPDIR: tempRoot,
      OPENAI_API_KEY: 'must-not-reach-dsh',
      ANTHROPIC_API_KEY: 'must-not-reach-dsh',
      DEEPSEEK_API_KEY: 'must-not-reach-dsh',
      DSH_PROVIDER_TOKEN: 'must-not-reach-dsh',
    },
  })
  assertSuccess(credentialProbe, 'manual DSH commands receive only the environment allowlist')
  assert.deepEqual(readdirSync(tempRoot), [])

  const injectionMarker = path.join(tempRoot, 'shell-injection-marker')
  const hostileArchive = path.join(fixtureRoot, 'plugin-$(touch shell-injection-marker).tgz')
  const hostileBytes = 'hostile filename is still shell data'
  writeFileSync(hostileArchive, hostileBytes)
  const hostileSha256 = createHash('sha256').update(hostileBytes).digest('hex')
  const hostileTranscript = manualFreshProfileCommands({ archive: hostileArchive, sha256: hostileSha256 }, '/usr/bin/true', 'web').join('\n')
  const hostile = run('/bin/sh', ['-c', hostileTranscript], {
    cwd: tempRoot,
    env: { ...process.env, TMPDIR: tempRoot },
  })
  assertSuccess(hostile, 'manual commands quote archive paths as shell data')
  assert.equal(existsSync(injectionMarker), false)
  assert.deepEqual(readdirSync(tempRoot), [])

  const noHashToolPath = path.join(fixtureRoot, 'no-hash-tools')
  mkdirSync(noHashToolPath)
  const unavailable = run('/bin/sh', ['-c', joined], {
    env: { ...process.env, PATH: noHashToolPath, TMPDIR: tempRoot },
  })
  assert.notEqual(unavailable.status, 0)
  assert.match(unavailable.stderr, /No SHA-256 utility found; install sha256sum or shasum.*before installation/)
  assert.deepEqual(readdirSync(tempRoot), [])
})

test('manual commands for non-Web Profiles do not invent Web startup or HTTP behavior', () => {
  const commands = manualFreshProfileCommands({
    archive: '/tmp/plugin.tgz',
    sha256: '0'.repeat(64),
  }, '/usr/bin/true', 'headless')
  const joined = commands.join('\n')
  const dshCommands = commands.filter(command => command.includes(' --profile ') && command.includes('DSH_HOME='))
  assert.equal(dshCommands.length, 2)
  assert.doesNotMatch(joined, /--no-open|--port 0|GET the printed|require HTTP 200|reported HTTP port/)
  assert.match(joined, /Non-Web Profile.*pinned Profile's documented startup, behavior\/readiness, and shutdown contract manually/i)
  assert.match(joined, /Do not reuse Web-specific startup flags, readiness assumptions, or shutdown behavior/i)
})

test('manual acceptance preserves every DSH gate failure and retains evidence', t => {
  const root = temporary(t, 'dsh-manual-failure-gates-')
  const archive = path.join(root, 'plugin.tgz')
  const archiveBytes = 'manual failure-gate artifact'
  writeFileSync(archive, archiveBytes)
  const artifact = {
    archive,
    sha256: createHash('sha256').update(archiveBytes).digest('hex'),
  }

  function assertFailedGate(label, dshBin, expectedStatus, expectedMessage, environment = {}) {
    const tempRoot = path.join(root, label)
    mkdirSync(tempRoot)
    const transcript = manualFreshProfileCommands(artifact, dshBin, 'web').join('\n')
    const result = run('/bin/sh', ['-c', transcript], {
      env: { ...process.env, TMPDIR: tempRoot, ...environment },
    })
    assert.equal(result.status, expectedStatus, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(result.stderr, expectedMessage)
    const evidence = readdirSync(tempRoot)
    assert.equal(evidence.length, 1, `${label} must retain exactly one isolated evidence directory`)
    assert.match(evidence[0], /^dsh-plugin-accept\./)
    assert.equal(existsSync(path.join(tempRoot, evidence[0], '.dsh-plugin-accept-sentinel')), true)
  }

  assertFailedGate(
    'install-failure',
    '/usr/bin/false',
    1,
    /DSH plugin installation gate failed \(exit 1\).*Evidence retained/,
  )

  const compositionFailure = path.join(root, 'composition-failure.mjs')
  writeFileSync(compositionFailure, [
    "if (process.argv.includes('--dump-config')) process.exit(42)",
    '',
  ].join('\n'))
  assertFailedGate(
    'composition-failure',
    compositionFailure,
    42,
    /DSH configuration-composition gate failed \(exit 42\).*Evidence retained/,
  )

  const bootFailure = path.join(root, 'boot-failure.mjs')
  writeFileSync(bootFailure, [
    "if (process.argv.includes('--no-open')) process.exit(43)",
    '',
  ].join('\n'))
  assertFailedGate(
    'boot-failure',
    bootFailure,
    43,
    /DSH Web boot\/shutdown gate failed \(exit 43\).*Evidence retained/,
  )

  const fakeBin = path.join(root, 'cleanup-failure-bin')
  mkdirSync(fakeBin)
  const fakeRm = path.join(fakeBin, 'rm')
  writeFileSync(fakeRm, '#!/bin/sh\nexit 37\n')
  chmodSync(fakeRm, 0o700)
  assertFailedGate(
    'cleanup-failure',
    '/usr/bin/true',
    37,
    /Acceptance evidence cleanup failed \(exit 37\).*Evidence may remain/,
    { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
  )
})

test('trusted pack-only acceptance honors exact pnpm, strips credentials, and requires the manual runtime gate', t => {
  const pnpmVersion = run('pnpm', ['--version'])
  if (pnpmVersion.error !== undefined || pnpmVersion.status !== 0) {
    t.skip('pnpm is not available for the package-manager acceptance fixture')
    return
  }
  const exactPnpmVersion = pnpmVersion.stdout.trim()
  assert.match(exactPnpmVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  const root = temporary(t, 'dsh-pnpm-acceptance-')
  const plugin = path.join(root, 'plugin')
  const packDestination = path.join(root, 'pack-json')
  mkdirSync(plugin)
  createAcceptanceFixture(plugin, { packageManager: `pnpm@${exactPnpmVersion}` })

  const credentialEnvironment = {
    ...process.env,
    OPENAI_API_KEY: 'must-not-reach-package-scripts',
    ANTHROPIC_API_KEY: 'must-not-reach-package-scripts',
    DEEPSEEK_API_KEY: 'must-not-reach-package-scripts',
    DSH_PROVIDER_TOKEN: 'must-not-reach-package-scripts',
  }
  const accepted = run(process.execPath, [
    ACCEPT,
    plugin,
    '--trusted-execute',
    '--pack-only',
    '--pack-destination', packDestination,
    '--json',
  ], { env: credentialEnvironment })
  assertSuccess(accepted, 'pnpm pack-only acceptance')
  const report = JSON.parse(accepted.stdout)
  assert.deepEqual(report.packageManager, {
    command: 'pnpm',
    declared: `pnpm@${exactPnpmVersion}`,
    expectedVersion: exactPnpmVersion,
    actualVersion: exactPnpmVersion,
  })
  assert.equal(report.package.name, 'dsh-package-manager-probe')
  assert.equal(report.package.version, '1.2.3')
  assert.equal(report.package.packageManager, `pnpm@${exactPnpmVersion}`)
  const archiveRelative = path.relative(realpathSync(packDestination), report.package.archive)
  assert.ok(archiveRelative.length > 0 && !archiveRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(archiveRelative))
  assert.match(archiveRelative, /^\.dsh-accepted-[^/]+\/artifact\.tgz$/)
  assert.equal(report.package.artifactGuard.sha256, report.package.sha256)
  assert.equal(report.package.artifactGuard.size, String(report.package.size))
  assert.deepEqual(report.packOnlyFinalArtifactValidation, report.package.artifactGuard)
  assert.equal(report.freshProfile, 'manual-required')
  assert.ok(report.manualCommands.filter(command => command.includes(' --profile ')).every(command => command.startsWith('env -i ')))
  assert.doesNotMatch(report.manualCommands.join('\n'), /must-not-reach|OPENAI_API_KEY|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|DSH_PROVIDER_TOKEN/)

  const humanPackDestination = path.join(root, 'pack-human')
  const human = run(process.execPath, [
    ACCEPT,
    plugin,
    '--trusted-execute',
    '--pack-only',
    '--pack-destination', humanPackDestination,
  ], { env: credentialEnvironment })
  assertSuccess(human, 'pnpm human-readable pack-only acceptance')
  assert.match(human.stdout, /PACKED_ARTIFACT_CREATED/)
  assert.match(human.stdout, /MANUAL_FRESH_PROFILE_ACCEPTANCE_REQUIRED/)
  assert.doesNotMatch(human.stdout, /PACKED_ARTIFACT_ACCEPTANCE_OK/)
})

test('trusted acceptance fails closed on missing, unknown, or non-exact packageManager declarations', async t => {
  for (const [label, packageManager] of [
    ['missing', undefined],
    ['unknown', 'yarn@4.9.2'],
    ['non-exact', 'npm@^10.9.3'],
    ['invalid-numeric-prerelease', 'npm@10.9.3-01'],
  ]) {
    await t.test(label, t => {
      const root = temporary(t, `dsh-package-manager-${label}-`)
      const plugin = path.join(root, 'plugin')
      mkdirSync(plugin)
      createAcceptanceFixture(plugin, { packageManager })
      const result = run(process.execPath, [ACCEPT, plugin, '--trusted-execute', '--pack-only'])
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Automatic trusted acceptance requires package\.json#packageManager/)
    })
  }
})

test('trusted acceptance rejects package identity changes made by pack lifecycle hooks', t => {
  const npmVersion = run('npm', ['--version'])
  assertSuccess(npmVersion, 'npm version probe')
  const root = temporary(t, 'dsh-postpack-identity-')
  const plugin = path.join(root, 'plugin')
  mkdirSync(plugin)
  createAcceptanceFixture(plugin, {
    packageManager: `npm@${npmVersion.stdout.trim()}`,
    postpack: 'node mutate-identity.mjs',
  })
  writeFileSync(path.join(plugin, 'mutate-identity.mjs'), [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "const manifest = JSON.parse(readFileSync('package.json', 'utf8'))",
    "manifest.version = '9.9.9'",
    "writeFileSync('package.json', `${JSON.stringify(manifest, null, 2)}\\n`)",
    '',
  ].join('\n'))
  const result = run(process.execPath, [ACCEPT, plugin, '--trusted-execute', '--pack-only'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /identity\/version changed|expected frozen identity/)
})

test('scaffold never overwrites a non-empty target and exposes no force bypass', t => {
  const root = temporary(t, 'dsh-scaffold-existing-')
  const home = path.join(root, 'dsh-home')
  const output = path.join(root, 'output')
  const target = path.join(output, 'dsh-existing')
  createFakeDshHome(home)
  mkdirSync(target, { recursive: true })
  writeFileSync(path.join(target, 'keep.txt'), 'user-owned\n')

  const result = run(process.execPath, scaffoldArgs('dsh-existing', output, home))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not empty/)
  assert.equal(readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'user-owned\n')

  const force = run(process.execPath, [...scaffoldArgs('dsh-existing', output, home), '--force'])
  assert.notEqual(force.status, 0)
  assert.match(force.stderr, /unknown option.*--force/)
  assert.equal(readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'user-owned\n')
})

test('scaffold rejects traversal-shaped and illegal scoped package names', t => {
  const root = temporary(t, 'dsh-scaffold-name-')
  const home = path.join(root, 'dsh-home')
  const output = path.join(root, 'output')
  createFakeDshHome(home)
  for (const packageName of ['../../dsh-escape', '@bad scope/dsh-name', '@scope/not-dsh', '@scope/../dsh-name']) {
    const result = run(process.execPath, scaffoldArgs(packageName, output, home))
    assert.notEqual(result.status, 0, packageName)
  }
  assert.equal(existsSync(path.join(root, 'dsh-escape')), false)
})

test('live installed contract generates a package that installs, builds, tests, packs, and boots in isolation', async t => {
  const liveHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const manifests = Object.keys(BASELINE).map(packageName => path.join(
    liveHome,
    'profiles',
    'node_modules',
    ...packageName.split('/'),
    'package.json',
  ))
  const dshBin = path.join(liveHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (![...manifests, dshBin].every(existsSync)) {
    t.skip('no complete local DSH installation is available for the acceptance gate')
    return
  }

  const root = temporary(t, 'dsh-scaffold-live-')
  const output = path.join(root, 'output')
  const scaffold = run(process.execPath, scaffoldArgs('dsh-live-scaffold-probe', output, liveHome, [
    '--description', 'Live installed-contract acceptance probe.',
    '--node-engine', NODE_ENGINE,
  ]))
  assertSuccess(scaffold, 'live scaffold')
  const plugin = path.join(output, 'dsh-live-scaffold-probe')

  for (const [label, command, args] of [
    ['npm install', 'npm', ['install', '--no-audit', '--no-fund']],
    ['npm run build', 'npm', ['run', 'build']],
    ['npm run typecheck', 'npm', ['run', 'typecheck']],
    ['npm test', 'npm', ['test']],
    ['built validator', process.execPath, [VALIDATOR, plugin, '--built']],
  ]) {
    const result = run(command, args, { cwd: plugin })
    assertSuccess(result, label)
  }
  assert.ok(existsSync(path.join(plugin, 'package-lock.json')))
  assert.ok(existsSync(path.join(plugin, 'dist', 'index.js')))
  assert.ok(existsSync(path.join(plugin, 'dist', 'index.d.ts')))

  const staticAcceptance = run(process.execPath, [ACCEPT, plugin, '--json'])
  assertSuccess(staticAcceptance, 'static-only acceptance')
  const staticReport = JSON.parse(staticAcceptance.stdout)
  assert.equal(staticReport.mode, 'static-only')
  assert.equal(staticReport.projectCodeExecuted, false)

  const packDestination = path.join(root, 'pack')
  const trustedAcceptance = run(process.execPath, [
    ACCEPT,
    plugin,
    '--trusted-execute',
    '--dsh-bin', dshBin,
    '--pack-destination', packDestination,
    '--timeout-ms', '180000',
    '--json',
  ], { timeout: 240_000 })
  assertSuccess(trustedAcceptance, 'trusted tarball/fresh-Profile acceptance')
  const trusted = JSON.parse(trustedAcceptance.stdout)
  assert.equal(trusted.mode, 'trusted-execute')
  assert.equal(trusted.projectCodeExecuted, true)
  assert.match(trusted.package.sha256, /^[0-9a-f]{64}$/)
  assert.ok(existsSync(trusted.package.archive))
  assert.deepEqual(trusted.postPackSourceValidation.errors, [])
  assert.equal(trusted.freshProfile.httpStatus, 200)
  assert.deepEqual(trusted.freshProfile.artifactBeforeInstall, trusted.package.artifactGuard)
  assert.deepEqual(trusted.freshProfile.artifactAfterInstall, trusted.package.artifactGuard)
  assert.deepEqual(trusted.freshProfile.artifactAfterAcceptance, trusted.package.artifactGuard)
  assert.deepEqual(trusted.freshProfile.installedArtifactValidation.errors, [])
  assert.equal(trusted.freshProfile.installedArtifactValidation.installedArtifact, true)
  assert.ok(!trusted.freshProfile.installedArtifactValidation.warnings.some(
    item => item.code === 'recommended-file' && item.message.includes('lockfile'),
  ))
  assert.match(trusted.freshProfile.installedTreeMetadataGuard.metadataSha256, /^[0-9a-f]{64}$/)
  assert.equal(trusted.freshProfile.installedTreeMetadataGuard.includesDist, true)
  assert.equal(trusted.freshProfile.installedTreeMetadataGuard.contentBytesHashed, false)
  assert.deepEqual(
    trusted.freshProfile.installedTreeMetadataGuard.stages.map(item => item.stage),
    [
      'before-installed-static-validation',
      'after-installed-static-validation',
      'before-dump-config',
      'before-web-boot',
      'after-shutdown-and-port-release',
    ],
  )
  assert.ok(trusted.freshProfile.installedTreeMetadataGuard.stages.every(
    item => item.metadataSha256 === trusted.freshProfile.installedTreeMetadataGuard.metadataSha256,
  ))
  assert.ok(trusted.freshProfile.acceptanceScope.notVerified.some(value => /transient same-UID/.test(value)))
  assert.ok(trusted.freshProfile.acceptanceScope.notVerified.some(value => /not content bytes/.test(value)))
  assert.equal(trusted.freshProfile.reportedHttpPortReleased, true)
  assert.deepEqual(trusted.freshProfile.topLevelDshExit, { code: 0, signal: null })
  assert.ok(trusted.freshProfile.acceptanceScope.notVerified.some(value => /descendant/.test(value)))
  assert.ok(trusted.freshProfile.acceptanceScope.notVerified.some(value => /patch-only/.test(value)))
  assert.ok(trusted.freshProfile.acceptanceScope.notVerified.some(value => /composed config/.test(value)))
  assert.ok(trusted.freshProfile.acceptanceScope.notVerified.some(value => /unmatched-patch/.test(value)))
  assert.equal(trusted.freshProfile.retained, false)
  assert.equal(existsSync(trusted.freshProfile.dshHome), false)
  assert.ok(trusted.freshProfile.rowIds.includes('live-scaffold-probe'))
})
