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

## Fresh Profile acceptance

Use a new temporary `DSH_HOME` and a dedicated Profile. Follow the installed CLI's current syntax; the `plugin` command may forward arguments to pnpm, and workspace-root flags or build-script allowlists are package-manager-version dependent.

The acceptance sequence is:

1. Initialize the fresh Profile.
2. Install the exact tarball or package candidate.
3. Verify the Bundle appears in the composed profile and the intended row/config is present.
4. Import built entry/worker/client artifacts where applicable.
5. Start the actual Profile, wait for explicit readiness, and exercise a bounded health or tool behavior.
6. Send normal termination, verify lifecycle disposal, process exit, and port/resource release.

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
