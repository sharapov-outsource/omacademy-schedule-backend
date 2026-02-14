const config = require("./config");
const logger = require("./logger");
const { connectMongo } = require("./db");
const { OmAcademyScraper } = require("./scraper");
const { ScheduleRepository } = require("./repository");
const { SyncService } = require("./syncService");

// CLI entry point to run one synchronization cycle outside the HTTP server.
(async () => {
  const client = await connectMongo(config.mongoUri);
  const db = client.db();
  const repository = new ScheduleRepository(db);
  await repository.ensureIndexes();

  const scraper = new OmAcademyScraper({
    baseUrl: config.sourceBaseUrl,
    timeoutMs: config.httpTimeoutMs,
    maxConcurrentRequests: config.maxConcurrentRequests
  });

  const syncService = new SyncService({
    scraper,
    repository,
    logger,
    timezone: config.syncTimezone
  });
  const result = await syncService.run("cli");
  console.log(JSON.stringify(result, null, 2));

  await client.close();
})();
