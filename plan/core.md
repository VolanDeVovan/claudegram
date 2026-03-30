# Core (неудаляемое ядро)

Core — минимальное неизменяемое ядро, которое работает даже если все плагины сломались.

> **Принцип:** плагин не может уронить core. Все вызовы плагинов (register, middleware, handlers, hooks) обёрнуты в try-catch. Сломанный плагин пропускается с warning, бот продолжает работу.

## Что входит в core

### Функциональность (`src/core/`)

| Файл | Ответственность |
|---|---|
| `server.ts` | Bootstrap: config load → owner auth → plugin scan → bot start |
| `executor.ts` | query() wrapper, project-aware: sandbox для self, стандартный режим для остальных |
| `config.ts` | Config schema (Zod) + ConfigManager (jsonc-parser) |
| `plugin-loader.ts` | Scan, import, register, sort by priority, error handling |
| `generation-manager.ts` | Снапшоты plugins/ |
| `response-renderer.ts` | Дефолтный стриминг ответа в Telegram (потребляет QueryEvent stream) |
| `core-tools.ts` | MCP tools: config_get/set, plugin_list, reload, generations |
| `core-commands.ts` | Telegram commands: /start, /new, /clear, /cancel, /ping |
| `session-manager.ts` | Базовое управление сессиями (per userId+project, resume, cleanup) |
| `database.ts` | SQLite init, миграции, общий доступ для core и плагинов |
| `logger.ts` | LogTape setup: JSONL sink в `data/logs/bot.log`, ротация по размеру |
| `plugin-api.ts` | Стабильный интерфейс для плагинов |

## Core Commands

### `/start`
Приветствие, базовая инфо о боте. Показывает текущий проект, активные плагины, доступные команды.

### `/new`, `/clear`
Сброс сессии — начать новый разговор с Claude. Очищает текущую сессию для userId+activeProject.

