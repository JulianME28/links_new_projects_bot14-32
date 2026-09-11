// ============================================================
// Telegram бот: сповіщення про нові проекти
// Аркуші: "Меджик - {Місяць}" і "ГП - {Місяць}" (основна таблиця, SHEET_ID)
//
// ЩО РОБИТЬ:
//  🔴 Терміново (кожні 10 хв): рядок отримав статус у колонці "Публікація"
//     (Меджик — "Заплановано", ГП — "Погоджено донорів"),
//     Простір = "на тул", Дедлайн = сьогодні → сповіщення одразу.
//  🟡 Близькі ДДЛ (щогодини з 9:00 до 19:30): якщо термінових на сьогодні
//     немає — список запланованих на завтра/післязавтра.
//  📋 Кнопка "Сьогоднішні ДДЛ" (є і в адміна, і в працівників): показує проекти
//     з дедлайном сьогодні, у яких Публікація ще не "Опубліковано".
//  🧹 О 3:00 ночі чат очищається — залишаються тільки сповіщення за сьогодні.
//  🚫 Поза робочим часом (будні 9:30–19:30) автоматичні розсилки не йдуть.
//     Кнопки адміна працюють як завжди (див. isQuietTime).
// ============================================================

const ADMIN_ID = 0;   // запасне значення; реальний ID — у Script Properties → ADMIN_ID

const MONTHS_UA = [
  "Січень", "Лютий", "Березень", "Квітень",
  "Травень", "Червень", "Липень", "Серпень",
  "Вересень", "Жовтень", "Листопад", "Грудень"
];

// Аркуші і статус-тригер для кожного
const SHEETS = [
  { prefix: "Меджик", display: "🎩 <b>МЕДЖИК</b>", short: "М", trigger: "заплановано" },
  { prefix: "ГП",     display: "🔵 <b>ГП</b>",     short: "Г", trigger: "погоджено донор" }
];

// Значення в колонці "Простір", яке нас цікавить
const SPACE_VALUE = "на тул";

// Статус у колонці "Публікація", після якого проект вважається закритим
const DONE_STATUS = "опубліковано";

// Кнопки адміна
const BTN_SEND = "📤 Розіслати термінові";
const BTN_URGENT = "👀 Термінові (тільки мені)";
const BTN_SOON = "🟡 Близькі ДДЛ";

// Кнопка, доступна і адміну, і працівникам
const BTN_TODAY = "📋 Сьогоднішні ДДЛ";

// Колонки (1-based). FALLBACK — реально шукаємо за назвами заголовків у рядку 2.
const COLS = {
  project: 1,      // A — "№"
  client: 2,       // B — "Замовник"
  publication: 8,  // H — "Публікація"
  deadline: 14,    // N — "Дедлайн"
  space: 19        // S — "Простір"
};

// ---------- POLLING (обробка команд) ----------
function doPost(e) { return ContentService.createTextOutput("ok"); }

