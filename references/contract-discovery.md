# Contract discovery

Use this reference before designing or editing a DeepSeek Harness plugin.

## Evidence priority

1. Target-repository instructions and lockfiles.
2. The exact installed `dsh` CLI and Profile being targeted.
3. A pinned checkout of the official `deepseek-ai/deepseek-harness` repository.
4. Official published package manifests and documentation.
5. Existing external plugins only as version-qualified examples.

Record the version, tag, and commit. If the installed CLI and official checkout differ, ask which deployment target controls or test both when compatibility is part of the request.

## Baseline probes

Adapt these to the environment; do not assume a global `dsh` binary exists.

```bash
dsh --version
node --version
pnpm --version

git -C <official-dsh-checkout> describe --tags --always --dirty
git -C <official-dsh-checkout> rev-parse HEAD

dsh --profile <profile> --dump-default-config
dsh --profile <profile> --dump-config
dsh --profile <profile> --patch ./candidate.patch.yml --dump-config
dsh plugin --profile <profile> why <package>
```

If using the official source launcher, build the repository as its current instructions require and invoke its documented CLI entry. Existing built artifacts may be stale, so do not infer source behavior from an old `lib/` tree.

## Official files to locate

Paths may move. Use `rg` rather than assuming these exact locations:

- CLI/Profile composition and plugin installation reference (`apps/cli/reference`).
- Minimal external Bundle publishing guide (`docs/user/develop/basic/publish`).
- Cordis lifecycle, services, configuration, composition, and HMR tutorials.
- Tool cookbook and the current `defineTool` contract.
- Capability/service seam inventory.
- Subsystem documentation for Agents, Sessions, Jobs, sandbox, filesystem, client modules, or providers used by the plugin.
- Postmortems about Loader exports, optional service lookup, stale build output, and real entry-path testing.
- Production packages using the same service seam.

Useful discovery queries:

```bash
rg -n 'dsh.*bundle|bundle.*patch|plugin.*add|dump-default-config|dump-config' <dsh-repo>
rg -n 'defineTool\(|ctx\.tools\.register|export const inject|export const Config|export function apply' <dsh-repo>
rg -n 'ctx\.effect\(|agent/created|agent/disposed|sessionPersistence|sandbox|jobs\.start' <dsh-repo>
```

## Re-derive these contracts every time

- Bundle manifest fields and patch resolution.
- Patch layering order and whether matching `config` values replace or merge.
- Namespace export and Loader behavior.
- Required versus optional service lookup.
- Root versus Agent-scoped tool registration.
- Tool parameter-root closure, output schema, rendering, and error behavior.
- Lifecycle/HMR disposal semantics.
- Profile package-manager behavior, including workspace-root flags and build-script allowlists.
- Node, pnpm, Cordis, Schemastery, TypeScript, build-tool, and DSH package versions.
- Client bundle declaration and export shape when building a Web extension.

## Package design

The minimal external Bundle can be very small. A practical TypeScript package generally adds `src/`, tests, type/build configuration, lockfile, documentation, and license. Include only dependencies required by the selected capability.

Keep each imported Harness/Cordis runtime package in both `peerDependencies` and `devDependencies` at the compatible version selected from the target contract. Runtime libraries owned by the plugin belong in `dependencies`. Configure the builder so Harness packages remain external.

An installable bundle package normally needs:

- ESM entry and type declaration exports;
- a `files` allowlist containing built output and the patch;
- `dsh.bundle.patch` pointing at that patch;
- build, typecheck, test, aggregate check, source-install prepare, and prepack gates;
- a lockfile and explicit supported Node/package-manager range.

Do not blindly copy versions from an older Cron, review, or example plugin.
