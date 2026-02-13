const { MaxApiClient } = require("./apiClient");
const { MaxUserPrefsRepository } = require("./userPrefsRepository");

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

function toRuDate(isoDate) {
  const match = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;
  const [, yyyy, mm, dd] = match;
  return `${dd}.${mm}.${yyyy}`;
}

function extractMessageText(update) {
  const bodyText = update?.message?.body?.text;
  if (typeof bodyText === "string") return bodyText.trim();

  const fallback = update?.message?.text;
  if (typeof fallback === "string") return fallback.trim();

  return "";
}

function normalizeCommand(text) {
  const raw = (text || "").trim();
  if (!raw) return { command: "", args: [] };

  const parts = raw.split(/\s+/);
  let command = parts[0];

  if (command.startsWith("/")) command = command.slice(1);
  command = command.split("@")[0].toLowerCase();

  return {
    command,
    args: parts.slice(1)
  };
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function splitLongMessage(text, maxLen = 3800) {
  if (!text || text.length <= maxLen) return [text || ""];

  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);
    current = line;
  }

  if (current) chunks.push(current);
  return chunks;
}

class MaxBotService {
  /**
   * @param {{
   *  db: import("mongodb").Db,
   *  scheduleRepository: any,
   *  syncService: any,
   *  logger: any,
   *  token: string,
   *  apiBaseUrl?: string,
   *  timeoutMs?: number,
   *  timezone: string,
   *  adminUserIds?: Array<string|number>
   * }} deps
   */
  constructor({
    db,
    scheduleRepository,
    syncService,
    logger,
    token,
    apiBaseUrl,
    timeoutMs,
    timezone,
    adminUserIds
  }) {
    this.logger = logger;
    this.scheduleRepository = scheduleRepository;
    this.syncService = syncService;
    this.timezone = timezone;
    this.adminUserIds = new Set((adminUserIds || []).map((id) => String(id)));

    this.api = new MaxApiClient({ token, apiBaseUrl, timeoutMs });
    this.userPrefsRepository = new MaxUserPrefsRepository(db);
  }

  /**
   * Initialize storage resources required by the bot.
   *
   * @returns {Promise<void>}
   */
  async init() {
    await this.userPrefsRepository.ensureIndexes();
  }

  /**
   * Entry point for incoming MAX webhook updates.
   *
   * @param {Record<string, any>} update
   * @returns {Promise<void>}
   */
  async handleUpdate(update) {
    if (!update || !update.update_type) return;

    if (update.update_type === "bot_started") {
      await this.replyFromBotStarted(update, this.helpMessage());
      return;
    }

    if (update.update_type !== "message_created") return;

    const sender = update?.message?.sender;
    if (!sender?.user_id) return;

    if (sender.is_bot === true) return;

    const text = extractMessageText(update);
    if (!text) return;

    const target = this.resolveTarget(update);
    if (!target) {
      this.logger.warn("MAX update target cannot be resolved", { updateType: update.update_type });
      return;
    }

    const { command, args } = normalizeCommand(text);
    if (!command) return;

    await this.handleCommand({ command, args, senderId: String(sender.user_id), target });
  }

  /**
   * Resolve message delivery target from update payload.
   *
   * @param {Record<string, any>} update
   * @returns {{chatId?: string|number, userId?: string|number}|null}
   */
  resolveTarget(update) {
    const recipient = update?.message?.recipient || {};

    if (recipient.chat_id !== undefined && recipient.chat_id !== null) {
      return { chatId: recipient.chat_id };
    }

    if (recipient.user_id !== undefined && recipient.user_id !== null) {
      return { userId: recipient.user_id };
    }

    const senderId = update?.message?.sender?.user_id;
    if (senderId !== undefined && senderId !== null) {
      return { userId: senderId };
    }

    return null;
  }

  /**
   * Send a bot message and split it into multiple chunks if needed.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} text
   * @returns {Promise<void>}
   */
  async sendText(target, text) {
    const chunks = splitLongMessage(text);
    for (const chunk of chunks) {
      await this.api.sendText({
        userId: target.userId,
        chatId: target.chatId,
        text: chunk,
        format: "markdown"
      });
    }
  }

  /**
   * Reply to MAX `bot_started` events.
   *
   * @param {Record<string, any>} update
   * @param {string} text
   * @returns {Promise<void>}
   */
  async replyFromBotStarted(update, text) {
    const chatId = update?.chat_id;
    const userId = update?.user?.user_id;

    if (chatId !== undefined && chatId !== null) {
      await this.api.sendText({ chatId, text });
      return;
    }

    if (userId !== undefined && userId !== null) {
      await this.api.sendText({ userId, text });
    }
  }

