const { MaxApiClient } = require("./apiClient");
const { MaxUserPrefsRepository } = require("./userPrefsRepository");
const { MaxBotStatsRepository } = require("./statsRepository");

function getIsoDateInTimezone(timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
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
  role: "role",
  "роль": "role",
  student: "student",
  "студент": "student",
  teacher: "teacher",
  "преподаватель": "teacher",
  groups: "groups",
  "группы": "groups",
  setgroup: "setgroup",
  "группа": "setgroup",
  mygroup: "mygroup",
  "моягруппа": "mygroup",
  "моя_группа": "mygroup",
  teachers: "teachers",
  "преподаватели": "teachers",
  setteacher: "setteacher",
  "препод": "setteacher",
  "преп": "setteacher",
  myteacher: "myteacher",
  "мойпрепод": "myteacher",
  "мойпреподаватель": "myteacher",
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
  "обновить": "sync",
  reminder: "reminder",
  reminders: "reminder",
  "напоминание": "reminder",
  "напоминания": "reminder"
};

function resolveCommandAlias(command) {
  return COMMAND_ALIASES[command] || command;
}

const CALLBACK_ACTIONS = {
  role: "role",
  student: "student",
  teacher: "teacher",
  pick_date: "pick_date",
  pick_group: "pick_group",
  pick_teacher: "pick_teacher",
  today: "today",
  tomorrow: "tomorrow",
  next: "next",
  mygroup: "mygroup",
  myteacher: "myteacher",
  groups: "groups",
  teachers: "teachers",
  reminder: "reminder",
  help: "help",
  sync: "sync"
};

