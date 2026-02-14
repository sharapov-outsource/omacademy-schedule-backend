const dotenv = require("dotenv");

dotenv.config();

// Parse boolean-like env vars with a safe default.
function toBool(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === "true";
}

// Parse integer env vars and fall back on invalid values.
function toInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

// Parse comma-separated env var into trimmed non-empty values.
function toList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Centralized application config loaded from environment variables.
module.exports = {
  port: toInt(process.env.PORT, 3000),
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/omacademy_schedule",
  sourceBaseUrl:
    process.env.SOURCE_BASE_URL || "https://omacademy.ru/rasp-new/Website-students/",
  syncCron: process.env.SYNC_CRON || "0 5 * * *",
  syncTimezone: process.env.SYNC_TIMEZONE || "Asia/Omsk",
  runSyncOnStartup: toBool(process.env.RUN_SYNC_ON_STARTUP, true),
  httpTimeoutMs: toInt(process.env.HTTP_TIMEOUT_MS, 20000),
  maxConcurrentRequests: toInt(process.env.MAX_CONCURRENT_REQUESTS, 5),
  maxBotEnabled: toBool(process.env.MAX_BOT_ENABLED, false),
  maxBotToken: process.env.MAX_BOT_TOKEN || "",
  maxApiBaseUrl: process.env.MAX_API_BASE_URL || "https://platform-api.max.ru",
  maxWebhookPath: process.env.MAX_WEBHOOK_PATH || "/webhooks/max",
  maxWebhookSecret: process.env.MAX_WEBHOOK_SECRET || "",
  maxWebhookSecretHeader: process.env.MAX_WEBHOOK_SECRET_HEADER || "x-max-bot-api-secret",
  maxWebhookPublicUrl: process.env.MAX_WEBHOOK_PUBLIC_URL || "",
  maxAdminUserIds: toList(process.env.MAX_ADMIN_USER_IDS),
  reminderEnabled: toBool(process.env.REMINDER_ENABLED, true),
  reminderCron: process.env.REMINDER_CRON || "* * * * *",
  reminderLessonStartTimes:
    process.env.REMINDER_LESSON_START_TIMES || "1=08:00,2=10:00,3=12:00,4=14:00,5=16:00,6=17:50",
  lessonPartMinutes: toInt(process.env.LESSON_PART_MINUTES, 45),
  midLessonBreakMinutes: toInt(process.env.MID_LESSON_BREAK_MINUTES, 10),
  betweenLessonsBreakMinutes: toInt(process.env.BETWEEN_LESSONS_BREAK_MINUTES, 20)
};
