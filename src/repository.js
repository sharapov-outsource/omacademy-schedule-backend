class ScheduleRepository {
  /**
   * @param {import("mongodb").Db} db
   */
  constructor(db) {
    this.db = db;
    this.groups = db.collection("groups");
    this.teachers = db.collection("teachers");
    this.lessons = db.collection("lessons");
    this.reminderLogs = db.collection("reminderLogs");
    this.meta = db.collection("meta");
    this.syncRuns = db.collection("syncRuns");
  }

  /**
   * Create and maintain MongoDB indexes required for query performance and deduplication.
   *
   * @returns {Promise<void>}
   */
  async ensureIndexes() {
    // Groups are uniquely identified by code from cgXXX.htm.
    await this.groups.createIndex({ code: 1 }, { unique: true, name: "uniq_group_code" });
    await this.groups.createIndex({ lastSeenSyncId: 1, name: 1 });
    await this.teachers.createIndex({ key: 1 }, { unique: true, name: "uniq_teacher_key" });
    await this.teachers.createIndex({ lastSeenSyncId: 1, name: 1 });

    await this.lessons.createIndex(
      {
        syncId: 1,
        groupCode: 1,
        date: 1,
        lessonNumber: 1,
        columnIndex: 1,
        subject: 1,
        room: 1,
        teacher: 1
      },
      { unique: true, name: "uniq_lesson_by_sync" }
    );
    await this.lessons.createIndex({ syncId: 1, groupName: 1, date: 1, lessonNumber: 1 });
    await this.lessons.createIndex({ syncId: 1, teacher: 1 });
    await this.lessons.createIndex({ syncId: 1, room: 1 });
    await this.reminderLogs.createIndex({ reminderKey: 1 }, { unique: true, name: "uniq_reminder_key" });
    await this.reminderLogs.createIndex({ createdAt: -1 }, { name: "idx_reminder_created_at" });

    await this.syncRuns.createIndex({ startedAt: -1 });
  }

  /**
   * Persist start metadata for a sync run.
   *
   * @param {string} syncId
   * @param {string} trigger
   * @returns {Promise<void>}
   */
  async startSyncRun(syncId, trigger) {
    await this.syncRuns.insertOne({
      syncId,
      trigger,
      status: "running",
      startedAt: new Date()
    });
  }

  /**
   * Mark a sync run as completed (success or failure).
   *
   * @param {string} syncId
   * @param {Record<string, any>} payload
   * @returns {Promise<void>}
   */
  async finishSyncRun(syncId, payload) {
    await this.syncRuns.updateOne(
      { syncId },
      {
        $set: {
          ...payload,
          finishedAt: new Date()
        }
      }
    );
  }

  /**
   * Store a complete synchronization snapshot and promote it as active.
   *
   * @param {{syncId: string, groups: Array<Record<string, any>>, teachers?: Array<Record<string, any>>, lessons: Array<Record<string, any>>, sourceUpdatedAt: string|null}} params
   * @returns {Promise<void>}
   */
  async saveSnapshot({ syncId, groups, teachers = [], lessons, sourceUpdatedAt }) {
    const now = new Date();

    if (groups.length > 0) {
      await this.groups.bulkWrite(
        groups.map((group) => ({
          updateOne: {
            filter: { code: group.code },
            update: {
              $set: {
                name: group.name,
                href: group.href,
                url: group.url,
                lastSeenSyncId: syncId,
                sourceUpdatedAt: sourceUpdatedAt ? new Date(sourceUpdatedAt) : null,
                updatedAt: now
              }
            },
            upsert: true
          }
        })),
        { ordered: false }
      );
    }

    if (teachers.length > 0) {
      await this.teachers.bulkWrite(
        teachers.map((teacher) => ({
          updateOne: {
            filter: { key: teacher.key },
            update: {
              $set: {
                key: teacher.key,
                code: teacher.code || null,
                name: teacher.name,
                href: teacher.href || null,
                url: teacher.url || null,
                lastSeenSyncId: syncId,
                sourceUpdatedAt: sourceUpdatedAt ? new Date(sourceUpdatedAt) : null,
                updatedAt: now
              }
            },
            upsert: true
          }
        })),
        { ordered: false }
      );
    }

    if (lessons.length > 0) {
      await this.lessons.bulkWrite(
        lessons.map((lesson) => ({
          updateOne: {
            filter: {
              syncId,
              groupCode: lesson.groupCode,
              date: lesson.date,
              lessonNumber: lesson.lessonNumber,
              columnIndex: lesson.columnIndex,
              subject: lesson.subject,
              room: lesson.room,
              teacher: lesson.teacher
            },
            update: {
              // Keep inserts idempotent within the same sync run.
              $setOnInsert: {
                ...lesson,
                syncId,
                createdAt: now
              }
            },
            upsert: true
          }
        })),
        { ordered: false }
      );
    }

    await this.meta.updateOne(
      { _id: "schedule" },
      {
        $set: {
          activeSyncId: syncId,
          sourceUpdatedAt: sourceUpdatedAt ? new Date(sourceUpdatedAt) : null,
          updatedAt: now
        }
      },
      { upsert: true }
    );

    // Keep only the currently active snapshot for fast read queries.
    await this.lessons.deleteMany({ syncId: { $ne: syncId } });
    await this.groups.deleteMany({ lastSeenSyncId: { $ne: syncId } });
    await this.teachers.deleteMany({ lastSeenSyncId: { $ne: syncId } });
  }

  /**
   * Get metadata for the currently active schedule snapshot.
   *
   * @returns {Promise<Record<string, any>|null>}
   */
  async getActiveSyncMeta() {
    return this.meta.findOne({ _id: "schedule" });
  }

  /**
   * Get active groups from the latest synchronized snapshot.
   *
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async getActiveGroups() {
    const meta = await this.getActiveSyncMeta();
    if (!meta?.activeSyncId) return [];

    return this.groups
      .find({ lastSeenSyncId: meta.activeSyncId })
      .sort({ name: 1 })
      .toArray();
  }

  /**
   * Get active teachers from the latest synchronized snapshot.
   *
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async getActiveTeachers() {
    const meta = await this.getActiveSyncMeta();
    if (!meta?.activeSyncId) return [];

    return this.teachers
      .find({ lastSeenSyncId: meta.activeSyncId })
      .sort({ name: 1 })
      .toArray();
  }

  /**
   * Get lessons from the active snapshot with optional exact-match filters.
   *
   * @param {{group?: string, groupCode?: string|number, date?: string, teacher?: string, room?: string}} [filters]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async getActiveLessons(filters = {}) {
    const meta = await this.getActiveSyncMeta();
    if (!meta?.activeSyncId) return [];

    const query = { syncId: meta.activeSyncId };

    // Exact-match filters for predictable API behavior.
    if (filters.group) {
      query.groupName = filters.group;
      // Exclude synthetic teacher-page rows from group queries.
      query.groupCode = { $not: /^tp:/ };
    }
    if (filters.groupCode) query.groupCode = String(filters.groupCode);
    if (filters.date) query.date = filters.date;
    if (filters.teacher) query.teacher = filters.teacher;
    if (filters.room) query.room = filters.room;

    return this.lessons
      .find(query)
      .sort({ date: 1, lessonNumber: 1, groupName: 1, columnIndex: 1 })
      .toArray();
  }

  /**
   * Get the latest synchronization run record.
   *
   * @returns {Promise<Record<string, any>|null>}
   */
  async getLastSyncRun() {
    return this.syncRuns.find().sort({ startedAt: -1 }).limit(1).next();
  }

  /**
   * Delete old lessons from active snapshot.
   * Keeps lessons with `date >= keepFromDate`.
   *
   * @param {string} keepFromDate
   * @returns {Promise<number>} deleted documents count
   */
  async deleteActiveLessonsOlderThan(keepFromDate) {
    const meta = await this.getActiveSyncMeta();
    if (!meta?.activeSyncId) return 0;

    const result = await this.lessons.deleteMany({
      syncId: meta.activeSyncId,
      date: { $lt: keepFromDate }
    });

    return result?.deletedCount || 0;
  }

  /**
   * Persist reminder delivery marker and skip duplicates.
   *
   * @param {{reminderKey: string, userId: string, role: string, daysBefore: number, date: string, lessonNumber: number, targetRef: string}} payload
   * @returns {Promise<boolean>} true when inserted, false when duplicate
   */
  async registerReminderSend(payload) {
    try {
      await this.reminderLogs.insertOne({
        ...payload,
        createdAt: new Date()
      });
      return true;
    } catch (error) {
      if (error && error.code === 11000) return false;
      throw error;
    }
  }
}

module.exports = { ScheduleRepository };
