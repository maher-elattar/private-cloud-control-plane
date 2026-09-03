# Console design system

The console's visual language is a port of a production cloud console's design system. The token
values in `src/styles.css` were **read off the live product's `:root` custom properties**, not
sampled from screenshots, so colours, spacing, and layout widths are exact rather than approximate.

## Provenance

| Token                   | Value              | Notes                                                   |
| ----------------------- | ------------------ | ------------------------------------------------------- |
| `--color-primary`       | `hsl(350 89% 44%)` | Brand red; hover `52%`, disabled `74%`                  |
| `--color-text`          | `hsl(0 0% 22%)`    | Muted `35%`, disabled `54%`, faint `72%`                |
| `--color-canvas`        | `hsl(0 0% 96%)`    | Page background; cards are `#fff`                       |
| `--color-border`        | `hsl(0 0% 91%)`    | Form borders are one step darker at `86%`               |
| `--font-sans`           | Inter              | 16px base, self-hosted via `@fontsource-variable/inter` |
| `--spacing-nav`         | `14rem`            | Left navigation rail                                    |
| `--spacing-stepper-nav` | `20rem`            | Create-wizard order summary                             |
| `--spacing-card`        | `2rem`             | Card and modal padding                                  |

Disabled primary buttons use a **lighter red**, not grey. That is deliberate: an unavailable
primary action stays recognisably the primary action instead of being demoted to a neutral colour.

## What is deliberately not copied

The reference product's **wordmark, logo, and brand name are not reproduced**. Only the layout
grammar and token system are ported; the product mark in `shell/top-bar.tsx` is this project's own.

Location flags are **inline SVG** (`components/flags.tsx`), not emoji. Regional-indicator
sequences have no glyph in the default font stack on most Linux systems, where `🇫🇮` degrades to
the bare letters `FI` and the location pickers stop being scannable.

## Structure

- `components/` — primitives (`Button`, `Badge`, `Card`, `Callout`, `EmptyState`, `TabBar`,
  `ProgressBar`, `Checkbox`, `TextField`), overlays (`Modal`, `InfoModal`, `CodeBlock`,
  `ToastStack`, `Spinner`), menus (`ContextMenu`, `GroupedSelect`), `Flag`, the `ImageTable`, and
  the wizard `StepperStep`. Extend a primitive rather than re-styling ad hoc in a route.
  - `InfoModal` is a `Modal` with no action bar — for a result the user only acknowledges, where
    a Cancel button would imply the action could still be undone.
  - `GroupedSelect` is a button plus panel rather than a native `<select>`, because its options
    carry a leading glyph — a country flag, or a server's status dot — that a native `<option>`
    cannot render.
- `shell/` — top bar, incident strip, navigation rail. The page never scrolls; the content column
  owns its scrollbar so the wizard's order summary stays usable.
- `routes/servers/` — list, create wizard, the 14-tab server detail, and the VNC console.
- `routes/sections.tsx` — navigation entries with no endpoint behind them yet. Their actions are
  intentionally disabled; see below.
- `data/` — view models, static catalog, API client, and console state.

## Relationship to the control-plane API

Wired to `packages/contracts/openapi/control-plane.v1.yaml`:

| Screen                               | Operation                                                               |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Servers list                         | `listInstances`                                                         |
| Wizard catalog                       | `listFlavors`, `listImages`, `listNetworks`                             |
| Create & Buy now                     | `createInstance` with an `Idempotency-Key`                              |
| Provisioning progress, activity feed | `listOperations`, `getOperation`                                        |
| Power toggle, Rescale                | `mutateInstance`                                                        |
| Snapshots tab                        | `listSnapshots`, `createSnapshot`, `rollbackSnapshot`, `deleteSnapshot` |

**Stubbed, because the contract has no endpoint for them:** Volumes, Load Balancers, Networks, DNS,
Object Storage, Storage Boxes, Placement groups, Backups, and Floating IPs. These render the
standard empty state with a disabled action rather than a control that would fail on click.

Backups and Floating IPs are the two exceptions that are **fully built against local state** rather
than left inert, because both carry pricing and multi-step flows worth reviewing before an endpoint
exists. Neither survives a `localStorage` clear, and both need an API before they mean anything.

`data/api.ts` degrades to `null` when the control API is unreachable, so the console renders
against `data/catalog.ts` for design review and offline development. That is why `pnpm exec vite`
alone produces a fully explorable UI.

## Billing confirmations

Any action that starts recurring billing goes through a `Modal` before it takes effect — enabling
backups, taking a snapshot. The modal blurs the page behind it rather than only dimming it, so a
charge confirmation cannot be misread as part of the page underneath, and it always names the
price. Enabling backups quotes the computed monthly figure, not just the percentage.

## Server console

`/console/:id` renders outside the shell — no top bar, no navigation — because it is launched into
its own window and the framebuffer should own the viewport. Below it sits a dark bar
(`--color-console--background`) carrying identity and addresses plus the two controls that cannot
be sent through the guest: display mode and Ctrl+Alt+Del.

The framebuffer itself is a **local placeholder**. Attaching a real one means pointing a VNC client
at a provider websocket endpoint, and the control plane exposes none today, so the chrome is built
and the transport is deliberately left unattached.

## Floating IPs

A floating IP belongs to the project, not to a server, which is why it gets its own section instead
of living under a server's addresses. Two consequences shape the UI:

- **Assignment is edited inline in the table cell**, not in a dialog. It is one choice from a short
  list, and keeping it in the row preserves the surrounding context — which address, which zone.
- **Only servers in the same network zone are offered.** The select is filtered rather than showing
  ineligible servers and rejecting the choice afterwards.

Assigning routes the address but does not configure it on the guest, so the flow ends in an
`InfoModal` carrying the `ip addr add` command in a click-to-copy `CodeBlock`, and says plainly that
a temporary configuration does not survive a reboot. Stopping at "assigned" would leave the user
with an address that silently does not work.

The server's **Networking** tab presents the same data from the server's side across five cards —
public network, private network, floating IPs, and the two traffic directions — so an address
attached here shows up there without the user having to reconcile two lists.

## Async provisioning

Creation does not block. A new instance appears immediately in a `provisioning` state, its list row
shows a determinate progress bar in place of the created-at column, and the activity feed fills in
as it converges — mirroring how the control plane actually commits intent before the resource
exists. Without a backend attached, `data/store.tsx` simulates that progression so the behaviour
stays visible during review. Snapshot and backup creation use the same treatment: the row appears
immediately with a progress bar in its status cell and settles to `Available`.

Mock state is mirrored into `localStorage`. That is not decoration — the server console opens in a
separate window, so purely in-memory state would leave that window looking at an empty project,
and a reload would discard everything mid-review. Clear the `console-web:state:v1` key to reset.

## Running

```bash
pnpm exec nx serve console-web     # http://localhost:4200, proxies /v1 to localhost:3000
CONTROL_API_URL=http://host:port pnpm exec nx serve console-web
```
