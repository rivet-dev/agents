# ACP Migration Research

This folder captures the v1 migration plan from the current in-house protocol to ACP-first architecture.

## Files

- `research/acp/00-delete-first.md`: delete/comment-out-first inventory for the rewrite kickoff.
- `research/acp/acp-notes.md`: ACP protocol notes extracted from `~/misc/acp-docs`.
- `research/acp/acp-over-http-findings.md`: field research from ACP Zulip thread on real ACP-over-HTTP transport patterns and recommendations.
- `research/acp/spec.md`: proposed v1 protocol/transport spec (ACP over HTTP).
- `research/acp/v1-schema-to-acp-mapping.md`: exhaustive 1:1 mapping of all current v1 endpoints/events into ACP methods, notifications, responses, and `_meta` extensions.
- `research/acp/rfds-vs-extensions.md`: simple list of which gaps should be raised as ACP RFDs vs remain product-specific extensions.
- `research/acp/migration-steps.md`: concrete implementation phases and execution checklist.
- `research/acp/friction.md`: ongoing friction/issues log for ACP migration decisions and blockers.

## Source docs read

- `~/misc/acp-docs/docs/protocol/overview.mdx`
- `~/misc/acp-docs/docs/protocol/initialization.mdx`
- `~/misc/acp-docs/docs/protocol/session-setup.mdx`
- `~/misc/acp-docs/docs/protocol/prompt-turn.mdx`
- `~/misc/acp-docs/docs/protocol/tool-calls.mdx`
- `~/misc/acp-docs/docs/protocol/file-system.mdx`
- `~/misc/acp-docs/docs/protocol/terminals.mdx`
- `~/misc/acp-docs/docs/protocol/session-modes.mdx`
- `~/misc/acp-docs/docs/protocol/session-config-options.mdx`
- `~/misc/acp-docs/docs/protocol/extensibility.mdx`
- `~/misc/acp-docs/docs/protocol/transports.mdx`
- `~/misc/acp-docs/docs/protocol/schema.mdx`
- `~/misc/acp-docs/schema/meta.json`
- `~/misc/acp-docs/schema/schema.json`
- `~/misc/acp-docs/docs/get-started/agents.mdx`
- `~/misc/acp-docs/docs/get-started/registry.mdx`

## Important context

- ACP stable transport is stdio; streamable HTTP is still draft in ACP docs.
- v1 in this repo is intentionally breaking and ACP-native.
- v1 is removed in v1 and returns HTTP 410 on `/v1/*`.
- `/opencode/*` is disabled during ACP core phases and re-enabled in the dedicated bridge phase.
- Keep `research/acp/friction.md` current as issues/ambiguities are discovered.
