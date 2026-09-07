# Diagram Workflow

This directory contains the canonical architecture-diagram sources and the rendered artifacts embedded by the documentation. The repository uses Mermaid for sequence and state models, and Draw.io for views that need C4 shapes, infrastructure icons, trust zones, or manual routing.

## Artifact Layout

| Path                     | Purpose                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `mermaid/*.mmd`          | Authoritative, diffable sequence and state-machine sources                   |
| `specs/*.json`           | Structured topology inputs used to establish repeatable Draw.io layouts      |
| `src/*.drawio`           | Authoritative editable C4, trust-boundary, and architecture-journey diagrams |
| `rendered/*.mermaid.svg` | Scalable Mermaid exports embedded by architecture documents                  |
| `rendered/*.drawio.png`  | Embedded Draw.io PNGs for compact views                                      |
| `rendered/*.drawio.svg`  | Embedded Draw.io SVGs for large views that require lossless zoom             |

Rendered artifacts are derived files. Change the matching `.mmd` or `.drawio` source first, validate it, regenerate the render, and inspect the result before committing both files.

## Diagram Inventory

| Documentation view              | Canonical source                             | Rendered artifact                                     |
| ------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| C4 system context               | `src/c4-model.drawio` page 1                 | `rendered/c4-system-context.drawio.png`               |
| C4 container view               | `src/c4-model.drawio` page 2                 | `rendered/c4-containers.drawio.svg`                   |
| Trust boundaries                | `src/trust-boundaries.drawio`                | `rendered/trust-boundaries.drawio.png`                |
| Create-instance request journey | `src/create-instance-request-journey.drawio` | `rendered/create-instance-request-journey.drawio.png` |
| Monorepo dependency boundaries  | `src/monorepo-boundaries.drawio`             | `rendered/monorepo-boundaries.drawio.svg`             |
| Contract communication          | `mermaid/contract-communication.mmd`          | `rendered/contract-communication.mermaid.svg`          |
| Fake-provider outcomes          | `mermaid/fake-provider-outcomes.mmd`          | `rendered/fake-provider-outcomes.mermaid.svg`          |
| Continuous-integration gates    | `mermaid/ci-quality-gates.mmd`                | `rendered/ci-quality-gates.mermaid.svg`                |
| Create-instance success         | `mermaid/create-instance-success.mmd`        | `rendered/create-instance-success.mermaid.svg`        |
| Kafka unavailable               | `mermaid/kafka-unavailable.mmd`              | `rendered/kafka-unavailable.mermaid.svg`              |
| Provider timeout                | `mermaid/provider-timeout.mmd`               | `rendered/provider-timeout.mermaid.svg`               |
| Duplicate message               | `mermaid/duplicate-message.mmd`              | `rendered/duplicate-message.mermaid.svg`              |
| Configuration compensation      | `mermaid/configuration-compensation.mmd`     | `rendered/configuration-compensation.mermaid.svg`     |
| Instance lifecycle              | `mermaid/instance-lifecycle.mmd`             | `rendered/instance-lifecycle.mermaid.svg`             |
| Desired power state             | `mermaid/desired-power-state.mmd`            | `rendered/desired-power-state.mermaid.svg`            |
| Observed provider state         | `mermaid/observed-provider-state.mmd`        | `rendered/observed-provider-state.mermaid.svg`        |
| Operation lifecycle             | `mermaid/operation-lifecycle.mmd`            | `rendered/operation-lifecycle.mermaid.svg`            |
| Phase 3 components              | `mermaid/phase-3-components.mmd`             | `rendered/phase-3-components.mermaid.svg`             |
| Phase 3 synchronous create      | `mermaid/phase-3-synchronous-create.mmd`     | `rendered/phase-3-synchronous-create.mermaid.svg`     |
| Phase 3 checkpoint recovery     | `mermaid/phase-3-checkpoint-recovery.mmd`    | `rendered/phase-3-checkpoint-recovery.mermaid.svg`    |
| Phase 3 workflow stages         | `mermaid/phase-3-workflow-stages.mmd`        | `rendered/phase-3-workflow-stages.mermaid.svg`        |
| Phase 4 runtime components      | `mermaid/phase-4-components.mmd`             | `rendered/phase-4-components.mermaid.svg`             |
| Phase 4 monorepo boundaries     | `mermaid/phase-4-monorepo-boundaries.mmd`    | `rendered/phase-4-monorepo-boundaries.mermaid.svg`    |
| Phase 4 event journey           | `mermaid/phase-4-event-journey.mmd`          | `rendered/phase-4-event-journey.mermaid.svg`          |
| Phase 4 CDC routing             | `mermaid/phase-4-cdc-routing.mmd`            | `rendered/phase-4-cdc-routing.mermaid.svg`            |
| Phase 4 checkpoint recovery     | `mermaid/phase-4-checkpoint-recovery.mmd`    | `rendered/phase-4-checkpoint-recovery.mermaid.svg`    |
| Phase 4 failure recovery        | `mermaid/phase-4-failure-recovery.mmd`       | `rendered/phase-4-failure-recovery.mermaid.svg`       |
| Phase 4 retry exhaustion        | `mermaid/phase-4-retry-exhaustion.mmd`       | `rendered/phase-4-retry-exhaustion.mermaid.svg`       |
| Phase 4 dead-letter path        | `mermaid/phase-4-dead-letter.mmd`            | `rendered/phase-4-dead-letter.mermaid.svg`            |
| Phase 4 governed replay         | `mermaid/phase-4-replay.mmd`                 | `rendered/phase-4-replay.mermaid.svg`                 |
| Phase 4 telemetry pipeline      | `mermaid/phase-4-telemetry-pipeline.mmd`     | `rendered/phase-4-telemetry-pipeline.mermaid.svg`     |
| Phase 4 metric flow             | `mermaid/phase-4-metric-flow.mmd`            | `rendered/phase-4-metric-flow.mermaid.svg`            |
| Phase 4 trace hierarchy         | `mermaid/phase-4-trace-hierarchy.mmd`        | `rendered/phase-4-trace-hierarchy.mermaid.svg`        |
| Phase 5 capability stages       | `mermaid/phase-5-capability-stages.mmd` | `rendered/phase-5-capability-stages.mermaid.svg` |
| Phase 5 purge guards            | `mermaid/phase-5-purge-guards.mmd`     | `rendered/phase-5-purge-guards.mermaid.svg`   |
| Phase 5 reconciliation sweep    | `mermaid/phase-5-reconciliation-sweep.mmd` | `rendered/phase-5-reconciliation-sweep.mermaid.svg` |
| Phase 6 sync waves              | `mermaid/phase-6-sync-waves.mmd`       | `rendered/phase-6-sync-waves.mermaid.svg`     |
| Phase 6 blue-green promotion    | `mermaid/phase-6-bluegreen-promotion.mmd` | `rendered/phase-6-bluegreen-promotion.mermaid.svg` |
| Phase 6 analysis gate           | `mermaid/phase-6-analysis-gate.mmd`    | `rendered/phase-6-analysis-gate.mermaid.svg`  |
| Phase 6 network boundaries      | `mermaid/phase-6-network-boundaries.mmd` | `rendered/phase-6-network-boundaries.mermaid.svg` |
| Phase 6 operations lifecycle    | `mermaid/phase-6-operations-lifecycle.mmd` | `rendered/phase-6-operations-lifecycle.mermaid.svg` |
| Phase 6 image supply chain      | `mermaid/phase-6-image-supply-chain.mmd` | `rendered/phase-6-image-supply-chain.mermaid.svg` |
| Phase 6 token acquisition       | `mermaid/phase-6-token-acquisition.mmd` | `rendered/phase-6-token-acquisition.mermaid.svg` |
| Phase 6 API request path        | `mermaid/phase-6-api-request-path.mmd` | `rendered/phase-6-api-request-path.mermaid.svg` |
| Phase 6 manifest map            | `mermaid/phase-6-manifest-map.mmd`     | `rendered/phase-6-manifest-map.mermaid.svg`   |