function poll() {
  const startMs = Date.now();
  const MAX_RUN_MS = 4 * 60 * 1000;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty("BOT_TOKEN");
    if (!token) throw new Error("BOT_TOKEN не встановлений");

    while (Date.now() - startMs < MAX_RUN_MS) {
      const offset = Number(props.getProperty("POLL_OFFSET") || "0");
      let resp;
      try {
        resp = UrlFetchApp.fetch(
          "https://api.telegram.org/bot" + token + "/getUpdates" +
          "?offset=" + offset +
          "&timeout=50" +
          "&allowed_updates=" + encodeURIComponent('["message"]'),
          { muteHttpExceptions: true }
        );
      } catch (fetchErr) {
        Logger.log("getUpdates помилка: " + fetchErr);
        Utilities.sleep(2000); continue;
      }
      const body = resp.getContentText();
      let data;
      try { data = JSON.parse(body); } catch (e0) { data = null; }
      if (!data || !data.ok) {
        Logger.log("getUpdates not ok: " + body.substring(0, 300));
        Utilities.sleep(2000); continue;
      }
      const updates = data.result || [];
      for (let i = 0; i < updates.length; i++) {
        const update = updates[i];
        props.setProperty("POLL_OFFSET", String(update.update_id + 1));
        try {
          if (update.message && update.message.text) handleMessage(update.message);
        } catch (msgErr) {
          Logger.log("handleMessage помилка: " + msgErr + " | " + (msgErr.stack || ""));
        }
      }
    }
  } catch (err) {
    Logger.log("poll помилка: " + err);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ---------- КОМАНДИ ----------
function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  trackMessage(chatId, msg.message_id);   // щоб уночі прибрати і команди теж
  const props = PropertiesService.getScriptProperties();
  const adminId = Number(props.getProperty("ADMIN_ID") || ADMIN_ID);
  const allowed = JSON.parse(props.getProperty("ALLOWED") || "[]");
  const isAdmin = chatId === adminId;
  const isUser = isAdmin || allowed.indexOf(chatId) !== -1;

  if (text === "/start" || text === "/id") {
    if (isAdmin) {
      sendMessage(chatId, "✅ Ви адміністратор бота.\n\nВаш ID: <code>" + chatId + "</code>", adminKeyboard());
    } else if (isUser) {
      sendMessage(chatId, "✅ Ви підписані на сповіщення про нові проекти.\n\nВаш ID: <code>" + chatId + "</code>", userKeyboard());
    } else {
      sendMessage(chatId, "👋 Вітаю!\n\nЩоб отримувати сповіщення, надішліть свій ID адміністратору:\n<code>" + chatId + "</code>");
      if (!isAdmin) sendMessage(adminId, "🔔 Новий запит на доступ.\nID: <code>" + chatId + "</code>\nДодати: /add " + chatId);
    }
    return;
  }

  if (text.indexOf("/add") === 0 && isAdmin) {
    const id = Number(text.replace("/add", "").trim());
    if (!id) { sendMessage(chatId, "Формат: /add 123456789"); return; }
    if (allowed.indexOf(id) === -1) allowed.push(id);
    props.setProperty("ALLOWED", JSON.stringify(allowed));
    sendMessage(chatId, "✅ Додано: " + id);
    try { sendMessage(id, "✅ Вам відкрито доступ до сповіщень про нові проекти.", userKeyboard()); } catch (e) {}
    return;
  }

  if (text.indexOf("/del") === 0 && isAdmin) {
    const id = Number(text.replace("/del", "").trim());
    const filtered = allowed.filter(function (x) { return x !== id; });
    props.setProperty("ALLOWED", JSON.stringify(filtered));
    sendMessage(chatId, "🗑 Видалено: " + id);
    return;
  }

  if (text === "/list" && isAdmin) {
    sendMessage(chatId, "👥 Підписники:\n" + (allowed.length ? allowed.join("\n") : "— порожньо —"));
    return;
  }

  if ((text === "/test" || text === BTN_URGENT) && isAdmin) {
    const res = checkUrgent(true, false);
    sendMessage(chatId, res || "Термінових проектів зараз немає.", adminKeyboard());
    return;
  }

  // Примусова розсилка всім підписникам — навіть якщо про ці проекти вже сповіщали
  if (text === BTN_SEND && isAdmin) {
    const res = checkUrgent(false, true);
    sendMessage(chatId, res ? deliveryReport(LAST_DELIVERY) : "Термінових проектів зараз немає — нічого розсилати.", adminKeyboard());
    return;
  }

  if (text === "/soon" || text === BTN_SOON) {
    if (!isUser) return;
    const digest = buildSoonDigest();
    sendMessage(chatId, digest || "Проектів з близьким дедлайном немає.", keyboardFor(isAdmin));
    return;
  }

  if (text === "/today" || text === BTN_TODAY) {
    if (!isUser) return;
    const list = buildTodayOpen();
    sendMessage(chatId, list || "Незакритих проектів із дедлайном на сьогодні немає. 🎉", keyboardFor(isAdmin));
    return;
  }

  if (isAdmin) {
    sendMessage(chatId, "Команди:\n/add ID — додати підписника\n/del ID — прибрати\n/list — список\n/test — перевірити зараз\n/soon — близькі дедлайни\n/today — сьогоднішні незакриті", adminKeyboard());
  }
}

