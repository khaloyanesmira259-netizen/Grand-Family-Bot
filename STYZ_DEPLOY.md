# Перенос Grand Family Bot на Styz

Архив `Grand-Family-Bot-STYZ.zip` содержит исходный код и конфигурацию без токена и секретов.

## Environment Variables

Задайте на Styz:

- `DISCORD_BOT_TOKEN` — настоящий токен Discord-бота.
- `SQLITE_PATH` — путь к persistent storage, например `/data/grand-family/families.sqlite`.

Не добавляйте токен в файлы проекта, Git, README, логи или ZIP-архив.

## Установка и запуск

Для архива с этим самостоятельным пакетом:

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run start
```

Если Styz разворачивает исходную структуру workspace, команды эквивалентны:

```bash
pnpm install
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run start
```

Процесс должен слушать переменную `PORT`. Health-проверка:

```text
GET /health
```

Ответ:

```json
{"status":"ok"}
```

## Persistent SQLite

Укажите `SQLITE_PATH` внутри постоянного диска Styz. Если переменная не задана, используется `./data/families.sqlite`. При старте создаются таблицы `settings`, `families`, `applications` и `transfers`, а SQLite автоматически включает WAL mode.

## После запуска

1. Убедитесь, что у бота включены `Message Content Intent` и `Server Members Intent`.
2. Пригласите бота на сервер с правами управления ролями и каналами.
3. Поднимите роль бота выше настроечных ролей.
4. Владелец приложения выполнит `/setup`.
5. Владелец введёт 8 ID, указанных в README.
6. Владелец выполнит `/panel`.

Категории, каналы, роли `Семья <название>` и `LD <название>` создаются автоматически после одобрения заявления.