### `/cancel`
Прерывание текущего query. Обходит очередь (см. [sessions.md](sessions.md#cancel-и-прерывание-запросов)). Вызывает `AbortController.abort()` для активного запроса.

### `/ping`
Health check. Обходит очередь. Отвечает "pong" + uptime.

## Core MCP Tools

Доступны Claude **только при работе с проектом `self`** (бот сам себя настраивает). При работе с другими проектами эти тулы не регистрируются.

| Tool | Описание |
|---|---|
| `config_get` | Получить конфиг (весь или по ключу). Возвращает значения + описания полей из Zod-схемы |
| `config_set` | Изменить настройку (key + value). Валидация через Zod, JSONC сохраняет комментарии |
| `plugin_list` | Список активных плагинов и доступных шаблонов из src/templates/ |
| `reload_plugins` | Hot-reload всех плагинов. Возвращает список загруженных + ошибки загрузки |
| `generation_list` | Список поколений с описаниями |
| `generation_rollback` | Откатиться на указанное поколение |
| `generation_diff` | Показать что изменилось между поколениями |

## Core Middleware

### Stale Message Filter

При рестарте бота Telegram может доставить сообщения, накопившиеся за время простоя. Core фильтрует их:

```typescript
// server.ts
const bootTime = Date.now();

bot.use(async (ctx, next) => {
  if (ctx.message && ctx.message.date * 1000 < bootTime) return; // ignore pre-boot messages
  await next();
});
```

Одна строчка middleware, ставится первым — до auth, до sequentialize.

### Message Deduplication

Telegram иногда доставляет дубликаты (особенно при нестабильной сети). Core отсекает повторные `message_id`:

```typescript
// server.ts
const seen = new Set<number>();
const MAX_SEEN = 1000;

bot.use(async (ctx, next) => {
  const id = ctx.message?.message_id;
  if (!id) return next();
  if (seen.has(id)) return;
  seen.add(id);
  if (seen.size > MAX_SEEN) {
    const first = seen.values().next().value;
    seen.delete(first);
  }
  await next();
});
```

Простой Set с FIFO-вытеснением. Не BoundedMap — не нужен value, только проверка наличия.

## Owner-Only Auth

Core проверяет `config.owner` на каждое входящее сообщение:

1. Если `userId === config.owner` → пропускаем
2. Если плагин зарегистрировал `authCheck(userId, pluginConfig, ctx): boolean` и вернул `true` → пропускаем
3. Иначе → игнорируем сообщение

`authCheck` получает полный grammy context (`ctx`) — плагин может проверять не только userId, но и тип чата (`ctx.chat.type`), ID группы (`ctx.chat.id`), @mention и т.д. Это нужно для групповых сценариев.

По умолчанию (без плагинов) только owner может писать боту. Расширение доступа — через плагин `auth.ts`.

## Executor: project-aware режимы

Executor создаёт Claude query по-разному в зависимости от активного проекта.

Общее для обоих режимов: SDK автоматически подхватывает CLAUDE.md файлы и `.claude/commands/` (скиллы) через `settingSources: ["user", "project", "local"]`.

### Проект `self` (бот управляет собой)

- **Sandbox**: write only to `plugins/`, контекстные reject'ы
- **MCP tools**: core tools (config_get/set, plugin_list, reload, generations) + тулы из плагинов
- **System prompt**: инструкции по самоконфигурации (см. [system-prompt.md](system-prompt.md))
- **Working directory**: корень бота
- **settingSources**: `["user", "project", "local"]` — SDK подхватывает CLAUDE.md бота

```typescript
// canUseTool для проекта self
canUseTool: (tool, input) => {
  if (tool === "Write" || tool === "Edit") {
    const filePath = input.file_path;

    if (filePath.startsWith(PLUGINS_DIR)) {
      return true;
    }

    // Контекстный reject — подсказываем что делать
    if (filePath === CONFIG_FILE || filePath.endsWith("config.jsonc")) {
      return {
        allowed: false,
        reason: "Cannot edit config.jsonc directly. Use config_get and config_set tools to read and modify configuration."
      };
    }

    if (filePath.startsWith(DATA_DIR)) {
      return {
        allowed: false,
        reason: `Cannot write to data/. Config: use config_set tool. Plugins: write to plugins/ directory.`
      };
    }

    if (filePath.startsWith(path.join(ROOT, "src"))) {
      return {
        allowed: false,
        reason: `Cannot modify src/ — it is immutable. Write plugins to plugins/ instead. Use templates in src/templates/ as read-only references.`
      };
    }

    return {
      allowed: false,
      reason: `Writing is restricted to plugins/ only. You tried to write to ${filePath}.`
    };
  }
  // Read/Glob/Grep — можно всё (чтобы Claude видел src/core/, src/templates/)
  return true;
}
```

### Любой другой проект

- **Sandbox**: нет ограничений — полный auto-approve, стандартный Claude Code
- **MCP tools**: нет core tools бота. SDK подхватывает MCP серверы проекта
- **System prompt**: стандартный, без инструкций по самоконфигурации бота
- **Working directory**: `project.path`
- **settingSources**: `["user", "project", "local"]` — SDK подхватывает CLAUDE.md проекта, `.claude/settings.json`, `.claude/commands/` (скиллы)
- **MCP серверы**: передаются из конфига проекта (`project.mcpServers`) + SDK подхватывает `.mcp.json` из `project.path`

```typescript
// canUseTool для внешних проектов — полный auto-approve
canUseTool: (tool, input) => {
  return true;
}
```

Переключение между режимами происходит автоматически при смене активного проекта.

### Общие параметры SDK

Оба режима передают в `query()`:

```typescript
const options: Options = {
  cwd: project.path,
  settingSources: ["user", "project", "local"],  // CLAUDE.md, .claude/settings.json
  mcpServers: {
    ...project.mcpServers,  // из конфига проекта (если есть)
  },
  // ... mode-specific options (systemPrompt, canUseTool, tools)
};
```

SDK автоматически:
- Читает `{cwd}/CLAUDE.md` и вложенные CLAUDE.md
- Читает `~/.claude/CLAUDE.md` (user level)
- Обнаруживает `.claude/commands/*.md` (скиллы) и отдаёт как доступные команды
- Подхватывает `.claude/settings.json` (permission mode, env vars)

### Approval Hook (chain logic)

По умолчанию всё auto-approve. Плагины могут добавлять approval handlers в chain:

```typescript
// Plugin API
approvalHandler?: (request: ApprovalRequest) => Promise<boolean>;

interface ApprovalRequest {
  tool: string;          // "Write", "Bash", etc.
  input: any;            // tool input
  description: string;   // human-readable описание
  chatId: number;
  bot: Bot;              // grammy instance для отправки кнопок
}
```

Примеры плагинов:
- Inline-кнопки Allow/Deny в Telegram для Bash команд
- Whitelist безопасных команд (auto для `git status`, спросить для `rm -rf`)
- Лог всех операций без блокировки

Core собирает все `approvalHandler`'ы из плагинов, сортирует по priority (меньше = раньше), вызывает последовательно:

```typescript
// core вызывает chain перед каждым tool call
async function checkApproval(request: ApprovalRequest): Promise<boolean> {
  for (const handler of approvalHandlers) { // sorted by plugin priority
    const allowed = await handler(request);
    if (!allowed) return false; // any deny = deny
  }
  return true; // all approve (or no handlers) = approve
}
```

Если ни один плагин не зарегистрировал хук — auto-approve.

> **Ограничение:** только один плагин может зарегистрировать `responseRenderer` или `resolveTarget`. Если второй пытается — ошибка при загрузке, плагин пропускается.

## Agent Watchdog

Простой таймер, логирующий зависшие query. Не прерывает — только предупреждает в лог.

```typescript
// executor.ts — внутри query wrapper
const WATCHDOG_WARN_SEC = 60;
const WATCHDOG_LOG_INTERVAL_SEC = 30;

function startWatchdog(userId: string, project: string): () => void {
  let elapsed = 0;
  const interval = setInterval(() => {
    elapsed += WATCHDOG_LOG_INTERVAL_SEC;
    if (elapsed >= WATCHDOG_WARN_SEC) {
      log.warn("Query running for {elapsed}s", { userId, project, elapsed });
    }
  }, WATCHDOG_LOG_INTERVAL_SEC * 1000);

  return () => clearInterval(interval); // stopWatchdog
}
```

Встраивается в executor: `const stop = startWatchdog(...)` → query → `stop()`. Никакой внешней логики, не влияет на плагины, просто пишет в лог.

## Response Target

Ответ Claude должен попасть в правильное место. Это место зависит от того, **как** юзер организовал переключение проектов:

- **CLI-стиль** (команды `/project self`, `/project api`): всё в одном чате. При переключении — flush текущий output фонового query.
- **Треды** (форум-топики): каждый проект в своём треде. Output стримится в нужный тред, даже если юзер переключился.
- **Inline-кнопки**: то же что CLI, один чат.

### ResponseTarget

```typescript
interface ResponseTarget {
  chatId: number;
  messageThreadId?: number;  // для тредов (forum topics)
}
```

Core не знает какой способ переключения используется. Core знает только `ResponseTarget`. Плагин переключения **определяет** target при каждом запросе.

### Как это работает

1. Юзер отправляет сообщение
2. Core определяет `activeProject` юзера
3. Core вызывает `resolveTarget` хук — плагин возвращает `ResponseTarget`
4. Если ни один плагин не зарегистрировал `resolveTarget` — дефолт: `{ chatId: ctx.chat.id }` (тот же чат, без треда)
5. `ResponseTarget` сохраняется вместе с query — executor знает куда стримить, даже если query фоновый

```typescript
// Хук в Plugin API
resolveTarget?: (userId: string, project: string, ctx: BotContext) => ResponseTarget;
```

### Фоновые query и flush

Когда query работает фоново (юзер переключился на другой проект):
- Output продолжает стримиться в тот `ResponseTarget`, который был определён при старте query
- Для тредов: стрим идёт в нужный тред, юзер видит обновления
- Для CLI-стиля: стрим идёт в основной чат — но юзер уже в другом проекте, поэтому ответ помечается именем проекта: `[api-backend] Done. Created 3 files.`

### Typing indicator

Heartbeat отправляет `sendChatAction("typing")` в тот же `ResponseTarget.chatId` (+ `message_thread_id` для тредов). Работает пока query активен.

## Response Renderer (дефолтный)

Core содержит стандартную логику отправки ответа Claude в `ResponseTarget`. Renderer получает `AsyncIterable<QueryEvent>` — полный поток событий от Claude Agent SDK.

### Дефолтный renderer (core)

- Потребляет `text_delta` события — стримит в Telegram через edit одного сообщения (debounced)
- Игнорирует `thinking_delta` и `tool_start`/`tool_end`
- **Chunking**: разбиение по 4096 символов (лимит Telegram)
- **Markdown**: parse mode для форматирования
- **Target-aware**: отправляет в `chatId` + `messageThreadId` из target

### Plugin override

Плагин может **переопределить** renderer через хук:

```typescript
responseRenderer?: (events: AsyncIterable<QueryEvent>, target: ResponseTarget, bot: Bot<BotContext>) => Promise<void>;
```

Exclusive — один плагин. Если зарегистрирован — core передаёт ему поток событий вместо дефолтного renderer.

Плагин получает **все события** и решает сам:
- Какие типы событий показывать (только text? text + thinking? tool calls?)
- Как оформлять (streaming edit, Telegraph, multiple messages)
- Когда отправлять (по мере генерации или после завершения)

## Database (`src/core/database.ts`)

Одна общая SQLite БД (`data/bot.db`) для core и плагинов.

### Core таблицы

Создаются при первом запуске:

```sql
-- Версионирование схемы
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- Сессии (см. sessions.md)
CREATE TABLE sessions (...);
CREATE TABLE user_state (...);
```

### Плагинные таблицы

Плагины создают свои таблицы через `db` из PluginContext в хуке `register()`:

```typescript
// plugins/rate-limit.ts
register: async (ctx) => {
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit_counters (
      user_id TEXT PRIMARY KEY,
      count INTEGER DEFAULT 0,
      window_start TEXT NOT NULL
    )
  `);
}
```

**Правила:**
- `CREATE TABLE IF NOT EXISTS` — идемпотентно, безопасно при reload
- Плагин именует таблицы с префиксом своего имени (`rate_limit_*`, `auth_*`)
- При удалении плагина таблицы остаются (orphaned) — не критично, занимают мало места
- Core не трогает чужие таблицы

### Миграции

Core использует версионную схему:

```typescript
const MIGRATIONS = [
  // version 1: initial
  `CREATE TABLE sessions (...)`,
  `CREATE TABLE user_state (...)`,
  // version 2: добавить cost tracking
  `ALTER TABLE sessions ADD COLUMN cost_usd REAL DEFAULT 0`,
];
```

При старте: проверяем `schema_version`, применяем недостающие миграции.

Плагины управляют миграциями сами через `register()` — `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` в try-catch.

## Error Log (`data/logs/`)

Лог-файлы на диске. Агент читает их через Read/Grep — нативно, без отдельных тулов.

**Цель лога — дать агенту контекст.** Лог пишет не только ошибки, а всю значимую активность бота: загрузку плагинов, reload, изменения конфига, входящие сообщения, запросы к Claude, смену проектов. Чем больше контекста в логе, тем лучше агент понимает что происходит и может диагностировать проблемы.

### Библиотека: LogTape

`@logtape/logtape` + `@logtape/file` — zero-dependency, first-class Bun support, JSONL formatter и rotating file sink из коробки.

### Setup (`src/core/logger.ts`)

```typescript
import { configure, getLogger, jsonLinesFormatter } from "@logtape/logtape";
import { getRotatingFileSink } from "@logtape/file";

