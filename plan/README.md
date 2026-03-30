# claudegram — Plan

## Context

Telegram-бот на Bun + grammy + Claude Agent SDK, ключевая особенность — настраивается через сам чат. Не нужно лезть в `.env`, YAML или JSON руками. Запускаешь бот, CLI-визард задаёт 2 вопроса, дальше всё управление через Telegram.

Два референса:
- **Официальный MCP-плагин** (`refs/claude-plugins-official/external_plugins/telegram/`) — grammy, MCP channel, access control, фото/файлы. ~1000 строк, минимальный, но нативная интеграция.
- **claude-code-telegram** (`refs/claude-code-telegram/`) — Python, Agent SDK, мульти-проект, SQLite, webhooks, voice. ~50 файлов, полноценная платформа.

Берём лучшее из обоих: нативность grammy + мощь Agent SDK + самоконфигурацию через плагины.

## Принцип: IMMUTABLE vs MUTABLE

Чёткое разделение на код (git, read-only в runtime) и данные (gitignored, изменяется агентом и ядром).

- `src/` — IMMUTABLE, код и шаблоны
- `data/` — MUTABLE, runtime-состояние, gitignored

## Документы плана

| Файл | Описание |
|---|---|
| [structure.md](structure.md) | Структура проекта (файлы, папки) |
| [core.md](core.md) | Core — неудаляемое ядро (auth, commands, tools, renderer, sandbox) |
| [plugins.md](plugins.md) | Plugin System — архитектура, API, loader, hot-reload |
| [generations.md](generations.md) | Generation System — снапшоты, откат, ротация |
| [config.md](config.md) | Config — JSONC, Zod, plugin configs, ConfigManager |
| [templates.md](templates.md) | Templates — библиотека готовых плагинов |
| [sessions.md](sessions.md) | Sessions — persistence, resume, multi-project |
| [system-prompt.md](system-prompt.md) | System Prompt — динамическая сборка |
| [wizard.md](wizard.md) | Setup Wizard — первый запуск, CLI |
| [ux-flows.md](ux-flows.md) | UX Flows — примеры взаимодействия |
| [tech-decisions.md](tech-decisions.md) | Технические решения и обоснования |
| [phases.md](phases.md) | Порядок реализации (phases) |
| [verification.md](verification.md) | Верификация — чеклист проверки |
