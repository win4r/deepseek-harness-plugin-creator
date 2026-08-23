# Tool and authority boundary

Read this when a plugin registers model-facing tools, scopes tools to Agents, or can cause durable/external mutation.

## Visibility is not permission

A visible tool can still be called by a stale, child, autonomous, or otherwise unauthorized Agent. Re-check authority inside `execute` immediately before business logic.

Build an explicit matrix for:

- eligible Agent identity and runtime-root membership;
- direct-human, plugin-generated, Cron-generated, or other message source;
- open/active turn and current initiator;
- read-only versus local mutation versus external/durable side effect;
- same-turn execution versus a later confirmation turn.

Do not reuse a human initiator for plugin-generated work. Generated messages need their own typed source and should not masquerade as user input.

## Sensitive mutation

For destructive, durable, costly, or external actions, consider a two-step confirmation only when it improves the actual authority boundary:

1. Normalize and hash the complete intended arguments and relevant target state.
2. Return a bounded, single-use token without performing the mutation.
3. Accept it only from a later direct-human turn bound to the same Agent, arguments, target, and expiry.
4. Consume it atomically before or with the authoritative state transition.

Do not make this universal. Bounded read-only inspection may need only direct-human/root checks. A scheduled job may instead rely on durable authorization established when the schedule was created.

## Model-facing schema

- Use the current typed tool DSL and canonical JSON output contract.
- Explicitly reject unknown keys when the current parameter root is open.
- Validate non-empty values, bounds, cross-field constraints, normalized paths, and identifiers not expressible in the schema.
- Return unsuccessful domain outcomes as structured successful values when they are not infrastructure failures; throw for infrastructure or policy failure.
- Keep human rendering separate from canonical output and replay metadata.
- Honor the current execution cancellation signal for foreground work. Transfer ownership to the current Jobs API only after a background job is successfully published.

## Registration and disposal

If tools are Agent-scoped, cover current and future eligible Agents, and unregister on Agent or plugin disposal. Apply scope after presets/extensions have mounted, then enforce again at execution. Bind runner control tools to the exact Agent, Session, run, and lifecycle token they control.

Do not commit a terminal or external state transition merely because a tool body began. When parent-operation success matters, commit on the authoritative result/receipt edge.

## Negative tests when applicable

Select tests for the authority mechanism actually implemented. Confirmation-token cases apply only when the plugin uses that pattern; do not add them to a bounded read-only tool merely to satisfy this list.

- child, stale, disposed, idle, or wrong-root Agent;
- same-turn or wrong-source confirmation;
- changed arguments, target state, expired token, and replay;
- unknown tool arguments and oversized values;
- tool added after initial scope setup;
- disposal during execution;
- parent operation fails after a control tool body returns.
