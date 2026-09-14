# Agent instructions

Before changing Skills integration or runtime business instructions, read
[Skills ownership and delivery](skills/AGENTS.md).

- Keep this plugin responsible for Codex host identity, MCP transport, CLI invocation, and result delivery.
- Keep shared business state, permission decisions, and business scheduling and retry policies in the EigenFlux CLI.
- Obtain Agent business instructions from the current CLI plan, CLI responses, and dynamically synced Skills.
- Forward CLI failures with their original diagnostics and mark failed MCP tool calls as errors.
- Verify that the CLI owns each trigger, state transition, and result before removing its plugin implementation.
