const express = require("express");
const cron = require("node-cron");

const config = require("./config");
const logger = require("./logger");
const { connectMongo } = require("./db");
const { OmAcademyScraper } = require("./scraper");
const { ScheduleRepository } = require("./repository");
const { SyncService } = require("./syncService");
const { MaxBotService } = require("./max/botService");
const { registerMaxWebhookRoute } = require("./max/webhook");

async function bootstrap() {
  // Initialize infrastructure first: DB connection, indexes, scraper, sync service.
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
  let maxBotService = null;

  const app = express();
  app.use(express.json());

  if (config.maxBotEnabled) {
    if (!config.maxBotToken) {
      throw new Error("MAX_BOT_ENABLED=true but MAX_BOT_TOKEN is empty");
    }

    maxBotService = new MaxBotService({
      db,
      scheduleRepository: repository,
      syncService,
      logger,
      token: config.maxBotToken,
      apiBaseUrl: config.maxApiBaseUrl,
      timeoutMs: config.httpTimeoutMs,
      timezone: config.syncTimezone,
      adminUserIds: config.maxAdminUserIds
    });

    await maxBotService.init();
    registerMaxWebhookRoute(app, {
      botService: maxBotService,
      logger,
      config: {
        webhookPath: config.maxWebhookPath,
        webhookSecret: config.maxWebhookSecret,
        webhookSecretHeader: config.maxWebhookSecretHeader
      }
    });
  }

  // Liveness endpoint plus active snapshot metadata.
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

  app.get("/api/teachers", async (req, res) => {
    const teachers = await repository.getActiveTeachers();
    const query = String(req.query.query || "").trim().toLowerCase();
    const filtered = query
      ? teachers.filter((teacher) => String(teacher.name || "").toLowerCase().includes(query))
      : teachers;
    res.json({ count: filtered.length, teachers: filtered });
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
      // Fire-and-log cron sync; do not crash the server on sync failures.
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
    if (config.maxBotEnabled) {
      logger.info(`MAX webhook enabled on path: ${config.maxWebhookPath}`);
    }
  });

  async function shutdown(signal) {
    // Graceful shutdown: stop accepting requests, then close DB connection.
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
