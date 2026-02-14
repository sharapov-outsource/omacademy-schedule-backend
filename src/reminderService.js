const { MaxApiClient } = require("./max/apiClient");
const { MaxUserPrefsRepository } = require("./max/userPrefsRepository");

function shiftIsoDate(isoDate, deltaDays) {
  const base = new Date(`${isoDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}

function toRuDate(isoDate) {
  const match = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;
  const [, yyyy, mm, dd] = match;
  return `${dd}.${mm}.${yyyy}`;
}

function teacherMatchKey(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const parts = normalized.split(" ").filter(Boolean);
  if (!parts.length) return "";

  const surname = parts[0];
  const initialsRaw = parts.slice(1).join("");
  if (!initialsRaw) return surname;

  if (parts.length >= 3) {
    const nameInitial = parts[1][0] || "";
    const middleInitial = parts[2][0] || "";
    return `${surname}:${nameInitial}${middleInitial}`;
  }

  const twoLetters = initialsRaw.slice(0, 2);
  return `${surname}:${twoLetters}`;
}

function getTimezoneNow(timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const byType = {};
  parts.forEach((part) => {
    byType[part.type] = part.value;
  });

  return {
    isoDate: `${byType.year}-${byType.month}-${byType.day}`,
    hhmm: `${byType.hour}:${byType.minute}`
  };
}

function parseLessonStartTimes(value) {
  const defaults = {
    1: "08:00",
    2: "10:00",
    3: "12:00",
    4: "14:00",
    5: "16:00",
    6: "17:50"
  };

  if (!value) return defaults;

  const map = {};
  String(value)
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .forEach((chunk) => {
      const [left, right] = chunk.split("=");
      const lessonNumber = Number.parseInt(String(left || "").trim(), 10);
      const hhmm = String(right || "").trim();
      if (!Number.isFinite(lessonNumber)) return;
      if (!/^\d{2}:\d{2}$/.test(hhmm)) return;
      map[lessonNumber] = hhmm;
    });

  return Object.keys(map).length > 0 ? map : defaults;
}

class ReminderService {
  /**
   * @param {{
   *  db: import("mongodb").Db,
   *  scheduleRepository: any,
   *  logger: any,
   *  token: string,
   *  apiBaseUrl?: string,
   *  timeoutMs?: number,
   *  timezone: string,
   *  lessonStartTimes?: string
   * }} deps
   */
  constructor({
    db,
    scheduleRepository,
    logger,
    token,
    apiBaseUrl,
    timeoutMs,
    timezone,
    lessonStartTimes
  }) {
    this.logger = logger;
    this.scheduleRepository = scheduleRepository;
    this.timezone = timezone;
    this.lessonStartTimes = parseLessonStartTimes(lessonStartTimes);
    this.running = false;

    this.api = new MaxApiClient({ token, apiBaseUrl, timeoutMs });
    this.userPrefsRepository = new MaxUserPrefsRepository(db);
  }

  /**
   * Execute one reminder tick.
   *
   * @returns {Promise<void>}
   */
  async runTick() {
    if (this.running) return;
    this.running = true;

    try {
      const now = getTimezoneNow(this.timezone);
      const activeLessonNumbers = Object.entries(this.lessonStartTimes)
        .filter(([, hhmm]) => hhmm === now.hhmm)
        .map(([lessonNumber]) => Number.parseInt(lessonNumber, 10))
        .filter((lessonNumber) => Number.isFinite(lessonNumber));

      if (activeLessonNumbers.length === 0) return;

      const users = await this.userPrefsRepository.getReminderSubscribers();
      if (!users.length) return;

      let sentCount = 0;
      for (const user of users) {
        const role = user.role === "teacher" ? "teacher" : "student";
        const daysBeforeList = Array.from(
          new Set((user.reminderDaysBefore || []).map((value) => Number.parseInt(value, 10)))
        )
          .filter((value) => value === 1 || value === 2)
          .sort((a, b) => a - b);

        if (!daysBeforeList.length) continue;

        for (const daysBefore of daysBeforeList) {
          const targetDate = shiftIsoDate(now.isoDate, daysBefore);
          const count = await this.processUserReminder({
            user,
            role,
            daysBefore,
            targetDate,
            activeLessonNumbers
          });
          sentCount += count;
        }
      }

      if (sentCount > 0) {
        this.logger.info("Reminder tick finished", {
          now: now.isoDate,
          time: now.hhmm,
          sentCount
        });
      }
    } catch (error) {
      this.logger.error("Reminder tick failed", { error: error.message });
    } finally {
      this.running = false;
    }
  }

  /**
   * Process reminders for one user/day offset.
   *
   * @param {{user: Record<string, any>, role: "student"|"teacher", daysBefore: number, targetDate: string, activeLessonNumbers: number[]}} params
   * @returns {Promise<number>}
   */
  async processUserReminder({ user, role, daysBefore, targetDate, activeLessonNumbers }) {
    const userId = String(user.userId || "");
    if (!userId) return 0;

    let lessons = [];
    let targetRef = "";

    if (role === "student") {
      if (!user.preferredGroupCode) return 0;
      targetRef = `group:${user.preferredGroupCode}`;
      lessons = await this.scheduleRepository.getActiveLessons({
        groupCode: user.preferredGroupCode,
        date: targetDate
      });
    } else {
      const teacherKey = user.preferredTeacherKey || teacherMatchKey(user.preferredTeacherName);
      if (!teacherKey) return 0;
      targetRef = `teacher:${teacherKey}`;
      const dayLessons = await this.scheduleRepository.getActiveLessons({ date: targetDate });
      lessons = dayLessons.filter((lesson) => teacherMatchKey(lesson.teacher) === teacherKey);
    }

    if (!lessons.length) return 0;

    const candidates = lessons.filter((lesson) => activeLessonNumbers.includes(lesson.lessonNumber));
    if (!candidates.length) return 0;

    let sentCount = 0;
    for (const lesson of candidates) {
      const reminderKey = [
        userId,
        role,
        daysBefore,
        lesson.date,
        lesson.lessonNumber,
        lesson.subject,
        lesson.groupCode || "",
        lesson.teacher || ""
      ].join("|");

      const accepted = await this.scheduleRepository.registerReminderSend({
        reminderKey,
        userId,
        role,
        daysBefore,
        date: lesson.date,
        lessonNumber: lesson.lessonNumber,
        targetRef
      });
      if (!accepted) continue;

      const message = this.buildReminderMessage({ role, daysBefore, lesson });
      try {
        await this.api.sendText({
          userId,
          text: message,
          format: "markdown"
        });
        sentCount += 1;
      } catch (error) {
        this.logger.warn("Reminder send failed", {
          userId,
          role,
          error: error.message
        });
      }
    }

    return sentCount;
  }

  /**
   * Build reminder message text.
   *
   * @param {{role: "student"|"teacher", daysBefore: number, lesson: Record<string, any>}} params
   * @returns {string}
   */
  buildReminderMessage({ role, daysBefore, lesson }) {
    const leadText = daysBefore === 1 ? "через 1 день" : "через 2 дня";
    if (role === "teacher") {
      return [
        `Напоминание: ${leadText} начнется пара №${lesson.lessonNumber}.`,
        `Дата: ${toRuDate(lesson.date)}`,
        lesson.subject,
        `Группа: ${lesson.groupName || lesson.groupCode || "-"}`,
        `Аудитория: ${lesson.room || "-"}`
      ].join("\n");
    }

    return [
      `Напоминание: ${leadText} начнется пара №${lesson.lessonNumber}.`,
      `Дата: ${toRuDate(lesson.date)}`,
      lesson.subject,
      `Аудитория: ${lesson.room || "-"}`,
      `Преподаватель: ${lesson.teacher || "-"}`
    ].join("\n");
  }
}

module.exports = { ReminderService };
