# Requirements Traceability Matrix

## Purpose

This matrix connects the product use cases to the normative requirements, source capability evidence, safety invariants, architecture allocations, and planned acceptance evidence. Requirement text remains authoritative in the [SRS](srs.md); this document records why each group exists and how it will be proven.

## Functional Traceability

| Requirement IDs | PRD use cases | Capability basis | Safety basis | Planned evidence |
| --- | --- | --- | --- | --- |
| SRS-FR-001 through 006 | UC-001 through UC-011 | NEW-001, SRC-043 | SAFE-001, SAFE-005, SAFE-007 | Authorization unit/contract tests; cross-project denial tests; audit assertions |
| SRS-FR-007 through 013 | UC-001, UC-002, UC-006 | SRC-003, SRC-004, SRC-006, NEW-001, NEW-002 | SAFE-002, SAFE-003, SAFE-007, SAFE-016, SAFE-027 | Catalog contract tests; quota preflight tests; fail-closed provider-profile tests |
| SRS-FR-014 through 017 | UC-002, UC-005 through UC-009, UC-011, UC-014 | SRC-038, NEW-004 | SAFE-008, SAFE-009 | Same-key/same-body and same-key/different-body integration tests |
| SRS-FR-018 through 023 | UC-002, UC-003, UC-011, UC-013 | SRC-022, SRC-023, SRC-031, NEW-004, NEW-006, NEW-008 | SAFE-011, SAFE-014, SAFE-017, SAFE-032, SAFE-033 | Transaction tests; API contract tests; operation projection and redaction tests |
| SRS-FR-024 through 031 | UC-002 | SRC-002, SRC-003, SRC-007 through SRC-009, SRC-033, NEW-002, NEW-012 | SAFE-002 through SAFE-005, SAFE-016, SAFE-023 through SAFE-027 | Fake-provider create E2E; catalog-forgery tests; lease-race and late-collision tests |
| SRS-FR-032 through 036 | UC-002, UC-003, UC-011 | SRC-023, SRC-025, NEW-006, NEW-007 | SAFE-014 through SAFE-022 | Worker-kill resume; provider timeout/late-success; compensation ownership tests |
| SRS-FR-037, 038 | UC-004, UC-010 | SRC-010, SRC-019, SRC-039, SRC-040, NEW-007 | SAFE-001, SAFE-004, SAFE-029 | Query contract tests; desired/observed/drift projection integration tests |
| SRS-FR-039, 040 | UC-005 | SRC-012, SRC-024 | SAFE-008 through SAFE-010, SAFE-014 through SAFE-018 | Power action contract/E2E tests; duplicate and already-satisfied cases |
| SRS-FR-041 through 045 | UC-006 | SRC-014, SRC-015, SRC-024 | SAFE-010, SAFE-016, SAFE-026, SAFE-027 | Quota and shrink rejection tests; concurrent mutation tests; provider adapter tests |
| SRS-FR-046 through 050 | UC-007 | SRC-016, SRC-024 | SAFE-001, SAFE-006, SAFE-008 through SAFE-010 | Snapshot ownership, quota, duplicate, rollback, and deletion tests |
| SRS-FR-051 through 056 | UC-008, UC-009 | SRC-026, SRC-030 | SAFE-004 through SAFE-007, SAFE-018, SAFE-021, SAFE-028, SAFE-029 | Soft-delete E2E; retention clock; purge ownership mismatch and unknown-outcome tests |
| SRS-FR-057 through 059 | UC-002, UC-011, UC-012 | NEW-003 through NEW-005 | SAFE-011 through SAFE-013, SAFE-033 | Database/Kafka outage test; envelope schema test; per-instance ordering test |
| SRS-FR-060, 061 | UC-002, UC-011 | SRC-038, NEW-004 | SAFE-012, SAFE-015 | Inbox transaction tests; 100-event duplicate injection |
| SRS-FR-062 through 065 | UC-003, UC-011 | SRC-022 through SRC-025, NEW-006 | SAFE-014 through SAFE-022 | Checkpoint tests; worker termination; retry classification and exhaustion tests |
| SRS-FR-066, 067 | UC-011 | NEW-003, NEW-006 | SAFE-008, SAFE-012, SAFE-017, SAFE-033 | Poison-event test; dead-letter record contract; authorized replay audit test |
| SRS-FR-068 | UC-003, UC-004 | SRC-039, NEW-003 | SAFE-012, SAFE-013 | Duplicate/out-of-order projection tests |
| SRS-FR-069 through 074 | UC-004, UC-010, UC-011 | SRC-019, SRC-035, SRC-039, SRC-040, NEW-007 | SAFE-018, SAFE-021, SAFE-029 | Drift fixtures; late-success completion; missing/ambiguous resource; destructive-call negative assertions |
| SRS-FR-075 through 078 | UC-012, UC-013 | SRC-031, NEW-008, NEW-009 | SAFE-031 through SAFE-034 | Captured create trace; correlated log query; metric label/cardinality tests |
| SRS-FR-079 | UC-011, UC-012 | SRC-048, NEW-011 | SAFE-030 | Liveness/readiness behavior under dependency failure |
| SRS-FR-080, 081 | UC-011, UC-012 | NEW-009, NEW-010 | SAFE-030, SAFE-034 | KEDA backlog test; provider semaphore assertion; alert-rule tests and drills |
| SRS-FR-082 through 086 | UC-014 | NEW-013, NEW-014 | SAFE-008, SAFE-009, SAFE-017, SAFE-035 | DynamoDB transaction test; duplicate stream and partial-batch tests |
| SRS-FR-087 through 090 | UC-014 | NEW-014 | SAFE-017, SAFE-031, SAFE-035, SAFE-036 | SQS poison/redrive; watchdog; S3 archive; CloudWatch alarm tests |
| SRS-FR-091 | UC-014 | AWS boundary decision | SAFE-017, SAFE-030 | Architecture policy test and deployment inventory review |

