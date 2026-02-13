class SyncService {
  constructor({ scraper, repository, logger }) {
    this.scraper = scraper;
    this.repository = repository;
    this.logger = logger;
    this.running = false;
    this.lastError = null;
    this.lastResult = null;
  }

  isRunning() {
    return this.running;
  }

  getState() {
    return {
      running: this.running,
      lastError: this.lastError,
      lastResult: this.lastResult
    };
  }

  async run(trigger = "manual") {
    if (this.running) {
      return {
        ok: false,
        skipped: true,
        reason: "sync already running"
      };
    }

    this.running = true;
    this.lastError = null;

    const startedAt = new Date();
    const syncId = startedAt.toISOString();

    try {
      await this.repository.startSyncRun(syncId, trigger);

      this.logger.info(`Sync started (${trigger})`, { syncId });

      const groupsPayload = await this.scraper.fetchGroups();
      const { groups, sourceUpdatedAt } = groupsPayload;

      const { groups: normalizedGroups, lessons } = await this.scraper.fetchAllLessons(groups);

      await this.repository.saveSnapshot({
        syncId,
        groups: normalizedGroups,
        lessons,
        sourceUpdatedAt
      });

      const finishedAt = new Date();
      const result = {
        ok: true,
        syncId,
        trigger,
        startedAt,
        finishedAt,
        groupsCount: normalizedGroups.length,
        lessonsCount: lessons.length,
        sourceUpdatedAt
      };

      await this.repository.finishSyncRun(syncId, {
        status: "success",
        groupsCount: result.groupsCount,
        lessonsCount: result.lessonsCount,
        sourceUpdatedAt: sourceUpdatedAt ? new Date(sourceUpdatedAt) : null
      });

      this.lastResult = result;
      this.logger.info("Sync finished", result);
      return result;
    } catch (error) {
      this.lastError = error.message;
      this.logger.error("Sync failed", { error: error.message, syncId });

      await this.repository.finishSyncRun(syncId, {
        status: "failed",
        error: error.message
      });

      return {
        ok: false,
        syncId,
        trigger,
        error: error.message
      };
    } finally {
      this.running = false;
    }
  }
}

module.exports = { SyncService };
