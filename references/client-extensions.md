# Web client extensions

Read this when an external plugin contributes browser code, a settings card,
or another Web UI surface. Complete
[contract discovery](contract-discovery.md) first.

> Snapshot boundary: the concrete manifest fields below were checked against
> `dsh-v0.1.1-rc.2`. Re-derive the client-module and build contracts from the
> pinned target before implementation.

## Required package surface

An external UI plugin is supported, but declaring a host plugin alone is not
enough. Under the rc.2 contract an enabled Loader entry is discovered as a Web
client package only when its manifest has both:

```json
{
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": {
      "types": "./lib/types/client/index.d.ts",
      "default": "./lib/client.js"
    }
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": []
    }
  }
}
```

The `files` allowlist must ship the host entry, client bundle, declarations,
assets, source maps when intended, and the bundle patch. The package still
needs an enabled host Loader row; an empty named `apply` is a common host half
when all behavior is in the browser.

`dsh.client.inject` contains package-name dependency edges used for inventory
and HMR reporting. It does not order Cordis Fiber activation. Host and browser
Cordis service injection remains a separate contract.

Each injected client package is part of the consumer contract: declare a peer
range plus an exact matching development version and prove the peer range
contains that version. A `./client` export without `dsh.client`, or a client
declaration without an enabled host row mounting this package/root subpath, is
not a usable Web extension.

## Client build contract

The rc.2 Web loader consumes a lazy-CJS factory bundle, not an arbitrary ESM
browser output. The official `clientBundle` build preset is source-internal
rather than a published external-plugin preset, so an out-of-tree package must
reproduce the pinned target's emitted format and purity checks. Do not claim
compatibility merely because `lib/client.js` exists.

The client module graph has three distinct dependency concepts:

| Declaration | Meaning |
| --- | --- |
| Cordis `inject` | Runtime service availability and Fiber activation |
| `dsh.client.inject` | Informational package dependency edge |
| `dsh.client.external` | Exact non-baseline module request supplied by the client module graph |

Baseline externals are target-specific. Do not copy a static list from this
Skill. For a non-baseline value import, declare its exact request only when the
pinned client-module contract requires it and prove a supplier exists. Type-
only imports disappear at build time. Missing suppliers, self-requests, and
synchronous cycles are composition failures.

Keep host-supplied Harness client imports in the peer/development sections
required by the target contract. Exact development versions and a lockfile
reproduce the build; peer ranges must include those versions. Put plugin-owned
runtime libraries in exact `dependencies`. Do not release `*`, `file:`,
`link:`, or `workspace:` specs.

## Discover the current client contract

Locate the client module scanner, official dynamic packages, shared module
table, build preset, and Web bundle composition:

```bash
rg -n "dsh\.client|exports.*['\"]\./client|clientBundle\(" <dsh-repo>/packages <dsh-repo>/docs
rg -n "PLATFORM_MODULES|PRELOADED_CLIENT_EXTERNALS|external" <dsh-repo>/packages/client
rg -n "clientModules|webServer|webPlugins" <dsh-repo>/packages <dsh-repo>/docs
rg -n "ui-slots|slots\.register|settings\.register" <dsh-repo>/packages/client <dsh-repo>/packages/settings
```

Inspect at least one official package that contributes the same UI surface.
Treat it as version-qualified evidence; do not infer that internal
`workspace:` dependencies or monorepo-only build presets are publishable.

## Acceptance gates

In addition to the ordinary plugin gates:

1. Inspect the packed manifest and confirm `exports["./client"]`, its types,
   bundle, assets, and source map all exist inside the archive.
2. Run the pinned target's client-bundle purity and module-graph validation, or
   a demonstrably equivalent check for the external package.
3. Install the exact archive into a fresh Web Profile and verify the package's
   Loader row is enabled and included in the client boot graph.
4. Start the real Web Profile, load a clean page, and exercise the contributed
   surface. A successful host boot alone does not prove the client loaded.
5. Test unload/reload and disposal when the target supports that lifecycle;
   verify styles, listeners, stores, and registrations do not duplicate.

If the external build cannot reproduce the pinned client bundle format, report
Web support as unverified rather than falling back to a generic browser build.
