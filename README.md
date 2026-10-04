# Agents

Agent infrastructure from [Rivet](https://rivet.dev). Join us on [Discord](https://rivet.dev/discord).

## Projects

| Project | Directory | Docs |
| --- | --- | --- |
| **Sandbox Agent**: run coding agents in sandboxes and control them over HTTP | [`sandbox-agent/`](./sandbox-agent/) | [sandboxagent.dev](https://sandboxagent.dev/docs) |

## Releases

Everything in this repository ships on one version line. `just release` runs the release script in [`scripts/release/`](./scripts/release/), which bumps every package, publishes crates and npm packages, uploads binaries, and tags `v<version>`.

## License

[Apache 2.0](./LICENSE)
