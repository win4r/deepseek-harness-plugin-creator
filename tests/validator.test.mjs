import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const VALIDATOR = fileURLToPath(new URL('../scripts/validate_plugin.mjs', import.meta.url))

function baseManifest(overrides = {}) {
  return {
    name: 'validator-fixture',
    version: '1.0.0',
    type: 'module',
    main: 'src/index.js',
    exports: { '.': './src/index.js' },
    files: ['src'],
    ...overrides,
  }
}

async function runFixture(t, { manifest = baseManifest(), files = {} }, args = []) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-validator-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entries = {
    'package.json': JSON.stringify(manifest, null, 2) + '\n',
    'src/index.js': 'export function apply() {}\n',
    ...files,
  }
  for (const [relativePath, content] of Object.entries(entries)) {
    const target = join(root, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  const result = spawnSync(process.execPath, [VALIDATOR, root, '--json', ...args], {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20_000,
  })
  assert.equal(result.signal, null, result.stderr)
  assert.doesNotThrow(() => JSON.parse(result.stdout), result.stderr || result.stdout)
  return { ...result, report: JSON.parse(result.stdout) }
}

function codes(report, group) {
  return report[group].map(item => item.code)
}

test('CLI help succeeds and describes host-runtime expectations precisely', () => {
  const result = spawnSync(process.execPath, [VALIDATOR, '--help'], {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' },
  })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /host-runtime-package/)
  assert.match(result.stdout, /installed-artifact/)
  assert.equal(result.stderr, '')
})

test('rejects missing or invalid package versions and malformed dependency sections', async t => {
  for (const [label, manifest, code] of [
    ['missing version', baseManifest({ version: undefined }), 'package-version'],
    ['version range', baseManifest({ version: '^1.0.0' }), 'package-version'],
    ['non-canonical prerelease', baseManifest({ version: '1.0.0-01' }), 'package-version'],
    ['scalar dependencies', baseManifest({ dependencies: 42 }), 'dependency-shape'],
    ['array devDependencies', baseManifest({ devDependencies: [] }), 'dependency-shape'],
    ['string peerDependencies', baseManifest({ peerDependencies: 'invalid' }), 'dependency-shape'],
    ['null optionalDependencies', baseManifest({ optionalDependencies: null }), 'dependency-shape'],
  ]) {
    await t.test(label, async t => {
      const result = await runFixture(t, { manifest })
      assert.equal(result.status, 1)
      assert.ok(codes(result.report, 'errors').includes(code))
    })
  }
})

test('installed-artifact mode does not recommend a source-only lockfile', async t => {
  const manifest = baseManifest({ packageManager: 'npm@10.9.3' })
  const source = await runFixture(t, { manifest })
  assert.ok(source.report.warnings.some(item => item.code === 'recommended-file' && item.message.includes('package-lock.json')))

  const installed = await runFixture(t, { manifest }, ['--installed-artifact'])
  assert.equal(installed.status, 0)
  assert.ok(!installed.report.warnings.some(item => item.code === 'recommended-file' && item.message.includes('lockfile')))
})

test('accepts a default-exported Service class with named helpers and no Bundle declaration', async t => {
  const result = await runFixture(t, {
    files: {
      'src/index.js': [
        'export const Config = {}',
        'export const helper = 1',
        'export class FixtureService {}',
        'export default FixtureService',
        '',
      ].join('\n'),
    },
  })
  assert.equal(result.status, 0)
  assert.ok(codes(result.report, 'checks').includes('default-plugin'))
  assert.ok(!codes(result.report, 'errors').includes('unsafe-path'))
  assert.ok(!codes(result.report, 'errors').includes('bundle-manifest'))
  assert.ok(codes(result.report, 'warnings').includes('default-sibling-metadata'))
  assert.ok(result.report.warnings.some(item => item.code === 'config-static-only' && item.message.includes('cannot prove Standard Schema')))
})

test('accepts a direct default object plugin with a callable apply method', async t => {
  const result = await runFixture(t, {
    files: {
      'src/index.js': 'export default { name: "fixture", apply(ctx) { ctx.effect(() => {}) } }\n',
    },
  })
  assert.equal(result.status, 0)
  assert.ok(codes(result.report, 'checks').includes('default-plugin'))
  assert.ok(!codes(result.report, 'warnings').includes('default-sibling-metadata'))
})

