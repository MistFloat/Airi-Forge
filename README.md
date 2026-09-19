# Airi Forge

A customized fork of the open-source [AIRI](https://github.com/moeru-ai/airi)
desktop AI agent. It runs as an Electron app with a Vue renderer, talks in text
or voice, drives a Live2D / avatar stage, remembers across sessions, and can
call MCP tools.

This fork adds:

- a **pgvector-backed long-term memory** layer with claim governance
- a **pluggable embedding provider** wired into the memory pipeline
- **resilient session-log loading** that skips retired event types from older
  builds instead of failing startup

> This repository is a fork of AIRI. Upstream AIRI and this fork are both MIT
> licensed, and the upstream history is preserved in this repository's git log.

## Features

- **Conversational stage** — streaming replies with emotion and motion tokens that drive TTS and the avatar stage
- **Voice** — speech recognition and text-to-speech providers, Live2D / PSD avatar rendering
- **Durable agent turns** — every turn is admitted, checkpointed and settled in the main process, so a crashed, reloaded or interrupted turn can be repaired and recovered instead of silently losing the reply
- **Memory** — short-term recall plus a pgvector-backed long-term store with claim governance
- **Recall** — the agent can search its durable conversation log by keyword (`built_in_conversationSearch`), including turns that were already compacted out of the prompt
- **Skills** — instruction documents discovered from the app, the user data directory and the workspace; only their names and descriptions enter the prompt, bodies load on demand
- **Tools** — MCP servers, built-in widget/weather/image tools, coding-agent integration
- **Providers** — OpenAI-compatible endpoints, Anthropic, Google, Cloudflare Workers AI, OpenRouter and local runtimes

## Requirements

- Node.js 22 LTS or newer
- pnpm 10 — the exact version is pinned by `packageManager` in `package.json` (`corepack enable` is the easiest way to get it)

## Quick start

```shell
pnpm install     # installs the workspace, builds shared packages, installs git hooks
pnpm dev         # starts the Electron desktop app with the Vite dev server
pnpm build       # builds the shared packages and packages the desktop app
```

Other useful root scripts:

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | Type-checks every package and app |
| `pnpm lint` / `pnpm lint:fix` | Runs the workspace linter |
| `pnpm test:run` | Runs the unit test suites |
| `pnpm dev:ui` | Runs the stage UI storybook |

## Configuration

- `instruction.md` in the repository root is merged into every conversation and
  is watched for changes. It contains the default stage protocol (the
  `<|ACT …|>`, `<|DELAY …|>` and `<|CALL …|>` tokens); replace it with your own
  instructions.
- Provider credentials, models and voice settings are configured in the app's
  settings pages and stored in the app's user-data directory.

## Skills

A skill is an instruction document the agent loads on demand. Each skill is a
directory with a `SKILL.md` file:

```text
my-skill/
  SKILL.md      # YAML frontmatter (name, description) plus the instructions
  references/   # optional documents the agent can read when it needs detail
```

Skills are discovered from three roots, lowest precedence first. A skill id
(directory name) found in a later root replaces the same id from an earlier one:

1. **bundled** — `resources/skills` shipped inside the app
2. **user** — `skills` inside the app's user-data directory
3. **workspace** — `.airi/skills` at the repository root of a development checkout

Only each skill's name and description reach the system prompt; the agent reads
the body, or one of its reference documents, with the built-in
`built_in_skillRead` tool. Unused skills therefore cost no context.

The prompt budget adapts long sessions to the model window: older tool results
are truncated first, and only if that is not enough are the oldest turns folded
into a single summary message. Newest turns and the system prompt always stay.

## Repository layout

- `apps/stage-tamagotchi` — the Electron desktop app (main process, preload and renderer)
- `packages/stage-ui` — shared stage UI, stores and composables
- `packages/core-agent` — agent runtime: turn lifecycle, session events and projections
- `packages/memory-pgvector` — long-term memory store
- `packages/stage-ui-three`, `packages/stage-ui-live2d`, `packages/stage-ui-spine` — 3D and model renderers
- `packages/i18n` — translations
- `engines/`, `services/`, `plugins/` — engine bindings, services and plugins

## License

MIT — see [`LICENSE`](./LICENSE). This project is derived from
[moeru-ai/airi](https://github.com/moeru-ai/airi); upstream copyright and license
notices are preserved.
