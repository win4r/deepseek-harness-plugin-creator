# Install and debug by symptom

Use this page after pinning the target contract. Commands are patterns: adapt
them to the installed `dsh` and package-manager versions instead of assuming a
global binary, one Profile layout, or one workspace-root flag.

## Symptom index

| What is observed | First evidence to collect | Likely causes and next action |
| --- | --- | --- |
| Package installs, but no bundle layer appears | Packed `package.json`, packed patch, `--dump-config`, `plugin ... why <pkg>` | Missing or wrong `dsh.bundle.patch`, patch omitted from `files`, package resolved under a different name, or install reconciliation did not complete. Fix the packed candidate, not the Profile by hand. |
| Bundle layer appears, but `apply` never runs | Complete composed row, startup error, Fiber/plugin inventory, required services | Row disabled; required `inject` unavailable in this Profile; invalid config; wrong entry export; import or startup failure. Test the real Loader entry rather than a stub Context. |
| `invalid plugin` or Loader discards metadata | Built entry namespace and package `exports` | Mixed default and named plugin shapes, a named object never exported as default, or the default is not a function/class/`{ apply }` object. Choose one root shape from `api-quick-reference.md`. |
| `ValidationError: invalid config` or defaults are absent | Built `Config` export and the pinned Standard Schema version | `Config` is a plain object, schema and runtime versions drifted, or normalized cross-fields are invalid. Use a real Standard Schema and test Loader validation. |
| Tool is missing although the plugin is active | Tool registry/inventory, registration scope, duplicate-name startup error, Agent restrictions | `tools` not injected, registration happened in the wrong scope, the Agent cannot see it, the name is duplicated/reserved, or authority setup removed it. Check visibility and execution authority separately. |
| `defineTool` rejects the schema | The exact built schema and installed `dsh-tools` version | Explicit object lacks `additionalProperties`; author DSL uses root JSON-Schema `required: []`; output and returned value disagree; unsupported keyword; version drift. Compare against the pinned schema implementation. |
| Event listener never fires or its return is ignored | Event declaration, generated producer/consumer matrix, dispatcher call | Wrong event name, wrong Profile/capability, or wrong dispatch mode. For a waterfall call `next()` to delegate; observe durable record types through `session/event`. |
| One patch edit resets unrelated fields | Full row before and after composition | The patch replaces the row's complete `config` under the rc.2 contract. Restate every field that must survive and retest layering. |
| Patch matches nothing | Patch diagnostics plus row `id` and guarded `name` | Wrong stable id, wrong layer order, or `name` guard mismatch. A guard is not a rename. Treat unmatched-patch warnings as failures in acceptance. |
| Built entry cannot be found | Packed file list, `exports`, `main`, build output, install spec | Stale/missing build, archive `files` omission, linked checkout moved, or a source install's build script was blocked. Rebuild and test the exact archive. |
| Source edits have no effect | Resolved installed path, built file hash, HMR roots, running process age | The Profile points to another copy, built output is stale, or this Profile does not watch that module. Rebuild and restart unless the pinned HMR contract proves live replacement. |
| pnpm reports a workspace-root error | Installed pnpm version and its full diagnostic | `dsh plugin` forwards to pnpm in the Profile directory. Use the exact acknowledgement flag printed by that pnpm/version; do not encode one flag as universal. |
| Git install refuses `prepare` | Installed pnpm policy file and the exact package key from its diagnostic | Modern pnpm blocks dependency build scripts until explicitly allowed. Treat allowance as host-code execution, pin the Git commit, or use a prebuilt archive. Do not guess between policy syntaxes from another pnpm release. |
| Works in Web but not Headless | Compare the two composed Profiles and service inventories | The plugin injects a Web-only service or depends on a client surface. Split host/tool and Web UI rows when Headless support is required. |
| Host starts but UI is absent | `dsh.client`, `exports["./client"]`, packed client bundle, client boot graph, browser errors | Missing Web platform declaration, disabled host row, wrong client build format, undeclared external, missing supplier, graph cycle, or UI registration failure. Follow `client-extensions.md`. |
| Child process survives unload | Active process tree and Fiber disposal evidence | Process was launched outside lifecycle ownership or cancellation did not drain it. Stop admission, cancel, wait for exit, then release resources in one owned effect. |
| Tool reads the wrong workspace | Authoritative Agent/Session/workspace value used by the tool | Host `process.cwd()` is the DSH process directory, not necessarily the user's workspace. Resolve and confine the current workspace through the pinned Harness seam. |
| External CLI exits 0 but result is unusable | Bounded stdout/stderr plus the CLI's structured status | Exit status alone is not a domain-success signal. Validate required fields, error envelopes, truncation, and provider failures before returning success. |

## Evidence ladder

Run the cheapest checks first, but do not stop at composition:

```bash
# Reproducible local artifact
<package-manager> run check
<package-manager> pack

# Static release-surface inspection
node <skill-dir>/scripts/validate_plugin.mjs <plugin-dir> --built

# Composition only; this does not import or start the plugin
dsh --profile <profile> --dump-config
dsh plugin --profile <profile> why <package>

# Real acceptance
# Install the exact archive in a fresh DSH_HOME/Profile, start the Profile,
# exercise one bounded behavior, terminate normally, and verify process/resource release.
```

Always record the exact CLI, Node, package-manager, Harness tag/commit, and
archive digest used. Directory links, a developer's current `dist/`, and a
freshly packed archive are different artifacts.

## Debugging boundaries

- Never “fix” an installed Profile by editing generated profile manifests when
  the defect belongs in the package or bundle layer.
- A hand-built/stub Context can test pure registration ergonomics, but it can
  reject legal plugins or accept impossible compositions. It is not a Loader,
  Profile, lifecycle, or release gate.
- `--dump-config` proves patch composition only. It does not run `apply`, wait
  for injections, import the client bundle, or call a model-facing tool.
- A real model functional check may send content to a provider and incur cost.
  Use an explicit opt-in and the disclosure in `sandboxed-workers.md`.
- Preserve complete, bounded diagnostics, but redact credentials, captured
  secret bytes, provider responses, and local paths when reporting failures.