test('accepts the common built default object binding form', async t => {
  const source = 'var plugin = { name: "fixture", apply(ctx) { ctx.effect(() => {}) } };\nexport { plugin as default };\n'
  const result = await runFixture(t, {
    manifest: baseManifest({
      main: 'lib/index.js',
      exports: { '.': './lib/index.js' },
      files: ['lib'],
    }),
    files: {
      'src/index.js': source,
      'lib/index.js': source,
    },
  }, ['--built'])
  assert.equal(result.status, 0)
  assert.ok(result.report.checks.filter(item => item.code === 'default-plugin').length >= 2)
})

test('rejects default objects without a statically callable apply', async t => {
  await t.test('direct object without apply', async t => {
    const result = await runFixture(t, {
      files: { 'src/index.js': 'export default { name: "fixture" }\n' },
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('default-plugin'))
  })

  await t.test('bound object with non-callable apply', async t => {
    const result = await runFixture(t, {
      files: {
        'src/index.js': 'const plugin = { apply: 42 };\nexport default plugin;\n',
      },
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('default-plugin'))
  })
})

test('accepts a named apply namespace without requiring name', async t => {
  const result = await runFixture(t, {
    files: { 'src/index.js': 'export function apply() {}\n' },
  })
  assert.equal(result.status, 0)
  assert.ok(result.report.checks.some(item => item.code === 'namespace-name' && item.message.includes('optional')))
})

test('requires a named apply export to be statically callable and locally defined', async t => {
  await t.test('rejects a non-callable exported binding', async t => {
    const result = await runFixture(t, {
      files: { 'src/index.js': 'export const apply = 42\n' },
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('namespace-apply'))
  })

  await t.test('rejects a re-export whose callability cannot be confirmed', async t => {
    const result = await runFixture(t, {
      files: {
        'src/index.js': "export { apply } from './helper.js'\n",
        'src/helper.js': 'export function apply() {}\n',
      },
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('namespace-apply'))
  })

  await t.test('accepts a callable local binding aliased to apply', async t => {
    const result = await runFixture(t, {
      files: { 'src/index.js': 'const activate = (ctx) => ctx.effect(() => {})\nexport { activate as apply }\n' },
    })
    assert.equal(result.status, 0)
    assert.ok(codes(result.report, 'checks').includes('namespace-apply'))
  })
})

test('rejects mixing a default Loader entry with named apply', async t => {
  const result = await runFixture(t, {
    files: {
      'src/index.js': 'export function apply() {}\nexport default class FixtureService {}\n',
    },
  })
  assert.equal(result.status, 1)
  assert.ok(codes(result.report, 'errors').includes('mixed-plugin-exports'))
})

test('accepts an explicit empty ESM shim for a patch-only Bundle', async t => {
  const manifest = baseManifest({
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    files: ['src', 'cordis.patch.yml'],
  })
  const result = await runFixture(t, {
    manifest,
    files: {
      'src/index.js': 'export {}\n',
      'cordis.patch.yml': '- insert:\n    name: some-other-plugin\n',
    },
  })
  assert.equal(result.status, 0)
  assert.ok(codes(result.report, 'checks').includes('patch-only-shim'))
})

test('does not treat an empty shim without a Bundle patch as patch-only', async t => {
  const result = await runFixture(t, {
    files: { 'src/index.js': 'export {}\n' },
  })
  assert.equal(result.status, 1)
  assert.ok(codes(result.report, 'errors').includes('plugin-export'))
})

test('validates a built web client declaration and artifact', async t => {
  const manifest = baseManifest({
    main: 'lib/index.js',
    exports: {
      '.': './lib/index.js',
      './client': { default: './lib/client.js' },
    },
    files: ['lib', 'cordis.patch.yml'],
    dsh: {
      bundle: { patch: 'cordis.patch.yml' },
      client: {
        platform: 'web',
        inject: ['@deepseek-ai/dsh-client-runtime'],
        external: ['react'],
      },
    },
    peerDependencies: { '@deepseek-ai/dsh-client-runtime': '^0.1.1-rc.2' },
    devDependencies: { '@deepseek-ai/dsh-client-runtime': '0.1.1-rc.2' },
  })
  const result = await runFixture(t, {
    manifest,
    files: {
      'lib/index.js': 'export default class FixtureService {}\n',
      'lib/client.js': 'module.exports = function clientModule() {}\n',
      'cordis.patch.yml': '- insert:\n    name: validator-fixture\n',
    },
  }, ['--built'])
  assert.equal(result.status, 0)
  assert.ok(codes(result.report, 'checks').includes('client-platform'))
  assert.ok(codes(result.report, 'checks').includes('client-export'))
  assert.ok(codes(result.report, 'checks').includes('client-bundle'))
  assert.ok(codes(result.report, 'checks').includes('client-inject-dependency'))
  assert.ok(result.report.checks.some(item => item.code === 'built-artifact' && item.message.includes('client export')))
})

test('binds client exports, dependency edges, and Bundle mounting into one contract', async t => {
  await t.test('rejects a client export without dsh.client', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({
        exports: { '.': './src/index.js', './client': './src/client.js' },
      }),
      files: { 'src/client.js': 'export default {}\n' },
    })
    assert.equal(result.status, 1)
    assert.ok(result.report.errors.some(item => item.code === 'client-manifest' && item.message.includes('requires a valid dsh.client')))
  })

  await t.test('rejects a valid client declaration without a Bundle patch', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({
        exports: { '.': './src/index.js', './client': './src/client.js' },
        dsh: { client: { platform: 'web' } },
      }),
      files: { 'src/client.js': 'export default {}\n' },
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('client-bundle'))
  })

  await t.test('does not treat a remove operation as mounting the client package', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({
        exports: { '.': './src/index.js', './client': './src/client.js' },
        files: ['src', 'cordis.patch.yml'],
        dsh: {
          bundle: { patch: 'cordis.patch.yml' },
          client: { platform: 'web' },
        },
      }),
      files: {
        'src/client.js': 'export default {}\n',
        'cordis.patch.yml': '- remove:\n    name: validator-fixture\n',
      },
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('client-bundle'))
  })

  await t.test('accepts an exported package subpath mounted by the Bundle', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({
        exports: {
          '.': './src/index.js',
          './host': './src/host.js',
          './client': './src/client.js',
        },
        files: ['src', 'cordis.patch.yml'],
        dsh: {
          bundle: { patch: 'cordis.patch.yml' },
          client: { platform: 'web' },
        },
      }),
      files: {
        'src/host.js': 'export function apply() {}\n',
        'src/client.js': 'export default {}\n',
        'cordis.patch.yml': '- insert:\n    name: validator-fixture/host\n',
      },
    })
    assert.equal(result.status, 0)
    assert.ok(codes(result.report, 'checks').includes('client-bundle'))
    assert.ok(codes(result.report, 'checks').includes('subpath-entry'))
  })

  await t.test('requires every injected package to have an exact dev and containing peer range', async t => {
    const common = {
      exports: { '.': './src/index.js', './client': './src/client.js' },
      files: ['src', 'cordis.patch.yml'],
      dsh: {
        bundle: { patch: 'cordis.patch.yml' },
        client: { platform: 'web', inject: ['client-runtime'] },
      },
    }
    const files = {
      'src/client.js': 'export default {}\n',
      'cordis.patch.yml': '- insert:\n    name: validator-fixture\n',
    }

    const missingPeer = await runFixture(t, {
      manifest: baseManifest({ ...common, devDependencies: { 'client-runtime': '1.2.3' } }),
      files,
    })
    assert.equal(missingPeer.status, 1)
    assert.ok(codes(missingPeer.report, 'errors').includes('client-inject-dependency'))

    const nonExactDev = await runFixture(t, {
      manifest: baseManifest({
        ...common,
        peerDependencies: { 'client-runtime': '^1.2.3' },
        devDependencies: { 'client-runtime': '^1.2.3' },
      }),
      files,
    })
    assert.equal(nonExactDev.status, 1)
    assert.ok(codes(nonExactDev.report, 'errors').includes('runtime-version'))

    const excludingPeer = await runFixture(t, {
      manifest: baseManifest({
        ...common,
        peerDependencies: { 'client-runtime': '^1.0.0' },
        devDependencies: { 'client-runtime': '2.0.0' },
      }),
      files,
    })
    assert.equal(excludingPeer.status, 1)
    assert.ok(codes(excludingPeer.report, 'errors').includes('client-inject-dependency'))
  })
})

