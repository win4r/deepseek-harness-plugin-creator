---
name: deepseek-harness-plugin-creator
description: Create or materially revise external plugins and bundle layers for DeepSeek Harness/Cordis, including model tools, host services, schedulers, workers, provider integrations, and client extensions. Use when the target explicitly concerns DeepSeek Harness, dsh, or @deepseek-ai/dsh-* development. Do not use for Codex plugins, generic Node packages, installation-only requests, or read-only reviews.
---

# DeepSeek Harness Plugin Creator

Build a plugin that works through the real DeepSeek Harness loading and deployment path, not only in an isolated unit test.

## Start with the current contract

DeepSeek Harness is preview software. Never choose APIs or dependency versions from memory, this Skill, or an older plugin alone.

1. Read the target repository's `AGENTS.md`, local instructions, manifest, lockfile, and existing patches.
2. Read [references/contract-discovery.md](references/contract-discovery.md) and pin the current official Harness tag or commit, installed CLI version, Node version, pnpm version, and relevant package versions.
3. State which observed contract is being implemented before creating files.
4. Treat existing `dsh-*` plugins as design evidence only after comparing their pinned Harness/Cordis versions with the selected contract.

Prefer a local official Harness checkout when it is current and identifiable. Otherwise inspect the official `deepseek-ai/deepseek-harness` repository. Use only official sources for API behavior; community examples may inform ergonomics, not establish the contract.

## Classify the contribution

Choose the smallest shape that satisfies the request:

| Need | Primary shape |
| --- | --- |
| Compose existing plugins or defaults | Bundle patch only |
| Add a host capability or registry | Cordis host plugin/service |
| Expose a model-callable operation | DSH tool plugin |
| Integrate Agent, Session, Goal, Job, or preset behavior | Agent/session plugin |
| Schedule or recover durable work | Durable host runtime |
| Invoke another process or model runtime | Isolated Worker/provider adapter |
| Extend the Web client | Host plugin plus declared client bundle |

Do not add a Worker, durable store, UI, custom Agent loop, or separate service merely because Harness supports one.

## Route the risk-specific guidance

- For any model-facing tool, root-scoped registration, permission gate, or external mutation, read [references/tool-authority.md](references/tool-authority.md).
- For subprocesses, filesystem snapshots, credentials, model providers, MCP servers, or isolation claims, read [references/sandboxed-workers.md](references/sandboxed-workers.md).
- For cron, heartbeat, background pumps, queues, persistence, or restart recovery, read [references/durable-runtime.md](references/durable-runtime.md).
- For packaging, installation, publishing, or a public/private repository, read [references/release-gates.md](references/release-gates.md).

Read only the references triggered by the requested capability. When several apply, combine their invariants rather than selecting one.

## Implement the Harness-native boundary

- Declare the package as a DSH Bundle only when it contributes a patch: `dsh.bundle.patch` must point to the shipped patch file.
- Keep every Harness/Cordis package imported by shipped code or declarations at the same exact compatible version in both peer dependencies and development dependencies. A package used only by tests/build tooling may remain development-only, but must not leak into shipped imports. Do not bundle a second runtime copy; configure the builder to externalize `@deepseek-ai/*`.
- Use the Cordis namespace form: named `name`, optional `inject`, optional runtime `Config` schema, and `apply`. Do not add a default export alongside these exports.
- Make `inject` match every service accessed through `ctx.<service>`. For an optional service deliberately outside the injection set, follow the current official lookup pattern rather than assuming property traversal works across fibers.
- Export a real Standard Schema for configurable plugins. Normalize and revalidate security-sensitive or cross-field values inside the implementation as well, because direct tests or callers can bypass Loader validation.
- Treat registrations such as `ctx.tools.register()` and `ctx.on()` as lifecycle-owned effects. Put timers, watchers, connections, subprocesses, and external resources under explicit admission, cancellation, drain, and disposal ownership.
- Remember that a patch targeting an existing row replaces that row's complete `config` object unless the currently pinned official contract proves otherwise. Preserve every field that must survive.
- Treat `!!js`, install-time `prepare`, shell commands, MCP servers, and host Workers as executable code outside the model's ordinary tool sandbox.

## Test the delivered shape

Testing must cover the path users will install and boot:

1. Unit-test pure parsing, state transitions, bounds, cancellation, and failure paths.
2. Mount through a real Cordis Context for service and disposal behavior.
3. Exercise the actual Loader/package export and `cordis.patch.yml`; a hand-built `{ name, inject, apply }` object cannot catch Loader export bugs.
4. Test negative authority, unknown arguments, unavailable services, partial confinement, shutdown during work, and bounded diagnostics when those risks exist.
5. Run the repository's exact typecheck, tests, and build.
6. Run the bundled validator after implementation:

   ```bash
   node <skill-dir>/scripts/validate_plugin.mjs <plugin-dir> --built
   ```

   The validator uses the bundled descriptor-bound tree helper through `/usr/bin/python3` and fails closed when that POSIX runtime is unavailable. On another platform, perform an equivalent frozen-tree/package inspection rather than weakening the boundary check.

7. When delivery is requested, follow the clean-package and fresh-Profile gates in `references/release-gates.md`. `--dump-config` proves composition only; it does not boot the plugin.
8. Make real-provider tests explicit opt-in. Tell the user exactly which fixture or diff will leave the machine, which provider receives it, and whether cost may be incurred.

For a high-risk plugin—durable external side effects, secrets, host command execution, security-sensitive snapshots, or public release—use an independent read-only audit before release. Resolve validated blockers and repeat affected artifact gates.

## Preserve authorization boundaries

Implementation permission does not authorize npm publication, GitHub repository creation, public visibility, deployment, credential changes, or messages to third parties. Obtain or rely on explicit user authorization for each requested external mutation, and perform release actions only after the final tested artifact is frozen.

## Completion report

Lead with the delivered capability. Include:

- local artifact paths and the pinned Harness/Cordis baseline;
- the registered services/tools and their authority boundary;
- writes, network calls, subprocesses, credentials, and provider disclosures;
- exact test, package, clean-install, startup, shutdown, and audit evidence;
- any unsupported deployment shapes or unsafe administrator opt-outs;
- remote URL and commit only if the user explicitly requested and the push was verified.