function keyboardFor(isAdmin) {
  return isAdmin ? adminKeyboard() : userKeyboard();
}

function adminKeyboard() {
  return {
    keyboard: [[{ text: BTN_SEND }], [{ text: BTN_URGENT }, { text: BTN_SOON }], [{ text: BTN_TODAY }]],
    resize_keyboard: true
  };
}

function userKeyboard() {
  return {
    keyboard: [[{ text: BTN_TODAY }]],
    resize_keyboard: true
  };
}

// ---------- РОБОЧИЙ ЧАС ----------
// Автоматичні розсилки йдуть лише в будні з 9:30 до 19:30.
// Кнопки адміна працюють завжди.
const WORK_START_MIN = 9 * 60 + 30;
const WORK_END_MIN = 19 * 60 + 30;

function isQuietTime() {
  const now = new Date();
  const day = now.getDay();                                  // 0 = неділя … 6 = субота
  if (day === 0 || day === 6) return true;                   // субота, неділя — цілий день
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins < WORK_START_MIN || mins > WORK_END_MIN;
}

// ---------- 🔴 ТЕРМІНОВІ ----------
// dryRun=true — нічого не розсилає і не запам'ятовує, лише повертає текст.
// force=true — бере всі поточні термінові, навіть якщо про них вже сповіщали.
function checkUrgent(dryRun, force) {
  // Тригер за часом передає сюди свій об'єкт події — його треба ігнорувати,
  // інакше бот вважає автоматичний запуск за режим "тільки показати".
  dryRun = (dryRun === true);
  force = (force === true);

  // Автозапуск (не кнопка) у неробочий час — мовчимо
  if (!dryRun && !force && isQuietTime()) {
    Logger.log("checkUrgent: неробочий час, розсилку пропущено");
    return "";
  }

  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty("SHEET_ID");
  if (!sheetId) throw new Error("SHEET_ID не встановлений");
  const ss = SpreadsheetApp.openById(sheetId);

  const today = new Date();
  const monthName = MONTHS_UA[today.getMonth()];
  const notified = loadNotified(monthName);
  Logger.log("checkUrgent: dryRun=" + !!dryRun + " force=" + !!force + " | у пам'яті: " + notified.length);

  const blocks = [];
  const freshKeys = [];

  SHEETS.forEach(function (cfg) {
    const sheet = findSheetTolerant(ss, cfg.prefix + " - " + monthName);
    if (!sheet) return;

    const rows = readRows(sheet, cfg, today, 0);
    // Ключ із датою: поступовий проект (740 сьогодні, 740 через тиждень) сповіщається щоразу
    function keyOf(r) { return cfg.short + r.id + "@" + r.deadline.getDate() + "." + (r.deadline.getMonth() + 1); }

    const fresh = rows.filter(function (r) {
      if (dryRun || force) return true;
      return notified.indexOf(keyOf(r)) === -1;
    });
    Logger.log(cfg.prefix + ": підходить рядків " + rows.length + ", з них нових " + fresh.length);
    if (!fresh.length) return;

    fresh.forEach(function (r) { freshKeys.push(keyOf(r)); });
    blocks.push(
      cfg.display + "\n" +
      fresh.map(function (r) {
        return "№ <b>" + r.id + "</b> · " + r.client + "\nДДЛ: сьогодні, " + formatDate(r.deadline);
      }).join("\n\n")
    );
  });

  if (!blocks.length) { Logger.log("checkUrgent: нема чого надсилати"); return ""; }

  const text = "🔴 <b>Нові проекти — терміново</b>\n\n" + blocks.join("\n\n");
  if (!dryRun) {
    const delivery = sendToAll(text);
    Logger.log("Розіслано. Доставка: " + JSON.stringify(delivery));
    saveNotified(monthName, notified.concat(freshKeys));
    // Після автоматичної розсилки адмін бачить, чи дійшло працівникам
    if (!force) {
      sendMessage(Number(props.getProperty("ADMIN_ID") || ADMIN_ID), deliveryReport(delivery), adminKeyboard());
    }
  }
  return text;
}

