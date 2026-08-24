# Packaging and release gates

Read this whenever the user asks to package, install, publish, deploy, create a repository, or push a Harness plugin.

## Freeze the candidate

Before packaging:

- inspect the working tree and preserve unrelated user changes;
- pin the target Harness/Cordis/toolchain versions;
- run the exact repository check command;
- run the repository's production dependency-audit policy; if none exists and the user did not choose a threshold, default to `moderate` and report it;
- complete any capability-specific real sandbox/provider test;
- obtain an independent read-only audit for high-risk plugins.

Any source/doc/patch/build-config change after a package test makes that artifact stale. Rebuild and repeat affected parity/install gates.

## Package inspection

Run the current package manager's pack command, then inspect the archive rather than trusting its success message:

- exact allowlisted paths; no absolute or `..` entries;
- built entry, worker/client bundles, declarations, patch, license, and intended docs present;
- no source secrets, local absolute paths, `.env`, logs, stores, test fixtures, credentials, or unexpected generated output;
- source-map `sourcesContent` and declarations match the frozen source;
- packed manifest differs only by documented package-manager normalization;
- no `file:`, `link:`, or `workspace:` dependency leaks;
- record the final archive SHA-256.

Use the Skill validator before pack and on the built checkout:

```bash
node <skill-dir>/scripts/validate_plugin.mjs <plugin-dir> --built
```

The acceptance helper defaults to the same non-executing static boundary:

```bash
node <skill-dir>/scripts/accept_plugin.mjs <plugin-dir>
```

After reviewing and trusting the candidate source, `--trusted-execute` verifies
the exact declared npm or pnpm CLI and runs its check and pack hooks with caller
host authority, records the archive
manifest and SHA-256, revalidates the source after the complete pack lifecycle, and can continue
through exact installed-artifact validation plus the isolated Web acceptance
below. It is not a sandbox. The helper has no built-in real-model/provider turn,
but trusted candidate hooks or startup code can use their host filesystem and
network authority to initiate one; offline behavior is not enforced.
`--pack-only` stops after the archive; use it for a non-Web Profile and perform
that surface's startup/shutdown gate manually.

The helper and its emitted `--pack-only` Profile commands use an allowlisted
operating environment and omit ambient provider/API credential variables. This
is credential minimization, not a sandbox: reviewed package scripts retain
caller filesystem and network power.

## Fresh Profile acceptance

Use a new temporary `DSH_HOME` and a dedicated Profile. Follow the installed CLI's current syntax; the `plugin` command may forward arguments to pnpm, and workspace-root flags or build-script allowlists are package-manager-version dependent.

For a reviewed, trusted Web candidate that mounts its own package root or
exported subpath, this helper automates exact-tarball install, installed-surface
validation, that own mount-row check, bounded readiness, normal termination,
and the port-release portion:

```bash
node <skill-dir>/scripts/accept_plugin.mjs <plugin-dir> \
  --trusted-execute --profile web --dsh-bin <current-dsh-bin>
```

The acceptance sequence is:

1. Initialize the fresh Profile.
2. Install the exact tarball, statically validate the installed release surface,
   and bind one descriptor-walk path/stat metadata snapshot across validation,
   composition, boot, and post-shutdown gates.
3. Verify that the candidate source block mounts its own package root or an
   exported subpath, and record those row IDs.
4. Start the actual Web Profile and require bounded HTTP readiness.
5. Send normal termination and verify the top-level DSH process exits and its
   reported port is released.

Patch-only Bundles, non-own row/config changes, and unmatched-patch diagnostics
are outside automatic composition acceptance; use `--pack-only` and verify each
intended composed value and diagnostic manually. The helper also does not load
the Web client in a browser, invoke a Tool/Worker/provider behavior, inventory
arbitrary descendant processes, or prove cleanup of stores, files, watchers,
sockets, queues, provider jobs, or other capability-specific resources. Add
explicit gates for every such capability before calling the plugin release-ready.
The installed-tree snapshot includes `dist`, skips nested `.git` and
`node_modules`, and hashes metadata rather than content bytes. It detects
persistent changes at the listed gates, not a same-UID change that is completely
restored between two checks.

`--dump-default-config` and `--dump-config` do not boot the plugin and cannot replace startup acceptance.

Git-source installs may run `prepare`, which pnpm can block until the consumer explicitly allows that package. A prebuilt tarball should not need a source build. Document this distinction and never weaken a global build policy silently.

## External release

Repository creation, public visibility, push, tag, release, npm publication, deployment, and Profile modification require explicit user authorization. Immediately before acting:

- confirm the exact owner/name/visibility/registry/profile;
- check whether the remote or package already exists;
- stage only intended files and run staged secret/local-path checks;
- verify the commit contains the frozen candidate;
- create/push/publish once, then read the remote state back;
- compare local and remote commit/tag/digest and confirm visibility.

Do not publish merely because tests passed; “if tests pass, publish” is authorization only when the user actually supplied the target and requested that action.

## Release evidence

Report exact commands or compact summaries for:

- tests/typecheck/build and counts;
- dependency audit;
- sandbox/real-provider tests and disclosures;
- archive manifest, parity, scans, and SHA;
- clean install, composed config, actual startup/health/shutdown;
- independent audit verdict;
- remote visibility and matching commit/digest.

If any gate is blocked, say which artifact remains unverified and do not imply release readiness.
