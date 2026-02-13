# OmAcademy Schedule Backend

Automated backend service that parses the OmAcademy schedule website, extracts lessons for all groups, stores data in MongoDB, and refreshes data every day.

Source website:
- `https://omacademy.ru/rasp-new/Website-students/cg.htm`

## Features

- Parses all groups from `cg.htm`
- Parses all teachers from `cp.htm`
- Opens each group page (`cgXXX.htm`) and extracts lessons
- Stores normalized data in MongoDB (NoSQL)
- Keeps an active snapshot of the latest sync
- Runs daily automatic sync via cron
- Supports manual sync via API endpoint
- Exposes REST API for schedule queries
- Includes a ready-to-run MAX messenger bot (webhook mode)

## What Gets Parsed

For each lesson, the backend saves:
- group code (e.g. `60`)
- group name (e.g. `ИСП-9.16`)
- date (`YYYY-MM-DD`)
- day label (e.g. `Сб-1`)
- lesson number (e.g. `2`)
- subject (e.g. `МДК.03.02 Управление проектами (Лек)`)
- room (e.g. `309`, `дист. обуч`, `обр.портал`)
- teacher (e.g. `Шарапов Александр Евгеньевич`)

For each teacher directory record, the backend saves:
- teacher code from `cpXXX.htm`
- teacher display name
- source link to teacher page

## Tech Stack

- Node.js (Express)
- MongoDB
- Axios + Cheerio (HTML parsing)
- node-cron (daily scheduler)
- Docker + Docker Compose

## Quick Start (Docker)

1. Create env file:

```bash
cp .env.example .env
```

2. Build and start services:

```bash
docker compose up --build -d
```

3. Trigger manual sync:

```bash
curl -X POST "http://localhost:3000/api/sync"
```

4. Check service health:

```bash
curl "http://localhost:3000/health"
```

## Production Deployment

This service is designed to run as a long-lived process behind a public HTTPS endpoint.

### 1. Prepare production environment

