# Draw.io Diagram Workflow

This directory contains the editable architecture diagrams and the rendered images embedded by the documentation.

## Artifact Layout

| Path | Purpose |
| --- | --- |
| `specs/*.json` | Structured topology and sequence inputs used to establish repeatable base layouts |
| `src/*.drawio` | Authoritative editable diagrams, including reviewed shape, routing, and failure-arrow refinements |
| `rendered/*.drawio.png` | Documentation images with the Draw.io XML embedded for direct editing |

The editable `src` artifact is authoritative. A generator input is a layout aid, not permission to overwrite a reviewed diagram without comparing the result. This matters for sequence diagrams whose crossed failure messages are refinements beyond the base sequence generator.

## Diagram Inventory

| Documentation view | Editable source | Rendered image |
| --- | --- | --- |
| C4 system context and container view | `src/c4-model.drawio` | `rendered/c4-system-context.drawio.png`, `rendered/c4-containers.drawio.png` |
| Trust boundaries | `src/trust-boundaries.drawio` | `rendered/trust-boundaries.drawio.png` |
| Create-instance success | `src/create-instance-success.drawio` | `rendered/create-instance-success.drawio.png` |
| Kafka unavailable | `src/kafka-unavailable.drawio` | `rendered/kafka-unavailable.drawio.png` |
| Provider timeout | `src/provider-timeout.drawio` | `rendered/provider-timeout.drawio.png` |
| Duplicate message | `src/duplicate-message.drawio` | `rendered/duplicate-message.drawio.png` |
| Configuration compensation | `src/configuration-compensation.drawio` | `rendered/configuration-compensation.drawio.png` |
| Instance lifecycle | `src/instance-lifecycle.drawio` | `rendered/instance-lifecycle.drawio.png` |
| Desired power state | `src/desired-power-state.drawio` | `rendered/desired-power-state.drawio.png` |
| Observed provider state | `src/observed-provider-state.drawio` | `rendered/observed-provider-state.drawio.png` |
| Operation lifecycle | `src/operation-lifecycle.drawio` | `rendered/operation-lifecycle.drawio.png` |

## Editing And Validation

1. Open the relevant file from `src` in Draw.io or diagrams.net.
2. Preserve native C4, UML, Kubernetes, AWS, database, queue, and security shapes. Do not substitute a cloud-provider icon for a different runtime.
3. Keep trust zones, state colors, failure arrows, and relationship direction consistent with the surrounding architecture document.
4. Validate the editable source before export.
5. Export an embedded PNG, repair its metadata when necessary, and inspect the rendered image at full size.

Set the local skill path once:

```bash
export DRAWIO_SKILL="${DRAWIO_SKILL:-$HOME/.agents/skills/drawio-skill}"
```

Validate a source:

```bash
python3 "$DRAWIO_SKILL/scripts/validate.py" --score \
  docs/diagrams/src/operation-lifecycle.drawio
```

Export and repair a single-page diagram:

```bash
drawio -x -f png -e --width 2000 -b 24 \
  -o docs/diagrams/rendered/operation-lifecycle.drawio.png \
  docs/diagrams/src/operation-lifecycle.drawio

python3 "$DRAWIO_SKILL/scripts/repair_png.py" \
  docs/diagrams/rendered/operation-lifecycle.drawio.png
```

The C4 source is multi-page. Export its pages explicitly:

```bash
drawio -x -f png -e -p 1 --width 1800 -b 24 \
  -o docs/diagrams/rendered/c4-system-context.drawio.png \
  docs/diagrams/src/c4-model.drawio

drawio -x -f png -e -p 2 --width 1800 -b 24 \
  -o docs/diagrams/rendered/c4-containers.drawio.png \
  docs/diagrams/src/c4-model.drawio
```

For draft review, omit `-e` and export to a temporary path. Do not replace a documentation image until labels, boundaries, arrows, and icons have been visually checked.
