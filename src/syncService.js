class SyncService {
  /**
   * @param {{scraper: any, repository: any, logger: any}} deps
   */
  constructor({ scraper, repository, logger }) {
    this.scraper = scraper;
    this.repository = repository;
    this.logger = logger;
    this.running = false;
    this.lastError = null;
    this.lastResult = null;
  }

  /**
   * Check whether synchronization is currently running.
   *
   * @returns {boolean}
   */
  isRunning() {
    return this.running;
  }

  /**
   * Get in-memory sync state for diagnostics endpoints.
   *
   * @returns {{running: boolean, lastError: string|null, lastResult: Record<string, any>|null}}
   */
  getState() {
    return {
      running: this.running,
      lastError: this.lastError,
      lastResult: this.lastResult
    };
  }

  /**
   * Run one full synchronization cycle.
   *
   * @param {string} [trigger="manual"]
   * @returns {Promise<Record<string, any>>}
   */
  async run(trigger = "manual") {
    // Prevent overlapping sync jobs from cron/manual/startup triggers.
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

      // Parse every group page, then atomically publish a new active snapshot.
      const { groups: normalizedGroups, lessons } = await this.scraper.fetchAllLessons(groups);
      const teachers = await this.buildTeachersSnapshot(lessons);

      await this.repository.saveSnapshot({
        syncId,
        groups: normalizedGroups,
        teachers,
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
        teachersCount: teachers.length,
        lessonsCount: lessons.length,
        sourceUpdatedAt
      };

      await this.repository.finishSyncRun(syncId, {
        status: "success",
        groupsCount: result.groupsCount,
        teachersCount: result.teachersCount,
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

  /**
   * Build teacher snapshot from source list and fallback values from parsed lessons.
   *
   * @param {Array<Record<string, any>>} lessons
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async buildTeachersSnapshot(lessons) {
    const map = new Map();

    try {
      const payload = await this.scraper.fetchTeachers();
      payload.teachers.forEach((teacher) => {
        const key = `cp:${teacher.code}`;
        map.set(key, {
          key,
          code: teacher.code,
          name: teacher.name,
          href: teacher.href,
          url: teacher.url
        });
      });
    } catch (error) {
      // Teacher list should not block sync, because lessons already include teacher names.
      this.logger.warn("Teacher list fetch failed, using lessons fallback", {
        error: error.message
      });
    }

    lessons.forEach((lesson) => {
      const teacherName = String(lesson.teacher || "").trim();
      if (!teacherName) return;

      const normalizedName = teacherName.toLowerCase();
      const key = `name:${normalizedName}`;
      if (map.has(key)) return;

      map.set(key, {
        key,
        code: null,
        name: teacherName,
        href: null,
        url: null
      });
    });

    return Array.from(map.values());
  }
}

module.exports = { SyncService };
