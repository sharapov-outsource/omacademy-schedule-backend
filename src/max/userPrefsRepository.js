class MaxUserPrefsRepository {
  /**
   * @param {import("mongodb").Db} db
   */
  constructor(db) {
    this.collection = db.collection("maxUserPrefs");
  }

  /**
   * Ensure indexes for fast user preference lookup.
   *
   * @returns {Promise<void>}
   */
  async ensureIndexes() {
    await this.collection.createIndex({ userId: 1 }, { unique: true, name: "uniq_max_user_id" });
  }

  /**
   * Get saved bot preferences for a user.
   *
   * @param {string|number} userId
   * @returns {Promise<Record<string, any>|null>}
   */
  async getByUserId(userId) {
    return this.collection.findOne({ userId: String(userId) });
  }

  /**
   * Save or update default group for a user.
   *
   * @param {string|number} userId
   * @param {{code: string, name: string}} group
   * @returns {Promise<void>}
   */
  async setPreferredGroup(userId, group) {
    await this.collection.updateOne(
      { userId: String(userId) },
      {
        $set: {
          userId: String(userId),
          preferredGroupCode: group.code,
          preferredGroupName: group.name,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  }
}

module.exports = { MaxUserPrefsRepository };
