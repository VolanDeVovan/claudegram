# Setup Wizard (первый запуск)

Файл: `src/setup/wizard.ts`

## Flow

1. Проверить есть ли `data/config.jsonc`
2. Если нет — запустить визард
3. Если есть — загрузить и запустить бот

## Визард (2 вопроса)

```
$ bun run src/core/server.ts

  Claude Telegram Bot - First Run Setup

  No config found. Let me help you set up.

  1. Bot token from @BotFather:
  > 123456789:AAH...

  2. Your Telegram user ID (get from @userinfobot):
  > 412587349

  Config saved to data/config.jsonc
  Starting bot...

  Bot is running as @my_claude_bot
  Send it a message on Telegram!
```

## Что делает визард

1. Спросить bot token
2. Проверить токен через `bot.api.getMe()`
3. Спросить user ID владельца
4. Создать директории:
   ```
   data/
   ├── config.jsonc
   ├── bot.db               # создаётся при первом запросе
   └── generations/
   plugins/
   ```
5. Создать проект `self` с `path: process.cwd()` (корень бота)
6. Записать `data/config.jsonc` с дефолтами и комментариями
7. Скопировать стартовый набор плагинов из `src/templates/` в `plugins/`:
   - `auth.ts`
   - `text-handler.ts`
   - `ack-reaction.ts`
8. Создать первое поколение (gen-001)

## Повторный запуск

```
$ bun run src/core/server.ts

  Config loaded. 1 project, 1 user.
  Bot is running as @my_claude_bot
```
