class ScheduleRepository {
  constructor(db) {
    this.db = db;
    this.groups = db.collection("groups");
    this.lessons = db.collection("lessons");
    this.meta = db.collection("meta");
    this.syncRuns = db.collection("syncRuns");
  }

  async ensureIndexes() {
    // Groups are uniquely identified by code from cgXXX.htm.
    await this.groups.createIndex({ code: 1 }, { unique: true, name: "uniq_group_code" });
    await this.groups.createIndex({ lastSeenSyncId: 1, name: 1 });

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

    await this.syncRuns.createIndex({ startedAt: -1 });
  }

  async startSyncRun(syncId, trigger) {
    await this.syncRuns.insertOne({
      syncId,
      trigger,
      status: "running",
      startedAt: new Date()
    });
  }

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

  async saveSnapshot({ syncId, groups, lessons, sourceUpdatedAt }) {
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
  }

  async getActiveSyncMeta() {
    return this.meta.findOne({ _id: "schedule" });
  }

  async getActiveGroups() {
    const meta = await this.getActiveSyncMeta();
    if (!meta?.activeSyncId) return [];

    return this.groups
      .find({ lastSeenSyncId: meta.activeSyncId })
      .sort({ name: 1 })
      .toArray();
  }

  async getActiveLessons(filters = {}) {
    const meta = await this.getActiveSyncMeta();
    if (!meta?.activeSyncId) return [];

    const query = { syncId: meta.activeSyncId };

    // Exact-match filters for predictable API behavior.
    if (filters.group) query.groupName = filters.group;
    if (filters.groupCode) query.groupCode = String(filters.groupCode);
    if (filters.date) query.date = filters.date;
    if (filters.teacher) query.teacher = filters.teacher;
    if (filters.room) query.room = filters.room;

    return this.lessons
      .find(query)
      .sort({ date: 1, lessonNumber: 1, groupName: 1, columnIndex: 1 })
      .toArray();
  }

  async getLastSyncRun() {
    return this.syncRuns.find().sort({ startedAt: -1 }).limit(1).next();
  }
}

module.exports = { ScheduleRepository };
