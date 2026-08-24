---
name: deepseek-harness-plugin-creator
description: Scaffold, create, materially revise, validate, or debug external DeepSeek Harness/Cordis plugins and bundle layers, including Tools, Services, schedulers, Workers, providers, and Web client extensions. Use when the target explicitly concerns DeepSeek Harness, dsh, or @deepseek-ai/dsh-* development. Do not use for Codex plugins, generic Node packages, installation-only requests, or read-only reviews.
---

# DeepSeek Harness Plugin Creator

Build the smallest plugin that works through the real DeepSeek Harness loading
and deployment path. Use the deterministic fast path for a simple Tool and the
risk-specific workflow for everything more capable.

## Discover the current contract first

DeepSeek Harness is preview software. Never choose APIs, commands, or versions
from memory, this Skill, an API snapshot, or another plugin alone.

1. Read the target repository's `AGENTS.md`, instructions, manifest, lockfile,
   and existing patches.
2. Read [references/contract-discovery.md](references/contract-discovery.md).
3. Pin the official Harness tag or commit, target CLI/Profile, Node and package-
   manager versions, and every relevant package version.
4. State the observed contract before creating files. Treat external plugins
   as version-qualified design evidence, not authority.

Prefer a current, identifiable official checkout. Otherwise inspect the
official `deepseek-ai/deepseek-harness` repository. Only official source and
documentation establish API behavior.

## Choose a lane

### Simple Tool fast path

Use the bundled scaffold when all of these hold:

- this is a new external package rather than a structural edit to an existing
  plugin;
- one named-namespace host entry and a bounded model-facing Tool satisfy the
  request;
- no durable state, scheduler, Worker/subprocess, credentials, provider call,
  Web client, custom Agent/session loop, or external mutation is required.

After contract discovery, inspect the script's current interface and run it:

```bash
node <skill-dir>/scripts/scaffold_plugin.mjs --help
node <skill-dir>/scripts/scaffold_plugin.mjs dsh-example \
  --dir <parent-dir> --profile <target-profile> \
  --dsh-repo <pinned-official-checkout> --tool example_echo
```

It reads runtime versions from the installed Profile and the Node engine from
the pinned official checkout. A published DSH manifest may omit the root engine
contract. If either evidence source is unavailable, pass the corresponding
exact runtime overrides and evidence-derived `--node-engine`; never derive the
target engine from whichever Node happens to run the script. The target must be
absent or an empty real directory; there is no overwrite mode. Then read
[references/api-quick-reference.md](references/api-quick-reference.md), inspect
every generated file, implement the bounded behavior, and follow the same real
Loader and fresh-Profile gates as a hand-built plugin. The scaffold is a
starting artifact, not contract discovery or release proof.

The fast path only runs for a DSH version whose complete scaffold contract is
audited in the script (currently `0.1.1-rc.2`, including Schemastery ownership
and toolchain pins). For any other target, use the capability-specific path
until that version receives a new audited snapshot. Generated host-runtime
peers default to the exact observed versions; widen them only after explicit
compatibility evidence.

Read [references/tool-authority.md](references/tool-authority.md) if the Tool is
not intentionally available to every eligible Agent, or if later requirements
add mutation, cost, or durable effects. Leave the fast path as soon as its
assumptions stop holding.

### Capability-specific path

Choose the smallest shape that satisfies the request:

| Need | Primary shape |
| --- | --- |
| Compose existing plugins/defaults | Bundle patch only |
| Add a host capability or registry | Cordis host plugin/Service |
| Expose a model-callable operation | DSH Tool plugin |
| Integrate Agent, Session, Goal, Job, or preset behavior | Agent/session plugin |
| Schedule or recover durable work | Durable host runtime |
| Invoke another process or model runtime | Isolated Worker/provider adapter |
| Extend the Web client | Host plugin plus declared client bundle |

Do not add a Worker, store, UI, custom Agent loop, or separate Service merely
because Harness supports one.

Load only the references triggered by the task:

- Any Tool, scoped registration, permission gate, or external mutation:
  [tool-authority.md](references/tool-authority.md).
- Subprocess, workspace snapshot, credential, provider, MCP, or isolation:
  [sandboxed-workers.md](references/sandboxed-workers.md).
- Cron, heartbeat, queue, background pump, persistence, or recovery:
  [durable-runtime.md](references/durable-runtime.md).
- Web UI or browser bundle:
  [client-extensions.md](references/client-extensions.md).
- Installation/load failure or silent behavior:
  [troubleshooting.md](references/troubleshooting.md).
- Packaging, Profile installation, repository, or publication:
  [release-gates.md](references/release-gates.md).

When several apply, combine their invariants.

## Implement the Harness-native boundary

- Declare `dsh.bundle.patch` only when the package contributes a patch, and
  point it to a shipped file.
- Cordis accepts function, object, and constructor/class plugins. An external
  Loader root should be either:
  - named namespace `apply` with optional `name`, `inject`, and `Config`, and no
    default export; or
  - one default-exported function, `{ apply }` object, or Service class.
  Auxiliary named exports may accompany a default plugin. Never add a competing
  named `apply`; named `inject` or `Config` bindings are not metadata for the
  unwrapped default, so attach required metadata to the default itself.
