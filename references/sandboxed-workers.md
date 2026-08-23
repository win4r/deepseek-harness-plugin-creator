# Sandboxed Workers and host boundaries

Read this when the plugin launches processes, reads workspaces, uses credentials, calls a provider, mounts MCP, or claims isolation.

## Separate host and sandbox powers

The plugin host runs outside the Agent's ordinary filesystem/tool sandbox. A sandboxed Worker does not retroactively confine host-side Git, database, configuration, or filesystem reads.

For every operation, state:

- which process performs it;
- its cwd and filesystem roots;
- allowed tools and syscalls/process interface;
- environment variables and credentials;
- network destinations;
- byte/time/file/concurrency bounds;
- cancellation, exit, drain, and disposal owner;
- data returned to Harness and data sent to a provider.

If full confinement is part of the promise, require and verify full enforcement. Reject partial or unavailable enforcement instead of silently downgrading. Any administrator-controlled opt-out must be named unsafe and default off.

## Process and environment rules

- Prefer the current Harness subprocess/sandbox services over ambient `child_process` when they provide the required enforcement and lifecycle integration.
- Resolve exact executable and argv vectors; avoid shell interpolation unless the shell itself is the requested capability.
- Start from a tombstoned/minimal environment, then explicitly forward an allowlist. Do not forward all credentials or process-control variables.
- Treat command-valued credential resolvers, MCP server commands, hooks, Git filters, pagers, askpass programs, tracing sinks, and provider helper commands as host code execution.
- Treat project-local linter/build configuration and third-party plugins as executable code too. Disable discovery by default for an isolated checker, or explicitly include that code in the declared trust boundary and tests.
- Bound stdout, stderr, input, runtime, files, and model output. A lossy/truncated snapshot must fail closed when completeness affects correctness.
- Wait for process exit, not only logical response completion. On disposal, stop admission, cancel, drain, and then release backing stores/resources.

## Filesystem and snapshot rules

- Canonicalize the workspace and each permitted path; reject traversal, absolute paths, control characters, unsafe symlinks, and boundary escape.
- When content confidentiality matters, account for hardlinks and time-of-check/time-of-use races, not only symlinks.
- Freeze the exact path/status set used for a diff or review. Bind metadata and content from one operation where the underlying tool supports it, and verify live content identities around reads.
- Do not expose deleted or staged-only paths through later live-worktree reads.
- Never include captured secret bytes, provider responses, stderr, or local absolute paths in a policy error.

The exact defenses depend on the host API and threat model. Do not copy a complex Git snapshot design into a plugin that never reads hostile paths.

## Provider disclosure

Before a real-model test or runtime call, disclose what content leaves the machine, the provider/model, expected cost, and credential source. Keep ordinary tests offline. Real-provider tests must use purpose-built fixtures and explicit opt-in environment forwarding.

## Required negative tests

- partial/unavailable sandbox;
- poisoned environment, config, executable path, hooks, or helpers;
- symlink/hardlink/rename race and boundary escape when reading untrusted paths;
- output, input, file-count, and timeout overflow;
- abort before spawn, during execution, and during shutdown;
- Worker response malformed, duplicated, oversized, or followed by a nonzero/signal exit;
- error redaction with secret sentinels.
