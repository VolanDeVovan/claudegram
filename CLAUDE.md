# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Self-configuring Telegram bot: Bun + grammy + Claude Agent SDK. The bot modifies its own behavior through plugins written by the agent at runtime. All configuration happens through Telegram chat.

## Tech Stack

Bun runtime, grammy (Telegram), @anthropic-ai/claude-agent-sdk, LogTape, JSONC config with Zod validation, JSON file storage.

## Commands

- `bun run start.ts` — start bot (wrapper with auto-restart on update)
- `bun run src/core/server.ts` — start bot directly (no restart wrapper)
- `bunx biome check --write .` — lint + format fix

## Code Style

- Biome for linting and formatting
- Conventional Commits

## Architecture

Two layers: **core** (`src/core/`) and **plugins** (`plugins/`).

Core entities:
- **Scope** — isolation primitive (who owns the request). Key for sessions, locks, store.
- **Project** — named execution context. Binds routing (sessions by scope+project), execution (cwd, model, mcpServers), and tool visibility (`scope: string[]`).
- **Session** — Claude SDK conversation state (session_id, turns, cost).
- **Generation** — snapshot of plugins/ for rollback. Safety net against agent-broken plugins.
- **Plugin** — extension unit. Loaded from `plugins/*.ts` or `plugins/*/index.ts`. Hot-reloadable.
- **Config** — JSONC + Zod validated. Single source of truth. Plugin schemas registered at load time.
- **Storage** — behind abstract interfaces (ScopeStore, SessionAPI). JSON files by default.

Message flow: `Telegram → stale/dedup → pluginContext → scope resolution → auth → core commands → plugin middleware → plugin commands/handlers → executor → Claude SDK → render → Telegram`.

Plugin API surface (`src/core/plugin-api.ts`): middleware, commands, handlers, tools, hooks (resolveContext, authCheck, beforeQuery, afterQuery, renderMiddleware), lifecycle (register, dispose).

Templates in `src/templates/` — read-only reference implementations. Plugins copy and adapt.

## Design Principles

The bot is self-modifying — an embedded LLM agent extends it at runtime by writing plugins via Claude Agent SDK. The following principles describe how the **bot's architecture** should be designed, not instructions for Claude Code itself.

### Product mindset
- This is a new type of product that modifies itself for the user. Design creatively, not like a traditional framework.
- The embedded agent (LLM) is imperfect. The bot's architecture must include safeguards (rollback, sandboxing) that make it hard to fully break the bot — but never at the cost of functionality.
- Core entities (scope, project, session, generation) must be separated from what can be a plugin. If it can be a plugin without hurting the core contract — it should be.

### API and architecture
- Design maximally abstract, give maximum capability. Only break from abstraction where standardization is needed (e.g., projects, config format, owner auth).
- Templates in `src/templates/` are examples, not the limit. The plugin API must support far more than what templates show.
- Architecture must be transparent and understandable to both humans and LLMs. Plugin authors shouldn't drown in hidden implicit logic.
- Don't add a pile of abstractions that one can replace. But do add an abstraction when it simplifies understanding.
- Objects passed to hooks/plugins must not contain excess, yet be standardized and carry everything needed — respecting responsibility boundaries.
- Think like an architect of battle-tested extensible projects. Patterns from Express, VS Code, Fastify — not invented abstractions.
- JSDoc comments in `plugin-api.ts` serve as runtime documentation for the embedded agent — it reads them when writing plugins. Include usage examples, gotchas, and non-obvious behavior (e.g., Telegram API scope priorities, middleware chain patterns). When modifying the plugin API, always preserve and update these comments.

## Data Storage Patterns (for plugins)

| What | Where | Example |
|------|-------|---------|
| Per-user state | `scopeStore.set(userId, key, value)` | active_project, preferences, tokens |
| Plugin settings | `config.get("plugins.myPlugin.setting")` | topicMapping, allowedUsers |
| Ephemeral runtime | variable in plugin closure | cache, counters, buffers |

No raw database access in plugin API. Storage backend is an implementation detail behind interfaces.

## Working with This Codebase

- Read files in chunks. Do not trust a single read for files over 500 lines — re-read the relevant section before editing.
- Before refactoring: separate commit cleaning dead code first, then the refactor.
- Tasks touching 5+ files: launch sub-agents in parallel.
- After 10+ messages in conversation: re-read files before editing — don't rely on stale context.
- See `drafts/final-api-vision.md` for the target API design. Current code may diverge — the draft is the source of truth for direction.
