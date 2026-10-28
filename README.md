# dsh-ability-strip

A **read-only** strip docked **under** the composer in the DeepSeek Harness Web GUI — inside the input bar's own dock, next to the persona bar.
It answers one question the GUI otherwise hides: *what does this session actually
have available?* — as two independent marks:

| Mark | Source | Collapsed answer |
| --- | --- | --- |
| **skill** | `skills/list` (browser Remote) | How many human-invocable skills this session sees |
| **MCP** | `ctx.tools.schemas()` (this package's host half) | 已连接 / 未连接 — whether any MCP server has tools registered |

The chevron opens a **floating** detail panel (fixed, portalled to `<body>`) that
never pushes the page: it lists every skill with `/name`, `model+user` /
`user-only`, description and `whenToUse`; every **connected** MCP server with its
tool count; the configured MCP Loader rows separately, with their phase; whether
`dsh-mcp-resources` is mounted; and the profile's enabled plugin bundles. Refresh
and close live in the panel header; Escape and any click outside close it.

### 已连接 is real, and it refreshes itself

The browser has no MCP status Remote, so the earlier versions could only report
Loader enablement. That was not the question being asked. The observable fact is
the **tool registry**: an MCP server registers one tool per remote tool, named
`mcp__<server>__<tool>`, and a server that fails to connect registers **none**.

So this package ships a host half that reads `ctx.tools.schemas()`, groups the
names on that convention, and serves the per-server counts to the browser over its
own route.

The strip re-reads **every 15 seconds while the tab is visible**, and immediately
when the tab becomes visible again. A hidden tab spends no reads. The poll is
silent: it does not flip the row into a loading state, so the marks stay steady
and only change when the answer actually changes.

Three guards keep the poll from costing anything, each solving a different waste:

| Waste | Guard |
| --- | --- |
| Re-copying the whole tool catalog every tick | The host half caches the summary and drops it on `tools/change` — the exact invalidation, never a timer. A poll that changes nothing does no `schemas()` call at all. |
| Repainting identical data | `samePayload` compares the fields the strip renders; an unchanged poll returns the previous state object, so React schedules no render. |
| Stacking requests against a slow Host | An in-flight flag: a tick during a pending read returns immediately instead of starting a second one. |

`loadedAt` is deliberately excluded from the comparison — it always differs, and
including it would defeat the whole suppression. The panel shows the timestamp of
the payload currently on screen, which is the honest reading of "when was this
answer obtained".

Two honest limits, both stated in the panel:

- **It is a poll, not a push.** DSH does emit `tools/change` on the Host, but
  forwarding that event to the browser requires a Typert Remote Event declaration
  — considerably more machinery than a read-only strip justifies. The consequence
  is bounded: a dropped server shows up within one interval, not instantly.
- **A server that connects but exposes no tools counts as 未连接.** This is
  deliberate. `dsh-mcp-client` keeps its connection object (`ready`, `connectedAt`,
  the retry supervisor) private, so "connected with zero tools" and "never
  connected" register nothing and are indistinguishable from the outside. A server
  whose tools are unavailable is not usable either way, so the safe reading is
  未连接 — and that is what the strip reports.

### A fault interrupts the reader; an absence does not

MCP failing silently is the reason this plugin exists: the tools stop working, the
only trace goes to the Host log, and nothing in the GUI says so. So a **fault**
opens a dialog on its own, without being asked.

A fault is a precise shape, not merely "no tools":

| Situation | Mark | Dialog |
| --- | --- | --- |
| At least one server has tools registered | 已连接 | no |
| MCP configured and enabled, but nothing registered a tool | 连接故障 | **yes, once** |
| No MCP configured at all | 未连接 | no |
| Every MCP row disabled | 未连接 | no |
| The tool registry could not be read | 读取失败 | no |

The three exclusions matter as much as the trigger. Nagging about a feature nobody
configured, or about servers deliberately switched off, is noise — and noise gets a
plugin uninstalled, which would defeat the whole point. A failed registry read is
excluded because the strip genuinely cannot tell whether anything is wrong, and it
must not accuse on ignorance.

The dialog opens once per distinct fault (keyed on the affected server names), so
the 15-second poll cannot re-nag every tick, and clicking the red 连接故障 mark
re-opens it after dismissal. It names each affected server and its Loader phase,
and states plainly that the actual error is in the Host log — the one thing the
strip cannot show, said rather than glossed over.

### How the two halves talk

```
browser:  connection.rpc.call("api", "ability-strip", payload)
host:     connection.fetch.register({ path: "/api/ability-strip", methods: ["POST"] })
wire:     request  { type: "client-request",  rpcId, payload: { action, data } }
          response { type: "server-response", rpcId, result }
```

`rpc.call` builds a dedicated channel by reading `owner.webServer`, which newer
harness builds refuse, so the host half registers an **exact Fetch route** on the
shared `/api` carrier instead — the carrier mounts that route itself and applies
the same owner-only authentication. This is the same mechanism the community MCP
panels use. Nothing here depends on another plugin.

The two MCP packages are kept apart on purpose. `@deepseek-ai/dsh-mcp-client`
takes **one row per server**, so those rows are the configured server list.
`@deepseek-ai/dsh-mcp-resources` is mounted **once for all servers** and adds the
three resource-reading tools; counting it as a server would be wrong, but hiding
it entirely would hide whether configured servers can be read at all.

### Where it sits, and why it stays narrow

The strip registers into `conversation.composer.dock`, the input bar's own dock
element, which the bar renders **after** its input row. `conversation.input.dock`
would sit *above* the box instead: it is a child of the composer stack that the
input bar follows. Do not move it back.

That dock is a single flex row shared with other widgets (two session-stat
widgets, the persona bar, and the context meter on this machine). A `width: 100%`
claim there does not center anything — it forces the whole row to overflow and
drags every sibling with it while leaving the strip's own content off to one
side. Measured on this machine: a full-width claim occupied **555 px** of a 941 px
row for 361 px of content; sizing to content plus moving the refresh control into
the detail panel brought the collapsed strip to **284 px**, and the title-less
`skill N | MCP 有` redesign narrowed it further.

So: the wrapper is `flex: 0 1 auto` (content width), the collapse control is
icon-only with its label in `aria-label`/`title`, and the detail panel floats as
a fixed dialog portalled to `<body>`, so opening it changes no layout at all.
`justify-content: center` on the dock cannot centre the group — the row is
full — so the strip sits where the dock puts it.

## Read-only by construction

The browser half calls three read-only Remotes:

- `skills/list`
- `pluginInventory/list`
- `pluginManager/listBundles`

The host half makes one read of the tool registry (`ctx.tools.schemas()`) per
request. Nothing is registered, written, mutated, or persisted: no tool, no
setting, no config file, no state between requests. The only lifecycle object is
the Fetch route itself, which the effect disposes on unload.

## Known limitation (stated in the panel too)

- **Poll, not push.** 已连接 is re-read every 15 s while the tab is visible (and
  immediately on becoming visible). A server that drops right after a read keeps
  reading 已连接 until the next tick. Watching `tools/change` on the Host and
  forwarding it to the browser would remove that window, but it needs a Typert
  Remote Event declaration — a much larger change than this strip warrants.
- **Connected-but-zero-tools reads as 未连接.** The only evidence used is the
  registered tools. `dsh-mcp-client`'s connection object is private, so a server
  that connected successfully but exposes no tools is indistinguishable from one
  that never connected. Both are reported as 未连接, deliberately: a server whose
  tools are unavailable is not usable either way.
- **No connection detail.** When a server does fail, the reason is not in the
  registry — it goes to the Host log. The strip cannot show why.

The Loader row carries only `entryId`, `moduleName`, `meta`, `enabled`, and
`fiberPhase` — **no config** — so the configured `serverName` is not reachable
from the inventory. Connected servers are named from the tool registry instead,
which is why the panel can name them at all; the Loader rows keep their row id
(`mcp-local` on this machine).

## Install

Install from a tarball so the profile holds a **copy**, never a symlink: editing
this source tree afterwards cannot affect a running installation. The profile
currently runs **0.1.1**. **0.3.0** is the first version with a real host half
(host half reads the tool registry, `MCP 已连接/未连接`, floating panel) and is
**not installed yet** — it waits for review.

0.3.0 adds a host half that runs real code, so it is the first version where a
host-side reload is exercised: installing it makes the Loader load new host code,
not just a new browser bundle. That path has not been observed yet on this machine.

```sh
pnpm pack --pack-destination dist
node scripts/verify-pack.mjs dist/dsh-ability-strip-0.3.0.tgz
dsh plugin --profile web add "<abs path>/dist/dsh-ability-strip-0.3.0.tgz"
```

To ship a source change, rebuild and re-add:

```sh
cd <this directory>
pnpm check                       # must print RESULT: PASS
pnpm pack --pack-destination dist
node scripts/verify-pack.mjs dist/dsh-ability-strip-0.3.0.tgz
dsh plugin --profile web add "<abs path>/dist/dsh-ability-strip-0.3.0.tgz"
```

Keep `dist/` where it is — the profile records the tarball's absolute path, and a
later `pnpm install` in that profile needs the file to still exist. Upgrade is
pack + `add` again; remove is `dsh plugin --profile web remove dsh-ability-strip`.

`dsh plugin add` forwards to pnpm inside the profile and then appends the package
to `dsh.profile.bundles` automatically, because `package.json` declares
`dsh.bundle.patch` (see `reconcile` in the plugin manager). A package without
that field installs as a plain dependency and never loads.

Then **hard-refresh the page** (`Ctrl+F5`). The Host needs no restart: `dsh-hmr`
watches the profile manifest and recomposes the layers, but the browser caches
the client bundle by revision, so a reload is required.

### Why a `link:` install is unsafe here — measured, not assumed

`dsh-client-modules` caches each plugin's **absolute** client bundle path in
`pkgMeta`, keyed by `` `${baseUrl}\0${loaderName}` ``, and never invalidates it
(no `delete`/`clear` anywhere in the package). `captureArtifactBaseline()` then
stats that cached path to derive the revision, so the whole session keeps reading
the file recorded at the **first** resolution.

A `link:` install records the source directory as that path. Uninstalling,
reinstalling from a tarball, and editing the profile all leave the cache intact:
the host keeps serving the working tree until it restarts. This was observed
here — the boot graph served the source file's revision while the profile's copy
sat unread.

The fix that needs no restart is a **new package name**: a new specifier is a new
cache key, so the first resolution happens after the tarball is in the profile and
pins the copy instead. That is why this package is `dsh-ability-strip` and not the
earlier `dsh-runtime-inspector` identity.

### Why a tarball and not a directory / `link:`

verified against pnpm's documentation and DSH's own spec parser:

| Spec form | pnpm result | Parsed by DSH as |
| --- | --- | --- |
| `<abs path>.tgz` | extracted copy in the store | `tarball` |
| `<abs directory>` | **symlink**, same as `pnpm link` | `path` |
| `link:<abs directory>` | **symlink** | `path` |

pnpm's docs state it directly: installing from a directory "creates a symlink in
`node_modules`, equivalent to running `pnpm link`". A symlink means editing this
tree changes the live UI with no review step, so both non-tarball forms are
refused here on purpose.

## Files

| Path | Role |
| --- | --- |
| `cordis.patch.yml` | Inserts the Host row that carries this package into the Loader |
| `lib/index.js` | Host half: reads `ctx.tools.schemas()`, serves `/api/ability-strip` |
| `lib/client.js` | Browser half: the strip, in lazy-CJS `__ModuleLoader__` form |
| `scripts/` | The four verification checks (see below) |
| `dist/*.tgz` | The built install medium, not part of the package itself |

## Requirements

- DSH `>=0.2.0-rc.2` (declared as `engines.dsh`, enforced at install and startup)

`engines.dsh` matters: without it a DSH upgrade that changes the client slot API
would fail silently at runtime instead of refusing the install. No `engines.node`
is declared on purpose — this package adds no Node-version-specific Host code, and
DSH itself declares no Node range, so claiming one would be an unfounded
constraint.

Per the official manifest reference:

- `engines.dsh` decides alone; `peerDependencies` are ignored when it is present,
  and prereleases participate in range matching — which is why `>=0.2.0-rc.2`
  matches the running `0.2.1-rc.2`.
- `dsh.manifestVersion: 1` marks the manifest format (independent of the npm and
  Session versions).
- `dsh.bundle.patch` may be one path or an ordered list; this package uses one.
- An incompatible **bundle** is skipped at startup and listed in `skippedBundles`
  rather than crashing the app; an incompatible **tarball install** is judged
  after installation and then rolled back. Both are why the range is declared here
  instead of left absent.
- `dsh.client.external` is only for non-baseline module requests. This bundle
  imports `react` and `@deepseek-ai/dsh-client-ui-primitives`, both in the shell's
  static table, so no `external` entry is needed.

## Build

There is no build step. `lib/client.js` is authored directly in the lazy-CJS form
the module system expects — one `window.__ModuleLoader__.load({ id, factory })`
registration whose factory `require`s only baseline modules. The Host serves the
file as-is and derives its revision from mtime/size, so nothing has to be
compiled. The checks in `scripts/` are the safety net a compiler would otherwise
provide, and they run without a browser.

## Verification

No browser is involved. Four checks run against the real source:

```sh
node scripts/check-host.mjs              # mcp__ split, per-server summary, route contract
node scripts/check-bundle-contract.mjs   # loader registration + slot + inject contract
node scripts/check-render.mjs            # renders the strip across every display state
node scripts/verify-pack.mjs <tarball>   # tarball matches this tree, refs all present
pnpm check                               # the first three together
```

What each one pins down:

- **check-host** imports `lib/index.js` and pins the load-bearing assumption: the
  `mcp__<server>__<tool>` split, including a server name that itself contains
  `__` (split at the LAST separator) and rejection of non-MCP names. It then
  checks the summary shape, that a throwing registry becomes an `error` rather
  than a silent zero, that `apply()` registers exactly one POST route at
  `/api/ability-strip` answering the carrier's `client-request` envelope and
  rejecting an unparseable body with 400, and — the poll-cost guarantee — that a
  repeated read does **not** call `schemas()` again, that `tools/change` invalidates
  the cache exactly once, and that unloading drops both the route and the listener.
- **check-bundle-contract** evaluates `lib/client.js` against a stub
  `window.__ModuleLoader__`, then asserts the factory id equals the package name,
  that only baseline modules are required (`react`, `react-dom`,
  `@deepseek-ai/dsh-client-ui-primitives`), the exported `inject` list names every
  Remote and service actually read (`connection` included), and `apply()` registers
  exactly one component into `conversation.composer.dock` with an inject face
  exposing `load` and *not* shadowing the built-in `sessionId` prop.
- **check-render** builds the tree with a small hook runtime, stubs `document.body`
  and a `createPortal` recorder, and asserts the reader-visible text across every
  display state: first paint (pending, never a false verdict), loaded (`skill N`,
  `MCP 已连接`, no server ids printed), **a configured server with no registered
  tools reading 未连接** while still being listed as configured, expanded (a
  portalled panel carrying both sections' headings, skill `/name`, `whenToUse`,
  connected servers with tool counts, Loader phases, the resource-plugin line,
  bundles, refresh and close controls), no resource plugin, tool-registry failure
  (`读取失败`, never a silent 已连接/未连接), independent skills/bundles failures,
  empty-but-successful read (`未连接`), and a thrown load (the error must be
  visible). It also proves the collapsed state builds none of the detail trees,
  since the dock re-renders on every composer keystroke, and pins all three poll
  guards: a hidden tab spends no read, an unchanged poll keeps the same state
  object (no render), and a tick during an in-flight read starts nothing new.
  Each of those three is covered by a mutation: removing the guard makes the
  corresponding check fail.
- **The fault trigger has a mutation matrix of its own.** Every one of the three
  conditions is proven necessary by breaking it and watching the matching check
  fail: removing `tools.error` makes an unreadable registry pop the dialog,
  removing the enabled-row requirement makes an unconfigured profile pop it, and
  forcing "no servers" to false makes the real fault go unreported. The negative
  checks each run the full commit sequence, because a dialog that wrongly opened
  would otherwise never reach the stage where it is visible.
- **verify-pack** inflates the `.tgz` and compares every entry with this tree,
  comparing `package.json` by value because pnpm rewrites its formatting, and
  checks each `main` / `exports` / `files` / `dsh.bundle.patch` reference actually
  exists inside the payload.

These catch what `node --check` cannot: an undefined identifier, a wrong slot
name, a Remote read without the matching inject declaration, and a tool-name split
that disagrees with the MCP client's own convention.

## Verification status

- All four checks pass on the current tree (run them; the output is the evidence).
- **Not yet verified on a running Host**: the 0.3.0 host half has never been
  loaded by a live Loader on this machine, so the route registration and the
  browser→host call are covered only by the stubbed contract checks above. Install
  and a page refresh are what would confirm them.
- Earlier versions were exercised in the live Web GUI: the strip renders inside
  `[data-composer-dock]` below the editor, and the served bundle's revision equals
  the installed copy's `artifactRevision`, not this source tree's — the measurement
  that proves the code under `lib/` is no longer what the page runs.
