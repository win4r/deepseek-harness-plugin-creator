# Durable scheduling and background runtimes

Read this for Cron, schedule, heartbeat, queues, background pumps, durable Agent runs, and restart recovery.

## Define semantics before code

Specify:

- schedule expression and timezone;
- daylight-saving overlap/gap behavior;
- misfire policy and catch-up bound;
- maximum concurrency and overlap behavior;
- timeout, cancellation, heartbeat, and stale-run thresholds;
- retry policy and terminal failure state;
- what restart recovery can prove versus what remains ambiguous.

Do not use “exactly once” for an external side effect unless the downstream system participates in the same atomic transaction. Prefer at-least-once admission plus idempotency, or a conservative unknown/incomplete outcome.

## State machine and store

- Give schedules, occurrences, runs, attempts, and receipts stable IDs.
- Use explicit states and legal transitions rather than inferring state from timestamps.
- Claim and advance with atomic/optimistic revisions and fencing so two pumps cannot own the same occurrence.
- Persist authorization, normalized arguments, version, and idempotency key with the occurrence.
- Make crash points testable: before claim, after claim, after durable message admission, during execution, after external side effect, and before receipt.
- On ambiguous recovery, do not silently re-run a potentially consumed side effect.
- Use atomic replacement/transactional writes and validate stored data on load. Corruption must fail visibly or enter a documented quarantine path.

## Agent and lifecycle ownership

Autonomous runs must not inherit the human initiator that created the schedule. Use a distinct plugin source and the least-permission preset/tool set required by that stored schedule.

Stop new admission before disposal. Remove timers/listeners, cancel active runs, wait for Agent/process completion, persist final recoverable state, then close the store. A heartbeat is evidence of liveness, not proof that an external action completed.

## Required tests

- timezone and DST boundaries;
- misfires under each policy and bounded catch-up;
- overlap/concurrency races and optimistic-revision conflicts;
- restart at every state-machine edge;
- duplicate delivery and idempotent receipt;
- stale heartbeat and timeout cancellation;
- schedule update/delete while a run is due or active;
- plugin unload/reload with timers and Agents active;
- external side effect succeeds but receipt persistence fails;
- generated Agent attempts tools outside the stored allowlist.
