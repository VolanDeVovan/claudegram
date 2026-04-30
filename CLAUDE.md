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

## Design Principles

The bot is self-modifying — an embedded LLM agent extends it at runtime by writing plugins via Claude Agent SDK. The following principles describe how the **bot's architecture** should be designed, not instructions for Claude Code itself.

### Core API: the constant failure mode to avoid

When changing the core or its plugin API, the most common mistake is to evaluate an abstraction against the **current** plugin list. Don't. Two facts make that wrong:

1. **`plugins/` and `src/templates/` are not the spec.** They are a frozen snapshot of what the embedded agent happened to need so far. The real consumer of the plugin API is **a future plugin the agent will write at runtime for a user request we cannot predict.**
2. **The product *is* this gap.** A traditional framework's API is sized to its known use cases. This bot's API must be sized to "whatever the user asks the bot to do next." Trimming the API to fit today's plugins narrows what the agent can build tomorrow.

Concrete rules that follow from this:

- **The right question is "could a reasonable plugin want this?" — never "do current plugins use this?"** If the answer to the first is yes, the capability stays even if zero current plugins exhaust it.
- **Templates and existing plugins are example callers, not the contract.** Designing the API around them is overfitting.
- **Capability is the default; removal needs justification.** When in doubt about whether a hook field, parameter, or surface is "needed," keep it. Cutting it costs the agent a future plugin; keeping it costs a line of types.
- **But over-engineering still hurts.** The agent reads `plugin-api.ts` to write plugins — every abstraction is a comprehension tax. The bar for *adding* an abstraction is: it (a) makes the API simpler to grasp, (b) cleanly separates a responsibility, or (c) opens a class of use cases. Not "it generalizes one current call site."
- **Optimize the API for being read, not written.** An author (human or LLM) should be able to read a hook signature once and correctly predict what's in scope and what is not. Naming, shape, and locality of behavior matter more than cleverness.

### Product mindset
- This is a new type of product that modifies itself for the user. Design creatively, not like a traditional framework.
- The embedded agent (LLM) is imperfect. The bot's architecture must include safeguards (rollback, sandboxing) that make it hard to fully break the bot — but never at the cost of functionality.
- Core entities (scope, project, session, generation) must be separated from what can be a plugin. If it can be a plugin without hurting the core contract — it should be.

### API and architecture
- Design maximally abstract, give maximum capability. Only break from abstraction where standardization is needed (e.g., projects, config format, owner auth).
- Architecture must be transparent and understandable to both humans and LLMs. Plugin authors shouldn't drown in hidden implicit logic.
- Objects passed to hooks/plugins must not contain excess, yet be standardized and carry everything needed — respecting responsibility boundaries.
- Think like an architect of battle-tested extensible projects. Patterns from Express, VS Code, Fastify — not invented abstractions.
- JSDoc comments in `plugin-api.ts` serve as runtime documentation for the embedded agent — it reads them when writing plugins. Include usage examples, gotchas, and non-obvious behavior (e.g., Telegram API scope priorities, middleware chain patterns). When modifying the plugin API, always preserve and update these comments.

## Architecture

Two layers: **core** (`src/core/`) and **plugins** (`plugins/`).

### Core (not replaceable by plugins)

Entities owned by the core — their semantics define the contract that plugins build on:

- **Scope** — isolation primitive (who owns the request). Key for sessions, locks, store.
- **Project** — named execution context. Binds routing (sessions by scope+project), execution (cwd, model, mcpServers), and tool visibility (`scope: string[]`).
- **Session** — Claude SDK conversation state (session_id, turns, cost).
- **Generation** — snapshot of `plugins/` for rollback. Safety net against agent-broken plugins.
- **Plugin loader** — discovery, hot-reload, generation management. The mechanism, not the plugins themselves.
- **Config** — JSONC + Zod validated. Single source of truth. Plugin schemas registered at load time.
- **Storage interfaces** — `ScopeStore`, `SessionAPI`. Backend (JSON files today) is an implementation detail.
- **Owner authentication** — single owner identity check. Anything richer (allowlists, role policy, per-chat rules) is plugin territory.
- **Built-in tools** — `config_get/set`, `plugin_list`, `reload_plugins`, `generation_list/rollback/diff`, update flow. They manage core entities; their behavior is changed only through config, never by plugins.

### Plugin territory (must be a plugin, not core)

If a feature can live as a plugin without breaking the core contract, it must be a plugin. Examples that are already templates or active plugins — and the shape of what belongs here:

- Message routing (forum, private topic, custom dispatch)
- Rendering to Telegram (text, telegraph, ack reactions, streaming)
- Commands, middleware, custom tools exposed to the embedded agent
- File handlers, attachments, media flow
- Auth policy beyond owner identity (allowlists, group rules, etc.)
- Project / session switching UX

### Plugin API

Surface (`src/core/plugin-api.ts`): middleware, commands, handlers, tools, hooks (`resolveContext`, `authCheck`, `beforeQuery`, `afterQuery`), renderer, lifecycle (`register`, `dispose`).

Message flow: `Telegram → stale/dedup → pluginContext → scope resolution → auth → core commands → plugin middleware → plugin commands/handlers → executor → Claude SDK → render → Telegram`.

## Storage Contract

Plugins access state through three planes; the core enforces this — no raw filesystem or database access leaks into the plugin API.

- `scopeStore` (`ScopeStore` interface) — per-scope persistent state.
- `config.get / config.set` — global plugin settings, validated by the plugin's `configSchema`.
- Plugin closure variables — ephemeral runtime state, dies on hot-reload.

Backend today is JSON files behind `ScopeStore` / `SessionAPI`. When editing storage code, do not let paths, file handles, or backend specifics surface through the plugin API — that's the contract being maintained.

## Working with This Codebase

- `SYSTEM.md` is the embedded agent's system prompt — paired document. When changing built-in tool names or signatures, `plugin-api.ts` JSDoc, onboarding flow, or any constraints visible to the bot, update `SYSTEM.md` in the same change. It does not load into Claude Code's context automatically and is easy to forget.
- Before refactoring: separate commit cleaning dead code first, then the refactor.
