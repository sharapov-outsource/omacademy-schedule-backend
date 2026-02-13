function headerValue(req, name) {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function isSecretValid(req, config) {
  if (!config.webhookSecret) return true;

  const candidates = [
    config.webhookSecretHeader,
    "x-max-bot-api-secret",
    "x-webhook-secret",
    "x-bot-secret"
  ];

  for (const headerName of candidates) {
    const incoming = headerValue(req, headerName);
    if (incoming && incoming === config.webhookSecret) return true;
  }

  return false;
}

/**
 * Register MAX webhook endpoint on the Express app.
 *
 * @param {import("express").Express} app
 * @param {{botService: {handleUpdate: (update: Record<string, any>) => Promise<void>}, logger: any, config: {webhookPath: string, webhookSecret?: string, webhookSecretHeader?: string}}} deps
 * @returns {void}
 */
function registerMaxWebhookRoute(app, { botService, logger, config }) {
  app.post(config.webhookPath, async (req, res) => {
    try {
      if (!isSecretValid(req, config)) {
        res.status(401).json({ ok: false, error: "invalid webhook secret" });
        return;
      }

      await botService.handleUpdate(req.body);
      res.json({ ok: true });
    } catch (error) {
      logger.error("MAX webhook handler failed", { error: error.message });
      res.status(500).json({ ok: false, error: "internal error" });
    }
  });
}

module.exports = { registerMaxWebhookRoute };
