# DeepSeek Harness Plugin Creator

English | [简体中文](README.zh-CN.md)

A reusable Codex Skill for scaffolding, designing, implementing, debugging,
validating, and releasing external plugins and bundle layers for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and Cordis.

It supports:

- A fail-closed scaffold for a simple model-callable Tool Bundle
- Bundle patches, host plugins, and Services
- Agent, Session, Goal, and Job integrations
- Cron, heartbeat, durable queues, and restart recovery
- Isolated Workers, subprocesses, credentials, and provider adapters
- Web client extensions
- Symptom-oriented install and load debugging

DeepSeek Harness is preview software. The Skill always discovers and pins the
official target contract before using its quick reference or generating code.

## Version 0.2 merge

Version 0.2 combines this project's authority, sandbox, durability, and release
workflow with the scaffold, API quick-reference, and symptom-index ideas from
[win4r/dsh-plugin-skill](https://github.com/win4r/dsh-plugin-skill). The
scaffold and references were rewritten against the official Harness contract
and the comparison audit; they are not copied as a fixed local snapshot.

## Core advantages

The main advantage is an executable, evidence-producing delivery path rather
than a prompt-only template or version-agnostic checklist:

| Advantage | Practical value |
| --- | --- |
| Contract-qualified development | Discovers the pinned official Harness source, target CLI/Profile, Node engine, package manager, and exact runtime versions before choosing APIs or generating files. Preview-era API drift fails closed instead of being hidden by remembered examples. |
| Two appropriately sized paths | Uses a deterministic scaffold for a genuinely bounded Tool, while routing Services, Cron, Workers, providers, Web clients, and existing-plugin revisions through capability-specific design and tests. |
| Harness-native architecture coverage | Handles real Loader export shapes, Bundle patches, Tools, Services, Agent/session integration, durable runtimes, isolated workers/provider adapters, and declared Web client bundles without forcing every plugin into one template. |
| Executable delivery tooling | Ships a scaffold, static validator, trusted acceptance helper, reusable templates, focused references, tests, and CI—the workflow can be run and audited rather than merely followed by hand. |
| Fail-closed package and supply-chain checks | Verifies exact dependency ownership and runtime pairing, lockfile/package surfaces, Loader and client exports, patch mounting, secrets and local paths, plus symlink, hardlink, tree-race, archive-replacement, and hostile pack-output cases. |
| Artifact-to-runtime continuity | Freezes the packed archive and SHA-256, revalidates after package lifecycle hooks, installs that exact artifact into an isolated temporary `DSH_HOME`, validates the unpacked package, checks composition, and exercises Web startup, HTTP readiness, normal shutdown, and port release. |
| Capability-aware safety and lifecycle guidance | Separates Tool visibility from authority and supplies dedicated rules for mutation, durable scheduling, cancellation, disposal, subprocess isolation, credentials, provider disclosure, and restart recovery. |
| Honest completion and authorization boundaries | Distinguishes static hints, `--dump-config`, Loader acceptance, runtime smoke tests, and capability-specific proof. It does not call an unsandboxed execution, model/provider turn, publication, Profile mutation, or external release “verified” without the required evidence and authorization. |
| Operational debugging and release evidence | Provides a symptom-oriented troubleshooting ladder and requires artifact identity, dependency audit, fresh-Profile evidence, cleanup limits, independent review for high-risk plugins, and an explicit list of what remains unverified. |

These advantages are exercised by the repository's automated tests, including
live isolated scaffold/install/build/pack/Web-boot acceptance. They do not
remove the need for capability-specific functional tests or review of code run
through `--trusted-execute`.

## Two work modes

| Mode | Use it for | What it does not replace |
| --- | --- | --- |
| Simple Tool fast path | A new, bounded pure-string Tool with no Worker, provider, persistence, UI, credentials, or external mutation | Contract discovery, authority review, real Loader/Profile acceptance |
| Capability-specific path | Existing plugins, Services, Cron, Workers, providers, UI, and other higher-risk extensions | Risk-specific tests, package inspection, fresh-Profile startup and shutdown |

The rc.2 examples in `references/api-quick-reference.md` are explicitly marked
as `dsh-v0.1.1-rc.2` examples. They must not be treated as the current API.

## Install

Clone the repository into your Codex Skills directory:

```bash
git clone https://github.com/win4r/deepseek-harness-plugin-creator.git \
  ~/.codex/skills/deepseek-harness-plugin-creator
```

## Use from Codex

Invoke the Skill explicitly:

```text
$deepseek-harness-plugin-creator Build and verify a durable Cron plugin for DeepSeek Harness.
```

Codex may also select it automatically for requests that explicitly concern
DeepSeek Harness, `dsh`, or `@deepseek-ai/dsh-*` plugin development. It excludes
Codex plugins, generic Node packages, installation-only requests, and read-only
reviews.

## Scaffold a simple Tool

The scaffold reads exact Cordis, `dsh-tools`, Schemastery, and DSH versions from
an installed target Profile. It reads the Node engine contract from a pinned
official checkout because published DSH manifests may omit the root engine.
Missing evidence fails closed; explicit runtime overrides must be exact semantic
versions and an explicit engine must come from the pinned target.

```bash
node scripts/scaffold_plugin.mjs --help

node scripts/scaffold_plugin.mjs dsh-example \
  --dir /path/to/parent \
  --profile web \
  --dsh-repo /path/to/pinned/deepseek-harness \
  --tool example_echo
```

The target package directory must be absent or an empty real directory. There
is no overwrite option. The generated package uses exact development and peer
versions for host-supplied runtimes, exact dependencies for plugin-owned
libraries, a Bundle patch, tests, release hooks, and security/documentation
files. Widen a peer only after explicit compatibility evidence. The fast
scaffold currently has one complete audited contract snapshot:
`dsh-v0.1.1-rc.2`; an unknown target fails closed and must use the manual path
until its Schemastery ownership and toolchain receive a new audit. Create and
commit the generated lockfile before relying on the artifact:

```bash
cd /path/to/parent/dsh-example
npm install
npm run check
node /path/to/skill/scripts/validate_plugin.mjs . --built
```

Use the manual capability-specific path when the requirement exceeds the
scaffold's pure-string Tool boundary.

## Dependency policy

For every host-supplied Cordis/DSH runtime imported by shipped source,
declarations, or the pinned client contract:

- use the exact target version in `devDependencies` and commit the lockfile;
- use a peer range containing that exact version—exact is valid, a broader
  range needs compatibility evidence;
- put plugin-owned runtime libraries in exact `dependencies`; under the rc.2
  contract this includes Schemastery;
- never release `*`, `file:`, `link:`, or `workspace:` specs;
- externalize host-owned runtimes so the plugin cannot load a second copy.

## Validate this Skill

The repository contains deterministic self-checks, Node tests, and a CI
workflow. Run the same local entry point before publishing changes:

```bash
npm ci
npm run check
```

## Validate a plugin

The static validator inspects the packaged plugin surface without executing
project code:

```bash
node scripts/validate_plugin.mjs /path/to/plugin --built
```

It checks the descriptor-bound file tree, package and patch ownership, Loader
entry surface, runtime dependency pairing, client declaration, secrets and
local paths, symlinks, hardlinks, tree races, and built package subpaths. It
uses `/usr/bin/python3` and fails closed when that POSIX helper is unavailable.
It cannot prove that a visible `Config` export implements Standard Schema
without executing candidate code; verify that through the actual Loader.

Static validation is not runtime proof. The Skill still requires real Cordis
Context tests, the actual Loader/package export, an exact packed artifact, and
fresh-Profile startup, behavior, normal shutdown, and resource-release checks.

## Accept a trusted plugin

The acceptance helper is static-only by default and does not import project
code, run package scripts, pack, install, or boot the candidate:

```bash
node scripts/accept_plugin.mjs /path/to/plugin
```

After reviewing and trusting the source, opt into executable acceptance. The
candidate must declare an exact `npm@...` or `pnpm@...` in `packageManager`,
and the corresponding local CLI must match it exactly:

```bash
node scripts/accept_plugin.mjs /path/to/plugin \
  --trusted-execute \
  --profile web \
  --dsh-bin /path/to/current/dsh
```

`--trusted-execute` is not a sandbox. It runs the candidate's declared npm or
pnpm check and pack hooks with caller host authority, records the exact archive and
SHA-256, revalidates the source after the complete pack lifecycle, installs it into an independent
temporary `DSH_HOME`, validates the package actually unpacked from that archive,
rechecks one descriptor-bound installed path/stat metadata snapshot before and
after static validation, before composition and boot, and after shutdown,
verifies an own-package mounted row ID, starts the Web Profile with bounded
readiness, terminates it normally, and checks the reported HTTP port is released.
Automatic composition acceptance applies only to Bundles mounting their own
package root or exported subpath. Patch-only Bundles, non-own row/config changes,
and unmatched-patch diagnostics require `--pack-only` plus a manual composition
gate. That success covers
the top-level DSH process and port only; it does not prove descendant-process
quiescence or cleanup of files, stores, sockets, or other capability-specific
resources. Use `--pack-only` for an unsupported Profile and perform that app's
startup/shutdown gate manually. For an unsupported package manager, keep to
static validation and perform the package, exact-artifact, and fresh-Profile
gates manually. Add explicit resource checks for capable plugins.

The installed-tree guard includes `dist` but hashes path/stat metadata rather
than file contents, and skips nested `.git` and `node_modules` trees. It rejects
persistent changes observed at its gates; it cannot exclude a same-UID process
that changes and restores a tree entirely between two checks.

Both automatic execution and emitted `--pack-only` Profile commands use a
small allowlisted operating environment and do not copy ambient provider/API
credential variables. That reduces accidental credential exposure; it is not
confinement—reviewed code still has caller filesystem and network authority.

The helper contains no built-in real-provider functional test, but it cannot
enforce offline behavior. Trusted candidate scripts or startup code retain host
filesystem and network authority and may initiate their own provider call or
read credentials from disk. Review that code and keep any intended model call
a separately disclosed opt-in.

## Repository layout

```text
SKILL.md                       Skill entrypoint and progressive routing
agents/openai.yaml             Codex UI metadata
assets/scaffold/               Simple Tool package templates
references/contract-discovery.md
references/api-quick-reference.md
references/tool-authority.md
references/sandboxed-workers.md
references/durable-runtime.md
references/client-extensions.md
references/troubleshooting.md
references/release-gates.md
scripts/scaffold_plugin.mjs    Fail-closed simple Tool scaffold
scripts/validate_plugin.mjs    Static plugin release-surface validator
scripts/accept_plugin.mjs      Static-by-default trusted acceptance helper
scripts/enumerate_tree.py      Descriptor-bound filesystem helper
scripts/check_skill.mjs        Skill structure/link/path self-check
tests/                         Deterministic regression tests
.github/workflows/ci.yml       Repository CI entry point
```

## Limits

- The quick reference is a version-labelled example, not a substitute for
  official contract discovery.
- The scaffold intentionally does not generate Cron, Workers, providers,
  Services, credentials, or Web UI, and refuses DSH versions without a complete
  audited scaffold snapshot.
- The rc.2 client build preset is source-internal; an out-of-tree Web extension
  must reproduce and verify the pinned target's lazy-CJS bundle contract.
- The validator is static and POSIX-dependent; it cannot prove behavior,
  Standard-Schema behavior, authority, sandbox enforcement, startup, or cleanup.
- Executable acceptance runs trusted candidate code with host authority; its
  temporary `DSH_HOME`/`DSH_AGENTS_HOME` isolates live Profile and skill roots,
  not code execution; it does not inventory or terminate arbitrary descendants.
- Publication, repository creation, Profile mutation, provider calls, and
  other external changes still require user authorization.
