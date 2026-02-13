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

const COMMAND_ALIASES = {
  start: "start",
  "старт": "start",
  help: "help",
  "помощь": "help",
  "меню": "help",
  "кнопки": "help",
  groups: "groups",
  "группы": "groups",
  setgroup: "setgroup",
  "группа": "setgroup",
  mygroup: "mygroup",
  "моягруппа": "mygroup",
  "моя_группа": "mygroup",
  today: "today",
  "сегодня": "today",
  tomorrow: "tomorrow",
  "завтра": "tomorrow",
  date: "date",
  "дата": "date",
  next: "next",
  "следующая": "next",
  "следующий": "next",
  "ближайшая": "next",
  sync: "sync",
  "синк": "sync",
  "обновить": "sync"
};

function resolveCommandAlias(command) {
  return COMMAND_ALIASES[command] || command;
}

const CALLBACK_ACTIONS = {
  today: "today",
  tomorrow: "tomorrow",
  next: "next",
  mygroup: "mygroup",
  groups: "groups",
  help: "help",
  sync: "sync"
};

function callbackButton(text, action) {
  return {
    type: "callback",
    text,
    payload: `cmd:${action}`
  };
}

function parseCallbackCommand(payload) {
  if (!payload) return "";

  if (typeof payload === "object") {
    const nested = payload.command || payload.cmd || payload.action || payload.payload || "";
    return parseCallbackCommand(nested);
  }

  const raw = String(payload).trim();
  if (!raw) return "";

  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      const parsed = JSON.parse(raw);
      const nested = parsed?.command || parsed?.cmd || parsed?.action || "";
      return parseCallbackCommand(nested);
    } catch (error) {
      return "";
    }
  }

  if (raw.startsWith("cmd:")) {
    return raw.slice(4).trim().toLowerCase();
  }

  return raw.toLowerCase();
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

    if (update.update_type === "message_callback") {
      await this.handleMessageCallbackUpdate(update);
      return;
    }

    if (update.update_type !== "message_created") return;

    const senderId = this.resolveSenderId(update);
    if (!senderId) return;
    if (update?.message?.sender?.is_bot === true) return;

    const text = extractMessageText(update);
    if (!text) return;

    const target = this.resolveTarget(update);
    if (!target) {
      this.logger.warn("MAX update target cannot be resolved", { updateType: update.update_type });
      return;
    }

    const { command, args } = normalizeCommand(text);
    if (!command) return;

    await this.handleCommand({ command, args, senderId, target });
  }

  /**
   * Resolve sender user ID from message or callback update payload.
   *
   * @param {Record<string, any>} update
   * @returns {string}
   */
  resolveSenderId(update) {
    const senderIdCandidates = [
      update?.message?.sender?.user_id,
      update?.callback?.user?.user_id,
      update?.callback?.sender?.user_id,
      update?.user?.user_id
    ];

    for (const value of senderIdCandidates) {
      if (value !== undefined && value !== null) return String(value);
    }

    return "";
  }

  /**
   * Resolve message delivery target from update payload.
   *
   * @param {Record<string, any>} update
   * @returns {{chatId?: string|number, userId?: string|number}|null}
   */
  resolveTarget(update) {
    const recipient =
      update?.message?.recipient || update?.callback?.message?.recipient || update?.recipient || {};

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

    const callbackChatId = update?.callback?.chat_id || update?.callback?.chat?.chat_id;
    if (callbackChatId !== undefined && callbackChatId !== null) {
      return { chatId: callbackChatId };
    }

    const callbackUserId =
      update?.callback?.user?.user_id || update?.callback?.sender?.user_id || update?.user?.user_id;
    if (callbackUserId !== undefined && callbackUserId !== null) {
      return { userId: callbackUserId };
    }

    return null;
  }

  /**
   * Send a bot message and split it into multiple chunks if needed.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} text
   * @param {{attachments?: Array<Record<string, any>>}} [options]
   * @returns {Promise<void>}
   */
  async sendText(target, text, options = {}) {
    const attachments = Array.isArray(options.attachments) ? options.attachments : undefined;
    const chunks = splitLongMessage(text);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await this.api.sendText({
        userId: target.userId,
        chatId: target.chatId,
        text: chunk,
        format: "markdown",
        attachments: index === 0 ? attachments : undefined
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
      await this.sendText({ chatId }, text, { attachments: this.mainMenuKeyboard() });
      return;
    }

    if (userId !== undefined && userId !== null) {
      await this.sendText({ userId }, text, { attachments: this.mainMenuKeyboard() });
    }
  }

  /**
   * Build inline keyboard attachment with quick actions.
   *
   * @returns {Array<Record<string, any>>}
   */
  mainMenuKeyboard() {
    return [
      {
        type: "inline_keyboard",
        payload: {
          buttons: [
            [callbackButton("Сегодня", "today"), callbackButton("Завтра", "tomorrow")],
            [callbackButton("Следующая пара", "next"), callbackButton("Моя группа", "mygroup")],
            [callbackButton("Группы", "groups"), callbackButton("Обновить", "sync")],
            [callbackButton("Помощь", "help")]
          ]
        }
      }
    ];
  }

  /**
   * Build the static help message shown to users.
   *
   * @returns {string}
   */
  helpMessage() {
    return [
      "Привет! Я бот расписания OmAcademy.",
      "Используйте команды или кнопки ниже.",
      "",
      "Команды:",
      "- `/помощь` (`/help`) - показать это меню",
      "- `/группы [поиск]` (`/groups`) - список групп",
      "- `/группа <код|название>` (`/setgroup`) - сохранить группу по умолчанию",
      "- `/моягруппа` (`/mygroup`) - текущая группа по умолчанию",
      "- `/сегодня [код|название]` (`/today`) - расписание на сегодня",
      "- `/завтра [код|название]` (`/tomorrow`) - расписание на завтра",
      "- `/дата <YYYY-MM-DD> [код|название]` (`/date`) - расписание на дату",
      "- `/следующая [код|название]` (`/next`) - ближайшая пара",
      "- `/обновить` (`/sync`) - принудительный sync (только admin)"
    ].join("\n");
  }

  /**
   * Handle callback updates generated by inline keyboard buttons.
   *
   * @param {Record<string, any>} update
   * @returns {Promise<void>}
   */
  async handleMessageCallbackUpdate(update) {
    const callbackId = update?.callback?.callback_id || update?.callback_id;
    if (!callbackId) return;

    const senderId = this.resolveSenderId(update);
    const target = this.resolveTarget(update);
    if (!senderId || !target) {
      await this.safeAnswerCallback(callbackId, "Не удалось обработать кнопку.");
      return;
    }

    const command = parseCallbackCommand(update?.callback?.payload || update?.payload);
    const resolvedCommand = CALLBACK_ACTIONS[command];
    if (!resolvedCommand) {
      await this.safeAnswerCallback(callbackId, "Неизвестная кнопка.");
      return;
    }

    await this.safeAnswerCallback(callbackId, "Готово");
    await this.handleCommand({ command: resolvedCommand, args: [], senderId, target });
  }

  /**
   * Send callback acknowledgement without interrupting update processing on API errors.
   *
   * @param {string} callbackId
   * @param {string} notification
   * @returns {Promise<void>}
   */
  async safeAnswerCallback(callbackId, notification) {
    try {
      await this.api.answerCallback({ callbackId, notification });
    } catch (error) {
      this.logger.warn("MAX callback answer failed", { error: error.message });
    }
  }

  /**
   * Route a parsed command to the corresponding command handler.
   *
   * @param {{command: string, args: string[], senderId: string, target: {chatId?: string|number, userId?: string|number}}} params
   * @returns {Promise<void>}
   */
  async handleCommand({ command, args, senderId, target }) {
    const resolvedCommand = resolveCommandAlias(command);

    switch (resolvedCommand) {
      case "start":
      case "help":
        await this.sendText(target, this.helpMessage(), { attachments: this.mainMenuKeyboard() });
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
        await this.sendText(target, "Неизвестная команда. Используйте `/помощь`.");
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
      return { error: "Активное расписание пока не загружено. Выполните `/обновить`." };
    }

    let input = (rawGroupInput || "").trim();

    if (!input) {
      const pref = await this.userPrefsRepository.getByUserId(senderId);
      if (!pref?.preferredGroupCode) {
        return {
          error:
            "Группа не указана. Используйте `/группа <код|название>` или передайте группу в команде."
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
        error: `Слишком много совпадений. Подходят: ${byNameContains
          .slice(0, 10)
          .map((g) => `${g.code} (${g.name})`)
          .join(", ")}`
      };
    }

    return { error: `Группа не найдена: ${input}` };
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
      await this.sendText(target, "Нет активных групп. Сначала выполните `/обновить`.");
      return;
    }

    const query = args.join(" ").trim().toLowerCase();
    const filtered = query
      ? groups.filter((g) => g.name.toLowerCase().includes(query) || g.code.includes(query))
      : groups;

    if (!filtered.length) {
      await this.sendText(target, "По вашему запросу группы не найдены.");
      return;
    }

    const limit = query ? 80 : 40;
    const lines = filtered.slice(0, limit).map((g) => `- ${g.code} - ${g.name}`);

    let result = `Найдено групп: ${filtered.length}\n\n${lines.join("\n")}`;
    if (filtered.length > limit) {
      result += `\n\nПоказаны первые ${limit}. Уточните запрос: /группы <текст>.`;
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
      await this.sendText(target, "Использование: `/группа <код|название>`");
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
      `Группа по умолчанию сохранена: ${resolved.group.name} (код: ${resolved.group.code})`
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
      await this.sendText(target, "Группа по умолчанию не задана. Используйте `/группа <код|название>`.");
      return;
    }

    await this.sendText(
      target,
      `Ваша группа по умолчанию: ${pref.preferredGroupName} (код: ${pref.preferredGroupCode})`
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
    const header = `${group.name} (${group.code})\nДата: ${toRuDate(isoDate)}`;

    if (!lessons.length) {
      return `${header}\n\nПар не найдено.`;
    }

    const lines = lessons.map((lesson) => {
      const teacher = lesson.teacher || "-";
      const room = lesson.room || "-";
      return `${lesson.lessonNumber}. ${lesson.subject}\n   Аудитория: ${room}\n   Преподаватель: ${teacher}`;
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
      await this.sendText(target, "Использование: `/дата <YYYY-MM-DD> [код|название]`");
      return;
    }

    const dateArg = args[0];
    if (!isIsoDate(dateArg)) {
      await this.sendText(target, "Неверный формат даты. Ожидается `YYYY-MM-DD`.");
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
        `Для группы ${resolved.group.name} (${resolved.group.code}) ближайшие пары не найдены.`
      );
      return;
    }

    const message = [
      `Ближайшая пара для ${resolved.group.name} (${resolved.group.code}):`,
      `${toRuDate(nextLesson.date)}, пара ${nextLesson.lessonNumber}`,
      nextLesson.subject,
      `Аудитория: ${nextLesson.room || "-"}`,
      `Преподаватель: ${nextLesson.teacher || "-"}`
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
      await this.sendText(target, "У вас нет прав для запуска синхронизации.");
      return;
    }

    if (this.syncService.isRunning()) {
      await this.sendText(target, "Синхронизация уже выполняется.");
      return;
    }

    this.syncService.run("max_bot").catch((error) => {
      this.logger.error("MAX bot sync trigger failed", { error: error.message });
    });

    await this.sendText(target, "Синхронизация запущена. Повторите команду позже для обновления.");
  }
}

module.exports = { MaxBotService };
