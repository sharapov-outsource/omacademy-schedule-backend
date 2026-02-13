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
        },
        $unset: {
          pendingAction: "",
          pendingUpdatedAt: ""
        }
      },
      { upsert: true }
    );
  }

  /**
   * Save or update default teacher for a user.
   *
   * @param {string|number} userId
   * @param {{name: string, code?: string|null, key?: string|null}} teacher
   * @returns {Promise<void>}
   */
  async setPreferredTeacher(userId, teacher) {
    await this.collection.updateOne(
      { userId: String(userId) },
      {
        $set: {
          userId: String(userId),
          preferredTeacherName: teacher.name,
          preferredTeacherCode: teacher.code || null,
          preferredTeacherKey: teacher.key || null,
          updatedAt: new Date()
        },
        $unset: {
          pendingAction: "",
          pendingUpdatedAt: ""
        }
      },
      { upsert: true }
    );
  }

  /**
   * Set user role for bot mode selection.
   *
   * @param {string|number} userId
   * @param {"student"|"teacher"} role
   * @returns {Promise<void>}
   */
  async setRole(userId, role) {
    await this.collection.updateOne(
      { userId: String(userId) },
      {
        $set: {
          userId: String(userId),
          role,
          updatedAt: new Date()
        },
        $unset: {
          pendingAction: "",
          pendingUpdatedAt: ""
        }
      },
      { upsert: true }
    );
  }

  /**
   * Save pending multi-step action for user.
   *
   * @param {string|number} userId
   * @param {string} action
   * @returns {Promise<void>}
   */
  async setPendingAction(userId, action) {
    await this.collection.updateOne(
      { userId: String(userId) },
      {
        $set: {
          userId: String(userId),
          pendingAction: action,
          pendingUpdatedAt: new Date(),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  }

  /**
   * Clear pending multi-step action.
   *
   * @param {string|number} userId
   * @returns {Promise<void>}
   */
  async clearPendingAction(userId) {
    await this.collection.updateOne(
      { userId: String(userId) },
      {
        $unset: {
          pendingAction: "",
          pendingUpdatedAt: ""
        },
        $set: { updatedAt: new Date() }
      }
    );
  }
}

module.exports = { MaxUserPrefsRepository };
