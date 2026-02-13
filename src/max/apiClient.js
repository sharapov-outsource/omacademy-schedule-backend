const axios = require("axios");

class MaxApiClient {
  /**
   * @param {{token: string, apiBaseUrl?: string, timeoutMs?: number}} options
   */
  constructor({ token, apiBaseUrl = "https://platform-api.max.ru", timeoutMs = 20000 }) {
    this.token = token;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.http = axios.create({
      baseURL: this.apiBaseUrl,
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${this.token}`,
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
   * @param {{userId?: string|number, chatId?: string|number, text: string, format?: string}} params
   * @returns {Promise<Record<string, any>>}
   */
  async sendText({ userId, chatId, text, format = "markdown" }) {
    const params = {};
    if (chatId !== undefined && chatId !== null) params.chat_id = chatId;
    if (userId !== undefined && userId !== null) params.user_id = userId;

    if (!params.chat_id && !params.user_id) {
      throw new Error("MAX target is missing: either chatId or userId is required");
    }

    const { data } = await this.http.post(
      "/messages",
      {
        text,
        format,
        notify: true
      },
      { params }
    );

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
