# Diagram Sources

The `.d2` files in this directory are the authoritative diagram sources. Their rendered `.svg` files are committed beside them so repository viewers can display the diagrams without a D2 plugin.

## Inventory

| Group | Diagram | Source |
| --- | --- | --- |
| C4 | System context | [system-context.d2](c4/system-context.d2) |
| C4 | Container view | [container-view.d2](c4/container-view.d2) |
| Security | Trust boundaries | [trust-boundaries.d2](security/trust-boundaries.d2) |
| Sequence | Create-instance success | [create-instance-success.d2](sequences/create-instance-success.d2) |
| Sequence | Kafka unavailable after acceptance | [kafka-unavailable.d2](sequences/kafka-unavailable.d2) |
| Sequence | Provider timeout and unknown outcome | [provider-timeout.d2](sequences/provider-timeout.d2) |
| Sequence | Duplicate Kafka delivery | [duplicate-message.d2](sequences/duplicate-message.d2) |
| Sequence | Configuration failure and compensation | [configuration-compensation.d2](sequences/configuration-compensation.d2) |
| State | Instance lifecycle | [instance-lifecycle.d2](states/instance-lifecycle.d2) |
| State | Desired power | [desired-power.d2](states/desired-power.d2) |
| State | Observed provider state | [observed-provider.d2](states/observed-provider.d2) |
| State | Operation lifecycle | [operation-lifecycle.d2](states/operation-lifecycle.d2) |

## Render

Prerequisites:

- D2 CLI `0.8.1` or a compatible later release
- Network access when a source contains a Terrastruct icon URL

Render every source from the repository root:

```bash
./docs/diagrams/render.sh
```

The script fails on the first invalid source and replaces only the corresponding generated SVG. Review both source and rendered output in the same change.

## Visual Language

| Color | Meaning |
| --- | --- |
| Teal | Control-plane application or active execution |
| Blue | Durable state, normal pending state, or existing edge platform |
| Purple | Messaging, retained state, retry, or compensation |
| Red | Privileged provider boundary, conclusive failure, or destructive risk |
| Amber | Human actor, degraded state, ambiguity, or manual review |
| Green | Verified success or observability path |
| Orange | AWS reference-slice service |

Icons must come from the validated Terrastruct catalog and remain reachable during rendering. When no validated reachable icon exists, use a native D2 shape rather than an unverified asset.