  /**
   * Build the static help message shown to users.
   *
   * @returns {string}
   */
  helpMessage() {
    return [
      "Hello! I am your OmAcademy schedule bot.",
      "",
      "Commands:",
      "- `/help` - show this help",
      "- `/groups [query]` - list groups (optionally filtered)",
      "- `/setgroup <groupCode|groupName>` - set your default group",
      "- `/mygroup` - show your current default group",
      "- `/today [groupCode|groupName]` - schedule for today",
      "- `/tomorrow [groupCode|groupName]` - schedule for tomorrow",
      "- `/date <YYYY-MM-DD> [groupCode|groupName]` - schedule for a date",
      "- `/next [groupCode|groupName]` - next lesson from today onward",
      "- `/sync` - force manual sync (admin only)"
    ].join("\n");
  }

  /**
   * Route a parsed command to the corresponding command handler.
   *
   * @param {{command: string, args: string[], senderId: string, target: {chatId?: string|number, userId?: string|number}}} params
   * @returns {Promise<void>}
   */
  async handleCommand({ command, args, senderId, target }) {
    switch (command) {
      case "start":
      case "help":
        await this.sendText(target, this.helpMessage());
        return;

      case "groups":
        await this.handleGroupsCommand(target, args);
        return;

      case "setgroup":
        await this.handleSetGroupCommand(target, senderId, args);
        return;

      case "mygroup":
        await this.handleMyGroupCommand(target, senderId);
        return;

      case "today": {
        const date = getIsoDateInTimezone(this.timezone);
        await this.handleDayScheduleCommand(target, senderId, date, args);
        return;
      }

      case "tomorrow": {
        const today = getIsoDateInTimezone(this.timezone);
        const tomorrow = shiftIsoDate(today, 1);
        await this.handleDayScheduleCommand(target, senderId, tomorrow, args);
        return;
      }

      case "date":
        await this.handleDateCommand(target, senderId, args);
        return;

      case "next":
        await this.handleNextCommand(target, senderId, args);
        return;

      case "sync":
        await this.handleSyncCommand(target, senderId);
        return;

      default:
        await this.sendText(target, "Unknown command. Use `/help`.");
    }
  }

  /**
   * Read active groups from the current schedule snapshot.
   *
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async getActiveGroups() {
    return this.scheduleRepository.getActiveGroups();
  }

  /**
   * Resolve a group by explicit input or user preference.
   *
   * @param {string} senderId
   * @param {string} rawGroupInput
   * @returns {Promise<{group?: Record<string, any>, error?: string}>}
   */
  async resolveGroup(senderId, rawGroupInput) {
    const groups = await this.getActiveGroups();
    if (!groups.length) {
      return { error: "No active schedule snapshot found yet. Run `/sync` first." };
    }

    let input = (rawGroupInput || "").trim();

    if (!input) {
      const pref = await this.userPrefsRepository.getByUserId(senderId);
      if (!pref?.preferredGroupCode) {
        return {
          error:
            "Group is not provided. Use `/setgroup <groupCode|groupName>` or pass group in command."
        };
      }
      input = pref.preferredGroupCode;
    }

    const byCode = groups.find((g) => g.code === input);
    if (byCode) return { group: byCode };

    const lower = input.toLowerCase();
    const byNameExact = groups.find((g) => g.name.toLowerCase() === lower);
    if (byNameExact) return { group: byNameExact };

    const byNameContains = groups.filter((g) => g.name.toLowerCase().includes(lower));
    if (byNameContains.length === 1) {
      return { group: byNameContains[0] };
    }

    if (byNameContains.length > 1) {
      return {
        error: `Ambiguous group. Matches: ${byNameContains
          .slice(0, 10)
          .map((g) => `${g.code} (${g.name})`)
          .join(", ")}`
      };
    }

    return { error: `Group not found: ${input}` };
  }

  /**
   * Handle `/groups` command.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async handleGroupsCommand(target, args) {
    const groups = await this.getActiveGroups();
    if (!groups.length) {
      await this.sendText(target, "No active groups found. Run `/sync` first.");
      return;
    }

    const query = args.join(" ").trim().toLowerCase();
    const filtered = query
      ? groups.filter((g) => g.name.toLowerCase().includes(query) || g.code.includes(query))
      : groups;

    if (!filtered.length) {
      await this.sendText(target, "No groups found for this query.");
      return;
    }

    const limit = query ? 80 : 40;
    const lines = filtered.slice(0, limit).map((g) => `- ${g.code} - ${g.name}`);

    let result = `Groups found: ${filtered.length}\n\n${lines.join("\n")}`;
    if (filtered.length > limit) {
      result += `\n\nShowing first ${limit}. Use /groups <query> to narrow results.`;
    }

    await this.sendText(target, result);
  }

  /**
   * Handle `/setgroup` command.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async handleSetGroupCommand(target, senderId, args) {
    const input = args.join(" ").trim();
    if (!input) {
      await this.sendText(target, "Usage: `/setgroup <groupCode|groupName>`");
      return;
    }

    const resolved = await this.resolveGroup(senderId, input);
    if (resolved.error) {
      await this.sendText(target, resolved.error);
      return;
    }

    await this.userPrefsRepository.setPreferredGroup(senderId, resolved.group);
    await this.sendText(
      target,
      `Default group saved: ${resolved.group.name} (code: ${resolved.group.code})`
    );
  }

  /**
   * Handle `/mygroup` command.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @returns {Promise<void>}
   */
  async handleMyGroupCommand(target, senderId) {
    const pref = await this.userPrefsRepository.getByUserId(senderId);
    if (!pref?.preferredGroupCode) {
      await this.sendText(target, "Default group is not set. Use `/setgroup <groupCode|groupName>`." );
      return;
    }

    await this.sendText(
      target,
      `Your default group: ${pref.preferredGroupName} (code: ${pref.preferredGroupCode})`
    );
  }