- Linux server or VPS
- Docker + Docker Compose installed
- Public domain (required for MAX webhook mode)
- TLS certificate (Let's Encrypt or your existing certificate)

### 2. Configure environment

Create a production `.env` file:

```bash
cp .env.example .env
```

Recommended production values:

```bash
PORT=3000
MONGO_URI=mongodb://mongo:27017/omacademy_schedule
SOURCE_BASE_URL=https://omacademy.ru/rasp-new/Website-students/
SYNC_CRON=0 5 * * *
SYNC_TIMEZONE=Asia/Omsk
RUN_SYNC_ON_STARTUP=true
HTTP_TIMEOUT_MS=20000
MAX_CONCURRENT_REQUESTS=5
```

### 3. Build and start containers

```bash
docker compose up -d --build
```

### 4. Verify backend is healthy

```bash
curl "http://localhost:3000/health"
curl "http://localhost:3000/api/sync/status"
```

### 5. Put backend behind HTTPS reverse proxy

Expose the service publicly as HTTPS (for example with Nginx, Caddy, or Traefik) and proxy traffic to `http://127.0.0.1:3000`.

Required public endpoint format:

`https://your-domain.example/webhooks/max`

### 6. Operations checklist

- Check logs:
  - `docker compose logs -f backend`
  - `docker compose logs -f mongo`
- Trigger manual sync after deploy:
  - `curl -X POST "http://localhost:3000/api/sync"`
- Ensure firewall allows inbound `443` and blocks direct external access to internal-only ports where possible.

## Local Run (without Docker)

1. Install dependencies:

```bash
npm install
```

2. Start MongoDB locally and configure `.env`.

3. Run backend:

```bash
npm start
```

Optional one-time sync from CLI:

```bash
npm run sync:once
```

Webhook management for MAX:

```bash
npm run max:webhook:register
npm run max:webhook:list
npm run max:webhook:delete
```

## MAX Bot

The project contains a complete MAX bot implementation in:

- `src/max/apiClient.js`
- `src/max/botService.js`
- `src/max/webhook.js`
- `src/max/userPrefsRepository.js`
- `src/max/registerWebhook.js`
- `src/max/listWebhooks.js`
- `src/max/deleteWebhook.js`

Supported bot commands:
- `/помощь` (`/help`)
- `/кнопки` (shows menu buttons, same as `/помощь`)
- `/роль` (`/role`) - choose mode
- `/студент` (`/student`) - switch to student mode
- `/преподаватель` (`/teacher`) - switch to teacher mode
- `/группы [query]` (`/groups`)
- `/группа <groupCode|groupName>` (`/setgroup`)
- `/моягруппа` (`/mygroup`)
- `/преподаватели [query]` (`/teachers`)
- `/препод <teacherName>` (`/setteacher`)
- `/мойпрепод` (`/myteacher`)
- `/сегодня [groupCode|groupName|teacherName]` (`/today`)
- `/завтра [groupCode|groupName|teacherName]` (`/tomorrow`)
- `/дата <YYYY-MM-DD> [groupCode|groupName|teacherName]` (`/date`)
- `/следующая [groupCode|groupName|teacherName]` (`/next`)
- `/обновить` (`/sync`, admin only)

The bot asks user role on first start (`Студент` or `Преподаватель`) and shows role-specific inline keyboard.
For better UX, menu includes `Выбрать группу` / `Выбрать преподавателя` buttons:
- click button
- type search text (name/code)
- choose from returned inline buttons

### Bot configuration variables

Set these in `.env`:

```bash
MAX_BOT_ENABLED=true
MAX_BOT_TOKEN=your_bot_token
MAX_API_BASE_URL=https://platform-api.max.ru
MAX_WEBHOOK_PATH=/webhooks/max
MAX_WEBHOOK_SECRET=your_random_secret
MAX_WEBHOOK_SECRET_HEADER=x-max-bot-api-secret
MAX_WEBHOOK_PUBLIC_URL=https://your-domain.example
MAX_ADMIN_USER_IDS=12345,67890
```

Notes:
- `MAX_WEBHOOK_PUBLIC_URL` must be public HTTPS.
- `MAX_WEBHOOK_PATH` must match your Express route and webhook registration URL.
- `MAX_ADMIN_USER_IDS` controls who can run `/sync` from chat. If empty, everyone can run it.

### Enable and run bot

1. Set bot env vars in `.env` (see above).
2. Start backend (`npm start` or Docker).
3. Register webhook:

```bash
npm run max:webhook:register
```

If webhook was already registered before button support, delete and register again so subscription includes `message_callback` updates:

```bash
npm run max:webhook:delete
npm run max:webhook:register
```

Webhook endpoint (local path): `POST /webhooks/max`

### Webhook management

List subscriptions:

```bash
npm run max:webhook:list
```

Delete current webhook (for configured public URL + path):

```bash
npm run max:webhook:delete
```

### Bot smoke test

1. Open your bot in MAX messenger.
2. Send `/помощь` and verify command list is returned.
3. Send `/группы исп-9.15` and check that group appears.
4. Use button `Выбрать группу`, type `исп-9.15`, and click group button.
5. Send `/сегодня` or `/дата 2026-02-14`.
6. Switch role with `/преподаватель`, run `/преподаватели тигова`, then `/препод Тигова А.Ю.` and `/сегодня`.
7. Use button `Выбрать преподавателя`, type `тигова`, and click teacher button.
8. If needed, run `/обновить` (admin user only when `MAX_ADMIN_USER_IDS` is set).

### Troubleshooting bot setup

- `401 invalid webhook secret`:
  - verify `MAX_WEBHOOK_SECRET` and `MAX_WEBHOOK_SECRET_HEADER`.
- No incoming updates:
  - ensure webhook URL is HTTPS and publicly reachable.
  - verify subscription with `npm run max:webhook:list`.
- Bot responds in API but not in chat:
  - verify `MAX_BOT_TOKEN` is correct and active.
  - check backend logs: `docker compose logs -f backend`.

## API

Base URL: `http://localhost:3000`

### `GET /health`
Returns service health and current active sync ID.

### `GET /api/groups`
Returns active list of groups.

### `GET /api/teachers`
Returns active list of teachers.

Supported query params:
- `query` (substring search by teacher name)

### `GET /api/schedule`
Returns lessons from the active snapshot.

Supported query params:
- `group` (exact group name)
- `groupCode` (numeric code from `cgXXX.htm`)
- `date` (`YYYY-MM-DD`)
- `teacher` (exact full name)
- `room` (exact value)

Examples:

```bash
curl "http://localhost:3000/api/schedule?groupCode=60&date=2026-02-14"
```

For Cyrillic group names, use URL encoding safely:

```bash
curl -G "http://localhost:3000/api/schedule" \
  --data-urlencode "group=ИСП-9.15" \
  --data-urlencode "date=2026-02-14"
```

### `POST /api/sync`
Starts a manual synchronization.

### `GET /api/sync/status`
Returns current sync state, last error (if any), and latest run metadata.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `MONGO_URI` | `mongodb://mongo:27017/omacademy_schedule` | MongoDB connection string |
| `SOURCE_BASE_URL` | `https://omacademy.ru/rasp-new/Website-students/` | Source website base URL |
| `SYNC_CRON` | `0 5 * * *` | Daily cron expression |
| `SYNC_TIMEZONE` | `Asia/Omsk` | Timezone for cron schedule |
| `RUN_SYNC_ON_STARTUP` | `true` | Run synchronization on backend startup |
| `HTTP_TIMEOUT_MS` | `20000` | HTTP timeout for source requests |
| `MAX_CONCURRENT_REQUESTS` | `5` | Concurrent requests while parsing group pages |
| `MAX_BOT_ENABLED` | `false` | Enable MAX messenger bot integration |
| `MAX_BOT_TOKEN` | `` | MAX bot token |
| `MAX_API_BASE_URL` | `https://platform-api.max.ru` | MAX API base URL |
| `MAX_WEBHOOK_PATH` | `/webhooks/max` | Express route for incoming MAX webhook updates |
| `MAX_WEBHOOK_SECRET` | `` | Secret value expected in webhook request headers |
| `MAX_WEBHOOK_SECRET_HEADER` | `x-max-bot-api-secret` | Header name used to read webhook secret |
| `MAX_WEBHOOK_PUBLIC_URL` | `` | Public base URL used by webhook registration scripts |
| `MAX_ADMIN_USER_IDS` | `` | Comma-separated MAX user IDs allowed to run `/sync` |

## Data Model (MongoDB)

### `groups`
- `code`
- `name`
- `href`
- `url`
- `lastSeenSyncId`
- `sourceUpdatedAt`
- `updatedAt`

### `teachers`
- `key`
- `code`
- `name`
- `href`
- `url`
- `lastSeenSyncId`
- `sourceUpdatedAt`
- `updatedAt`

### `lessons`
- `syncId`
- `groupCode`
- `groupName`
- `date`
- `dayLabel`
- `lessonNumber`
- `columnIndex`
- `subject`
- `room`
- `teacher`
- `sourceUrl`
- `createdAt`

### `meta`
- `_id: "schedule"`
- `activeSyncId`
- `sourceUpdatedAt`
- `updatedAt`

### `syncRuns`
- run history with status (`running`, `success`, `failed`)
- trigger source (`startup`, `cron`, `manual`, `cli`)
- start/finish timestamps

## Project Structure

```text
src/
  config.js
  db.js
  logger.js
  scraper.js
  repository.js
  syncService.js
  server.js
  manualSync.js
  max/
    apiClient.js
    botService.js
    webhook.js
    userPrefsRepository.js
    registerWebhook.js
    listWebhooks.js
    deleteWebhook.js
```

## Notes

- The source website can change markup at any time; parser updates may be required.
- `groupCode` filtering is recommended over `group` for stability.
- If you use Zsh, always quote URLs containing `&` in curl commands.

## Contributing

Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a Pull Request.

## License

This project is licensed under the MIT License. See [`LICENSE`](./LICENSE).