// ---------- 🟡 БЛИЗЬКІ ДЕДЛАЙНИ ----------
function hourlyDigest() {
  if (isQuietTime()) { Logger.log("hourlyDigest: неробочий час, дайджест пропущено"); return; }

  // Не dryRun: інакше пам'ять notified ігнорується і вже надіслані термінові
  // блокують дайджест на весь день.
  const urgent = checkUrgent(false, false);
  if (urgent) return;   // пріоритет у термінових — дайджест не шлемо

  const digest = buildSoonDigest();
  if (digest) sendToAll(digest);
}

function buildSoonDigest() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.openById(props.getProperty("SHEET_ID"));
  const today = new Date();
  const monthName = MONTHS_UA[today.getMonth()];

  const blocks = [];
  SHEETS.forEach(function (cfg) {
    const sheet = findSheetTolerant(ss, cfg.prefix + " - " + monthName);
    if (!sheet) return;

    const rows = readRows(sheet, cfg, today, 1).concat(readRows(sheet, cfg, today, 2));
    if (!rows.length) return;

    blocks.push(
      cfg.display + "\n" +
      rows.map(function (r) {
        const when = sameDay(r.deadline, addDays(today, 1)) ? "завтра" : "післязавтра";
        return "№ <b>" + r.id + "</b> · " + r.client + " — " + when + ", " + formatDate(r.deadline);
      }).join("\n")
    );
  });

  if (!blocks.length) return "";
  return "🟡 <b>Проекти з близьким дедлайном</b>\n\n" + blocks.join("\n\n");
}

// ---------- 📋 СЬОГОДНІШНІ ДДЛ, ЩЕ НЕ ЗАКРИТІ ----------
// Доступно і адміну, і працівникам. Пам'ять NOTIFIED тут не враховується —
// це список стану на зараз, а не сповіщення.
function buildTodayOpen() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.openById(props.getProperty("SHEET_ID"));
  const today = new Date();
  const monthName = MONTHS_UA[today.getMonth()];

  const blocks = [];
  SHEETS.forEach(function (cfg) {
    const sheet = findSheetTolerant(ss, cfg.prefix + " - " + monthName);
    if (!sheet) return;

    const rows = readRows(sheet, cfg, today, 0, true);
    if (!rows.length) return;

    blocks.push(
      cfg.display + "\n" +
      rows.map(function (r) {
        return "№ <b>" + r.id + "</b> · " + r.client + " — " + r.status;
      }).join("\n")
    );
  });

  if (!blocks.length) return "";
  return "📋 <b>ДДЛ сьогодні, " + formatDate(today) + " — ще не закриті</b>\n\n" + blocks.join("\n\n");
}

