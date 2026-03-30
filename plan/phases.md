# Порядок реализации

## Phase 1: Core

1. `src/core/plugin-api.ts` — интерфейс Plugin + PluginContext
2. `src/core/database.ts` — SQLite init, миграции, общий доступ для core и плагинов
3. `src/core/config.ts` — Zod schema + ConfigManager (jsonc-parser: read/write/validate)
4. `src/core/logger.ts` — structured JSONL logger (`data/logs/bot.log`), ротация по размеру
5. `src/core/plugin-loader.ts` — scan `plugins/`, hotImport с cache busting (mtime+size), register, sort by priority, error handling
6. `src/core/generation-manager.ts` — create/list/rollback снапшоты plugins/
7. `src/core/response-renderer.ts` — дефолтный стриминг ответа в Telegram (потребляет `AsyncIterable<QueryEvent>`, chunking, markdown, debounced edit)
8. `src/core/session-manager.ts` — multi-session (per userId+project, resume с fallback, expiration, user lock, deferred persistence)
9. `src/core/core-tools.ts` — config_get/set, plugin_list, reload_plugins, generation_list/rollback/diff
10. `src/core/core-commands.ts` — /start, /new, /clear, /cancel, /ping
11. `src/core/executor.ts` — query() wrapper с canUseTool sandbox (write only to plugins/, явный reject с причиной)
12. `src/core/server.ts` — bootstrap: config load → stale filter → dedup → /cancel+/ping bypass → owner auth → sequentialize → plugin scan → swappable middleware → bot start
13. `src/setup/wizard.ts` — визард (2 вопроса, создание data/ + plugins/, копирование стартовых плагинов, gen-001)

**Результат:** ядро запускается, загружает плагины, генерации работают, сессии персистентны с multi-session и concurrency, hot-reload без остановки polling, Claude ограничен в записи, только owner имеет доступ. Stale/dedup фильтры защищают от дублей и старых сообщений. /cancel прерывает query. Watchdog логирует зависшие запросы.

## Phase 2: Base Templates

14. `src/templates/text-handler.ts` — text → Claude query → ответ через renderer
15. `src/templates/auth.ts` — расширенный доступ (allowedUsers whitelist, authCheck хук)
16. `src/templates/ack-reaction.ts` — реакция на входящие (configurable emoji)
17. System prompt builder (с текущим состоянием плагинов, проектов, инструкциями по самоконфигурации)

**Результат:** бот отвечает на сообщения, можно менять настройки и плагины через чат, только owner.

## Phase 3: Multi-Project

18. Переключение проектов (через плагин — команды, кнопки, или треды)
19. Executor: project-aware режимы (sandbox для self, стандартный для остальных)

**Результат:** можно работать с несколькими проектами, переключение через чат.

## Phase 4: Media + More Templates

20. `src/templates/photo-handler.ts` — скачать фото, передать Claude
21. `src/templates/document-handler.ts` — скачать файл, передать Claude
22. `src/templates/thread-routing.ts` — проекты в тредах (форум-топики)
23. `src/templates/rate-limit.ts` — token bucket rate limiting
24. `src/templates/status-command.ts` — /status (session info, loaded plugins, costs)
25. `src/templates/help-command.ts` — /help
26. `src/templates/telegraph-renderer.ts` — длинные ответы публикуются в Telegraph Instant View (auto-create account, без токена)
26b. `src/templates/session-switcher.ts` — /sessions, /resume, /continue (переключение между сессиями через SessionAPI)

## Phase 5: UX Polish

27. Улучшение стриминга (progressive edit, typing indicator heartbeat)
28. Verbosity levels (в конфиге)

## Future

- Docker (Dockerfile, docker-compose, volumes)
- Voice messages (Whisper transcription)
- Webhook API server (GitHub events, CI notifications)
- Verbose renderer template (показывает reasoning + tool calls)
- Auth по mention в группах (template)
