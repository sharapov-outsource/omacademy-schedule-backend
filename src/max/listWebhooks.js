const config = require("../config");
const { MaxApiClient } = require("./apiClient");

(async () => {
  if (!config.maxBotToken) {
    throw new Error("MAX_BOT_TOKEN is required");
  }

  const api = new MaxApiClient({
    token: config.maxBotToken,
    apiBaseUrl: config.maxApiBaseUrl,
    timeoutMs: config.httpTimeoutMs
  });

  const result = await api.getSubscriptions();
  console.log(JSON.stringify(result, null, 2));
})();