## Mermaid Editing And Validation

Use Mermaid CLI when available:

```bash
npm install -g @mermaid-js/mermaid-cli

source=docs/diagrams/mermaid/operation-lifecycle.mmd
rendered=docs/diagrams/rendered/operation-lifecycle.mermaid.svg

# Validate to a disposable artifact first.
mmdc -i "$source" -o /tmp/operation-lifecycle.svg --backgroundColor white

# Export only after validation succeeds.
mmdc -i "$source" -o "$rendered" --backgroundColor white
```

Kroki is the no-install fallback:

```bash
source=docs/diagrams/mermaid/operation-lifecycle.mmd

curl --fail --silent --show-error \
  -X POST -H 'Content-Type: text/plain' --data-binary "@$source" \
  https://kroki.io/mermaid/svg \
  -o /tmp/operation-lifecycle.svg
```

Keep asynchronous arrows, failure arrows, `loop`, `alt`/`else`, and state-transition guards in the Mermaid source. Inspect every exported SVG in a browser at both fit-to-page and full zoom.

## Draw.io Editing And Validation

1. Open the relevant file from `src` in Draw.io or diagrams.net.
2. Preserve native C4, Kubernetes, AWS, database, queue, and security shapes.
3. Keep trust zones, relationship direction, and routing consistent with the surrounding architecture document.
4. Validate the editable source before export.
5. Export with embedded diagram data and inspect the rendered result at full size.

Set the local skill path once:

```bash
export DRAWIO_SKILL="${DRAWIO_SKILL:-$HOME/.agents/skills/drawio-skill}"
```

Validate a source:

```bash
python3 "$DRAWIO_SKILL/scripts/validate.py" --score \
  docs/diagrams/src/c4-model.drawio
```

Export the compact C4 context view as an embedded PNG:

```bash
drawio -x -f png -e --page-index 1 --width 1800 -b 24 \
  -o docs/diagrams/rendered/c4-system-context.drawio.png \
  docs/diagrams/src/c4-model.drawio

python3 "$DRAWIO_SKILL/scripts/repair_png.py" \
  docs/diagrams/rendered/c4-system-context.drawio.png
```

Export the large C4 container view as an embedded vector SVG:

```bash
drawio -x -f svg -e --page-index 2 -b 24 \
  -o docs/diagrams/rendered/c4-containers.drawio.svg \
  docs/diagrams/src/c4-model.drawio
```

For draft review, omit `-e` and export a width-capped PNG to a temporary path. Keep the container view as SVG in documentation because a fixed-resolution raster makes its dense labels unreadable when zoomed.
