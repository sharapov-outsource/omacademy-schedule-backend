const express = require("express");
const cron = require("node-cron");

const config = require("./config");
const logger = require("./logger");
const { connectMongo } = require("./db");
const { OmAcademyScraper } = require("./scraper");
const { ScheduleRepository } = require("./repository");
const { SyncService } = require("./syncService");

async function bootstrap() {
  const mongoClient = await connectMongo(config.mongoUri);
  const db = mongoClient.db();

  const repository = new ScheduleRepository(db);
  await repository.ensureIndexes();

  const scraper = new OmAcademyScraper({
    baseUrl: config.sourceBaseUrl,
    timeoutMs: config.httpTimeoutMs,
    maxConcurrentRequests: config.maxConcurrentRequests
  });

  const syncService = new SyncService({ scraper, repository, logger });

  const app = express();
  app.use(express.json());

  app.get("/health", async (req, res) => {
    const meta = await repository.getActiveSyncMeta();
    res.json({
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      activeSyncId: meta?.activeSyncId || null,
      updatedAt: meta?.updatedAt || null
    });
  });

  app.get("/api/groups", async (req, res) => {
    const groups = await repository.getActiveGroups();
    res.json({ count: groups.length, groups });
  });

  app.get("/api/schedule", async (req, res) => {
    const filters = {
      group: req.query.group,
      groupCode: req.query.groupCode,
      date: req.query.date,
      teacher: req.query.teacher,
      room: req.query.room
    };

    const lessons = await repository.getActiveLessons(filters);
    res.json({ count: lessons.length, lessons });
  });

  app.post("/api/sync", async (req, res) => {
    const result = await syncService.run("manual");
    if (!result.ok && !result.skipped) {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  });

  app.get("/api/sync/status", async (req, res) => {
    const state = syncService.getState();
    const meta = await repository.getActiveSyncMeta();
    const lastRun = await repository.getLastSyncRun();

    res.json({
      running: state.running,
      lastError: state.lastError,
      lastResult: state.lastResult,
      activeSyncId: meta?.activeSyncId || null,
      sourceUpdatedAt: meta?.sourceUpdatedAt || null,
      lastRun
    });
  });

  cron.schedule(
    config.syncCron,
    () => {
      syncService.run("cron").catch((error) => {
        logger.error("Cron sync failed", { error: error.message });
      });
    },
    { timezone: config.syncTimezone }
  );

  if (config.runSyncOnStartup) {
    syncService.run("startup").catch((error) => {
      logger.error("Startup sync failed", { error: error.message });
    });
  }

  const server = app.listen(config.port, () => {
    logger.info(`Backend listening on port ${config.port}`);
    logger.info(`Daily sync cron: ${config.syncCron} (${config.syncTimezone})`);
  });

  async function shutdown(signal) {
    logger.warn(`Received ${signal}, shutting down...`);
    server.close(async () => {
      await mongoClient.close();
      process.exit(0);
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
