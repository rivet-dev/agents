# Docs Bundle CLAUDE.md

Rules for the Agents docs in this repo. These pages are **not** rendered here.
They are published on [rivet.dev](https://rivet.dev/agents/docs) by the
[website](https://github.com/rivet-dev/website) repo. `.github/workflows/docs-sync.yml`
copies this directory and `examples/` into the website's `vendor/agents/` on
every merge to `main`. Everything below exists so a page written here renders
correctly there.

Sandbox Agent's own docs (sandboxagent.dev) live in `sandbox-agent/docs/` and
follow different rules. Nothing in this file applies to them.

## Layout

```
docs/
  sidebar.json
  content/
    docs/**.mdx         -> /agents/docs/...
examples/
  docs/<topic>/*.ts     snippets embedded with <CodeSnippet>
```

The website links `content/` into its content collection, so **only real pages
belong under `content/`**. Anything else (scripts, fixtures, notes) goes
elsewhere in the repo or it will be published as a docs page.

## Frontmatter

Every page needs `title` and `description`. Both are used for SEO and the
sidebar falls back to `title` when a sidebar entry omits one.

```mdx
---
title: "Pi"
description: "Run the Pi coding agent as a durable Rivet Actor."
---
```

## sidebar.json

Navigation for the bundle. Icons travel as Font Awesome **export names** (for
example `"faSquareInfo"`) or `{ "src": "/images/..." }` for website-hosted
images, so this repo needs no dependency on the website's icon package.

- `href` is the full site path the page renders at: `/agents/docs/...`.
- Adding a page to `content/` does not add it to the nav. Add it here too.
- Deploy and self-hosting guides are website-owned and generated there.

## Code

- **Never inline a fenced TypeScript block.** Real examples live in
  `examples/docs/` and are embedded with `<CodeSnippet>`, so they are
  type-checked (`pnpm check-types`) and cannot rot.
- Snippet paths are relative to **this repo's root**, so the same path works
  both here and on rivet.dev:
  ```mdx
  <CodeSnippet file="examples/docs/pi/server.ts" />
  ```
- Embed part of a file with `region="name"`, delimited in the source by
  `// docs:start name` / `// docs:end name`.
- Shell commands, YAML, Dockerfiles, and terminal output **may** be inline
  fenced blocks. The no-inline rule exists for type checking, which only applies
  to TypeScript.
- Every TypeScript snippet must include its imports and define everything it
  references. Use `@nocheck` only for API that does not exist yet, and exclude
  such files in `examples/docs/tsconfig.json` with a comment saying why.
- Snippets are not reformatted by Biome (`biome.json` excludes `examples/docs`
  from the formatter and import sorting), so the published layout is exactly
  what you write.

## What does not belong here

- **Marketing pages.** They live in the website repo.
- **Deploy and self-hosting guides.** They are written once in the website repo
  and templated across every product.
- **Website components.** Do not import from the website by relative path or
  alias; a page must render from the components the site already provides.

## Terminology

- The service that routes, schedules, and persists is the **control plane**.
  Never "engine", "server", or "orchestrator".
- A process running user code with the Rivet SDK is a **worker**. Never
  "envoy", "runner", "node", "compute", or "data plane".
- Spell the product `agentOS`, never `AgentOS`. Capitalize **Rivet Actor** as a
  proper noun, lowercase generic "actor".
- Where prose must name the managed offering it is **Rivet Cloud**, and it links
  to <https://dashboard.rivet.dev>.
- Always `rivet.dev`, never `rivet.gg`.

## Writing

- Write comments and prose as complete sentences. **Never use em dashes**; use
  periods instead.
- Do not document deltas. A reader who never saw the old version gains nothing
  from "this was renamed".

## Previewing locally

Clone the website next to this repo and run it. It detects the sibling
checkout `../agents` and serves this directory's pages live:

```sh
git clone https://github.com/rivet-dev/website
cd website && pnpm install && pnpm dev
```
