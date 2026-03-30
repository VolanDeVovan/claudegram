# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Self-configuring Telegram bot: Bun + grammy + Claude Agent SDK. All configuration happens through Telegram chat. See `@PLAN.md` for architecture index and `@plan/` for detailed design docs.

## Tech Stack

Bun runtime, grammy (Telegram), @anthropic-ai/claude-agent-sdk, bun:sqlite, LogTape, JSONC config with Zod validation.

## Code Style

- Biome for linting and formatting
- Conventional Commits

## Commands

- `bun run src/core/server.ts` — start bot
- `bunx biome check --write .` — lint + format fix

## Environment Variables

- `ANTHROPIC_API_KEY` — required
