const config = require("../config");
const { MaxApiClient } = require("./apiClient");

(async () => {
  if (!config.maxBotToken) {
    throw new Error("MAX_BOT_TOKEN is required");
  }

  if (!config.maxWebhookPublicUrl) {
    throw new Error("MAX_WEBHOOK_PUBLIC_URL is required");
  }

  const api = new MaxApiClient({
    token: config.maxBotToken,
    apiBaseUrl: config.maxApiBaseUrl,
    timeoutMs: config.httpTimeoutMs
  });

  const url = new URL(config.maxWebhookPath, config.maxWebhookPublicUrl).href;

  const result = await api.createSubscription({
    url,
    secret: config.maxWebhookSecret || undefined,
    updateTypes: ["message_created", "bot_started", "message_callback"]
  });

  console.log(JSON.stringify({ ok: true, url, result }, null, 2));
})();