await configure({
  sinks: {
    file: getRotatingFileSink("data/logs/bot.log", {
      formatter: jsonLinesFormatter,
      maxSize: 5 * 1024 * 1024,  // 5 MB
      maxFiles: 3,
    }),
  },
  loggers: [
    { category: ["bot"], lowestLevel: "debug", sinks: ["file"] },
  ],
});

// Использование в core и плагинах
const log = getLogger(["bot", "plugin-loader"]);
log.info("Plugin {plugin} loaded", { plugin: "auth" });
log.error("Plugin {plugin} failed in {phase}: {error}", {
  plugin: "rate-limit",
  phase: "handler",
  error: e.message,
});
```

Плагины используют `getLogger` напрямую из `@logtape/logtape` — конвенция: `getLogger(["bot", "plugins", pluginName])`. Core настраивает sink, плагины просто вызывают `getLogger`.

### Формат (JSONL)

```jsonl
{"@timestamp":"2026-03-30T12:00:01Z","@level":"info","@category":["bot","plugin-loader"],"@message":"Plugin auth loaded","plugin":"auth"}
{"@timestamp":"2026-03-30T12:00:05Z","@level":"error","@category":["bot","plugins","rate-limit"],"@message":"Plugin rate-limit failed in handler: Cannot read property 'rpm' of undefined","plugin":"rate-limit","phase":"handler","error":"Cannot read property..."}
```

Одна строка = один JSON объект. Агент грепает по `"@level":"error"`, по имени плагина в `@category`, по фазе.

### Что логируется

Весь жизненный цикл бота — чтобы агент мог прочитать лог и понять полную картину.

> **Правило: все log messages на английском.** Лог предназначен для агента (Claude), английский для него нативнее.

| Category | Level | What is logged |
|---|---|---|
| **Startup** | info | Bot started, version, owner ID |
| **Plugin loader** | info | Each loaded plugin (name, priority, registered hooks) |
| **Plugin loader** | warn | Plugin skipped (load error, missing export) |
| **Plugin loader** | error | Plugin crashed in register() — with stack trace |
| **Reload** | info | Reload started, which plugins loaded, which skipped |
| **Reload** | info | Generation created (number, description, plugin list) |
| **Reload** | error | Reload failed, rolled back to generation N |
| **Config** | info | config_set: what changed (key, old → new value) |
| **Auth** | info | Incoming message: userId, chatId, allowed/denied |
| **Executor** | info | Claude query started: project, model, resume/new session |
| **Executor** | info | Claude query completed: turns, cost, duration |
| **Executor** | error | Claude query failed: API error, network error, etc. |
| **Session** | info | New session created / resume succeeded / resume failed → fallback |
| **Handler** | error | Plugin handler threw exception — with stack trace |
| **Generation** | info | Rollback: from generation X to generation Y |

### Примеры записей

```jsonl
{"@timestamp":"...","@level":"info","@category":["bot","startup"],"@message":"Bot started as @my_claude_bot, owner: 412587349"}
{"@timestamp":"...","@level":"info","@category":["bot","plugin-loader"],"@message":"Loaded 3 plugins: auth (p:10), ack-reaction (p:15), text-handler (p:50)"}
{"@timestamp":"...","@level":"info","@category":["bot","reload"],"@message":"Reload complete, generation 5 created","plugins":["auth","ack-reaction","text-handler","status-command"]}
{"@timestamp":"...","@level":"info","@category":["bot","config"],"@message":"Config changed: model claude-sonnet-4 → claude-opus-4"}
{"@timestamp":"...","@level":"info","@category":["bot","auth"],"@message":"Message from user 123456 in chat -100123: allowed (plugin: auth)"}
{"@timestamp":"...","@level":"info","@category":["bot","executor"],"@message":"Query started for project self, model claude-sonnet-4, session resume abc123"}
{"@timestamp":"...","@level":"info","@category":["bot","executor"],"@message":"Query complete: 3 turns, $0.02, 4.2s"}
{"@timestamp":"...","@level":"error","@category":["bot","plugins","rate-limit"],"@message":"Handler error: Cannot read property 'rpm' of undefined","stack":"TypeError: ..."}
```

### Как ошибки попадают в лог

Все try-catch обёртки вокруг плагинов пишут в лог:

```typescript
// plugin-loader.ts — при загрузке
try {
  const mod = await hotImport(pluginPath);
  await mod.default.register?.(ctx);
} catch (e) {
  log.error("Plugin {plugin} failed in {phase}: {error}", {
    plugin: pluginName, phase: "register", error: e.message,
  });
}

// swappable middleware — при обработке сообщений
try {
  await pluginHandler(ctx);
} catch (e) {
  log.error("Plugin {plugin} failed in {phase}: {error}", {
    plugin: pluginName, phase: "handler", error: e.message,
  });
}
```

### Ротация

`getRotatingFileSink` — ротация по размеру (5 MB), хранит до 3 файлов: `bot.log`, `bot.log.1`, `bot.log.2`.

### Workflow для агента

1. Claude пишет/меняет плагин
2. Вызывает `reload_plugins` → видит ошибки загрузки в ответе
3. Если загрузка ок, но плагин падает в runtime → юзер жалуется
4. Claude грепает `data/logs/bot.log` по `"@level":"error"` или по имени плагина
5. Видит ошибку → исправляет → reload → грепает снова
