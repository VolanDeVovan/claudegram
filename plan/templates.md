# Templates — библиотека готовых плагинов

Templates — проверенные реализации в `src/templates/`. Read-only. Claude читает их, копирует в `plugins/`, адаптирует.

## Стартовый набор

Копируются автоматически при первом запуске (wizard):

| Template | Описание | Priority |
|---|---|---|
| `auth.ts` | Расширенный whitelist (allowedUsers). По умолчанию пустой — только owner | 10 |
| `text-handler.ts` | text → Claude query → ответ через renderer. Без него бот не отвечает на сообщения (но не упадёт) | 50 |
| `ack-reaction.ts` | Реакция на входящие сообщения (configurable emoji, default 👀) | 15 |

## Дополнительные templates

Пользователь включает через чат ("включи фото", "добавь rate limiting"):

| Template | Описание | Priority |
|---|---|---|
| `photo-handler.ts` | Скачать фото, передать Claude как image input | 50 |
| `document-handler.ts` | Скачать файл, передать Claude как контекст | 50 |
| `thread-routing.ts` | Проекты в тредах (форум-топики Telegram) | 20 |
| `rate-limit.ts` | Token bucket rate limiting | 15 |
| `status-command.ts` | /status — session info, loaded plugins, costs | 50 |
| `help-command.ts` | /help — список команд и возможностей | 50 |
| `telegraph-renderer.ts` | Длинные ответы → Telegraph Instant View | 50 |
| `session-switcher.ts` | Переключение между сессиями (/sessions, /resume, /continue) | 50 |

## Детали по каждому template

### auth.ts

```typescript
/**
 * @plugin auth
 * @description Extended access control — allowedUsers whitelist.
 *   Extends core owner-only auth with configurable user whitelist.
 *   Without this plugin, only the owner can interact with the bot.
 * @priority 10
 * @config plugins.auth.allowedUsers — array of Telegram user IDs
 */
```

```typescript
configSchema: z.object({
  allowedUsers: z.array(z.string()).default([]),
})

// pluginConfig — уже распарсенный plugins.auth из config.jsonc
authCheck: (userId, pluginConfig, ctx) => {
  return pluginConfig.allowedUsers.includes(String(userId));
  // Для доступа к core настройкам: ctx.pluginContext.config.get("model")
}

tools: [{
  name: "user_add",
  description: "Add user to whitelist",
  schema: z.object({ userId: z.string() }),
  handler: async ({ userId }, ctx: PluginContext) => {
    const users = ctx.config.get("plugins.auth.allowedUsers") || [];
    ctx.config.set("plugins.auth.allowedUsers", [...users, userId]);
    return `User ${userId} added`;
  },
}]
```

### text-handler.ts

```typescript
/**
 * @plugin text-handler
 * @description Routes text messages to Claude and sends responses.
 *   Core plugin — without it the bot won't respond to messages.
 *   Uses the active project's session and working directory.
 */
```

```typescript
handlers: {
  "message:text": async (ctx) => {
    const events = ctx.pluginContext.query({
      message: ctx.message.text,
      project: activeProject,
    });
    // events передаются в responseRenderer (дефолтный или плагинный)
  }
}
```

### ack-reaction.ts

```typescript
/**
 * @plugin ack-reaction
 * @description Reacts to incoming messages with an emoji before processing.
 *   Gives the user instant feedback that their message was received.
 * @priority 15
 * @config plugins.ack-reaction.emoji — reaction emoji (default: "👀")
 */
```

```typescript
configSchema: z.object({
  emoji: z.string().default("👀"),
})

middleware: [async (ctx, next) => {
  const cfg = ctx.pluginContext.config.get("plugins.ack-reaction");
  await ctx.react(cfg?.emoji || "👀");
  await next();
}]
```

### photo-handler.ts

```typescript
/**
 * @plugin photo-handler
 * @description Handles photo messages — downloads via grammy getFile(),
 *   passes to Claude as image input for analysis.
 */
```

### document-handler.ts

```typescript
/**
 * @plugin document-handler
 * @description Handles file attachments — downloads and reads content
 *   (text, code, etc.), passes to Claude as context.
 */
```

### thread-routing.ts

```typescript
/**
 * @plugin thread-routing
 * @description Maps projects to Telegram forum topics.
 *   Each project gets its own thread. Messages in a thread
 *   are automatically routed to the corresponding project session.
 * @priority 20
 * @config plugins.thread-routing.chatId — Telegram chat ID for forum topics
 */
```

### rate-limit.ts

```typescript
/**
 * @plugin rate-limit
 * @description Token bucket rate limiting per user.
 *   Prevents abuse by limiting requests per minute and per day.
 * @priority 15
 * @config plugins.rate-limit.rpm — requests per minute (default: 30)
 * @config plugins.rate-limit.dailyLimit — max requests per day (default: 500)
 */
```

