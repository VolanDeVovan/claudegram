# Plugin System

## Архитектура: Core + Plugins

- **Core** (`src/core/`) — неизменяемое ядро (см. [core.md](core.md))
- **Plugins** (`plugins/`) — всё остальное. Claude может писать, редактировать, удалять
- **Templates** (`src/templates/`) — библиотека готовых плагинов (read-only, см. [templates.md](templates.md))

## Самодостаточные плагины

Каждый плагин — **независимый юнит**, который декларирует всё, что ему нужно: команды, хендлеры, middleware, MCP-тулы, cron-задачи. Никакой организации по типу (`commands/`, `handlers/`, `middleware/`).

```typescript
// plugins/auth.ts
/**
 * @plugin auth
 * @description Extended access control — allowedUsers whitelist.
 *   Extends core owner-only auth with configurable user whitelist.
 *   Without this plugin, only the owner can interact with the bot.
 * @priority 10
 * @config plugins.auth.allowedUsers — array of Telegram user IDs
 */
import type { Plugin } from "@core/plugin-api";

export default {
  name: "auth",
  description: "Extended access control (allowedUsers whitelist)",
  priority: 10,  // middleware загружается раньше (default: 50)

  configSchema: z.object({
    allowedUsers: z.array(z.string()).default([]),
  }),

  // pluginConfig — распарсенный plugins.auth из config.jsonc
  authCheck: (userId, pluginConfig, ctx) => {
    return pluginConfig.allowedUsers.includes(String(userId));
  },

  tools: [{
    name: "user_add",
    description: "Add user to whitelist",
    schema: z.object({ userId: z.string() }),
    handler: async ({ userId }, ctx: PluginContext) => {
      const users = ctx.config.get("plugins.auth.allowedUsers") || [];
      ctx.config.set("plugins.auth.allowedUsers", [...users, userId]);
      return `User ${userId} added`;
    },
  }],
} satisfies Plugin;
```

## Обязательный заголовок

Каждый плагин (и template) **обязан** иметь JSDoc-заголовок с описанием:

```typescript
/**
 * @plugin {name}
 * @description {что делает плагин, 1-3 строки}
 * @priority {число, если отличается от default 50}
 * @config {какие поля в config.jsonc использует, если есть}
 */
```

Это нужно чтобы:
- Claude мог прочитать файл и понять что плагин делает, не разбирая код
- `plugin_list` tool мог показать описания
- Юзер мог открыть файл и сразу понять назначение

Plugin loader парсит заголовок при загрузке. Если `@plugin` и `@description` отсутствуют — warning в логе.

## Структура плагинов

**Простые плагины** — один файл (`auth.ts`, `text-handler.ts`).

**Сложные плагины** — папка с `index.ts`:

```
plugins/
├── auth.ts                  # простой — один файл
├── text-handler.ts
├── projects/                # сложный — папка
│   ├── index.ts             # экспортирует Plugin
│   ├── commands.ts
│   └── tools.ts
└── ack-reaction.ts
```

Loader: файл `.ts` → импортирует напрямую. Папка с `index.ts` → импортирует `index.ts`.

## Plugin API

```typescript
// src/core/plugin-api.ts

// ─── Context ────────────────────────────────────────────────────

/** grammy context расширенный PluginContext */
type BotContext = GrammyContext & { pluginContext: PluginContext };

export interface ResponseTarget {
  chatId: number;
  messageThreadId?: number;
}

export interface PluginContext {
  bot: Bot<BotContext>;
  config: ConfigManager;              // read/write config.jsonc (полный доступ ко всему конфигу)
  db: Database;                       // bun:sqlite — плагин создаёт свои таблицы в register()
  query: (opts: QueryOpts) => AsyncIterable<QueryEvent>;
  sessions: SessionAPI;
}

// Логирование: плагины используют getLogger напрямую из @logtape/logtape
// Конвенция: getLogger(["bot", "plugins", pluginName])
// Core настраивает sink один раз в logger.ts, плагины просто вызывают getLogger

// ─── Query Events (стриминг от Claude) ──────────────────────────

export type QueryEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; tool: string; input: unknown }
  | { type: "tool_end"; tool: string; output: string }
  | { type: "done"; finalText: string };

// ─── Sessions ───────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  projectName: string;
  createdAt: string;
  lastUsed: string;
  turns: number;
  costUsd: number;
  isActive: boolean;
}

export interface SessionAPI {
  list(userId: string, projectName?: string): SessionInfo[];
  activate(sessionId: string): void;
  getActive(userId: string, projectName: string): SessionInfo | null;
}

// ─── Tools (MCP) ────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  schema: ZodSchema;
  handler: (input: z.infer<typeof schema>, ctx: PluginContext) => Promise<string>;
}

// ─── Commands ───────────────────────────────────────────────────

export type CommandHandler = (ctx: BotContext) => void | Promise<void>;

export interface CommandDefinition {
  description?: string;               // для BotFather /setcommands и help-command плагина
  handler: CommandHandler;
}

// ─── Approval ───────────────────────────────────────────────────

export interface ApprovalRequest {
  tool: string;                        // "Write", "Bash", etc.
  input: unknown;
  description: string;
  chatId: number;
  bot: Bot<BotContext>;
}

// ─── Plugin ─────────────────────────────────────────────────────

export interface Plugin {
  name: string;
  description?: string;
  priority?: number;                   // порядок загрузки (default: 50, меньше = раньше)
  configSchema?: ZodSchema;            // схема для plugins.{name} в конфиге

  // ── регистрация ──

  middleware?: MiddlewareFn<BotContext>[];
  commands?: Record<string, CommandHandler | CommandDefinition>;
  handlers?: Record<string, Handler<BotContext>>;   // grammy FilterQuery keys
  tools?: ToolDefinition[];

  // ── хуки ──

  authCheck?: (userId: string, pluginConfig: unknown, ctx: BotContext) => boolean;
  resolveTarget?: (userId: string, project: string, ctx: BotContext) => ResponseTarget;
  responseRenderer?: (events: AsyncIterable<QueryEvent>, target: ResponseTarget, bot: Bot<BotContext>) => Promise<void>;
  approvalHandler?: (request: ApprovalRequest) => Promise<boolean>;

  // ── lifecycle ──

  register?(ctx: PluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
```

