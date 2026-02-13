const dotenv = require("dotenv");

dotenv.config();

function toBool(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === "true";
}

function toInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

module.exports = {
  port: toInt(process.env.PORT, 3000),
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/omacademy_schedule",
  sourceBaseUrl:
    process.env.SOURCE_BASE_URL || "https://omacademy.ru/rasp-new/Website-students/",
  syncCron: process.env.SYNC_CRON || "0 5 * * *",
  syncTimezone: process.env.SYNC_TIMEZONE || "Asia/Omsk",
  runSyncOnStartup: toBool(process.env.RUN_SYNC_ON_STARTUP, true),
  httpTimeoutMs: toInt(process.env.HTTP_TIMEOUT_MS, 20000),
  maxConcurrentRequests: toInt(process.env.MAX_CONCURRENT_REQUESTS, 5)
};
