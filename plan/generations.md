# Generation System (снапшоты плагинов)

Вместо бэкапа отдельных файлов — **атомарные поколения** всего состояния `plugins/`.

## Структура

```
data/generations/
├── gen-001/
│   ├── meta.json           # { generation: 1, timestamp: "...", description: "initial setup", plugins: ["auth", "text-handler"] }
│   └── plugins/            # полная копия plugins/ на момент снапшота
├── gen-002/
│   ├── meta.json
│   └── plugins/
└── current                 # файл с номером текущего поколения (e.g. "2")
```

## Принцип

**Агент не знает про файловую структуру generations.** Работает только через core tools:

| Tool | Описание |
|---|---|
| `generation_list` | Показать историю поколений с описаниями |
| `generation_rollback` | Откатиться на указанное поколение |
| `generation_diff` | Показать что изменилось между поколениями |

## Workflow

1. Claude пишет/меняет файлы в `plugins/`
2. Вызывает `reload_plugins`
3. Если reload **успешен** → ядро автоматически создаёт новое поколение
4. Если reload **провалился** → ядро автоматически откатывает к последнему рабочему поколению
5. Юзер в чате: "откати до вчерашнего состояния" → Claude вызывает `generation_list`, потом `generation_rollback`

## Ротация

Хранить максимум 50 поколений, удалять самые старые. Для десятка .ts файлов по 1-5 KB это ~250 KB.

## Generation Manager

Файл: `src/core/generation-manager.ts`

Методы:
- `create(description: string)` — копирует `plugins/` → `data/generations/gen-{N}/plugins/`, пишет `meta.json`, обновляет `current`
- `list()` — возвращает все поколения с метаданными
- `rollback(generation: number)` — копирует `data/generations/gen-{N}/plugins/` → `plugins/`, обновляет `current`
- `diff(from: number, to: number)` — показывает разницу файлов между двумя поколениями
- `rotate()` — удаляет поколения сверх лимита (50)