test('rejects malformed client declarations', async t => {
  await t.test('non-object declaration', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({ dsh: { client: 'web' } }),
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('client-manifest'))
  })

  await t.test('non-web platform and missing client export', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({ dsh: { client: { platform: 'desktop' } } }),
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('client-platform'))
    assert.ok(codes(result.report, 'errors').includes('client-export'))
  })

  await t.test('empty and duplicate dependency specifiers', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({
        exports: { '.': './src/index.js', './client': './lib/client.js' },
        dsh: {
          client: {
            platform: 'web',
            inject: ['', 'pkg', 'pkg'],
            external: ['react', 'react'],
          },
        },
      }),
    })
    assert.equal(result.status, 1)
    assert.ok(result.report.errors.filter(item => item.code === 'client-manifest').length >= 3)
  })

  await t.test('missing built client artifact', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({
        main: 'lib/index.js',
        exports: { '.': './lib/index.js', './client': './lib/client.js' },
        files: ['lib'],
        dsh: { client: { platform: 'web' } },
      }),
      files: { 'lib/index.js': 'export default class FixtureService {}\n' },
    }, ['--built'])
    assert.equal(result.status, 1)
    assert.ok(result.report.errors.some(item => item.code === 'file-boundary' && item.message.includes('client export')))
  })
})

