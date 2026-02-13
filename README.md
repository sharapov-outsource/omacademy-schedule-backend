# OmAcademy Schedule Backend

Automated backend service that parses the OmAcademy schedule website, extracts lessons for all groups, stores data in MongoDB, and refreshes data every day.

Source website:
- `https://omacademy.ru/rasp-new/Website-students/cg.htm`

## Features

- Parses all groups from `cg.htm`
- Opens each group page (`cgXXX.htm`) and extracts lessons
- Stores normalized data in MongoDB (NoSQL)
- Keeps an active snapshot of the latest sync
- Runs daily automatic sync via cron
- Supports manual sync via API endpoint
- Exposes REST API for schedule queries

## What Gets Parsed

For each lesson, the backend saves:
- group code (e.g. `60`)
- group name (e.g. `ИСП-9.15`)
- date (`YYYY-MM-DD`)
- day label (e.g. `Сб-1`)
- lesson number (e.g. `2`)
- subject (e.g. `МДК.03.02 Управление проектами (Лек)`)
- room (e.g. `207`, `дист. обуч`, `обр.портал`)
- teacher (e.g. `Кочемайкина Лариса Адамовна`)

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

## API

Base URL: `http://localhost:3000`

### `GET /health`
Returns service health and current active sync ID.

### `GET /api/groups`
Returns active list of groups.

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

## Data Model (MongoDB)

### `groups`
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
```

## Notes

- The source website can change markup at any time; parser updates may be required.
- `groupCode` filtering is recommended over `group` for stability.
- If you use Zsh, always quote URLs containing `&` in curl commands.

## Contributing

Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a Pull Request.

## License

This project is licensed under the MIT License. See [`LICENSE`](./LICENSE).