```typescript
configSchema: z.object({
  rpm: z.number().default(30),
  dailyLimit: z.number().default(500),
})
```

### status-command.ts

```typescript
/**
 * @plugin status-command
 * @description Adds /status command — shows current project,
 *   active plugins, session cost, and turn count.
 */
```

### help-command.ts

```typescript
/**
 * @plugin help-command
 * @description Adds /help command — lists all available commands
 *   collected from loaded plugins.
 */
```

### telegraph-renderer.ts

```typescript
/**
 * @plugin telegraph-renderer
 * @description Publishes long responses (>2500 chars) to Telegraph Instant View.
 *   Uses Telegraph API createAccount (auto, no manual token needed).
 *   Account persisted in data/telegraph-account.json.
 *   Registers as responseRenderer — replaces default chunked output.
 * @priority 50
 * @config plugins.telegraph-renderer.threshold — char limit before switching to Telegraph (default: 2500)
 */
```

```typescript
configSchema: z.object({
  threshold: z.number().default(2500),
})

// responseRenderer — получает полный поток событий от Claude
responseRenderer: async (events, target, bot) => {
  let text = "";
  let msgId: number | undefined;
  const threshold = ctx.pluginContext.config.get("plugins.telegraph-renderer")?.threshold ?? 2500;

  for await (const event of events) {
    if (event.type !== "text_delta") continue;
    text += event.delta;

    // Пока текст короткий — стримим как обычно (debounced edit)
    if (text.length <= threshold) {
      msgId = await editOrSend(bot, target, text, msgId);
    }
  }

  // Финал: если текст длинный — заменяем сообщение ссылкой на Telegraph
  if (text.length > threshold) {
    const account = await getOrCreateAccount();
    const page = await createPage(account, text);
    const url = page.url;
    if (msgId) {
      await bot.api.editMessageText(target.chatId, msgId, `📄 ${url}`);
    } else {
      await bot.api.sendMessage(target.chatId, `📄 ${url}`, {
        message_thread_id: target.messageThreadId,
      });
    }
  }
}
```

Telegraph API `createAccount` не требует токена — вызывается один раз, возвращает `access_token`, который сохраняется в `data/telegraph-account.json`. Дальнейшие вызовы используют сохранённый токен.

### session-switcher.ts

```typescript
/**
 * @plugin session-switcher
 * @description Switch between sessions within a project.
 *   Adds /sessions (list), /resume (pick from list), /continue (resume latest).
 *   Uses ctx.pluginContext.sessions API from core.
 *   This is a starting point — user can adapt: add inline keyboards,
 *   auto-resume on bot restart, session naming, etc.
 * @priority 50
 */
```

```typescript
commands: {
  sessions: async (ctx) => {
    const sessions = ctx.pluginContext.sessions.list(
      String(ctx.from.id),
      ctx.pluginContext.config.get(`userState.${ctx.from.id}.activeProject`) || "self"
    );

    if (!sessions.length) {
      await ctx.reply("No sessions found.");
      return;
    }

    const lines = sessions.map((s, i) =>
      `${s.isActive ? "▸" : " "} ${i + 1}. ${s.projectName} — ${s.turns} turns, ${timeSince(s.lastUsed)} ago`
    );
    await ctx.reply(lines.join("\n"));
  },

  resume: async (ctx) => {
    const num = parseInt(ctx.match); // /resume 3
    const sessions = ctx.pluginContext.sessions.list(String(ctx.from.id));
    const target = sessions[num - 1];
    if (!target) {
      await ctx.reply("Invalid session number. Use /sessions to see the list.");
      return;
    }
    ctx.pluginContext.sessions.activate(target.id);
    await ctx.reply(`Resumed session in ${target.projectName} (${target.turns} turns).`);
  },

  continue: async (ctx) => {
    // Resume most recent inactive session for current project
    const project = ctx.pluginContext.config.get(`userState.${ctx.from.id}.activeProject`) || "self";
    const sessions = ctx.pluginContext.sessions.list(String(ctx.from.id), project);
    const latest = sessions.filter(s => !s.isActive).sort((a, b) =>
      new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime()
    )[0];

    if (!latest) {
      await ctx.reply("No previous session to continue.");
      return;
    }
    ctx.pluginContext.sessions.activate(latest.id);
    await ctx.reply(`Continued session (${latest.turns} turns, ${timeSince(latest.lastUsed)} ago).`);
  },
}
```

**Это стартовая точка.** Юзер может адаптировать:
- Добавить inline-кнопки вместо номеров
- Добавить имена/метки сессиям (через отдельную таблицу в `register()`)
- Авто-resume последней сессии при старте бота
- Показывать cost и длительность
- Фильтровать по проекту
