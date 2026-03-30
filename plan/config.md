# Config

## Формат: JSONC

Используем `jsonc-parser` (npm пакет от Microsoft/vscode):

- JSON с комментариями — human-readable
- `modify()` — меняет значение по JSON path, **сохраняя комментарии и форматирование**
- Идеально для `config_set` — меняем только нужное поле

```typescript
import { parse, modify, applyEdits } from 'jsonc-parser';

// config_set("model", "claude-opus-4")
const edits = modify(fileContent, ["model"], "claude-opus-4", { formattingOptions });
const newContent = applyEdits(fileContent, edits);
```

## Schema (Zod)

### Базовая схема (`src/core/config.ts`)

```typescript
const McpServerSchema = z.union([
  z.object({
    name: z.string(),
    type: z.enum(["http", "sse"]),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  }),
  z.object({
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  }),
]);

const ProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  mcpServers: z.array(McpServerSchema).optional(),  // дополнительные MCP серверы (поверх .mcp.json проекта)
});

const BaseConfigSchema = z.object({
  // Telegram
  botToken: z.string(),

  // Access
  owner: z.string(),           // Telegram user ID владельца (полные права)

  // Projects
  projects: z.array(ProjectSchema).default([]),
  defaultProject: z.string().default("self"),

  // Claude
  model: z.string().default("claude-sonnet-4"),
  maxTurns: z.number().default(10),

  // Sessions
  maxSessionsPerUser: z.number().default(10),
  sessionTimeoutHours: z.number().default(24),

  // Plugin configs (namespace = plugin name)
  plugins: z.record(z.unknown()).default({}),
});
```

### Plugin Config

Плагины расширяют конфиг через `configSchema`:

```typescript
// Плагин auth.ts
configSchema: z.object({
  allowedUsers: z.array(z.string()).default([]),
})
```

Это становится схемой для `plugins.auth` в конфиге.

При `config_set("plugins.auth.allowedUsers", [...])`:
1. Core находит загруженный плагин `auth`
2. Берёт его `configSchema`
3. Валидирует новое значение
4. Сохраняет через jsonc-parser (комментарии сохраняются)

Если два плагина используют одно значение — один читает конфиг другого: `config.get("plugins.rate-limit.rpm")`.

## ConfigManager

Файл: `src/core/config.ts`

Методы:
- `get(key?: string)` — вернуть весь конфиг или значение по dot-path (`"plugins.auth.allowedUsers"`)
- `set(key: string, value: unknown)` — изменить значение, валидировать, сохранить. Использует jsonc-parser modify для сохранения комментариев
- `validate()` — полная валидация через Zod (base + все plugin schemas)
- `reload()` — перечитать файл с диска
- `getSchema()` — вернуть описание всех полей (для config_get tool, чтобы Claude видел допустимые поля и типы)

## Пример config.jsonc

```jsonc
{
  // Telegram bot token from @BotFather
  "botToken": "123456789:AAH...",

  // Owner Telegram user ID (full access, cannot be removed)
  "owner": "412587349",

  // Projects
  "projects": [
    {
      "name": "self",
      "path": "/home/me/claude-telegram-bot",
      "description": "This bot itself"
    },
    {
      "name": "api-backend",
      "path": "/home/me/projects/api",
      "description": "REST API service",
      // MCP серверы поверх .mcp.json проекта (опционально)
      "mcpServers": [
        {
          "name": "postgres",
          "command": "mcp-server-postgres",
          "args": ["postgresql://localhost/api"]
        }
      ]
    }
  ],
  "defaultProject": "self",

  // Claude settings
  "model": "claude-sonnet-4",
  "maxTurns": 10,

  // Sessions
  "maxSessionsPerUser": 10,
  "sessionTimeoutHours": 24,

  // Plugin-specific configs
  "plugins": {
    "auth": {
      "allowedUsers": ["123456"]
    },
    "ack-reaction": {
      "emoji": "👀"
    },
    "rate-limit": {
      "rpm": 30,
      "dailyLimit": 500
    }
  }
}
```

Файл хранится в `data/config.jsonc`. Права 600.

## Core Tools для конфига

### `config_get(key?: string)`

- Без аргумента — весь конфиг (без botToken) + описание полей из Zod-схемы
- С ключом — значение + тип + описание поля
- Показывает и base fields, и plugin fields (из зарегистрированных configSchema)

### `config_set(key: string, value: unknown)`

- Валидирует через Zod (base schema или plugin configSchema)
- Сохраняет через jsonc-parser modify (комментарии сохраняются)
- Возвращает подтверждение или ошибку валидации
- Для `plugins.{name}.*` — ищет configSchema у загруженного плагина
