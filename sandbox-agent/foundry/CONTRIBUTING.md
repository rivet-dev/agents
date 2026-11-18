# Contributing

## Development Setup

1. Clone:

```bash
git clone https://github.com/rivet-dev/sandbox-agent.git
cd sandbox-agent/foundry
```

2. Install dependencies:

```bash
pnpm install
```

3. Build all packages:

```bash
pnpm -w build
```

## Package Layout

- `packages/shared`: contracts/schemas
- `packages/backend`: RivetKit actors + DB + providers + integrations
- `packages/cli`: `hf` and `hf tui` (OpenTUI)

## Local RivetKit Dependency

Build local RivetKit before backend changes that depend on Rivet internals:

```bash
cd ../rivet
pnpm build -F rivetkit

cd /path/to/sandbox-agent/foundry
just sync-rivetkit
```

## Validation

Run before opening a PR:

```bash
pnpm -w typecheck
pnpm -w build
pnpm -w test
```

## Dev Backend (Docker Compose)

Start the dev backend (hot reload via `bun --watch`) and Vite frontend via Docker Compose:

```bash
just foundry-dev
```

Stop it:

```bash
just foundry-dev-down
```