- Make `inject` match required services accessed through `ctx.<service>`. Use
  the pinned official lookup pattern for genuinely optional services.
- Export a real Standard Schema for configurable plugins. Normalize and
  revalidate security-sensitive or cross-field values in the implementation.
- For each host-supplied Cordis/DSH runtime imported by shipped code, use an
  exact development version and committed lockfile. The peer range must include
  that version and may be exact or evidence-backed compatible. Put plugin-owned
  runtime libraries, including Schemastery under the rc.2 contract, in exact
  `dependencies`. Never release `*`, `file:`, `link:`, or `workspace:` specs,
  and externalize host-owned runtimes.
- Treat registrations as Fiber-owned effects. Give timers, watchers,
  connections, subprocesses, and stores explicit admission, cancellation,
  drain, and disposal ownership.
- Assume a patch overriding an existing row replaces its complete `config`
  unless the pinned contract proves otherwise.
- Treat `!!js`, source-install scripts, shell commands, MCP servers, and host
  Workers as executable host code outside the model's ordinary Tool sandbox.
- For a Web extension, require both `dsh.client.platform: web` and
  `exports["./client"]`, then reproduce the pinned client-bundle contract.

## Test the delivered shape

1. Unit-test pure parsing, bounds, cancellation, state transitions, and failure
   paths.
2. Mount through a real Cordis Context for lifecycle and disposal behavior.
3. Exercise the actual Loader/package export and `cordis.patch.yml`; a stub
   `{ name, inject, apply }` object cannot prove package loading.
4. Test negative authority, unavailable services, shutdown during work,
   partial confinement, and bounded diagnostics when those risks exist.
5. Run the repository's exact typecheck, tests, build, and aggregate check.
6. Run the bundled static validator:

   ```bash
   node <skill-dir>/scripts/validate_plugin.mjs <plugin-dir> --built
   ```

   It verifies observable package and export structure, but cannot prove that a
   visible `Config` binding implements Standard Schema without executing
   candidate code; the real Loader gate remains authoritative. It uses
   `/usr/bin/python3` for descriptor-bound tree inspection and fails
   closed when that POSIX runtime is unavailable. On another platform, perform
   an equivalent frozen-tree/package inspection.

7. Use the acceptance helper in static-only mode before trusting candidate
   code, then opt into execution only after reviewing the source:

   ```bash
   node <skill-dir>/scripts/accept_plugin.mjs <plugin-dir>
   node <skill-dir>/scripts/accept_plugin.mjs <plugin-dir> --trusted-execute
   ```

   Default mode only delegates to static validation. `--trusted-execute` is not
   a sandbox: for an exact declared npm or pnpm version, it verifies that local
   CLI, runs candidate package scripts, packs the result, installs the
   exact archive in a temporary `DSH_HOME`, revalidates the post-pack source
   and installed archive surface, binds descriptor-walk path/stat metadata for
   that installed tree across validation, composition, boot, and shutdown gates,
   and automatically boots only a Web Profile. This metadata guard includes
   `dist` but does not hash installed content bytes; a same-UID mutation fully
   restored between checks remains outside the proof boundary.
   Automatic composition acceptance applies only when the Bundle mounts its
   own package root or an exported package subpath, and checks those mounted row
   IDs. Patch-only Bundles, non-own row/config changes, and unmatched-patch
   diagnostics require `--pack-only` plus a manual composition gate.
   It forwards a small operating environment rather than ambient provider/API
   credential variables, but it is still unsandboxed host code with filesystem
   and network authority. Use it only for reviewed source. Its automatic success
   proves the top-level DSH process, HTTP readiness endpoint, normal exit, and
   reported port release—not descendant-process quiescence, database/file cleanup,
   or other capability-specific resources. Use `--pack-only` plus manual
   app-specific gates for unsupported Profiles. For an unsupported package
   manager, keep to static validation and run every packaging and fresh-Profile
   gate manually. Always add capability-specific cleanup checks when the plugin
   can create external resources. The helper has no built-in provider
   functional turn, but it cannot enforce offline behavior: trusted candidate
   scripts or startup code retain host filesystem and network authority and may
   initiate their own provider call or read credentials from disk.
8. For delivery, follow the clean-package and fresh-Profile gates in
   `references/release-gates.md`. `--dump-config` proves composition only.
9. Make real-provider tests explicit opt-in. Disclose the fixture/diff leaving
   the machine, provider/model, credential source, and possible cost.

For a high-risk plugin—durable external effects, secrets, host command
execution, security-sensitive snapshots, or public release—obtain an
independent read-only audit and repeat affected artifact gates after fixes.

## Preserve authorization boundaries

Implementation does not authorize npm publication, GitHub repository creation
or visibility changes, deployment, Profile mutation, credential changes, or
third-party messages. Perform only externally mutating steps the user actually
authorized, against the frozen tested artifact.

## Completion report

Lead with the delivered capability. Include the artifact path and pinned
baseline; registered Services/Tools and authority; writes, network,
subprocesses, credentials, and provider disclosure; exact test, package,
fresh-install, startup, shutdown, and audit evidence; unsupported shapes or
unsafe opt-outs; and a remote URL/commit only when a requested push was read
back and verified.