test('accepts a compatible Cordis peer range and an exact Schemastery dependency', async t => {
  const manifest = baseManifest({
    dependencies: { '@deepseek-ai/schemastery': '3.18.1' },
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
    devDependencies: { '@deepseek-ai/cordis': '4.0.1' },
  })
  const result = await runFixture(t, {
    manifest,
    files: {
      'src/index.js': [
        "import '@deepseek-ai/cordis'",
        "import z from '@deepseek-ai/schemastery'",
        'export const Config = z.object({})',
        'export function apply() {}',
        '',
      ].join('\n'),
    },
  }, [
    '--expect', '@deepseek-ai/cordis=4.0.1',
  ])
  assert.equal(result.status, 0)
  assert.equal(result.report.checks.filter(item => item.code === 'runtime-pair').length, 1)
})

test('rejects unsafe or incompatible runtime version declarations', async t => {
  const source = "import '@deepseek-ai/cordis'\nexport function apply() {}\n"

  await t.test('self-consistent old pair that violates an explicit baseline', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({
        peerDependencies: { '@deepseek-ai/cordis': '3.0.0' },
        devDependencies: { '@deepseek-ai/cordis': '3.0.0' },
      }),
      files: { 'src/index.js': source },
    }, ['--expect', '@deepseek-ai/cordis=4.0.1'])
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('runtime-baseline'))
  })

  await t.test('non-exact dev version', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
        devDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
      }),
      files: { 'src/index.js': source },
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('runtime-version'))
  })

  await t.test('unrestricted peer wildcard', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({
        peerDependencies: { '@deepseek-ai/cordis': '*' },
        devDependencies: { '@deepseek-ai/cordis': '4.0.1' },
      }),
      files: { 'src/index.js': source },
    })
    assert.equal(result.status, 1)
    assert.ok(result.report.errors.some(item => item.code === 'runtime-version' && item.message.includes('*')))
  })

  await t.test('peer range that excludes the exact dev version', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({
        peerDependencies: { '@deepseek-ai/cordis': '>=3.0.0 <4.0.0' },
        devDependencies: { '@deepseek-ai/cordis': '4.0.1' },
      }),
      files: { 'src/index.js': source },
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('runtime-pair'))
  })

  await t.test('peer comparator set must have both lower and upper bounds', async t => {
    for (const peer of ['>=4.0.1', '<5.0.0']) {
      const result = await runFixture(t, {
        manifest: baseManifest({
          peerDependencies: { '@deepseek-ai/cordis': peer },
          devDependencies: { '@deepseek-ai/cordis': '4.0.1' },
        }),
        files: { 'src/index.js': source },
      })
      assert.equal(result.status, 1, peer)
      assert.ok(codes(result.report, 'errors').includes('runtime-range'), peer)
    }
  })

  await t.test('prerelease peer ranges require a comparator on the same version tuple', async t => {
    for (const peer of ['^1.2.3-rc.1', '>=1.2.3-rc.1 <2.0.0']) {
      const result = await runFixture(t, {
        manifest: baseManifest({
          peerDependencies: { '@deepseek-ai/cordis': peer },
          devDependencies: { '@deepseek-ai/cordis': '1.3.0-rc.1' },
        }),
        files: { 'src/index.js': source },
      })
      assert.equal(result.status, 1, peer)
      assert.ok(codes(result.report, 'errors').includes('runtime-pair'), peer)
    }

    const admitted = await runFixture(t, {
      manifest: baseManifest({
        peerDependencies: { '@deepseek-ai/cordis': '^1.2.3-rc.1' },
        devDependencies: { '@deepseek-ai/cordis': '1.2.3-rc.2' },
      }),
      files: { 'src/index.js': source },
    })
    assert.equal(admitted.status, 0)
    assert.ok(codes(admitted.report, 'checks').includes('runtime-pair'))
  })

  await t.test('unrestricted Schemastery dependency wildcard', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({ dependencies: { '@deepseek-ai/schemastery': '*' } }),
    })
    assert.equal(result.status, 1)
    assert.ok(result.report.errors.some(item => item.code === 'runtime-version' && item.message.includes('schemastery')))
  })
})