  /**
   * Format lessons into a readable day schedule message.
   *
   * @param {{name: string, code: string}} group
   * @param {string} isoDate
   * @param {Array<Record<string, any>>} lessons
   * @returns {string}
   */
  formatLessonsForDay(group, isoDate, lessons) {
    const header = `${group.name} (${group.code})\nDate: ${toRuDate(isoDate)}`;

    if (!lessons.length) {
      return `${header}\n\nNo lessons found.`;
    }

    const lines = lessons.map((lesson) => {
      const teacher = lesson.teacher || "-";
      const room = lesson.room || "-";
      return `${lesson.lessonNumber}. ${lesson.subject}\n   Room: ${room}\n   Teacher: ${teacher}`;
    });

    return `${header}\n\n${lines.join("\n")}`;
  }

  /**
   * Handle day-based commands and send schedule for resolved group/date.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string} isoDate
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async handleDayScheduleCommand(target, senderId, isoDate, args) {
    const input = args.join(" ").trim();
    const resolved = await this.resolveGroup(senderId, input);

    if (resolved.error) {
      await this.sendText(target, resolved.error);
      return;
    }

    const lessons = await this.scheduleRepository.getActiveLessons({
      groupCode: resolved.group.code,
      date: isoDate
    });

    const text = this.formatLessonsForDay(resolved.group, isoDate, lessons);
    await this.sendText(target, text);
  }

  /**
   * Handle `/date` command.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async handleDateCommand(target, senderId, args) {
    if (!args.length) {
      await this.sendText(target, "Usage: `/date <YYYY-MM-DD> [groupCode|groupName]`");
      return;
    }

    const dateArg = args[0];
    if (!isIsoDate(dateArg)) {
      await this.sendText(target, "Invalid date format. Expected `YYYY-MM-DD`." );
      return;
    }

    const groupInput = args.slice(1).join(" ");
    await this.handleDayScheduleCommand(target, senderId, dateArg, groupInput ? [groupInput] : []);
  }

  /**
   * Handle `/next` command.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async handleNextCommand(target, senderId, args) {
    const input = args.join(" ").trim();
    const resolved = await this.resolveGroup(senderId, input);

    if (resolved.error) {
      await this.sendText(target, resolved.error);
      return;
    }

    const today = getIsoDateInTimezone(this.timezone);
    const lessons = await this.scheduleRepository.getActiveLessons({ groupCode: resolved.group.code });

    const nextLesson = lessons
      .filter((l) => l.date >= today)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.lessonNumber - b.lessonNumber;
      })[0];

    if (!nextLesson) {
      await this.sendText(
        target,
        `No upcoming lessons found for ${resolved.group.name} (${resolved.group.code}).`
      );
      return;
    }

    const message = [
      `Next lesson for ${resolved.group.name} (${resolved.group.code}):`,
      `${toRuDate(nextLesson.date)}, lesson ${nextLesson.lessonNumber}`,
      nextLesson.subject,
      `Room: ${nextLesson.room || "-"}`,
      `Teacher: ${nextLesson.teacher || "-"}`
    ].join("\n");

    await this.sendText(target, message);
  }

  /**
   * Handle `/sync` command with optional admin restriction.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @returns {Promise<void>}
   */
  async handleSyncCommand(target, senderId) {
    if (this.adminUserIds.size > 0 && !this.adminUserIds.has(String(senderId))) {
      await this.sendText(target, "You are not allowed to run manual sync.");
      return;
    }

    if (this.syncService.isRunning()) {
      await this.sendText(target, "Sync is already running.");
      return;
    }

    this.syncService.run("max_bot").catch((error) => {
      this.logger.error("MAX bot sync trigger failed", { error: error.message });
    });

    await this.sendText(target, "Sync started. Use this command later to refresh data again.");
  }
}

module.exports = { MaxBotService };