## Non-Functional Traceability

| Requirement IDs | Product measure or risk | Architecture allocation | Planned evidence |
| --- | --- | --- | --- |
| SRS-NFR-001, 002 | SM-REL-001; Kafka outage | SRS-ARC-001, SRS-ARC-002 | 30-minute broker outage with accepted-command/outbox/Kafka reconciliation counts |
| SRS-NFR-003, 004 | SM-REL-002; duplicate mutation | SRS-ARC-003 | 100-request and 100-event duplicate suites with provider-resource count assertion |
| SRS-NFR-005 | SM-REL-003; worker loss | SRS-ARC-003, SRS-ARC-004 | Kill during task poll, restart, checkpoint resume, provider submission count assertion |
| SRS-NFR-006 through 008 | Partial commit, timeout, and clock-ordering risks | SRS-ARC-001 through 003 | Transaction rollback tests; timeout tests; timestamp and duration review |
| SRS-NFR-009, 010 | SM-PERF-001, SM-PERF-002 | Fake provider; load-test harness | k6 report at 1,000 VUs and ramp toward 2,000 VUs |
| SRS-NFR-011 through 013 | Payload growth, provider overload, ambiguous latency | Kafka/event contracts; KEDA/provider limiter | Size-boundary tests; KEDA/provider cap drill; separate latency dashboards |
| SRS-NFR-014 through 016 | External interception, excess privilege, unsafe defaults | Existing Gateway/TLS; live repo RBAC/secrets; provider profile | TLS probe; policy review; least-privilege test; fail-closed startup tests |
| SRS-NFR-017, 018 | Secret and provider-detail leakage | Shared redaction and observability boundary | Secret canary tests across responses/events/logs/traces/metrics; bounded error tests |
| SRS-NFR-019, 020 | Unattributed recovery and long-lived AWS credentials | Audit events; CI OIDC; temporary hybrid identity | Audit assertions; credential inventory; absence-of-static-key scan |
| SRS-NFR-021 through 024 | SM-OPS-001 through 003; telemetry outage | OpenTelemetry package and collector deployment | Trace/log correlation capture; cardinality checks; collector outage drill |
| SRS-NFR-025, 026 | SM-OPS-004, SM-OPS-005; evidence quality | Alert/runbook ownership in live repo | Rule tests; drill links; report review separating targets and results |
| SRS-NFR-027 through 029 | Provider coupling and contract drift | SRS-ARC-004; contracts and provider SDK packages | Dependency-boundary tests; OpenAPI/protobuf/event compatibility gates |
| SRS-NFR-030, 031 | Regression and documentation drift | Application repository quality gates | Coverage map; documentation link/diagram/requirement validation |
| SRS-NFR-032 through 034 | SM-DEL-001, SM-DEL-002; unreproducible runtime | Separate live GitOps repository | Render/schema/policy checks; Argo sync record; immutable digest proof |
| SRS-NFR-035, 036 | SM-AWS-001, SM-AWS-004; cost/security drift | SRS-ARC-008, SRS-ARC-009 | Terraform validate/plan/apply/destroy; AWS Config/API verification artifacts |
| SRS-NFR-037 | Required resilience evidence | All reliability allocations | Versioned failure report covering every named drill |
| SRS-NFR-038 | Live-provider safety | Fake provider plus lab boundary | Load config asserts fake provider; live operation counter and cap evidence |

## Architecture Constraint Traceability

| Constraint | Decision topic | Requirements primarily served |
| --- | --- | --- |
| SRS-ARC-001 | PostgreSQL and DynamoDB ports | SRS-FR-025, SRS-FR-060, SRS-FR-062, SRS-FR-083; SRS-NFR-006 |
| SRS-ARC-002 | Debezium outbox | SRS-FR-057; SRS-NFR-001, SRS-NFR-002 |
| SRS-ARC-003 | Kafka at-least-once semantics | SRS-FR-058 through 068; SRS-NFR-003 through 005 |
| SRS-ARC-004 | Four deployables | SRS-FR-020, SRS-FR-057, SRS-FR-062, SRS-FR-069, SRS-FR-075 |
| SRS-ARC-005 | Explicit placement | SRS-FR-008, SRS-FR-011, SRS-FR-013, SRS-FR-029 |
| SRS-ARC-006 | Soft deletion | SRS-FR-051 through 056 |
| SRS-ARC-007 | Non-destructive reconciliation | SRS-FR-069 through 074 |
| SRS-ARC-008 | DynamoDB alternate port | SRS-FR-082 through 090; SRS-NFR-035, SRS-NFR-036 |
| SRS-ARC-009 | AWS reference boundary | SRS-FR-082 through 091 |

## Coverage Check

- PRD use cases traced: UC-001 through UC-014
- Functional requirements traced: SRS-FR-001 through SRS-FR-091
- Non-functional requirements traced: SRS-NFR-001 through SRS-NFR-038
- Architecture constraints traced: SRS-ARC-001 through SRS-ARC-009
- Safety invariants referenced: SAFE-001 through SAFE-036

Detailed test case identifiers will be added when contracts and test suites are created. Until then, the planned-evidence column defines the acceptance obligation rather than claiming completed verification.
