class MaxBotStatsRepository {
  /**
   * @param {import("mongodb").Db} db
   */
  constructor(db) {
    this.users = db.collection("maxBotUsers");
    this.installs = db.collection("maxBotInstalls");
  }

  /**
   * Ensure indexes for statistics collections.
   *
   * @returns {Promise<void>}
   */
  async ensureIndexes() {
    await this.users.createIndex({ userId: 1 }, { unique: true, name: "uniq_max_stats_user_id" });
    await this.users.createIndex({ lastSeenAt: -1 }, { name: "idx_max_stats_last_seen_at" });
    await this.users.createIndex({ firstStartedAt: -1 }, { name: "idx_max_stats_first_started_at" });

    await this.installs.createIndex({ createdAt: -1 }, { name: "idx_max_installs_created_at" });
    await this.installs.createIndex({ userId: 1, createdAt: -1 }, { name: "idx_max_installs_user_id" });
  }

  /**
   * Mark user as seen in bot activity.
   *
   * @param {{userId: string|number, updateType?: string}} params
   * @returns {Promise<void>}
   */
  async recordUserSeen({ userId, updateType }) {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return;

    const now = new Date();
    await this.users.updateOne(
      { userId: normalizedUserId },
      {
        $setOnInsert: {
          userId: normalizedUserId,
          firstSeenAt: now,
          startedCount: 0
        },
        $set: {
          lastSeenAt: now,
          lastUpdateType: updateType || null,
          updatedAt: now
        }
      },
      { upsert: true }
    );
  }

  /**
   * Record bot install/start event and update per-user counters.
   *
   * @param {{userId?: string|number, chatId?: string|number|null}} params
   * @returns {Promise<void>}
   */
  async recordBotStarted({ userId, chatId }) {
    const now = new Date();
    const normalizedUserId = userId !== undefined && userId !== null ? String(userId) : null;
    const normalizedChatId = chatId !== undefined && chatId !== null ? String(chatId) : null;

    await this.installs.insertOne({
      userId: normalizedUserId,
      chatId: normalizedChatId,
      createdAt: now
    });

    if (!normalizedUserId) return;

    await this.users.updateOne(
      { userId: normalizedUserId },
      {
        $setOnInsert: {
          userId: normalizedUserId,
          firstSeenAt: now,
          firstStartedAt: now,
          startedCount: 0
        },
        $set: {
          lastSeenAt: now,
          lastStartedAt: now,
          updatedAt: now
        },
        $inc: { startedCount: 1 },
        $min: { firstStartedAt: now }
      },
      { upsert: true }
    );
  }

  /**
   * Build summary object for CLI output.
   *
   * @returns {Promise<Record<string, any>>}
   */
  async getSummary() {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      usersWithStart,
      active1d,
      active7d,
      active30d,
      totalInstallEvents,
      installEvents1d,
      installEvents7d,
      installEvents30d,
      firstInstallEvent,
      lastInstallEvent
    ] = await Promise.all([
      this.users.countDocuments({}),
      this.users.countDocuments({ firstStartedAt: { $exists: true } }),
      this.users.countDocuments({ lastSeenAt: { $gte: oneDayAgo } }),
      this.users.countDocuments({ lastSeenAt: { $gte: sevenDaysAgo } }),
      this.users.countDocuments({ lastSeenAt: { $gte: thirtyDaysAgo } }),
      this.installs.countDocuments({}),
      this.installs.countDocuments({ createdAt: { $gte: oneDayAgo } }),
      this.installs.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      this.installs.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
      this.installs.find().sort({ createdAt: 1 }).limit(1).next(),
      this.installs.find().sort({ createdAt: -1 }).limit(1).next()
    ]);

    return {
      generatedAt: now.toISOString(),
      users: {
        total: totalUsers,
        withBotStarted: usersWithStart,
        active1d,
        active7d,
        active30d
      },
      installs: {
        totalEvents: totalInstallEvents,
        events1d: installEvents1d,
        events7d: installEvents7d,
        events30d: installEvents30d,
        firstEventAt: firstInstallEvent?.createdAt?.toISOString() || null,
        lastEventAt: lastInstallEvent?.createdAt?.toISOString() || null
      }
    };
  }
}

module.exports = { MaxBotStatsRepository };
