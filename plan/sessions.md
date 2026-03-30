# Sessions

> Sessions — часть core (`src/core/session-manager.ts`). Без них бот не может вести multi-turn разговоры.

## Ключ сессии

`(userId, projectName)` — каждый юзер имеет отдельную сессию на каждый проект.

## Multi-Session

Юзер может иметь **несколько сессий** (по одной на проект). Все сессии хранятся в БД, переключение между ними происходит при смене активного проекта. Лимитов на количество сессий нет — cleanup только по expiration.

## Persistence

bun:sqlite (`data/bot.db`) — общая БД, см. [core.md](core.md#database)

### Таблица sessions

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,           -- session ID от Claude Agent SDK
  user_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used TEXT NOT NULL,
  turns INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  is_active INTEGER DEFAULT 1,   -- soft delete
  UNIQUE(user_id, project_name, is_active)  -- один активный на пару user+project
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_project ON sessions(project_name);
```

### Таблица user_state

```sql
CREATE TABLE user_state (
  user_id TEXT PRIMARY KEY,
  active_project TEXT NOT NULL DEFAULT 'self'
);
```

## Resume с fallback

Паттерн из claude-code-telegram: попытка resume → при ошибке или expiration → fallback на новую сессию.

```typescript
// src/core/session-manager.ts
async function queryWithResume(opts: QueryOpts): Promise<Response> {
  const session = await db.getActiveSession(opts.userId, opts.project);

  if (session && !isExpired(session)) {
    try {
      const response = await query({
        ...opts,
        resume: session.id,
      });
      await db.updateSession(session.id, response);
      return response;
    } catch (e) {
      // Session expired/invalid on Claude side — start fresh
      log.warn("Session resume failed, starting fresh", {
        sessionId: session.id, error: e
      });
      await db.deactivateSession(session.id); // soft delete
    }
  }

  // New session
  const response = await query(opts);
  if (response.sessionId) {
    await db.createSession(response.sessionId, opts.userId, opts.project);
  }
  return response;
}
```

**Ключевой момент:** новая сессия создаётся только после получения sessionId от Claude Agent SDK (deferred persistence). Если SDK не вернул sessionId — сессия не сохраняется, следующее сообщение создаст новую.

## Session Expiration

Сессии не бессмертны. `isExpired()` проверяет `last_used` — если прошло больше `sessionTimeoutHours` (default: 24, configurable), сессия считается expired и не resume'ится.

```typescript
function isExpired(session: Session): boolean {
  const hoursSinceLastUse = (Date.now() - new Date(session.last_used).getTime()) / 3600_000;
  return hoursSinceLastUse > config.sessionTimeoutHours;
}
```

## Сброс

`/new` или `/clear` — deactivate текущую сессию (soft delete, `is_active = 0`). Следующее сообщение создаст новую.

## SessionAPI (для плагинов)

Core предоставляет `sessions` в PluginContext — read-only доступ к сессиям + возможность активировать старую:

```typescript
interface SessionAPI {
  list(userId: string, projectName?: string): SessionInfo[];
  activate(sessionId: string): void;  // деактивирует текущую, активирует указанную
  getActive(userId: string, projectName: string): SessionInfo | null;
}
```

Core **не** предоставляет UI для переключения сессий. Это делают плагины — см. template `session-switcher.ts`. Юзер может адаптировать template или написать свой вариант (inline-кнопки, авто-resume, именованные сессии и т.д.).

## Переключение проекта

Через плагин (команда, inline-кнопки, или треды):
- Меняется `activeProject` юзера
- Следующий `query()` пойдёт в другую сессию (другой `userId + projectName`)
- Старая сессия сохраняется и остаётся активной — можно вернуться

## Concurrency: один query за раз на проект

Sequential lock per `userId+projectName`. Пока Claude query выполняется в рамках одного проекта, новые сообщения в тот же проект ждут в очереди.

```typescript
// src/core/session-manager.ts
const sessionLocks = new Map<string, Promise<void>>();

function lockKey(userId: string, project: string): string {
  return `${userId}:${project}`;
}

async function withSessionLock<T>(userId: string, project: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(userId, project);
  const prev = sessionLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn); // sequential chain
  sessionLocks.set(key, next.then(() => {}, () => {}));
  return next;
}
```

Переключение на другой проект **не блокируется** — это другой lock key. Юзер может:
1. Отправить сообщение в проект `self` (query запущен)
2. Переключиться на `api-backend`
3. Отправить сообщение (новый query в другой сессии)
4. Оба работают параллельно

Каждый query при старте получает `ResponseTarget` (см. [core.md](core.md#response-target)) — знает куда стримить ответ, даже если юзер уже переключился.

> **Нет таймаута на query.** Запрос к Claude может работать минуты или часы (фоновые задачи). Typing indicator heartbeat отправляется в `ResponseTarget` пока query активен.

## Cancel и прерывание запросов

`/cancel` — core command, **обходит sequentialize middleware** (как и `/ping`). Это важно: если query занимает очередь, обычная команда встанет в очередь и не выполнится пока query не завершится.

```typescript
// server.ts — /cancel и /ping обрабатываются ДО sequentialize
bot.command("cancel", cancelHandler);  // bypass queue
bot.command("ping", pingHandler);      // bypass queue
bot.use(sequentialize(...));           // всё остальное — в очередь
```

### AbortController

Каждый query получает `AbortController`. `/cancel` вызывает `controller.abort()`.

```typescript
// session-manager.ts
const activeControllers = new Map<string, AbortController>();

async function withSessionLock<T>(userId: string, project: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const key = lockKey(userId, project);
  const controller = new AbortController();
  activeControllers.set(key, controller);

  try {
    const prev = sessionLocks.get(key) ?? Promise.resolve();
    const next = prev.then(() => fn(controller.signal), () => fn(controller.signal));
    sessionLocks.set(key, next.then(() => {}, () => {}));
    return next;
  } finally {
    activeControllers.delete(key);
  }
}

function cancelQuery(userId: string, project: string): boolean {
  const key = lockKey(userId, project);
  const controller = activeControllers.get(key);
  if (controller) {
    controller.abort();
    return true;
  }
  return false;
}
```

`/cancel` определяет `activeProject` юзера и вызывает `cancelQuery()`. Executor передаёт `signal` в Claude Agent SDK.