// ---------- ЧИТАННЯ АРКУША ----------
// dayOffset: 0 = сьогодні, 1 = завтра, 2 = післязавтра
// openOnly=true — не звіряти статус-тригер відділу, а брати все, що ще не "Опубліковано"
function readRows(sheet, cfg, today, dayOffset, openOnly) {
  const cols = resolveCols(sheet);
  const targetDate = addDays(today, dayOffset);

  let maxCol = 0;
  Object.keys(cols).forEach(function (k) { if (cols[k] > maxCol) maxCol = cols[k]; });
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return [];

  const values = sheet.getRange(3, 1, lastRow - 2, maxCol).getValues();
  const groups = {};   // 740/1 і 740/2 — це частини одного проекту 740
  const order = [];

  values.forEach(function (row) {
    const id = formatProjectId(row[cols.project - 1]);
    if (!id) return;

    const space = normalize(row[cols.space - 1]);
    if (space.indexOf(SPACE_VALUE) === -1) return;

    const deadline = parseDateVal(row[cols.deadline - 1]);
    if (!deadline || !sameDay(deadline, targetDate)) return;

    const baseId = id.split("/")[0].trim();
    if (!groups[baseId]) {
      groups[baseId] = {
        id: baseId,
        client: String(row[cols.client - 1] || "—").trim(),
        status: "—",
        deadline: deadline,
        parts: []
      };
      order.push(baseId);
    }
    groups[baseId].parts.push({
      isPart: id.indexOf("/") !== -1,
      publication: normalize(row[cols.publication - 1]),
      raw: String(row[cols.publication - 1] || "").trim()
    });
  });

  const out = [];
  order.forEach(function (baseId) {
    const g = groups[baseId];
    // Рядок-шапка (840) завжди має порожню Публікацію — статус живе в частинах 840/1, 840/2.
    // Якщо частини є, дивимось лише на них, інакше шапка виглядала б як незакритий проект.
    const hasParts = g.parts.some(function (p) { return p.isPart; });
    const parts = hasParts ? g.parts.filter(function (p) { return p.isPart; }) : g.parts;

    const hit = parts.filter(function (p) {
      return openOnly
        ? p.publication.indexOf(DONE_STATUS) !== 0
        : p.publication.indexOf(cfg.trigger) === 0;
    });
    if (!hit.length) return;

    g.status = hit[0].raw || "—";
    out.push(g);
  });

  return out;
}

function resolveCols(sheet) {
  return {
    project:     findColByHeader(sheet, 2, ["№", "Номер", "Проект №"], COLS.project),
    client:      findColByHeader(sheet, 2, "Замовник",   COLS.client),
    publication: findColByHeader(sheet, 2, "Публікація", COLS.publication),
    deadline:    findColByHeader(sheet, 2, "Дедлайн",    COLS.deadline),
    space:       findColByHeader(sheet, 2, "Простір",    COLS.space)
  };
}

function findColByHeader(sheet, headerRow, nameOrArray, fallback) {
  const names = (nameOrArray instanceof Array ? nameOrArray : [nameOrArray]).map(normalizeHeader);
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0];
  for (let i = 0; i < headers.length; i++) {
    if (names.indexOf(normalizeHeader(headers[i])) !== -1) return i + 1;
  }
  return fallback;
}

// ---------- ПАМ'ЯТЬ ПРО НАДІСЛАНЕ ----------
// Ключі короткі ("М687/3"). При зміні місяця список обнуляється.
function loadNotified(monthName) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty("NOTIFIED_MONTH") !== monthName) return [];
  return JSON.parse(props.getProperty("NOTIFIED") || "[]");
}

function saveNotified(monthName, list) {
  const props = PropertiesService.getScriptProperties();
  const uniq = list.filter(function (v, i) { return list.indexOf(v) === i; });
  props.setProperty("NOTIFIED_MONTH", monthName);
  props.setProperty("NOTIFIED", JSON.stringify(uniq));
}

function resetNotified() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty("NOTIFIED");
  props.deleteProperty("NOTIFIED_MONTH");
  Logger.log("Пам'ять сповіщень очищена.");
}

// ---------- ХЕЛПЕРИ ----------
// Номери на кшталт "2/19" Google Sheets перетворює на дату (19 лютого).
// Повертаємо їх назад у вигляд "місяць/день" = вихідний номер проекту.
function formatProjectId(val) {
  if (val instanceof Date && !isNaN(val.getTime())) {
    return (val.getMonth() + 1) + "/" + val.getDate();
  }
  return String(val == null ? "" : val).trim();
}

function normalize(s) {
  return String(s == null ? "" : s).replace(/\u00A0/g, " ").trim().toLowerCase();
}

