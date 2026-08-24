# API quick reference

Use this page for a small Tool, Service, or event hook after completing
[contract discovery](contract-discovery.md).

> Snapshot boundary: examples and names on this page were checked against
> `dsh-v0.1.1-rc.2`. They are examples, not the current contract. Re-run the
> discovery queries against the pinned target before copying them.

## Loader entry shapes

Cordis itself accepts function, object, and constructor/class plugins. An
external package imported by the Loader should expose one unambiguous root:

1. **Named namespace entry** — export `apply` and, when needed, `name`,
   `inject`, and `Config`; do not export a default.
2. **Default entry** — default-export one function, `{ apply }` object, or
   `Service` class. Other named helper exports are allowed, but the Loader
   executes the default and ignores them as plugin metadata.

Do not combine a default plugin with a competing named `apply`. A default
function, object, or Service class may have arbitrary named helper exports,
including bindings called `inject` or `Config`, but the Loader unwraps the
default first and does not attach those bindings as its plugin metadata. Put
metadata on the default function/object/class itself and never rely on adjacent
named metadata. A named variable containing an object plugin is useful for
`ctx.plugin(objectPlugin)`, but it is not a Loader root unless that object is
the default export.

For an ordinary tool, prefer the named namespace shape:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'example-tool'
export const inject = ['tools']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'example_echo',
    description: 'Return a bounded text value unchanged.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'Text to return.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      return args.text
    },
  }))
}
```

A service commonly uses one default class:

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MetricsService extends Service {
  static inject = ['llm']

  constructor(ctx: Context) {
    super(ctx, 'metrics')
  }
}
```

Ship the matching `declare module '@deepseek-ai/cordis'` augmentation in the
declaration output when consumers access a custom service as `ctx.metrics`.

## Tool schema DSL

`defineTool` parameters use an implicit open object property map. Do not wrap
that root in `{ type: 'object', properties: ... }`.

| Need | Author DSL shape |
| --- | --- |
| Required property | `{ type: 'string', required: true }` on that property |
| Scalar | `string`, `number`, `integer`, `boolean`, or `null` |
| Fixed choices | matching scalar node with `enum` or `const` |
| Array | `{ type: 'array', items: <node> }` |
| Nested object | `{ type: 'object', properties: {...}, additionalProperties: false }` |
| Exact-one union | `{ oneOf: [<node>, <node>] }` |
| Any lossless JSON | `{ type: 'json' }` |

Every explicit object node declares `additionalProperties: true | false`.
Requiredness is a per-property `required: true`; the author DSL does not use a
root JSON-Schema `required: []` array. Output roots may be scalars, arrays,
objects, `null`, or `json`.

The canonical value returned by `execute` must match `output.schema`.
`output.render` converts that value into model-visible content. Thread the
required execution signal into foreground I/O and subprocess work; a timeout
or background hand-off does not remove lifecycle ownership.

For any external mutation or tool whose visibility is narrower than “every
eligible Agent may call it,” also read [tool-authority.md](tool-authority.md).

## Config and lifecycle

- Export a real Standard Schema as `Config`, not a plain defaults object.
- `inject` lists required services. A plugin remains pending while one is
  unavailable and is reloaded when a required service is replaced.
- Query a genuinely optional service through the current official lookup
  pattern instead of adding it to required `inject`.
- Registrations made through `ctx` are Fiber-owned. Use `ctx.effect()` for
  external resources such as processes, sockets, file watchers, or database
  handles, and make ordered cleanup one awaited disposer.
- A bundle patch that overrides an existing row replaces that row's complete
  `config` value under the rc.2 contract. Restate every field that must survive.

## rc.2 event examples

These are navigation hints, not an exhaustive catalog:

| Event | rc.2 mode | Typical use |
| --- | --- | --- |
| `tools/pre-execute` | waterfall | allow, deny, or ask before dispatch |
| `tools/execute` | waterfall | timeout, retry, or metrics wrapper |
| `tools/post-execute` | waterfall | accept, replace, enrich, or block a result |
| `tools/result` | emit | observe the final frozen result |
| `agent/pre-step` | waterfall | alter or veto the next model step |
| `agent/session-start` | emit | observe an Agent starting a Session |
| `agent/created`, `agent/disposed`, `agent/status` | emit | Agent lifecycle |
| `session/created`, `session/event`, `session/disposed` | emit | Session lifecycle and durable events |
| `session/flush` | parallel | participate in a flush boundary |

Waterfall listeners call `next()` to delegate; omitting it deliberately
short-circuits. Durable `turn/*`, `step/*`, `tool/call`, and `tool/result`
records are Session event types observed through `session/event`, not assumed
to be same-named Cordis events.

## Discover current services and events

Prefer generated official catalogs and source declarations to a copied list.
Paths may move, so start broad and narrow by the capability:

```bash
rg -n "interface Context|declare module ['\"]@deepseek-ai/cordis['\"]" <dsh-repo>/packages
rg -n "extends Service|super\(ctx,|ctx\.provide\(" <dsh-repo>/packages
rg -n "interface Events|ctx\.on\(|ctx\.(emit|bail|serial|parallel|waterfall)\(" <dsh-repo>/packages
rg -n "defineTool\(|ctx\.tools\.register" <dsh-repo>/packages <dsh-repo>/docs
rg -n "Event Producer And Consumer Matrix|Cordis API" <dsh-repo>/docs
```

Then inspect the declaration, dispatcher, at least one production consumer,
and the target Profile composition. A service present in Web is not thereby
available in Headless, and a declared event name does not establish its mode.
