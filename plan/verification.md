# Верификация

## Core

1. `bun run src/core/server.ts` — первый запуск, визард спрашивает 2 вопроса (token + user ID), создаёт data/ + plugins/
2. Повторный запуск — бот стартует, загружает плагины из `plugins/`
3. Сломанный плагин в `plugins/` — бот стартует, пропускает сломанный с warning
4. Не-owner пишет боту — игнор (без плагина auth)

## Базовая функциональность

5. Отправить текст в Telegram → получить ответ от Claude (стриминг)
6. "Покажи настройки" → Claude вызывает config_get
7. "Поставь модель opus" → Claude вызывает config_set → config.jsonc обновляется, комментарии сохранены

## Sessions

8. Отправить два сообщения подряд → второе знает контекст первого (session resume работает)
9. `/new` → следующее сообщение начинает новый разговор (session deactivated, новая создана)
10. Перезапустить бот → отправить сообщение → resume подхватывает старую сессию из SQLite
11. Expired session (last_used > sessionTimeoutHours) → автоматически создаётся новая, без ошибки
12. `/cancel` во время query → query прерывается, бот отвечает "Cancelled"

## Concurrency & Response Target

13. Отправить сообщение, пока предыдущий query ещё идёт (тот же проект) → второе ждёт в очереди
14. Отправить сообщение в проект `self`, переключиться на `api-backend`, отправить → оба query работают параллельно
15. Фоновый query завершается после переключения проекта → ответ всё равно приходит (в правильный тред или с меткой проекта в чате)
16. Плагин thread-routing: ответ стримится в тред проекта, не в основной чат

## Plugin System

17. "Какие плагины активны?" → Claude вызывает plugin_list
18. "Включи команду /status" → Claude копирует из templates/, reload → команда работает
19. "Сделай команду /deploy которая запускает make deploy" → Claude пишет новый плагин с нуля → reload → команда работает

## Hot-Reload

20. Reload плагинов не останавливает polling — сообщения во время reload обрабатываются
21. Изменённый плагин перечитывается при reload (mtime+size cache busting работает)
22. Неизменённый плагин при reload → тот же module из кеша (mtime+size не изменились)
23. Два плагина регистрируют responseRenderer → второй пропускается с warning
24. Два плагина регистрируют approvalHandler → оба работают (chain logic, по priority)

## Database

25. Плагин создаёт таблицу в register() через `CREATE TABLE IF NOT EXISTS` → таблица создана
26. Reload плагина → `CREATE TABLE IF NOT EXISTS` не ломает существующую таблицу

## Error Visibility

27. Плагин кидает exception в handler → ошибка пишется в `data/logs/bot.log`, бот не падает
28. Claude грепает лог по `"level":"error"` или по имени плагина → видит stack trace
29. Claude исправляет плагин → reload → новых ошибок в логе нет

## Sandbox

30. Claude пытается записать в `src/` → canUseTool блокирует с явным сообщением: "Writing is restricted to plugins/ only"
31. Claude пишет в `plugins/` → успешно

## Generation System

32. После каждого успешного reload — новое поколение создаётся автоматически
33. Сломанный плагин → reload fails → автооткат к предыдущему поколению → бот работает
34. "Верни как было вчера" → Claude вызывает generation_list → generation_rollback → restore

## Config

35. `config_set` валидирует через Zod — невалидное значение отклоняется с ошибкой
36. Plugin config валидируется через configSchema плагина
37. Комментарии в config.jsonc сохраняются после config_set

## Multi-Project

38. "Добавь проект /home/me/api" → config_set обновляет projects → Claude предлагает способ переключения

## Stale/Dedup/Cancel/Watchdog

39. Рестарт бота → старые сообщения (до boot) игнорируются
40. Дубликат message_id → обрабатывается только один раз
41. `/cancel` во время длинного query → AbortController.abort() → query прерывается
42. `/cancel` когда нет активного query → бот отвечает "Nothing to cancel"
43. `/ping` во время query → отвечает "pong" немедленно (bypass queue)
44. Query работает >60s → watchdog пишет warning в лог

## Plugin Lifecycle

45. Плагин с `dispose()` (clearInterval) → reload → интервал не утекает
46. Плагин с `handlers: { "callback_query:data": ... }` → inline-кнопки работают
47. Плагин с `commands: { status: { description: "...", handler } }` → описание доступно в help-command
