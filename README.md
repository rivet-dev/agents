# Agents

Agent infrastructure from [Rivet](https://rivet.dev). Join us on [Discord](https://rivet.dev/discord).

## Projects

| Project | Directory | Docs |
| --- | --- | --- |
| **Rivet Agents**: run agents such as [Pi](https://github.com/earendil-works/pi) as durable Rivet Actors (`@rivet-dev/pi`, `@rivet-dev/sandbox-adapter`) | [`packages/`](./packages/), docs in [`docs/`](./docs/) | [rivet.dev/agents/docs](https://rivet.dev/agents/docs) |
| **Sandbox Agent**: run coding agents in sandboxes and control them over HTTP | [`sandbox-agent/`](./sandbox-agent/) | [sandboxagent.dev](https://sandboxagent.dev/docs) |

## Releases

Everything in this repository ships on one version line. `just release` runs the release script in [`scripts/release/`](./scripts/release/), which bumps every package, publishes crates and npm packages, uploads binaries, and tags `v<version>`.

## License

[Apache 2.0](./LICENSE)
