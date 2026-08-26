# Phase 3 API implementation

Phase 3 exposes the synchronous acceptance and readback subset of the versioned public contracts. The wider OpenAPI and protobuf surfaces remain compatibility commitments for later lifecycle phases; an operation listed in the generated contract is not necessarily active in this phase.

## Authentication and request context

REST calls use an OIDC access token in `Authorization: Bearer <token>`. gRPC calls carry the same value in `authorization` metadata. The control API validates the RS256 signature against the configured remote JWKS, issuer, audience, subject, `roles`, and `projects` claims. A caller must have the `tenant_developer` role and a project grant matching the requested project.

| Input | REST location | gRPC location | Rule |
| --- | --- | --- | --- |
| Project ID | Path | `context.project_id` | UUID and present in the caller's `projects` claim |
| Idempotency key | `Idempotency-Key` header | `context.idempotency_key` | Required for mutation acceptance; bound to the canonical request body and actor |
| Correlation ID | `Correlation-Id` header | `context.correlation_id` | Optional UUID; generated when omitted |
| Trace context | `traceparent` header | `traceparent` metadata | Optional W3C traceparent; rejected when malformed |
| Access token | `Authorization` header | `authorization` metadata | Required except for health probes |

## Active endpoints

| Capability | REST | Public gRPC | Result |
| --- | --- | --- | --- |
| Liveness | `GET /health/live` | Not exposed | Process status |
| Readiness | `GET /health/ready` | Not exposed | Process status |
| Project | `GET /v1/projects/{projectId}` | `CatalogService.GetProject` | Project view |
| Quota | `GET /v1/projects/{projectId}/quota` | `CatalogService.GetProjectQuota` | Limits and current reserved usage |
| Images | `GET /v1/projects/{projectId}/catalog/images` | `CatalogService.ListImages` | Enabled project catalog page |
| Flavors | `GET /v1/projects/{projectId}/catalog/flavors` | `CatalogService.ListFlavors` | Enabled project catalog page |
| Networks | `GET /v1/projects/{projectId}/catalog/networks` | `CatalogService.ListNetworks` | Enabled project catalog page |
| Accept create | `POST /v1/projects/{projectId}/instances` | `InstanceService.CreateInstance` | `202`/accepted mutation after the database transaction commits |
| Instances | `GET /v1/projects/{projectId}/instances` | `InstanceService.ListInstances` | Projection page |
| Instance | `GET /v1/projects/{projectId}/instances/{instanceId}` | `InstanceService.GetInstance` | Desired and observed projection |
| Operations | `GET /v1/projects/{projectId}/operations` | `OperationService.ListOperations` | Operation projection page |
| Operation | `GET /v1/projects/{projectId}/operations/{operationId}` | `OperationService.GetOperation` | Current operation status |

## Create-instance fields

| Field | Type | Validation | Persisted meaning |
| --- | --- | --- | --- |
| `imageId` / `image_id` | string | Enabled catalog slug | Provider-neutral desired image |
| `flavorId` / `flavor_id` | string | Enabled catalog slug | Desired CPU, memory, and minimum disk profile |
| `networkId` / `network_id` | string | Enabled project network | Network used for the reserved IPv4 lease |
| `hostname` | string | DNS label, maximum 63 characters | Desired guest hostname |
| `sshPublicKeys` / `ssh_public_keys` | string array | Maximum five, unique, 32-8192 characters each | Desired authorized public keys; never logged |

The body limit is 65,536 bytes and unknown JSON fields are rejected. Acceptance atomically creates the desired instance, operation, IPv4 reservation, audit record, idempotency record, and transactional outbox command. Reusing the key with the same canonical request returns the original identifiers with `replayed=true`; reusing it for different intent returns a conflict.

## Error mapping

REST errors use RFC 9457 problem details with stable `code` values. gRPC maps the same categories to canonical statuses: unauthenticated, permission denied, invalid argument, not found, already exists, aborted, resource exhausted, and failed precondition. Internal exception details are not returned to callers.
