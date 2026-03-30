# Структура проекта

```
claude-telegram-bot/                 # repo root
├── src/                             # IMMUTABLE — код, шаблоны
│   ├── core/                        # ядро бота
│   │   ├── server.ts                # bootstrap, plugin loader, hot-reload
│   │   ├── executor.ts              # query() wrapper, canUseTool sandbox
│   │   ├── config.ts                # config schema (Zod) + manager (jsonc-parser)
│   │   ├── plugin-loader.ts         # scan, import, register plugins
│   │   ├── generation-manager.ts    # снапшоты plugins/
│   │   ├── response-renderer.ts     # дефолтный стриминг ответа в Telegram
│   │   ├── core-tools.ts            # config_get/set, plugin_list, reload, generations
│   │   ├── core-commands.ts         # /start, /new, /clear
│   │   ├── session-manager.ts       # сессии (per userId+project, resume, cleanup)
│   │   ├── database.ts              # SQLite init, миграции, общий доступ
│   │   ├── logger.ts                # structured JSONL logger с ротацией
│   │   └── plugin-api.ts            # стабильный API для плагинов
│   ├── templates/                   # библиотека шаблонов плагинов (read-only)
│   │   ├── auth.ts
│   │   ├── text-handler.ts
│   │   ├── ack-reaction.ts
│   │   ├── photo-handler.ts
│   │   ├── document-handler.ts
│   │   ├── thread-routing.ts
│   │   ├── help-command.ts
│   │   ├── status-command.ts
│   │   ├── rate-limit.ts
│   │   ├── telegraph-renderer.ts
│   │   └── session-switcher.ts
│   └── setup/                       # CLI визард первого запуска
│       └── wizard.ts
├── plugins/                         # MUTABLE — активные плагины, gitignored
│   ├── auth.ts                      # агент пишет сюда
│   ├── text-handler.ts
│   └── ack-reaction.ts
├── data/                            # MUTABLE — runtime-данные, gitignored
│   ├── config.jsonc                 # конфиг бота (JSONC с комментариями)
│   ├── bot.db                       # SQLite (сессии, user_state, плагинные таблицы)
│   ├── logs/                        # JSONL логи (bot.log, ротация по 5 MB)
│   └── generations/                 # снапшоты плагинов (управляет ядро)
│       ├── gen-001/
│       │   ├── meta.json            # { timestamp, description, pluginList }
│       │   └── plugins/             # полная копия plugins/ на момент снапшота
│       ├── gen-002/
│       │   ├── meta.json
│       │   └── plugins/
│       └── current                  # номер текущего поколения
├── tsconfig.json
├── package.json
└── .gitignore                       # содержит: plugins/, data/
```

## Path Aliases

Bun нативно поддерживает `paths` из tsconfig — никаких доп. тулов не нужно.

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@core/*": ["./src/core/*"],
      "@templates/*": ["./src/templates/*"],
      "@setup/*": ["./src/setup/*"]
    }
  }
}
```

Импорт в плагинах:
```typescript
// plugins/auth.ts
import type { Plugin } from "@core/plugin-api";
```

Чисто, понятно, не ломается при перемещении файлов.

