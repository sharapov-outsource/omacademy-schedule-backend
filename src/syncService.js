function getIsoDateInTimezone(timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function shiftIsoDate(isoDate, deltaDays) {
  const base = new Date(`${isoDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}

class SyncService {
  /**
   * @param {{scraper: any, repository: any, logger: any, timezone?: string}} deps
   */
  constructor({ scraper, repository, logger, timezone }) {
    this.scraper = scraper;
    this.repository = repository;
    this.logger = logger;
    this.timezone = timezone || "Asia/Omsk";
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
   * Delete lessons older than yesterday in configured timezone.
   *
   * @returns {Promise<{keepFromDate: string, deletedCount: number}>}
   */
  async cleanupOldLessons() {
    const today = getIsoDateInTimezone(this.timezone);
    const keepFromDate = shiftIsoDate(today, -1);
    const deletedCount = await this.repository.deleteActiveLessonsOlderThan(keepFromDate);

    if (deletedCount > 0) {
      this.logger.info("Old lessons cleanup finished", { keepFromDate, deletedCount });
    }

    return { keepFromDate, deletedCount };
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

      // Parse every group page, then enrich with teacher-page-only lessons/events.
      const { groups: normalizedGroups, lessons: groupLessons } = await this.scraper.fetchAllLessons(groups);
      let teachersDirectory = [];
      let teacherLessons = [];
      try {
        const teachersPayload = await this.scraper.fetchTeachers();
        teachersDirectory = teachersPayload.teachers || [];
        const teacherLessonsPayload = await this.scraper.fetchAllTeacherLessons(teachersDirectory);
        teacherLessons = teacherLessonsPayload.lessons || [];
      } catch (error) {
        this.logger.warn("Teacher pages fetch failed, continuing with group lessons only", {
          error: error.message
        });
      }
      const lessons = [...groupLessons, ...teacherLessons];
      const teachers = await this.buildTeachersSnapshot(lessons, teachersDirectory);

      await this.repository.saveSnapshot({
        syncId,
        groups: normalizedGroups,
        teachers,
        lessons,
        sourceUpdatedAt
      });
      const cleanup = await this.cleanupOldLessons();

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
        teacherLessonsCount: teacherLessons.length,
        sourceUpdatedAt,
        cleanup
      };

      await this.repository.finishSyncRun(syncId, {
        status: "success",
        groupsCount: result.groupsCount,
        teachersCount: result.teachersCount,
        lessonsCount: result.lessonsCount,
        teacherLessonsCount: result.teacherLessonsCount,
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
   * @param {Array<Record<string, any>>} sourceTeachers
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async buildTeachersSnapshot(lessons, sourceTeachers = []) {
    const map = new Map();

    sourceTeachers.forEach((teacher) => {
      const key = `cp:${teacher.code}`;
      map.set(key, {
        key,
        code: teacher.code,
        name: teacher.name,
        href: teacher.href,
        url: teacher.url
      });
    });

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