test('requires exact plugin-owned dependencies and exact Schemastery placement', async t => {
  await t.test('rejects ranges, tags, git requests, and local requests in plugin-owned dependencies', async t => {
    for (const [label, specifier] of [
      ['range', '^1.2.3'],
      ['tag', 'latest'],
      ['git', 'git+https://example.invalid/library.git'],
      ['local', 'file:../library'],
    ]) {
      const result = await runFixture(t, {
        manifest: baseManifest({ dependencies: { ['fixture-' + label]: specifier } }),
      })
      assert.equal(result.status, 1, label)
      assert.ok(codes(result.report, 'errors').includes('dependency-version'), label)
    }
  })

  await t.test('rejects a non-exact optional runtime dependency', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({ optionalDependencies: { 'optional-library': '~2.3.4' } }),
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('dependency-version'))
  })

  await t.test('requires shipped Schemastery imports in exact dependencies', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({
        devDependencies: { '@deepseek-ai/schemastery': '3.18.1' },
      }),
      files: {
        'src/index.js': "import schema from '@deepseek-ai/schemastery'\nexport function apply() { return schema }\n",
      },
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('schemastery-dependency'))
  })

  await t.test('accepts exact plugin-owned dependencies', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({ dependencies: { 'fixture-library': '1.2.3-beta.1' } }),
    })
    assert.equal(result.status, 0)
    assert.ok(codes(result.report, 'checks').includes('dependency-version'))
  })
})

test('allows environment templates while still scanning their contents', async t => {
  await t.test('placeholder templates', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({ files: ['src', '.env.example', '.env.template'] }),
      files: {
        '.env.example': 'API_KEY=replace-me\n',
        '.env.template': 'BASE_URL=https://example.invalid\n',
      },
    })
    assert.equal(result.status, 0)
    assert.ok(!codes(result.report, 'errors').includes('env-file'))
  })

  await t.test('secret-looking value in template', async t => {
    const result = await runFixture(t, {
      manifest: baseManifest({ files: ['src', '.env.template'] }),
      files: { '.env.template': 'API_KEY=sk-abcdefghijklmnopqrstuv\n' },
    })
    assert.equal(result.status, 1)
    assert.ok(codes(result.report, 'errors').includes('secret-pattern'))
    assert.ok(!codes(result.report, 'errors').includes('env-file'))
  })
})

test('reports ctx service and Config observations only as heuristics', async t => {
  const result = await runFixture(t, {
    files: {
      'src/index.js': 'export function apply(ctx, config) { ctx.tools.register(config.tool) }\n',
    },
  })
  assert.equal(result.status, 0)
  assert.ok(codes(result.report, 'warnings').includes('service-inject-heuristic'))
  assert.ok(codes(result.report, 'warnings').includes('config-heuristic'))
})

test('treats a visible Config export as a static hint, not proof of Standard Schema', async t => {
  const result = await runFixture(t, {
    files: {
      'src/index.js': 'export const Config = { arbitrary: true }\nexport function apply(ctx, config) {}\n',
    },
  })
  assert.equal(result.status, 0)
  assert.ok(result.report.warnings.some(item => item.code === 'config-static-only' && item.message.includes('cannot prove Standard Schema')))
  assert.ok(!codes(result.report, 'warnings').includes('config-heuristic'))
})
