# Технические решения

| Вопрос | Решение | Почему |
|---|---|---|
| Runtime | Bun | Запрос пользователя |
| Telegram lib | grammy | Проверена в официальном плагине, TypeScript-first |
| Claude | @anthropic-ai/claude-agent-sdk | Нативный SDK, streaming, sessions |
| Config format | JSONC (jsonc-parser) | Комментарии, modify сохраняет форматирование, точечные изменения |
| Config validation | Zod | Уже dep Agent SDK, одна схема для config + tool inputs + plugin configs |
| MCP tools | Core tools в ядре, доп. тулы в плагинах | Core нельзя сломать, плагины расширяют |
| Database | Одна общая SQLite (`data/bot.db`) для core и плагинов | Проще чем per-plugin БД, плагины создают таблицы через `CREATE TABLE IF NOT EXISTS` в register() |
| Logging | LogTape (`@logtape/logtape` + `@logtape/file`) | Zero-dep, first-class Bun, JSONL + rotating file sink из коробки |
| Error visibility | JSONL лог-файл (`data/logs/bot.log`), агент грепает через Read/Grep | Нативнее для агента чем SQL или API — просто grep по файлу, переживает рестарты |
| Plugins location | `plugins/` в корне, отдельно от `data/` | Код отдельно от данных, свой Docker volume |
| Data location | `data/` — конфиг, БД, генерации | gitignored, volume в Docker |
| Path aliases | `@core/*`, `@templates/*` через tsconfig paths | Bun нативно поддерживает, чистые импорты в плагинах |
| Plugin snapshots | Копии директорий (generations) | Проще bare git, агент не путается, работает через тулы |
| Hot-reload | Swappable middleware (grammy Composer), без bot.stop/start | Нет downtime, update'ы не теряются во время reload |
| Module cache | `import()` с mtime+size cache busting (паттерн из openclaw) | Bun кеширует import по specifier, query string с mtime+size обходит кеш только при реальных изменениях |
| Sessions | Core (не плагин), multi-session per user, resume с fallback, expiration, sequential lock per user | Нужны для multi-turn с Phase 1, паттерн из claude-code-telegram. Параллельные query в разных проектах, sequential в одном |
| Exclusive hooks | responseRenderer — один плагин. approvalHandler — chain (все по priority, any deny = deny) | responseRenderer: один рендерит. approval: chain logic естественнее, плагины могут добавлять проверки независимо |
| Auth | Owner в core, расширение через плагины | Минимум в ядре, гибкость через плагины |
| Response target | `ResponseTarget { chatId, messageThreadId? }` — определяется плагином через `resolveTarget` хук | Renderer не привязан к входящему ctx — может стримить в треды, в чат, в правильное место для фоновых query |
| Response delivery | Дефолтный renderer в core, переопределяемый плагином. Получает `ResponseTarget`, не `ctx` | Работает из коробки, но можно кастомизировать. Не ломается для фоновых query без активного ctx |
| Project management | Через config_set, не отдельные CRUD тулы | Проще, меньше тулов, Claude достаточно умён |
| Project switching | Через плагин (треды, команды, кнопки) | Гибкость, пользователь выбирает способ |
| Executor mode | Project-aware: sandbox для self, стандартный для остальных | Бот управляет собой через тулы, внешние проекты — как обычный Claude Code |
| Concurrency | Sequential lock per userId+project, параллельные query между проектами | Один query за раз в рамках проекта, но юзер может переключиться и работать с другим проектом параллельно |
| Timeouts | Нет таймаута на Claude query | Query может работать минуты или часы (фоновые задачи). Typing indicator heartbeat пока query идёт |
| CLAUDE.md | `settingSources: ["user", "project", "local"]` — SDK подхватывает автоматически | Не парсим руками. SDK читает `{cwd}/CLAUDE.md`, `~/.claude/CLAUDE.md`, `.claude/settings.json` |
| MCP серверы | Передаём в SDK через `mcpServers` option + SDK подхватывает `.mcp.json` | Конфиг проекта может указать дополнительные MCP серверы поверх `.mcp.json` |
| Скиллы (slash commands) | SDK обнаруживает `.claude/commands/*.md` автоматически | Проектные скиллы работают без дополнительного кода в боте |

## Почему не отдельные тулы для projects/users

Вместо `project_add`, `project_remove`, `project_list`, `project_switch`, `user_add`, `user_remove`, `user_list` — используем `config_get` + `config_set`. Это:
- Меньше тулов → проще для Claude
- Одна точка входа → легче валидировать
- Zod-схема описывает структуру → Claude видит что можно менять

## Почему два режима executor'а

Проект `self` — бот управляет собой. Нужен sandbox (чтобы не сломать core), кастомные MCP tools (config, plugins, generations), специальный system prompt. Внешние проекты — бот работает как обычный Claude Code агент: полный доступ к файлам в project.path, подхватывает `.mcp.json` проекта, стандартный промпт. Смешивать эти режимы нельзя — иначе sandbox бота будет мешать работе с внешними проектами.

## Почему нет send_message тула

Текстовый output Claude автоматически стримится в Telegram через response renderer. Не нужен отдельный тул для ответа. Это:
- Естественнее — Claude просто пишет
- Проще — нет дублирования каналов
- Поддерживает стриминг из коробки
