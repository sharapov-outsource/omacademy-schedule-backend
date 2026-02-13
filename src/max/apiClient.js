const axios = require("axios");

class MaxApiClient {
  /**
   * @param {{token: string, apiBaseUrl?: string, timeoutMs?: number}} options
   */
  constructor({ token, apiBaseUrl = "https://platform-api.max.ru", timeoutMs = 20000 }) {
    const normalizedToken = String(token || "")
      .trim()
      .replace(/^Bearer\s+/i, "");

    this.token = token;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.http = axios.create({
      baseURL: this.apiBaseUrl,
      timeout: timeoutMs,
      headers: {
        // MAX API expects: Authorization: <token> (without Bearer prefix).
        Authorization: normalizedToken,
        "Content-Type": "application/json"
      }
    });
  }

  /**
   * Get current bot account details from MAX API.
   *
   * @returns {Promise<Record<string, any>>}
   */
  async getMe() {
    const { data } = await this.http.get("/me");
    return data;
  }

  /**
   * Send a text message to a user or chat.
   *
   * @param {{userId?: string|number, chatId?: string|number, text: string, format?: string, attachments?: Array<Record<string, any>>, notify?: boolean}} params
   * @returns {Promise<Record<string, any>>}
   */
  async sendText({ userId, chatId, text, format = "markdown", attachments, notify = true }) {
    const params = {};
    if (chatId !== undefined && chatId !== null) params.chat_id = chatId;
    if (userId !== undefined && userId !== null) params.user_id = userId;

    if (!params.chat_id && !params.user_id) {
      throw new Error("MAX target is missing: either chatId or userId is required");
    }

    const payload = {
      text,
      format,
      notify
    };

    if (Array.isArray(attachments) && attachments.length > 0) {
      payload.attachments = attachments;
    }

    const { data } = await this.http.post("/messages", payload, { params });

    return data;
  }

  /**
   * Answer a keyboard callback click.
   *
   * @param {{callbackId: string, notification?: string, message?: Record<string, any>}} params
   * @returns {Promise<Record<string, any>>}
   */
  async answerCallback({ callbackId, notification, message }) {
    if (!callbackId) {
      throw new Error("MAX callbackId is required for /answers");
    }

    const payload = {};
    if (notification) payload.notification = notification;
    if (message) payload.message = message;

    const { data } = await this.http.post("/answers", payload, {
      params: { callback_id: callbackId }
    });

    return data;
  }

  /**
   * Register a webhook subscription for bot updates.
   *
   * @param {{url: string, secret?: string, updateTypes: string[]}} params
   * @returns {Promise<Record<string, any>>}
   */
  async createSubscription({ url, secret, updateTypes }) {
    const payload = {
      url,
      update_types: updateTypes
    };

    if (secret) payload.secret = secret;

    const { data } = await this.http.post("/subscriptions", payload);
    return data;
  }

  /**
   * List currently registered webhook subscriptions.
   *
   * @returns {Promise<Record<string, any>>}
   */
  async getSubscriptions() {
    const { data } = await this.http.get("/subscriptions");
    return data;
  }

  /**
   * Delete a webhook subscription by URL.
   *
   * @param {string} url
   * @returns {Promise<Record<string, any>>}
   */
  async deleteSubscription(url) {
    const { data } = await this.http.delete("/subscriptions", {
      params: { url }
    });
    return data;
  }
}

module.exports = { MaxApiClient };