### handlers: grammy FilterQuery

`handlers` принимает ключи — [grammy filter query strings](https://grammy.dev/guide/filter-queries). Core регистрирует каждый через `bot.on(filterQuery, handler)`. Это даёт доступ ко всем типам update'ов без расширения plugin-api:

```typescript
handlers: {
  "message:text": async (ctx) => { /* текстовые сообщения */ },
  "message:photo": async (ctx) => { /* фото */ },
  "message:voice": async (ctx) => { /* голосовые */ },
  "message:document": async (ctx) => { /* файлы */ },
  "callback_query:data": async (ctx) => { /* inline-кнопки */ },
  "inline_query": async (ctx) => { /* inline mode */ },
  "message:video": async (ctx) => { /* видео */ },
  "message:sticker": async (ctx) => { /* стикеры */ },
  "message:location": async (ctx) => { /* геолокация */ },
  // ... любой grammy FilterQuery
}
```

Не нужно менять `plugin-api.ts` чтобы добавить поддержку нового типа — grammy уже знает все типы.

### commands: описания для BotFather

Команды поддерживают два формата:

```typescript
// Короткий — просто handler
commands: {
  ping: async (ctx) => ctx.reply("pong"),
}

// С описанием — для /setcommands и help-command плагина
commands: {
  status: {
    description: "Show current project, session, and costs",
    handler: async (ctx) => { ... },
  },
}
```

Core собирает все описания из плагинов. Плагин `help-command` использует их для генерации /help. При желании можно автоматически регистрировать в BotFather через `bot.api.setMyCommands()`.

### responseRenderer: стриминг

Renderer получает `AsyncIterable<QueryEvent>` — полный поток событий от Claude. Плагин решает что показывать и как:

```typescript
// Дефолтный (core) — стримит text_delta, игнорирует thinking
responseRenderer: async (events, target, bot) => {
  let text = "";
  let msgId: number | undefined;

  for await (const event of events) {
    if (event.type === "text_delta") {
      text += event.delta;
      // debounced edit
      msgId = await editOrSend(bot, target, text, msgId);
    }
  }
}

// Verbose — показывает reasoning + tool calls
responseRenderer: async (events, target, bot) => {
  for await (const event of events) {
    if (event.type === "thinking_delta") { /* показать рассуждение */ }
    if (event.type === "tool_start") { /* "🔍 Using grep..." */ }
    if (event.type === "text_delta") { /* стримить текст */ }
  }
}

// Telegraph — собирает всё, публикует если длинное
responseRenderer: async (events, target, bot) => {
  let text = "";
  for await (const event of events) {
    if (event.type === "text_delta") text += event.delta;
  }
  if (text.length > 2500) {
    const page = await publishToTelegraph(text);
    await bot.api.sendMessage(target.chatId, page.url);
  } else {
    await bot.api.sendMessage(target.chatId, text);
  }
}
```

Exclusive — один плагин. Если не зарегистрирован — core использует дефолтный renderer.

### authCheck: pluginConfig

Хук получает **свою секцию** конфига (уже распарсенную через `configSchema`), а не весь конфиг. Для доступа к полному конфигу — `ctx.pluginContext.config`:

```typescript
// pluginConfig — это plugins.auth из config.jsonc, типизированный через configSchema
authCheck: (userId, pluginConfig, ctx) => {
  // Быстрый доступ к своему конфигу
  return pluginConfig.allowedUsers.includes(String(userId));

  // Если нужен чужой конфиг или core настройки:
  // const model = ctx.pluginContext.config.get("model");
  // const otherPlugin = ctx.pluginContext.config.get("plugins.rate-limit");
}
```

### dispose: cleanup при hot-reload

```typescript
let interval: Timer;

export default {
  register: (ctx) => {
    interval = setInterval(() => checkHealth(ctx), 60_000);
  },
  dispose: () => {
    clearInterval(interval);
  },
} satisfies Plugin;
```

Loader при reload: `dispose()` всех текущих → import новых → `register()`. Если `dispose` отсутствует — пропускается.

### BotContext

grammy context расширен `pluginContext` — каждый хендлер, middleware и хук получает доступ и к Telegram-контексту (chatId, message_thread_id, entities, chat.type), и к PluginContext (config, db, bot, query, sessions).

Это критично для групповых сценариев:
- `authCheck` видит `ctx.chat.type`, `ctx.chat.id` — может проверять доступ per-group
- middleware видит `ctx.message.message_thread_id` — может маршрутизировать по тредам
- handlers видят `ctx.message.entities` — могут фильтровать по @mention
- `"callback_query:data"` handler видит `ctx.callbackQuery.data` — для inline-кнопок

## Plugin Loader

Файл: `src/core/plugin-loader.ts`

1. Сканирует `plugins/` — файлы `.ts` и папки с `index.ts`
2. Сортирует по `priority` (меньше = раньше, default: 50)
3. `import()` каждого в try-catch (сломанный пропускается с warning)
4. Вызывает `plugin.register(ctx)` для каждого (timeout 5 сек)
5. Регистрирует middleware, commands (оба формата: handler и CommandDefinition), handlers (по grammy FilterQuery), tools, authCheck
6. Регистрирует хуки: `resolveTarget` (exclusive), `responseRenderer` (exclusive), `approvalHandler` (chain — несколько плагинов, по priority). Если exclusive хук уже зарегистрирован — плагин пропускается с warning
7. Возвращает список загруженных плагинов и ошибок

## Hot-Reload (без остановки polling)

grammy поддерживает swappable middleware — не нужно останавливать бот для перезагрузки плагинов.

### Архитектура: swappable middleware

```typescript
// server.ts — при старте бота
let currentMiddleware: MiddlewareFn<BotContext> = (ctx, next) => next();
bot.use((ctx, next) => currentMiddleware(ctx, next));
bot.start(); // polling запущен, больше не останавливаем

// reload — подменяем middleware chain без остановки polling
function applyPlugins(plugins: Plugin[]): void {
  const composer = new Composer<BotContext>();
  // ... регистрируем middleware, commands, handlers из плагинов
  currentMiddleware = composer.middleware();
  // С этого момента все новые update'ы идут через новую chain
}
```

### Module Cache Busting

Bun кеширует `import()` по specifier string. Повторный `import("./plugins/auth.ts")` вернёт старый модуль.

Решение — mtime+size cache key (паттерн из openclaw `src/hooks/import-url.ts`): query string меняется только когда файл реально изменился. Это избегает лишних записей в module cache при reload'ах без изменений.

```typescript
// src/core/plugin-loader.ts
import { statSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";

async function hotImport<T>(filePath: string): Promise<T> {
  const absolute = resolve(filePath);
  const base = pathToFileURL(absolute).href;

  try {
    const { mtimeMs, size } = statSync(absolute);
    const url = `${base}?t=${mtimeMs}&s=${size}`;
    return (await import(url)) as T;
  } catch {
    // Fallback если stat не сработал
    return (await import(`${base}?t=${Date.now()}`)) as T;
  }
}
```

Каждый **изменённый** файл при reload создаёт новую запись в module cache (~1-5 KB). Неизменённые файлы переиспользуют кеш. Для бота с десятком плагинов это пренебрежимо.

### Процесс reload_plugins

При изменении плагинов Claude вызывает core tool `reload_plugins`:

1. Создать снапшот текущего состояния (generation)
2. `dispose()` всех текущих плагинов (cleanup: intervals, connections, etc.)
3. Сканировать `plugins/` — файлы и папки с `index.ts`
4. Сортировать по `priority`
5. `hotImport()` каждого в try-catch (сломанный пропускается с warning)
6. Вызвать `plugin.register(ctx)` для каждого (timeout 5 сек)
7. Собрать новый `Composer` из middleware, commands, handlers
8. Подменить `currentMiddleware` → новые update'ы сразу используют новую chain
9. Если всё ок → поколение сохраняется как current
10. Если сборка упала → откат к предыдущему поколению, повторный reload
11. Вернуть Claude список загруженных плагинов и ошибок

**Polling не останавливается.** Update'ы, пришедшие во время reload, обрабатываются старой chain до момента подмены.

## Как Claude работает с плагинами

Claude использует templates тремя способами:

1. **Копировать и использовать как есть** — "включи auth" → копирует `src/templates/auth.ts` в `plugins/auth.ts`
2. **Копировать и адаптировать** — "сделай auth по mention в группах" → копирует, редактирует
3. **Как референс для нового** — "сделай команду /deploy" → смотрит паттерн в templates, пишет новый плагин

Templates не загружаются ботом напрямую — только то, что лежит в `plugins/`.