function callbackButton(text, action, senderId = "") {
  const token = senderId ? `:${encodeToken(senderId)}` : "";
  return {
    type: "callback",
    text,
    payload: `cmd:${action}${token}`
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
    return raw.slice(4).trim();
  }

  return raw;
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

function isSlashCommand(text) {
  return String(text || "").trim().startsWith("/");
}

function encodeToken(value) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function decodeToken(value) {
  try {
    return Buffer.from(String(value), "base64url").toString("utf8");
  } catch (error) {
    return "";
  }
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

function hhmmToMinutes(hhmm) {
  const match = String(hhmm || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesToHhmm(totalMinutes) {
  const minutesInDay = 24 * 60;
  const normalized = ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function prettyTime(hhmm) {
  const match = String(hhmm || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return hhmm;
  const hour = Number.parseInt(match[1], 10);
  return `${hour}:${match[2]}`;
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
   *  lessonStartTimes?: string,
   *  lessonPartMinutes?: number,
   *  midLessonBreakMinutes?: number,
   *  betweenLessonsBreakMinutes?: number,
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
    lessonStartTimes,
    lessonPartMinutes,
    midLessonBreakMinutes,
    betweenLessonsBreakMinutes,
    adminUserIds
  }) {
    this.logger = logger;
    this.scheduleRepository = scheduleRepository;
    this.syncService = syncService;
    this.timezone = timezone;
    this.lessonStartTimes = parseLessonStartTimes(lessonStartTimes);
    this.lessonPartMinutes =
      Number.isFinite(lessonPartMinutes) && lessonPartMinutes > 0 ? lessonPartMinutes : 45;
    this.midLessonBreakMinutes =
      Number.isFinite(midLessonBreakMinutes) && midLessonBreakMinutes >= 0
        ? midLessonBreakMinutes
        : 10;
    this.betweenLessonsBreakMinutes =
      Number.isFinite(betweenLessonsBreakMinutes) && betweenLessonsBreakMinutes >= 0
        ? betweenLessonsBreakMinutes
        : 20;
    this.adminUserIds = new Set((adminUserIds || []).map((id) => String(id)));
    this.lastSenderByTarget = new Map();
    this.pendingByTarget = new Map();

    this.api = new MaxApiClient({ token, apiBaseUrl, timeoutMs });
    this.userPrefsRepository = new MaxUserPrefsRepository(db);
    this.statsRepository = new MaxBotStatsRepository(db);
  }

  /**
   * Initialize storage resources required by the bot.
   *
   * @returns {Promise<void>}
   */
  async init() {
    await this.userPrefsRepository.ensureIndexes();
    await this.statsRepository.ensureIndexes();
  }

  /**
   * Persist "user seen" metric without failing request flow.
   *
   * @param {string} senderId
   * @param {string} updateType
   * @returns {Promise<void>}
   */
  async trackUserSeenMetric(senderId, updateType) {
    if (!senderId) return;
    try {
      await this.statsRepository.recordUserSeen({ userId: senderId, updateType });
    } catch (error) {
      this.logger.warn("Failed to persist MAX user activity metric", { error: error.message });
    }
  }

  /**
   * Persist bot_started metric without failing request flow.
   *
   * @param {Record<string, any>} update
   * @returns {Promise<void>}
   */
  async trackBotStartedMetric(update) {
    try {
      await this.statsRepository.recordBotStarted({
        userId: update?.user?.user_id,
        chatId: update?.chat_id
      });
    } catch (error) {
      this.logger.warn("Failed to persist MAX install metric", { error: error.message });
    }
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
      const senderId = this.resolveSenderId(update);
      await this.trackUserSeenMetric(senderId, update.update_type);
      await this.trackBotStartedMetric(update);
      await this.replyFromBotStarted(update);
      return;
    }

    if (update.update_type === "message_callback") {
      const senderId = this.resolveSenderId(update);
      await this.trackUserSeenMetric(senderId, update.update_type);
      await this.handleMessageCallbackUpdate(update);
      return;
    }

    if (update.update_type !== "message_created") return;

    const senderId = this.resolveSenderId(update);
    if (!senderId) return;
    if (update?.message?.sender?.is_bot === true) return;
    await this.trackUserSeenMetric(senderId, update.update_type);

    const text = extractMessageText(update);
    if (!text) return;

    const target = this.resolveTarget(update);
    if (!target) {
      this.logger.warn("MAX update target cannot be resolved", { updateType: update.update_type });
      return;
    }
    this.rememberTargetSender(target, senderId);

    if (!isSlashCommand(text)) {
      const consumedByWizard = await this.handlePendingTextInput({ senderId, target, text });
      if (consumedByWizard) return;
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
   * Build stable key for target-scoped in-memory state.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @returns {string}
   */
  targetKey(target) {
    if (target?.chatId !== undefined && target?.chatId !== null) return `chat:${String(target.chatId)}`;
    if (target?.userId !== undefined && target?.userId !== null) return `user:${String(target.userId)}`;
    return "";
  }

  /**
   * Save last sender for current target and cleanup stale pending state.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @returns {void}
   */
  rememberTargetSender(target, senderId) {
    const key = this.targetKey(target);
    if (!key || !senderId) return;
    this.lastSenderByTarget.set(key, String(senderId));

    const state = this.pendingByTarget.get(key);
    if (!state?.updatedAt) return;
    // 15-minute TTL for in-memory wizard state.
    if (Date.now() - state.updatedAt > 15 * 60 * 1000) {
      this.pendingByTarget.delete(key);
    }
  }

  /**
   * Send a bot message and split it into multiple chunks if needed.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} text
   * @param {{attachments?: Array<Record<string, any>>, noMenu?: boolean, senderId?: string}} [options]
   * @returns {Promise<void>}
   */
  async sendText(target, text, options = {}) {
    let attachments = Array.isArray(options.attachments) ? options.attachments : undefined;
    const noMenu = options.noMenu === true;
    const senderIdFromOptions = options.senderId ? String(options.senderId) : "";
    const key = this.targetKey(target);
    const senderIdFromTarget = key ? this.lastSenderByTarget.get(key) || "" : "";
    const effectiveSenderId = senderIdFromOptions || senderIdFromTarget;

    if (!attachments && !noMenu && effectiveSenderId) {
      const role = await this.getUserRole(effectiveSenderId);
      attachments = role
        ? this.mainMenuKeyboard(role, effectiveSenderId)
        : this.roleSelectionKeyboard(effectiveSenderId);
    }

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
   * @returns {Promise<void>}
   */
  async replyFromBotStarted(update) {
    const chatId = update?.chat_id;
    const userId = update?.user?.user_id;
    const senderId = userId !== undefined && userId !== null ? String(userId) : "";
    const payload = await this.buildWelcomePayload(senderId);

    if (chatId !== undefined && chatId !== null) {
      await this.sendText({ chatId }, payload.text, { attachments: payload.attachments });
      return;
    }

    if (userId !== undefined && userId !== null) {
      await this.sendText({ userId }, payload.text, { attachments: payload.attachments });
    }
  }

  /**
   * Get stored user role.
   *
   * @param {string} senderId
   * @returns {Promise<"student"|"teacher"|null>}
   */
  async getUserRole(senderId) {
    if (!senderId) return null;
    const pref = await this.userPrefsRepository.getByUserId(senderId);
    return pref?.role === "teacher" || pref?.role === "student" ? pref.role : null;
  }

  /**
   * Build first-time role selection text.
   *
   * @returns {string}
   */
  roleSelectionMessage() {
    return [
      "Выберите режим работы:",
      "- Студент: расписание по группе",
      "- Преподаватель: расписание по ФИО",
      "",
      "Нажмите кнопку ниже или используйте команду `/студент` / `/преподаватель`."
    ].join("\n");
  }

  /**
   * Build role selection keyboard.
   *
   * @returns {Array<Record<string, any>>}
   */
  roleSelectionKeyboard(senderId = "") {
    return [
      {
        type: "inline_keyboard",
        payload: {
          buttons: [
            [
              callbackButton("Я студент", "student", senderId),
              callbackButton("Я преподаватель", "teacher", senderId)
            ]
          ]
        }
      }
    ];
  }

  /**
   * Build inline keyboard attachment with quick actions based on selected role.
   *
   * @param {"student"|"teacher"} [role="student"]
   * @returns {Array<Record<string, any>>}
   */
  mainMenuKeyboard(role = "student", senderId = "") {
    const roleButtons = [
      [callbackButton("Выбор даты", "pick_date", senderId), callbackButton("Сегодня", "today", senderId)],
      [
        callbackButton("Выбор группы", "pick_group", senderId),
        callbackButton("Выбор преподавателя", "pick_teacher", senderId)
      ],
      [callbackButton("Помощь", "help", senderId), callbackButton("Напоминания", "reminder", senderId)]
    ];

    return [
      {
        type: "inline_keyboard",
        payload: {
          buttons: roleButtons
        }
      }
    ];
  }

  /**
   * Build help message shown to users.
   *
   * @param {"student"|"teacher"|null} [role]
   * @returns {string}
   */
  helpMessage(role = null) {
    const common = [
      "Привет! Я бот расписания OmAcademy.",
      "Можно использовать команды или кнопки меню.",
      "",
      "Общие команды:",
      "- `/помощь` (`/help`) - это меню",
      "- `/роль` - выбор режима",
      "- `/студент` - режим студента",
      "- `/преподаватель` - режим преподавателя",
      "- `/напоминание` - статус напоминаний",
      "- `/напоминание 1|2|1,2|выкл` - настройка напоминаний",
      "- `/обновить` (`/sync`) - принудительный sync (только admin)"
    ];

    const studentCommands = [
      "",
      "Режим Студент:",
      "- `/группы [поиск]` (`/groups`) - список групп",
      "- `/группа <код|название>` (`/setgroup`) - сохранить группу по умолчанию",
      "- `/моягруппа` (`/mygroup`) - текущая группа",
      "- `/сегодня [код|название]` (`/today`) - расписание на сегодня",
      "- `/завтра [код|название]` (`/tomorrow`) - расписание на завтра",
      "- `/дата <YYYY-MM-DD> [код|название]` (`/date`) - расписание на дату",
      "- `/следующая [код|название]` (`/next`) - ближайшая пара"
    ];

    const teacherCommands = [
      "",
      "Режим Преподаватель:",
      "- `/преподаватели [поиск]` (`/teachers`) - список преподавателей",
      "- `/препод <ФИО>` (`/setteacher`) - сохранить преподавателя по умолчанию",
      "- `/мойпрепод` (`/myteacher`) - текущий преподаватель",
      "- `/сегодня [ФИО]` (`/today`) - расписание на сегодня",
      "- `/завтра [ФИО]` (`/tomorrow`) - расписание на завтра",
      "- `/дата <YYYY-MM-DD> [ФИО]` (`/date`) - расписание на дату",
      "- `/следующая [ФИО]` (`/next`) - ближайшая пара"
    ];

    if (role === "student") return [...common, ...studentCommands].join("\n");
    if (role === "teacher") return [...common, ...teacherCommands].join("\n");

    return [
      this.roleSelectionMessage(),
      "",
      "После выбора роли используйте `/помощь`, чтобы увидеть команды для вашего режима."
    ].join("\n");
  }

  /**
   * Build welcome payload for user depending on selected role.
   *
   * @param {string} senderId
   * @returns {Promise<{text: string, attachments: Array<Record<string, any>>}>}
   */
  async buildWelcomePayload(senderId) {
    const role = await this.getUserRole(senderId);
    if (!role) {
      return {
        text: this.helpMessage(null),
        attachments: this.roleSelectionKeyboard(senderId)
      };
    }

    return {
      text: this.helpMessage(role),
      attachments: this.mainMenuKeyboard(role, senderId)
    };
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

    const target = this.resolveTarget(update);
    const targetKey = this.targetKey(target);
    const callbackSenderId =
      this.resolveSenderId(update) || (targetKey ? this.lastSenderByTarget.get(targetKey) || "" : "");

    if (!callbackSenderId || !target) {
      await this.safeAnswerCallback(callbackId, "Не удалось обработать кнопку.");
      return;
    }

    const commandRaw = parseCallbackCommand(update?.callback?.payload || update?.payload);
    const command = commandRaw.toLowerCase();

    if (command.startsWith("pickg:")) {
      const payload = commandRaw.slice("pickg:".length).trim();
      await this.safeAnswerCallback(callbackId, "Выбрано");
      await this.handlePickGroupFromCallback(target, callbackSenderId, payload);
      return;
    }

    if (command.startsWith("gpage:")) {
      const payload = commandRaw.slice("gpage:".length).trim();
      await this.safeAnswerCallback(callbackId, "Открываю");
      await this.handleGroupPageFromCallback(target, callbackSenderId, payload);
      return;
    }

    if (command.startsWith("pickt:")) {
      const payload = commandRaw.slice("pickt:".length).trim();
      await this.safeAnswerCallback(callbackId, "Выбрано");
      await this.handlePickTeacherFromCallback(target, callbackSenderId, payload);
      return;
    }

    if (String(commandRaw || "").toLowerCase().startsWith("datepick:")) {
      const payload = commandRaw.slice("datepick:".length).trim();
      await this.safeAnswerCallback(callbackId, "Выбрано");
      await this.handleDatePickFromCallback(target, callbackSenderId, payload);
      return;
    }

    if (String(commandRaw || "").toLowerCase().startsWith("remset:")) {
      const [, modeRaw, senderToken] = String(commandRaw || "").split(":");
      const mode = String(modeRaw || "").trim().toLowerCase();
      const senderFromToken = decodeToken(senderToken);
      const effectiveSenderId = senderFromToken || callbackSenderId;
      this.rememberTargetSender(target, effectiveSenderId);
      await this.safeAnswerCallback(callbackId, "Готово");
      await this.handleReminderCommand(target, effectiveSenderId, mode ? [mode] : []);
      return;
    }

    const [actionRaw, senderToken] = String(commandRaw || "").split(":");
    const senderFromToken = decodeToken(senderToken);
    const effectiveSenderId = senderFromToken || callbackSenderId;
    this.rememberTargetSender(target, effectiveSenderId);

    const resolvedCommand = CALLBACK_ACTIONS[String(actionRaw || "").toLowerCase()];
    if (!resolvedCommand) {
      await this.safeAnswerCallback(callbackId, "Неизвестная кнопка.");
      return;
    }

    await this.safeAnswerCallback(callbackId, "Готово");
    await this.handleCommand({ command: resolvedCommand, args: [], senderId: effectiveSenderId, target });
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
   * Handle callback selection for group.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string} payload
   * @returns {Promise<void>}
   */
  async handlePickGroupFromCallback(target, senderId, payload) {
    const [groupCodeRaw, senderToken] = String(payload || "").split(":");
    const groupCode = String(groupCodeRaw || "").trim();
    const senderFromToken = decodeToken(senderToken);
    const effectiveSenderId = senderFromToken || senderId;

    if (!groupCode) {
      await this.sendText(target, "Не удалось определить группу. Попробуйте снова.");
      return;
    }

    const resolved = await this.resolveGroup(effectiveSenderId, groupCode);
    if (resolved.error) {
      await this.sendText(target, resolved.error);
      return;
    }

    await this.clearPendingState(effectiveSenderId, target);
    await this.userPrefsRepository.setPreferredGroup(effectiveSenderId, resolved.group);
    await this.userPrefsRepository.setRole(effectiveSenderId, "student");
    await this.sendText(
      target,
      `Группа выбрана: ${resolved.group.name} (код: ${resolved.group.code})`,
      { attachments: this.mainMenuKeyboard("student", effectiveSenderId), senderId: effectiveSenderId }
    );
  }

  /**
   * Handle callback pagination for group picker.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string} payload
   * @returns {Promise<void>}
   */
  async handleGroupPageFromCallback(target, senderId, payload) {
    const [pageRaw, senderToken] = String(payload || "").split(":");
    const senderFromToken = decodeToken(senderToken);
    const effectiveSenderId = senderFromToken || senderId;
    const page = Number.parseInt(String(pageRaw || "0"), 10);
    await this.startGroupPicker(target, effectiveSenderId, Number.isFinite(page) ? page : 0);
  }

  /**
   * Handle callback selection for teacher.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string} payload
   * @returns {Promise<void>}
   */
  async handlePickTeacherFromCallback(target, senderId, payload) {
    const [teacherToken, senderToken] = String(payload || "").split(":");
    const token = String(teacherToken || "").trim();
    const senderFromToken = decodeToken(senderToken);
    const effectiveSenderId = senderFromToken || senderId;
    const decoded = decodeToken(token);
    if (!decoded) {
      await this.sendText(target, "Не удалось определить преподавателя. Попробуйте снова.");
      return;
    }

    const teachers = await this.getActiveTeachers();
    const teacher = teachers.find(
      (item) => (item.code && `code:${item.code}` === decoded) || `key:${item.key}` === decoded
    );

    if (!teacher) {
      await this.sendText(target, "Преподаватель не найден. Повторите выбор.");
      return;
    }

    await this.clearPendingState(effectiveSenderId, target);
    await this.userPrefsRepository.setPreferredTeacher(effectiveSenderId, teacher);
    await this.userPrefsRepository.setRole(effectiveSenderId, "teacher");
    await this.sendText(target, `Преподаватель выбран: ${teacher.name}`, {
      attachments: this.mainMenuKeyboard("teacher", effectiveSenderId),
      senderId: effectiveSenderId
    });
  }

  /**
   * Handle callback selection for date picker.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string} payload
   * @returns {Promise<void>}
   */
  async handleDatePickFromCallback(target, senderId, payload) {
    const [isoDateRaw, senderToken] = String(payload || "").split(":");
    const isoDate = String(isoDateRaw || "").trim();
    const senderFromToken = decodeToken(senderToken);
    const effectiveSenderId = senderFromToken || senderId;

    if (!isIsoDate(isoDate)) {
      await this.sendText(target, "Некорректная дата. Попробуйте открыть выбор даты заново.");
      return;
    }

    const role = await this.getUserRole(effectiveSenderId);
    if (!role) {
      await this.sendText(target, this.roleSelectionMessage(), {
        attachments: this.roleSelectionKeyboard(effectiveSenderId),
        senderId: effectiveSenderId
      });
      return;
    }

    if (role === "teacher") {
      await this.handleTeacherDayScheduleCommand(target, effectiveSenderId, isoDate, []);
      return;
    }

    await this.handleStudentDayScheduleCommand(target, effectiveSenderId, isoDate, []);
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
      case "help": {
        const payload = await this.buildWelcomePayload(senderId);
        await this.sendText(target, payload.text, { attachments: payload.attachments });
        return;
      }

      case "role":
        await this.sendText(target, this.roleSelectionMessage(), {
          attachments: this.roleSelectionKeyboard(senderId),
          senderId
        });
        return;

      case "student":
        await this.userPrefsRepository.setRole(senderId, "student");
        await this.sendText(target, "Режим переключен: Студент.", {
          attachments: this.mainMenuKeyboard("student", senderId),
          senderId
        });
        return;

      case "teacher":
        await this.userPrefsRepository.setRole(senderId, "teacher");
        await this.sendText(target, "Режим переключен: Преподаватель.", {
          attachments: this.mainMenuKeyboard("teacher", senderId),
          senderId
        });
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

      case "pick_group":
        await this.startGroupPicker(target, senderId);
        return;

      case "pick_date":
        await this.startDatePicker(target, senderId);
        return;

      case "teachers":
        await this.handleTeachersCommand(target, args);
        return;

      case "setteacher":
        await this.handleSetTeacherCommand(target, senderId, args);
        return;

      case "myteacher":
        await this.handleMyTeacherCommand(target, senderId);
        return;

      case "pick_teacher":
        await this.startTeacherPicker(target, senderId);
        return;

      case "today": {
        const role = await this.getUserRole(senderId);
        if (!role) {
          await this.sendText(target, this.roleSelectionMessage(), {
            attachments: this.roleSelectionKeyboard(senderId),
            senderId
          });
          return;
        }
        const date = getIsoDateInTimezone(this.timezone);
        if (role === "teacher") {
          await this.handleTeacherDayScheduleCommand(target, senderId, date, args);
          return;
        }

        await this.handleStudentDayScheduleCommand(target, senderId, date, args);
        return;
      }

      case "tomorrow": {
        const role = await this.getUserRole(senderId);
        if (!role) {
          await this.sendText(target, this.roleSelectionMessage(), {
            attachments: this.roleSelectionKeyboard(senderId),
            senderId
          });
          return;
        }
        const today = getIsoDateInTimezone(this.timezone);
        const tomorrow = shiftIsoDate(today, 1);
        if (role === "teacher") {
          await this.handleTeacherDayScheduleCommand(target, senderId, tomorrow, args);
          return;
        }

        await this.handleStudentDayScheduleCommand(target, senderId, tomorrow, args);
        return;
      }

      case "date": {
        const role = await this.getUserRole(senderId);
        if (!role) {
          await this.sendText(target, this.roleSelectionMessage(), {
            attachments: this.roleSelectionKeyboard(senderId),
            senderId
          });
          return;
        }

        if (role === "teacher") {
          await this.handleTeacherDateCommand(target, senderId, args);
          return;
        }

        await this.handleStudentDateCommand(target, senderId, args);
        return;
      }

      case "next": {
        const role = await this.getUserRole(senderId);
        if (!role) {
          await this.sendText(target, this.roleSelectionMessage(), {
            attachments: this.roleSelectionKeyboard(senderId),
            senderId
          });
          return;
        }

        if (role === "teacher") {
          await this.handleTeacherNextCommand(target, senderId, args);
          return;
        }

        await this.handleStudentNextCommand(target, senderId, args);
        return;
      }

      case "reminder":
        await this.handleReminderCommand(target, senderId, args);
        return;

      case "sync":
        await this.handleSyncCommand(target, senderId);
        return;

      default:
        await this.sendText(target, "Неизвестная команда. Используйте `/помощь`.");
    }
  }

  /**
   * Persist and cache pending wizard state.
   *
   * @param {string} senderId
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} action
   * @returns {Promise<void>}
   */
  async setPendingState(senderId, target, action) {
    if (senderId) {
      await this.userPrefsRepository.setPendingAction(senderId, action);
    }

    const key = this.targetKey(target);
    if (key) {
      this.pendingByTarget.set(key, {
        action,
        senderId: senderId || "",
        updatedAt: Date.now()
      });
    }
  }

  /**
   * Clear pending wizard state in DB and in-memory cache.
   *
   * @param {string} senderId
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @returns {Promise<void>}
   */
  async clearPendingState(senderId, target) {
    if (senderId) {
      await this.userPrefsRepository.clearPendingAction(senderId);
    }

    const key = this.targetKey(target);
    if (key) this.pendingByTarget.delete(key);
  }

  /**
   * Handle text in the context of pending multi-step selection flow.
   *
   * @param {{senderId: string, target: {chatId?: string|number, userId?: string|number}, text: string}} params
   * @returns {Promise<boolean>}
   */
  async handlePendingTextInput({ senderId, target, text }) {
    const pref = await this.userPrefsRepository.getByUserId(senderId);
    const targetKey = this.targetKey(target);
    const pendingByTarget = targetKey ? this.pendingByTarget.get(targetKey) : null;
    const pendingAction = pref?.pendingAction || pendingByTarget?.action || "";
    if (!pendingAction) return false;

    const input = String(text || "").trim();
    if (!input) return true;

    const lower = input.toLowerCase();
    if (lower === "отмена" || lower === "cancel") {
      await this.clearPendingState(senderId, target);
      await this.sendText(target, "Выбор отменен.");
      return true;
    }

    if (pendingAction === "await_group_query") {
      await this.handleGroupPickerInput(target, senderId, input);
      return true;
    }

    if (pendingAction === "await_teacher_query") {
      await this.handleTeacherPickerInput(target, senderId, input);
      return true;
    }

    return false;
  }

  /**
   * Start group picker flow.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @returns {Promise<void>}
   */
  async startGroupPicker(target, senderId, page = 0) {
    await this.userPrefsRepository.setRole(senderId, "student");
    await this.clearPendingState(senderId, target);

    const groups = await this.getActiveGroups();
    if (!groups.length) {
      await this.sendText(target, "Нет активных групп. Сначала выполните `/обновить`.");
      return;
    }

    const pageSize = 24;
    const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const from = safePage * pageSize;
    const currentPageGroups = groups.slice(from, from + pageSize);

    const senderToken = encodeToken(senderId);
    const buttons = [];
    for (let index = 0; index < currentPageGroups.length; index += 2) {
      const row = [];
      const first = currentPageGroups[index];
      const second = currentPageGroups[index + 1];

      row.push({
        type: "callback",
        text: first.name,
        payload: `cmd:pickg:${first.code}:${senderToken}`
      });

      if (second) {
        row.push({
          type: "callback",
          text: second.name,
          payload: `cmd:pickg:${second.code}:${senderToken}`
        });
      }

      buttons.push(row);
    }

    if (totalPages > 1) {
      const navRow = [];
      if (safePage > 0) {
        navRow.push({
          type: "callback",
          text: "← Назад",
          payload: `cmd:gpage:${safePage - 1}:${senderToken}`
        });
      }
      if (safePage < totalPages - 1) {
        navRow.push({
          type: "callback",
          text: "Вперед →",
          payload: `cmd:gpage:${safePage + 1}:${senderToken}`
        });
      }
      if (navRow.length) buttons.push(navRow);
    }

    await this.sendText(target, `Выберите группу (страница ${safePage + 1}/${totalPages}):`, {
      attachments: [{ type: "inline_keyboard", payload: { buttons } }],
      noMenu: true,
      senderId
    });
  }

  /**
   * Start teacher picker flow.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @returns {Promise<void>}
   */
  async startTeacherPicker(target, senderId) {
    await this.userPrefsRepository.setRole(senderId, "teacher");
    await this.setPendingState(senderId, target, "await_teacher_query");
    await this.sendText(
      target,
      "Введите фамилию или часть ФИО преподавателя.\nПример: `Иванов`.\nДля отмены напишите: `отмена`.",
      { noMenu: true, senderId }
    );
  }

  /**
   * Start date picker flow based on current role and selected group/teacher.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @returns {Promise<void>}
   */
  async startDatePicker(target, senderId) {
    const role = await this.getUserRole(senderId);
    if (!role) {
      await this.sendText(target, this.roleSelectionMessage(), {
        attachments: this.roleSelectionKeyboard(senderId),
        senderId
      });
      return;
    }

    let dates = [];
    if (role === "teacher") {
      const teacherResolved = await this.resolveTeacher(senderId, "");
      if (teacherResolved.error) {
        await this.sendText(
          target,
          "Сначала выберите преподавателя (`/препод <ФИО>` или кнопка `Выбор преподавателя`)."
        );
        return;
      }

      const lessons = await this.getTeacherLessons(teacherResolved.teacher);
      dates = Array.from(new Set(lessons.map((lesson) => String(lesson.date || "")).filter(isIsoDate))).sort(
        (a, b) => a.localeCompare(b)
      );
    } else {
      const groupResolved = await this.resolveGroup(senderId, "");
      if (groupResolved.error) {
        await this.sendText(target, "Сначала выберите группу (`/группа <код>` или кнопка `Выбор группы`).");
        return;
      }

      const lessons = await this.scheduleRepository.getActiveLessons({ groupCode: groupResolved.group.code });
      dates = Array.from(new Set(lessons.map((lesson) => String(lesson.date || "")).filter(isIsoDate))).sort(
        (a, b) => a.localeCompare(b)
      );
    }

    if (!dates.length) {
      await this.sendText(target, "Для выбранного режима нет доступных дат с занятиями.");
      return;
    }

    const list = dates;
    const senderToken = encodeToken(senderId);
    const buttons = [];

    for (let index = 0; index < list.length; index += 2) {
      const row = [];
      const first = list[index];
      const second = list[index + 1];
      row.push({
        type: "callback",
        text: toRuDate(first),
        payload: `cmd:datepick:${first}:${senderToken}`
      });
      if (second) {
        row.push({
          type: "callback",
          text: toRuDate(second),
          payload: `cmd:datepick:${second}:${senderToken}`
        });
      }
      buttons.push(row);
    }

    const text = "Выберите дату:";

    await this.sendText(target, text, {
      attachments: [{ type: "inline_keyboard", payload: { buttons } }],
      noMenu: true,
      senderId
    });
  }

  /**
   * Process group picker query and return selection buttons.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string} input
   * @returns {Promise<void>}
   */
  async handleGroupPickerInput(target, senderId, input) {
    const groups = await this.getActiveGroups();
    if (!groups.length) {
      await this.sendText(target, "Нет активных групп. Сначала выполните `/обновить`.");
      return;
    }

    const query = input.toLowerCase();
    const filtered = groups.filter(
      (group) => group.code.includes(query) || group.name.toLowerCase().includes(query)
    );

    if (!filtered.length) {
      await this.sendText(target, "Ничего не найдено. Уточните запрос или введите `отмена`.", {
        noMenu: true,
        senderId
      });
      return;
    }

    if (filtered.length === 1) {
      await this.clearPendingState(senderId, target);
      await this.userPrefsRepository.setPreferredGroup(senderId, filtered[0]);
      await this.userPrefsRepository.setRole(senderId, "student");
      await this.sendText(
        target,
        `Группа выбрана: ${filtered[0].name} (код: ${filtered[0].code})`,
        { attachments: this.mainMenuKeyboard("student", senderId), senderId }
      );
      return;
    }

    const limit = 12;
    const senderToken = encodeToken(senderId);
    const buttons = filtered.slice(0, limit).map((group) => [
      {
        type: "callback",
        text: `${group.name} (${group.code})`,
        payload: `cmd:pickg:${group.code}:${senderToken}`
      }
    ]);

    let textOut = `Найдено групп: ${filtered.length}. Выберите группу кнопкой ниже.`;
    if (filtered.length > limit) {
      textOut += `\nПоказаны первые ${limit}. Уточните запрос для более точного списка.`;
    }

    await this.sendText(target, textOut, {
      attachments: [
        {
          type: "inline_keyboard",
          payload: { buttons }
        }
      ],
      noMenu: true,
      senderId
    });
  }

  /**
   * Process teacher picker query and return selection buttons.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string} input
   * @returns {Promise<void>}
   */
  async handleTeacherPickerInput(target, senderId, input) {
    const teachers = await this.getActiveTeachers();
    if (!teachers.length) {
      await this.sendText(target, "Нет списка преподавателей. Сначала выполните `/обновить`.");
      return;
    }

    const query = input.toLowerCase();
    const queryKey = teacherMatchKey(input);
    const filtered = teachers.filter(
      (teacher) =>
        teacher.name.toLowerCase().includes(query) || (queryKey && teacher.key.startsWith(queryKey))
    );

    if (!filtered.length) {
      await this.sendText(target, "Ничего не найдено. Уточните запрос или введите `отмена`.", {
        noMenu: true,
        senderId
      });
      return;
    }

    if (filtered.length === 1) {
      await this.clearPendingState(senderId, target);
      await this.userPrefsRepository.setPreferredTeacher(senderId, filtered[0]);
      await this.userPrefsRepository.setRole(senderId, "teacher");
      await this.sendText(target, `Преподаватель выбран: ${filtered[0].name}`, {
        attachments: this.mainMenuKeyboard("teacher", senderId),
        senderId
      });
      return;
    }

    const limit = 12;
    const senderToken = encodeToken(senderId);
    const buttons = filtered.slice(0, limit).map((teacher) => {
      const token = encodeToken(teacher.code ? `code:${teacher.code}` : `key:${teacher.key}`);
      return [
        {
          type: "callback",
          text: teacher.name,
          payload: `cmd:pickt:${token}:${senderToken}`
        }
      ];
    });

    let textOut = `Найдено преподавателей: ${filtered.length}. Выберите преподавателя кнопкой ниже.`;
    if (filtered.length > limit) {
      textOut += `\nПоказаны первые ${limit}. Уточните запрос для более точного списка.`;
    }

    await this.sendText(target, textOut, {
      attachments: [
        {
          type: "inline_keyboard",
          payload: { buttons }
        }
      ],
      noMenu: true,
      senderId
    });
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
   * Read active teachers from current schedule snapshot and deduplicate by initials key.
   *
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async getActiveTeachers() {
    const teachers = await this.scheduleRepository.getActiveTeachers();
    const byKey = new Map();

    teachers.forEach((teacher) => {
      const key = teacherMatchKey(teacher.name);
      if (!key) return;

      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, {
          key,
          code: teacher.code || null,
          name: teacher.name
        });
        return;
      }

      // Prefer full form over initials when both variants exist.
      const prevScore = prev.name.length + (prev.code ? 5 : 0);
      const nextScore = teacher.name.length + (teacher.code ? 5 : 0);
      if (nextScore > prevScore) {
        byKey.set(key, {
          key,
          code: teacher.code || null,
          name: teacher.name
        });
      }
    });

    return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name, "ru"));
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
   * Resolve a teacher by explicit input or user preference.
   *
   * @param {string} senderId
   * @param {string} rawTeacherInput
   * @returns {Promise<{teacher?: Record<string, any>, error?: string}>}
   */
  async resolveTeacher(senderId, rawTeacherInput) {
    const teachers = await this.getActiveTeachers();
    if (!teachers.length) {
      return { error: "Список преподавателей пока недоступен. Выполните `/обновить`." };
    }

    let input = (rawTeacherInput || "").trim();
    if (!input) {
      const pref = await this.userPrefsRepository.getByUserId(senderId);
      if (!pref?.preferredTeacherName && !pref?.preferredTeacherKey) {
        return {
          error:
            "Преподаватель не указан. Используйте `/препод <ФИО>` или передайте ФИО в команде."
        };
      }

      if (pref.preferredTeacherKey) {
        const byKey = teachers.find((teacher) => teacher.key === pref.preferredTeacherKey);
        if (byKey) return { teacher: byKey };
      }

      input = pref.preferredTeacherName || "";
    }

    const byCode = teachers.find((teacher) => teacher.code && teacher.code === input);
    if (byCode) return { teacher: byCode };

    const lower = input.toLowerCase();
    const byNameExact = teachers.find((teacher) => teacher.name.toLowerCase() === lower);
    if (byNameExact) return { teacher: byNameExact };

    const byKeyExact = teachers.find((teacher) => teacher.key === teacherMatchKey(input));
    if (byKeyExact) return { teacher: byKeyExact };

    const byNameContains = teachers.filter((teacher) => teacher.name.toLowerCase().includes(lower));
    if (byNameContains.length === 1) {
      return { teacher: byNameContains[0] };
    }

    if (byNameContains.length > 1) {
      return {
        error: `Слишком много совпадений. Подходят: ${byNameContains
          .slice(0, 10)
          .map((teacher) => teacher.name)
          .join(", ")}`
      };
    }

    return { error: `Преподаватель не найден: ${input}` };
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

    const lines = filtered.map((g, index) => `${index + 1}. ${g.name} (код: ${g.code})`);
    let result = `Найдено групп: ${filtered.length}\n\n${lines.join("\n")}`;
    result += "\n\nЧтобы выбрать группу: `/группа <код>`";

    await this.sendText(target, result);
  }

  /**
   * Handle `/teachers` command.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async handleTeachersCommand(target, args) {
    const teachers = await this.getActiveTeachers();
    if (!teachers.length) {
      await this.sendText(target, "Нет списка преподавателей. Сначала выполните `/обновить`.");
      return;
    }

    const query = args.join(" ").trim().toLowerCase();
    const filtered = query
      ? teachers.filter((teacher) => teacher.name.toLowerCase().includes(query))
      : teachers;

    if (!filtered.length) {
      await this.sendText(target, "По вашему запросу преподаватели не найдены.");
      return;
    }

    const lines = filtered.map((teacher, index) => `${index + 1}. ${teacher.name}`);
    let result = `Найдено преподавателей: ${filtered.length}\n\n${lines.join("\n")}`;
    result += "\n\nЧтобы выбрать преподавателя: `/препод <ФИО>`";

    await this.sendText(target, result);
  }

  /**
   * Get configured lesson start time by lesson number.
   *
   * @param {number} lessonNumber
   * @returns {string}
   */
  getLessonStartTime(lessonNumber) {
    return this.lessonStartTimes[lessonNumber] || "--:--";
  }

  /**
   * Get lesson time range by lesson number.
   * Rule: `LESSON_PART_MINUTES + MID_LESSON_BREAK_MINUTES + LESSON_PART_MINUTES`
   * inside a lesson, plus `BETWEEN_LESSONS_BREAK_MINUTES` between lessons.
   *
   * @param {number} lessonNumber
   * @returns {string}
   */
  getLessonTimeRange(lessonNumber) {
    const lessonNo = Number.parseInt(lessonNumber, 10);
    if (!Number.isFinite(lessonNo) || lessonNo < 1) return "--:--";

    const baseStart = hhmmToMinutes(this.lessonStartTimes[1]) ?? hhmmToMinutes("08:00");
    if (baseStart === null) return "--:--";

    const lessonDurationMinutes =
      this.lessonPartMinutes + this.midLessonBreakMinutes + this.lessonPartMinutes;
    const stepMinutes = lessonDurationMinutes + this.betweenLessonsBreakMinutes;
    const start = baseStart + (lessonNo - 1) * stepMinutes;
    const end = start + lessonDurationMinutes;
    return `${minutesToHhmm(start)} - ${minutesToHhmm(end)}`;
  }

  /**
   * Pick nearest lesson not earlier than current date/time.
   *
   * @param {Array<Record<string, any>>} lessons
   * @returns {Record<string, any>|null}
   */
  findNextLesson(lessons) {
    if (!Array.isArray(lessons) || !lessons.length) return null;
    const now = getTimezoneNow(this.timezone);

    const sorted = lessons
      .slice()
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.lessonNumber - b.lessonNumber;
      });

    const upcoming = sorted.find((lesson) => {
      if (lesson.date > now.isoDate) return true;
      if (lesson.date < now.isoDate) return false;

      const start = this.getLessonStartTime(lesson.lessonNumber);
      if (start === "--:--") return true;
      return start >= now.hhmm;
    });

    return upcoming || null;
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
    await this.userPrefsRepository.setRole(senderId, "student");
    await this.clearPendingState(senderId, target);
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
   * Handle `/setteacher` command.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async handleSetTeacherCommand(target, senderId, args) {
    const input = args.join(" ").trim();
    if (!input) {
      await this.sendText(target, "Использование: `/препод <ФИО>`");
      return;
    }

    const resolved = await this.resolveTeacher(senderId, input);
    if (resolved.error) {
      await this.sendText(target, resolved.error);
      return;
    }

    await this.userPrefsRepository.setPreferredTeacher(senderId, resolved.teacher);
    await this.userPrefsRepository.setRole(senderId, "teacher");
    await this.clearPendingState(senderId, target);
    await this.sendText(target, `Преподаватель по умолчанию сохранен: ${resolved.teacher.name}`);
  }

  /**
   * Handle `/myteacher` command.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @returns {Promise<void>}
   */
  async handleMyTeacherCommand(target, senderId) {
    const pref = await this.userPrefsRepository.getByUserId(senderId);
    if (!pref?.preferredTeacherName) {
      await this.sendText(target, "Преподаватель по умолчанию не задан. Используйте `/препод <ФИО>`.");
      return;
    }

    await this.sendText(target, `Ваш преподаватель по умолчанию: ${pref.preferredTeacherName}`);
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
    const header = `${group.name} (${group.code})\n${toRuDate(isoDate)}`;

    if (!lessons.length) {
      return `${header}\n\nПар не найдено.`;
    }

    const sorted = lessons
      .slice()
      .sort((a, b) => {
        if (a.lessonNumber !== b.lessonNumber) return a.lessonNumber - b.lessonNumber;
        return (a.columnIndex || 0) - (b.columnIndex || 0);
      });

    const blocks = sorted.map((lesson) => {
      const room = lesson.room || "-";
      const teacher = lesson.teacher || "-";
      const lessonTime = this.getLessonTimeRange(lesson.lessonNumber);
      const [startRaw, endRaw] = lessonTime.split(" - ");
      const start = prettyTime(startRaw);
      const end = prettyTime(endRaw);
      return [
        `${lesson.lessonNumber}. ${start} - ${end}`,
        `${lesson.subject} (${room})`,
        teacher
      ].join("\n");
    });

    return `${header}\n\n${blocks.join("\n\n")}`;
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
  async handleStudentDayScheduleCommand(target, senderId, isoDate, args) {
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
  async handleStudentDateCommand(target, senderId, args) {
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
    await this.handleStudentDayScheduleCommand(target, senderId, dateArg, groupInput ? [groupInput] : []);
  }

  /**
   * Handle `/next` command.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async handleStudentNextCommand(target, senderId, args) {
    const input = args.join(" ").trim();
    const resolved = await this.resolveGroup(senderId, input);

    if (resolved.error) {
      await this.sendText(target, resolved.error);
      return;
    }

    const lessons = await this.scheduleRepository.getActiveLessons({ groupCode: resolved.group.code });
    const nextLesson = this.findNextLesson(lessons);

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
      `Время начала: ${this.getLessonStartTime(nextLesson.lessonNumber)}`,
      nextLesson.subject,
      `Аудитория: ${nextLesson.room || "-"}`,
      `Преподаватель: ${nextLesson.teacher || "-"}`
    ].join("\n");

    await this.sendText(target, message);
  }

  /**
   * Filter active lessons by teacher identity and optional date.
   *
   * @param {{name: string, key: string}} teacher
   * @param {{date?: string}} [filters]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async getTeacherLessons(teacher, filters = {}) {
    const lessons = await this.scheduleRepository.getActiveLessons(filters.date ? { date: filters.date } : {});
    const filtered = lessons
      .filter((lesson) => teacherMatchKey(lesson.teacher) === teacher.key)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        if (a.lessonNumber !== b.lessonNumber) return a.lessonNumber - b.lessonNumber;
        return (a.groupName || "").localeCompare(b.groupName || "", "ru");
      });

    const teacherPageOnly = filtered.filter((lesson) => String(lesson.groupCode || "").startsWith("tp:"));
    const source = teacherPageOnly.length > 0 ? teacherPageOnly : filtered;
    return this.mergeTeacherParallelLessons(source);
  }

  /**
   * Merge parallel teacher lessons into one row when time and room are the same.
   *
   * @param {Array<Record<string, any>>} lessons
   * @returns {Array<Record<string, any>>}
   */
  mergeTeacherParallelLessons(lessons) {
    const buckets = new Map();

    lessons.forEach((lesson) => {
      const date = String(lesson.date || "");
      const lessonNumber = Number.parseInt(lesson.lessonNumber, 10);
      const room = String(lesson.room || "-");
      const subjectKey = String(lesson.subject || "").toLowerCase();
      const key = `${date}|${lessonNumber}|${room}|${subjectKey}`;
      const groupLabel = String(lesson.groupName || "");
      const subjectLabel = String(lesson.subject || "");

      if (!buckets.has(key)) {
        buckets.set(key, {
          lesson: { ...lesson },
          groups: new Set(groupLabel ? [groupLabel] : []),
          subjects: new Set(subjectLabel ? [subjectLabel] : [])
        });
        return;
      }

      const item = buckets.get(key);
      if (groupLabel) item.groups.add(groupLabel);
      if (subjectLabel) item.subjects.add(subjectLabel);
    });

    return Array.from(buckets.values())
      .map(({ lesson, groups, subjects }) => {
        const groupsList = Array.from(groups).filter(Boolean);
        const subjectsList = Array.from(subjects).filter(Boolean);

        return {
          ...lesson,
          groupName: groupsList.length ? groupsList.join(" ") : lesson.groupName || null,
          subject: subjectsList.length > 1 ? subjectsList.join(" / ") : lesson.subject
        };
      })
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        if (a.lessonNumber !== b.lessonNumber) return a.lessonNumber - b.lessonNumber;
        return String(a.groupName || "").localeCompare(String(b.groupName || ""), "ru");
      });
  }

  /**
   * Format teacher day schedule for a readable bot response.
   *
   * @param {{name: string}} teacher
   * @param {string} isoDate
   * @param {Array<Record<string, any>>} lessons
   * @returns {string}
   */
  formatTeacherLessonsForDay(teacher, isoDate, lessons) {
    const header = `${teacher.name}\n${toRuDate(isoDate)}`;
    if (!lessons.length) {
      return `${header}\n\nПар не найдено.`;
    }

    const sorted = lessons
      .slice()
      .sort((a, b) => {
        if (a.lessonNumber !== b.lessonNumber) return a.lessonNumber - b.lessonNumber;
        return (a.groupName || "").localeCompare(b.groupName || "", "ru");
      });

    const byLessonNumber = new Map();
    sorted.forEach((lesson) => {
      const lessonNumber = Number.parseInt(lesson.lessonNumber, 10);
      if (!Number.isFinite(lessonNumber)) return;
      const list = byLessonNumber.get(lessonNumber) || [];
      list.push(lesson);
      byLessonNumber.set(lessonNumber, list);
    });

    const numbers = Array.from(byLessonNumber.keys()).sort((a, b) => a - b);
    if (!numbers.length) return `${header}\n\nПар не найдено.`;

    const blocks = [];
    const minLesson = numbers[0];
    const maxLesson = numbers[numbers.length - 1];

    for (let lessonNumber = minLesson; lessonNumber <= maxLesson; lessonNumber += 1) {
      const rows = byLessonNumber.get(lessonNumber) || [];
      if (!rows.length) {
        const lessonTime = this.getLessonTimeRange(lessonNumber);
        const [startRaw, endRaw] = lessonTime.split(" - ");
        const start = prettyTime(startRaw);
        const end = prettyTime(endRaw);
        blocks.push(`${lessonNumber}. ${start} - ${end}\nПары нет`);
        continue;
      }

      rows.forEach((lesson) => {
        const room = lesson.room || "-";
        const group = lesson.groupName || "";
        const lessonTime = this.getLessonTimeRange(lesson.lessonNumber);
        const [startRaw, endRaw] = lessonTime.split(" - ");
        const start = prettyTime(startRaw);
        const end = prettyTime(endRaw);
        const location = cleanText([group, room !== "-" ? room : ""].filter(Boolean).join(" ")) || room;
        blocks.push([`${lesson.lessonNumber}. ${start} - ${end}`, location, lesson.subject].join("\n"));
      });
    }

    return `${header}\n\n${blocks.join("\n\n")}`;
  }

  /**
   * Handle teacher day-based commands.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string} isoDate
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async handleTeacherDayScheduleCommand(target, senderId, isoDate, args) {
    const input = args.join(" ").trim();
    const resolved = await this.resolveTeacher(senderId, input);

    if (resolved.error) {
      await this.sendText(target, resolved.error);
      return;
    }

    const lessons = await this.getTeacherLessons(resolved.teacher, { date: isoDate });
    const text = this.formatTeacherLessonsForDay(resolved.teacher, isoDate, lessons);
    await this.sendText(target, text);
  }

  /**
   * Handle `/date` command in teacher mode.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async handleTeacherDateCommand(target, senderId, args) {
    if (!args.length) {
      await this.sendText(target, "Использование: `/дата <YYYY-MM-DD> [ФИО]`");
      return;
    }

    const dateArg = args[0];
    if (!isIsoDate(dateArg)) {
      await this.sendText(target, "Неверный формат даты. Ожидается `YYYY-MM-DD`.");
      return;
    }

    const teacherInput = args.slice(1).join(" ");
    await this.handleTeacherDayScheduleCommand(target, senderId, dateArg, teacherInput ? [teacherInput] : []);
  }

  /**
   * Handle `/next` command in teacher mode.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async handleTeacherNextCommand(target, senderId, args) {
    const input = args.join(" ").trim();
    const resolved = await this.resolveTeacher(senderId, input);

    if (resolved.error) {
      await this.sendText(target, resolved.error);
      return;
    }

    const lessons = await this.getTeacherLessons(resolved.teacher);
    const nextLesson = this.findNextLesson(lessons);

    if (!nextLesson) {
      await this.sendText(target, `Для преподавателя ${resolved.teacher.name} ближайшие пары не найдены.`);
      return;
    }
    const dayLessonsCount = new Set(
      lessons
        .filter((lesson) => lesson.date === nextLesson.date)
        .map((lesson) => Number.parseInt(lesson.lessonNumber, 10))
        .filter((lessonNumber) => Number.isFinite(lessonNumber))
    ).size;

    const message = [
      `Ближайшая пара преподавателя ${resolved.teacher.name}:`,
      `${toRuDate(nextLesson.date)}, пара ${nextLesson.lessonNumber}`,
      `Время начала: ${this.getLessonStartTime(nextLesson.lessonNumber)}`,
      nextLesson.subject,
      `Группа: ${nextLesson.groupName || "-"}`,
      `Аудитория: ${nextLesson.room || "-"}`,
      `Всего пар в этот день: ${dayLessonsCount}`
    ].join("\n");

    await this.sendText(target, message);
  }

  /**
   * Parse reminder command args into lead-day options.
   *
   * @param {string[]} args
   * @returns {number[]|null}
   */
  parseReminderDays(args) {
    const raw = args.join(" ").trim().toLowerCase();
    if (!raw) return null;

    const compact = raw.replace(/\s+/g, "");
    const offSet = new Set(["0", "off", "disable", "выкл", "выключить", "нет", "stop"]);
    if (offSet.has(compact)) return [];

    if (compact === "1") return [1];
    if (compact === "2") return [2];

    if (compact === "1,2" || compact === "2,1" || compact === "12" || compact === "21") {
      return [1, 2];
    }

    const tokens = raw
      .split(/[\s,;]+/)
      .map((token) => token.trim())
      .filter(Boolean);

    const parsed = new Set();
    tokens.forEach((token) => {
      if (token === "1") parsed.add(1);
      if (token === "2") parsed.add(2);
    });

    if (!parsed.size) return null;
    return Array.from(parsed).sort((a, b) => a - b);
  }

  /**
   * Build human-readable reminder status line.
   *
   * @param {Record<string, any>|null} pref
   * @returns {string}
   */
  buildReminderStatus(pref) {
    if (!pref?.reminderEnabled || !Array.isArray(pref.reminderDaysBefore) || !pref.reminderDaysBefore.length) {
      return "Напоминания: выключены.";
    }

    const labels = pref.reminderDaysBefore
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => value === 1 || value === 2)
      .sort((a, b) => a - b)
      .map((value) => (value === 1 ? "за 1 день" : "за 2 дня"));

    if (!labels.length) return "Напоминания: выключены.";
    return `Напоминания: включены (${labels.join(", ")}).`;
  }

  /**
   * Build inline keyboard for reminder settings.
   *
   * @param {string} senderId
   * @param {Record<string, any>|null} pref
   * @returns {Array<Record<string, any>>}
   */
  reminderSettingsKeyboard(senderId, pref) {
    const enabled = Boolean(pref?.reminderEnabled);
    const days = new Set(
      enabled
        ? (pref?.reminderDaysBefore || [])
            .map((value) => Number.parseInt(value, 10))
            .filter((value) => value === 1 || value === 2)
        : []
    );

    const only1 = days.has(1) && !days.has(2);
    const only2 = !days.has(1) && days.has(2);
    const both = days.has(1) && days.has(2);
    const disabled = !enabled || days.size === 0;
    const mark = (active, label) => (active ? `✅ ${label}` : label);

    return [
      {
        type: "inline_keyboard",
        payload: {
          buttons: [
            [
              {
                type: "callback",
                text: mark(only1, "За 1 день"),
                payload: `cmd:remset:1:${encodeToken(senderId)}`
              },
              {
                type: "callback",
                text: mark(only2, "За 2 дня"),
                payload: `cmd:remset:2:${encodeToken(senderId)}`
              }
            ],
            [
              {
                type: "callback",
                text: mark(both, "За 1 и 2 дня"),
                payload: `cmd:remset:1,2:${encodeToken(senderId)}`
              }
            ],
            [
              {
                type: "callback",
                text: mark(disabled, "Выключить"),
                payload: `cmd:remset:off:${encodeToken(senderId)}`
              }
            ],
            [callbackButton("Меню", "help", senderId)]
          ]
        }
      }
    ];
  }

  /**
   * Handle reminder settings command.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async handleReminderCommand(target, senderId, args) {
    const pref = await this.userPrefsRepository.getByUserId(senderId);
    const role = pref?.role === "teacher" ? "teacher" : pref?.role === "student" ? "student" : null;

    if (!role) {
      await this.sendText(
        target,
        "Сначала выберите роль: `/студент` или `/преподаватель`, затем настройте напоминания."
      );
      return;
    }

    if (role === "student" && !pref?.preferredGroupCode) {
      await this.sendText(target, "Сначала выберите группу (`/группа <код>` или кнопка `Выбор группы`).");
      return;
    }

    if (role === "teacher" && !pref?.preferredTeacherName && !pref?.preferredTeacherKey) {
      await this.sendText(
        target,
        "Сначала выберите преподавателя (`/препод <ФИО>` или кнопка `Выбор преподавателя`)."
      );
      return;
    }

    const parsedDays = this.parseReminderDays(args);
    if (parsedDays === null) {
      const status = this.buildReminderStatus(pref);
      await this.sendText(
        target,
        [
          status,
          "",
          "Настройка:",
          "- `/напоминание 1` — за 1 день",
          "- `/напоминание 2` — за 2 дня",
          "- `/напоминание 1,2` — за 1 и 2 дня",
          "- `/напоминание выкл` — отключить"
        ].join("\n"),
        {
          attachments: this.reminderSettingsKeyboard(senderId, pref),
          noMenu: true,
          senderId
        }
      );
      return;
    }

    await this.userPrefsRepository.setReminderSettings(senderId, {
      enabled: parsedDays.length > 0,
      daysBefore: parsedDays
    });

    const updatedPref = await this.userPrefsRepository.getByUserId(senderId);
    await this.sendText(target, this.buildReminderStatus(updatedPref), {
      attachments: this.reminderSettingsKeyboard(senderId, updatedPref),
      noMenu: true,
      senderId
    });
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
