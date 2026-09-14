# Skills ownership and delivery

- Treat [Eigenflux/skills](https://github.com/phronesis-io/eigenflux/tree/main/skills) as the sole source of EigenFlux Skills.
- Change Skill behavior in that repository and follow its [Skills maintenance instructions](https://github.com/phronesis-io/eigenflux/blob/main/skills/AGENTS.md).
- Use the EigenFlux CLI to dynamically sync compatible signed Skills into the host's configured Skills directory. For Codex, the default is `~/.agents/skills`; honor an explicitly configured sync target.
- Keep this directory documentation-only. Keep Skill definitions and generated bundles out of the plugin repository.
- Limit plugin prompts to host context and delivery. Obtain business instructions from the current heartbeat plan, server-delivered `output_contract`, and current CLI-synced Skills.
- Distribute Skill-only changes through the central Skills release workflow. Keep plugin versions unchanged and skip plugin publication for those changes.
