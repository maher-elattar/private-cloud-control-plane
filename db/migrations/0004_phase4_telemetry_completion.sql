-- Retain only the bounded W3C carrier needed to link a new administrative replay trace to the
-- failed workflow trace. The carrier remains internal and is never returned by the REST API.
ALTER TABLE projection.dead_letters
  ADD COLUMN trace_context jsonb;

-- Existing projected dead letters originated from the workflow owner, whose retained original
-- envelope already contains this carrier. Backfill it so replays created before this deployment
-- gain the same trace-link semantics as new failures.
UPDATE projection.dead_letters projected
SET trace_context = dead_letter.original_payload -> 'traceContext'
FROM workflow.dead_letters dead_letter
WHERE dead_letter.original_event_id = projected.original_event_id
  AND jsonb_typeof(dead_letter.original_payload -> 'traceContext') = 'object';
