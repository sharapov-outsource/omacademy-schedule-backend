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
  "обновить": "sync"
};

function resolveCommandAlias(command) {
  return COMMAND_ALIASES[command] || command;
}

const CALLBACK_ACTIONS = {
  role: "role",
  student: "student",
  teacher: "teacher",
  pick_group: "pick_group",
  pick_teacher: "pick_teacher",
  today: "today",
  tomorrow: "tomorrow",
  next: "next",
  mygroup: "mygroup",
  myteacher: "myteacher",
  groups: "groups",
  teachers: "teachers",
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
      await this.replyFromBotStarted(update);
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
  roleSelectionKeyboard() {
    return [
      {
        type: "inline_keyboard",
        payload: {
          buttons: [
            [callbackButton("Я студент", "student"), callbackButton("Я преподаватель", "teacher")]
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
  mainMenuKeyboard(role = "student") {
    const roleButtons =
      role === "teacher"
        ? [
            [callbackButton("Сегодня", "today"), callbackButton("Завтра", "tomorrow")],
            [callbackButton("Следующая пара", "next"), callbackButton("Выбрать преподавателя", "pick_teacher")],
            [callbackButton("Мой преподаватель", "myteacher"), callbackButton("Преподаватели", "teachers")],
            [callbackButton("Я студент", "student")],
            [callbackButton("Помощь", "help"), callbackButton("Обновить", "sync")]
          ]
        : [
            [callbackButton("Сегодня", "today"), callbackButton("Завтра", "tomorrow")],
            [callbackButton("Следующая пара", "next"), callbackButton("Выбрать группу", "pick_group")],
            [callbackButton("Моя группа", "mygroup"), callbackButton("Группы", "groups")],
            [callbackButton("Я преподаватель", "teacher")],
            [callbackButton("Помощь", "help"), callbackButton("Обновить", "sync")]
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
        attachments: this.roleSelectionKeyboard()
      };
    }

    return {
      text: this.helpMessage(role),
      attachments: this.mainMenuKeyboard(role)
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

    const senderId = this.resolveSenderId(update);
    const target = this.resolveTarget(update);
    if (!senderId || !target) {
      await this.safeAnswerCallback(callbackId, "Не удалось обработать кнопку.");
      return;
    }

    const command = parseCallbackCommand(update?.callback?.payload || update?.payload);

    if (command.startsWith("pickg:")) {
      const groupCode = command.slice("pickg:".length).trim();
      await this.safeAnswerCallback(callbackId, "Выбрано");
      await this.handlePickGroupFromCallback(target, senderId, groupCode);
      return;
    }

    if (command.startsWith("pickt:")) {
      const token = command.slice("pickt:".length).trim();
      await this.safeAnswerCallback(callbackId, "Выбрано");
      await this.handlePickTeacherFromCallback(target, senderId, token);
      return;
    }

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
   * Handle callback selection for group.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string} groupCode
   * @returns {Promise<void>}
   */
  async handlePickGroupFromCallback(target, senderId, groupCode) {
    if (!groupCode) {
      await this.sendText(target, "Не удалось определить группу. Попробуйте снова.");
      return;
    }

    const resolved = await this.resolveGroup(senderId, groupCode);
    if (resolved.error) {
      await this.sendText(target, resolved.error);
      return;
    }

    await this.userPrefsRepository.setPreferredGroup(senderId, resolved.group);
    await this.userPrefsRepository.setRole(senderId, "student");
    await this.sendText(
      target,
      `Группа выбрана: ${resolved.group.name} (код: ${resolved.group.code})`,
      { attachments: this.mainMenuKeyboard("student") }
    );
  }

  /**
   * Handle callback selection for teacher.
   *
   * @param {{chatId?: string|number, userId?: string|number}} target
   * @param {string} senderId
   * @param {string} token
   * @returns {Promise<void>}
   */
  async handlePickTeacherFromCallback(target, senderId, token) {
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

    await this.userPrefsRepository.setPreferredTeacher(senderId, teacher);
    await this.userPrefsRepository.setRole(senderId, "teacher");
    await this.sendText(target, `Преподаватель выбран: ${teacher.name}`, {
      attachments: this.mainMenuKeyboard("teacher")
    });
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
          attachments: this.roleSelectionKeyboard()
        });
        return;

      case "student":
        await this.userPrefsRepository.setRole(senderId, "student");
        await this.sendText(target, "Режим переключен: Студент.", {
          attachments: this.mainMenuKeyboard("student")
        });
        return;

      case "teacher":
        await this.userPrefsRepository.setRole(senderId, "teacher");
        await this.sendText(target, "Режим переключен: Преподаватель.", {
          attachments: this.mainMenuKeyboard("teacher")
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
            attachments: this.roleSelectionKeyboard()
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
            attachments: this.roleSelectionKeyboard()
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
            attachments: this.roleSelectionKeyboard()
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
            attachments: this.roleSelectionKeyboard()
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

      case "sync":
        await this.handleSyncCommand(target, senderId);
        return;

      default:
        await this.sendText(target, "Неизвестная команда. Используйте `/помощь`.");
    }
  }

  /**
   * Handle text in the context of pending multi-step selection flow.
   *
   * @param {{senderId: string, target: {chatId?: string|number, userId?: string|number}, text: string}} params
   * @returns {Promise<boolean>}
   */
  async handlePendingTextInput({ senderId, target, text }) {
    const pref = await this.userPrefsRepository.getByUserId(senderId);
    const pendingAction = pref?.pendingAction;
    if (!pendingAction) return false;

    const input = String(text || "").trim();
    if (!input) return true;

    const lower = input.toLowerCase();
    if (lower === "отмена" || lower === "cancel") {
      await this.userPrefsRepository.clearPendingAction(senderId);
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
  async startGroupPicker(target, senderId) {
    await this.userPrefsRepository.setRole(senderId, "student");
    await this.userPrefsRepository.setPendingAction(senderId, "await_group_query");
    await this.sendText(
      target,
      "Введите часть названия группы или код группы.\nПример: `исп-9.15` или `60`.\nДля отмены напишите: `отмена`."
    );
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
    await this.userPrefsRepository.setPendingAction(senderId, "await_teacher_query");
    await this.sendText(
      target,
      "Введите фамилию или часть ФИО преподавателя.\nПример: `тигова`.\nДля отмены напишите: `отмена`."
    );
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
      await this.sendText(target, "Ничего не найдено. Уточните запрос или введите `отмена`.");
      return;
    }

    if (filtered.length === 1) {
      await this.userPrefsRepository.setPreferredGroup(senderId, filtered[0]);
      await this.userPrefsRepository.setRole(senderId, "student");
      await this.sendText(
        target,
        `Группа выбрана: ${filtered[0].name} (код: ${filtered[0].code})`,
        { attachments: this.mainMenuKeyboard("student") }
      );
      return;
    }

    const limit = 12;
    const buttons = filtered.slice(0, limit).map((group) => [
      {
        type: "callback",
        text: `${group.name} (${group.code})`,
        payload: `cmd:pickg:${group.code}`
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
      ]
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
      await this.sendText(target, "Ничего не найдено. Уточните запрос или введите `отмена`.");
      return;
    }

    if (filtered.length === 1) {
      await this.userPrefsRepository.setPreferredTeacher(senderId, filtered[0]);
      await this.userPrefsRepository.setRole(senderId, "teacher");
      await this.sendText(target, `Преподаватель выбран: ${filtered[0].name}`, {
        attachments: this.mainMenuKeyboard("teacher")
      });
      return;
    }

    const limit = 12;
    const buttons = filtered.slice(0, limit).map((teacher) => {
      const token = encodeToken(teacher.code ? `code:${teacher.code}` : `key:${teacher.key}`);
      return [
        {
          type: "callback",
          text: teacher.name,
          payload: `cmd:pickt:${token}`
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
      ]
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

    const limit = query ? 60 : 35;
    const lines = filtered.slice(0, limit).map((g, index) => `${index + 1}. ${g.name} (код: ${g.code})`);

    let result = `Найдено групп: ${filtered.length}\n\n${lines.join("\n")}`;
    if (filtered.length > limit) {
      result += `\n\nПоказаны первые ${limit}. Уточните запрос: /группы <текст>.`;
    }
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

    const limit = query ? 60 : 35;
    const lines = filtered.slice(0, limit).map((teacher, index) => `${index + 1}. ${teacher.name}`);

    let result = `Найдено преподавателей: ${filtered.length}\n\n${lines.join("\n")}`;
    if (filtered.length > limit) {
      result += `\n\nПоказаны первые ${limit}. Уточните запрос: /преподаватели <текст>.`;
    }
    result += "\n\nЧтобы выбрать преподавателя: `/препод <ФИО>`";

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
    await this.userPrefsRepository.setRole(senderId, "student");
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
   * Filter active lessons by teacher identity and optional date.
   *
   * @param {{name: string, key: string}} teacher
   * @param {{date?: string}} [filters]
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async getTeacherLessons(teacher, filters = {}) {
    const lessons = await this.scheduleRepository.getActiveLessons(filters.date ? { date: filters.date } : {});
    return lessons
      .filter((lesson) => teacherMatchKey(lesson.teacher) === teacher.key)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        if (a.lessonNumber !== b.lessonNumber) return a.lessonNumber - b.lessonNumber;
        return (a.groupName || "").localeCompare(b.groupName || "", "ru");
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
    const header = `${teacher.name}\nДата: ${toRuDate(isoDate)}`;
    if (!lessons.length) {
      return `${header}\n\nПар не найдено.`;
    }

    const lines = lessons.map((lesson) => {
      const room = lesson.room || "-";
      const group = lesson.groupName || lesson.groupCode || "-";
      return `${lesson.lessonNumber}. ${lesson.subject}\n   Группа: ${group}\n   Аудитория: ${room}`;
    });

    return `${header}\n\n${lines.join("\n")}`;
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

    const today = getIsoDateInTimezone(this.timezone);
    const lessons = await this.getTeacherLessons(resolved.teacher);
    const nextLesson = lessons.filter((lesson) => lesson.date >= today)[0];

    if (!nextLesson) {
      await this.sendText(target, `Для преподавателя ${resolved.teacher.name} ближайшие пары не найдены.`);
      return;
    }

    const message = [
      `Ближайшая пара преподавателя ${resolved.teacher.name}:`,
      `${toRuDate(nextLesson.date)}, пара ${nextLesson.lessonNumber}`,
      nextLesson.subject,
      `Группа: ${nextLesson.groupName || nextLesson.groupCode || "-"}`,
      `Аудитория: ${nextLesson.room || "-"}`
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