function normalizeHeader(s) {
  return normalize(s).replace(/\s+/g, " ");
}

function findSheetTolerant(ss, wantedName) {
  const wanted = normalizeHeader(wantedName);
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (normalizeHeader(sheets[i].getName()) === wanted) return sheets[i];
  }
  return null;
}

function parseDateVal(val) {
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const s = String(val || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

function addDays(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + n);
  return r;
}

function formatDate(d) {
  const dd = ("0" + d.getDate()).slice(-2);
  const mm = ("0" + (d.getMonth() + 1)).slice(-2);
  return dd + "." + mm + "." + d.getFullYear();
}

// ---------- ВІДПРАВКА ----------
// Результат останньої розсилки — щоб показати адміну, кому дійшло
let LAST_DELIVERY = { total: 0, sent: 0, failed: [] };

function sendToAll(text) {
  const props = PropertiesService.getScriptProperties();
  const adminId = Number(props.getProperty("ADMIN_ID") || ADMIN_ID);
  const allowed = JSON.parse(props.getProperty("ALLOWED") || "[]");
  const workers = allowed.filter(function (x) { return x !== adminId; });

  // Клавіатуру шлемо разом із кожним сповіщенням — так кнопки відновлюються
  // навіть після нічного прибирання, яке видаляє повідомлення з клавіатурою.
  try { sendMessage(adminId, text, adminKeyboard()); } catch (e) { Logger.log("sendToAll admin: " + e); }

  const failed = [];
  let sent = 0;
  workers.forEach(function (id) {
    let ok = false;
    try { ok = sendMessage(id, text, userKeyboard()); } catch (e) { Logger.log("sendToAll " + id + ": " + e); }
    if (ok) sent++; else failed.push(id);
  });

  LAST_DELIVERY = { total: workers.length, sent: sent, failed: failed };
  return LAST_DELIVERY;
}

function deliveryReport(d) {
  let msg = "✅ Надіслано працівникам: " + d.sent + " з " + d.total;
  if (d.failed.length) {
    msg += "\n\n⚠️ Не дійшло: " + d.failed.join(", ") +
           "\nЙмовірно, людина не натиснула «Почати» в боті або заблокувала його.";
  }
  return msg;
}

function sendMessage(chatId, text, replyMarkup) {
  const token = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN");
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const resp = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  try {
    const data = JSON.parse(resp.getContentText());
    if (data.ok && data.result) {
      trackMessage(chatId, data.result.message_id);
      return true;
    }
  } catch (e) {}
  return false;
}

// ---------- 🧹 НІЧНЕ ПРИБИРАННЯ ЧАТУ ----------
// Запам'ятовуємо кожне повідомлення, щоб уночі його видалити.
function trackMessage(chatId, messageId) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty("TRACKED") || "";
  const list = raw ? raw.split(";") : [];
  list.push(chatId + ":" + messageId);
  // Telegram дозволяє видаляти лише за останні 48 год, тому старі записи не потрібні
  const trimmed = list.slice(-800);
  props.setProperty("TRACKED", trimmed.join(";"));
}

function nightCleanup() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("BOT_TOKEN");
  const raw = props.getProperty("TRACKED") || "";
  if (!raw) return;

  props.deleteProperty("TRACKED");
  raw.split(";").forEach(function (item) {
    const parts = item.split(":");
    if (parts.length !== 2) return;
    try {
      UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/deleteMessage", {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({ chat_id: Number(parts[0]), message_id: Number(parts[1]) }),
        muteHttpExceptions: true
      });
    } catch (e) {}
  });
  Logger.log("Чат очищено.");
}

// ---------- ВСТАНОВЛЕННЯ ----------
function installTriggers() {
  const token = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN");
  if (!token) throw new Error("Спочатку встанови BOT_TOKEN у Script Properties");
  UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/deleteWebhook", { muteHttpExceptions: true });
  PropertiesService.getScriptProperties().deleteProperty("POLL_OFFSET");

  stopTriggers();
  ScriptApp.newTrigger("poll").timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger("checkUrgent").timeBased().everyMinutes(5).create();

  // Дайджест близьких ДДЛ: щогодини о :00 з 10:00 до 19:00.
  // Ранковий — nearMinute(45), бо Google зсуває тригер на ±15 хв, і о 9:30 він міг би
  // впасти на 9:20 — тобто в тишу; 9:45 гарантовано потрапляє в робочий час.
  ScriptApp.newTrigger("hourlyDigest").timeBased().everyDays(1).atHour(9).nearMinute(45).create();
  for (let h = 10; h <= 19; h++) {
    ScriptApp.newTrigger("hourlyDigest").timeBased().everyDays(1).atHour(h).nearMinute(0).create();
  }

  ScriptApp.newTrigger("nightCleanup").timeBased().everyDays(1).atHour(3).create();

  Logger.log("Тригери встановлені: poll (1 хв), checkUrgent (5 хв), hourlyDigest (9:45–19:00), nightCleanup (3:00)");
}

function stopTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log("Тригери зупинені.");
}

// Показує все, що бот бачить по конкретному проекту.
// Вибрати "debugProject" у списку функцій, натиснути Run і подивитись Logger.
// Щоб перевірити інший проект — змінити номер у рядку нижче.
function debugProject(wantedId) {
  wantedId = wantedId || "840";
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.openById(props.getProperty("SHEET_ID"));
  const monthName = MONTHS_UA[new Date().getMonth()];
  const today = new Date();

  SHEETS.forEach(function (cfg) {
    const sheet = findSheetTolerant(ss, cfg.prefix + " - " + monthName);
    if (!sheet) { Logger.log("НЕ ЗНАЙДЕНО аркуш: " + cfg.prefix + " - " + monthName); return; }

    const cols = resolveCols(sheet);
    Logger.log("=== " + sheet.getName() + " | колонки: " + JSON.stringify(cols));

    let maxCol = 0;
    Object.keys(cols).forEach(function (k) { if (cols[k] > maxCol) maxCol = cols[k]; });
    const lastRow = sheet.getLastRow();
    if (lastRow < 3) return;

    const values = sheet.getRange(3, 1, lastRow - 2, maxCol).getValues();
    values.forEach(function (row, i) {
      const id = formatProjectId(row[cols.project - 1]);
      if (!id || id.split("/")[0].trim() !== String(wantedId).trim()) return;
      const deadline = parseDateVal(row[cols.deadline - 1]);
      Logger.log(
        "рядок " + (i + 3) +
        " | № '" + id + "'" +
        " | Публікація '" + row[cols.publication - 1] + "'" +
        " | Простір '" + row[cols.space - 1] + "'" +
        " | ДДЛ " + (deadline ? formatDate(deadline) : "нема") +
        " | сьогодні? " + (deadline ? sameDay(deadline, today) : false) +
        " | проходить Простір? " + (normalize(row[cols.space - 1]).indexOf(SPACE_VALUE) !== -1)
      );
    });

    const open = readRows(sheet, cfg, today, 0, true);
    Logger.log("readRows(openOnly) віддав: " +
      open.map(function (r) { return r.id + " [" + r.status + "]"; }).join(", "));
  });
}

// Показує заголовки рядка 2 — для перевірки, що колонки знайдені правильно.
function debugHeaders() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.openById(props.getProperty("SHEET_ID"));
  const monthName = MONTHS_UA[new Date().getMonth()];
  SHEETS.forEach(function (cfg) {
    const sheet = findSheetTolerant(ss, cfg.prefix + " - " + monthName);
    if (!sheet) { Logger.log("НЕ ЗНАЙДЕНО аркуш: " + cfg.prefix + " - " + monthName); return; }
    const cols = resolveCols(sheet);
    Logger.log(sheet.getName() + " → " + JSON.stringify(cols));
  });
}
