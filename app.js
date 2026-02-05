const ui = {
  conversation: document.getElementById("conversation"),
  userInput: document.getElementById("user-input"),
  btnSend: document.getElementById("btn-send"),
  btnMic: document.getElementById("btn-mic"),
  btnReset: document.getElementById("btn-reset"),
  btnCopy: document.getElementById("btn-copy"),
  btnFocus: document.getElementById("btn-focus"),
  toast: document.getElementById("toast"),
  autoSend: document.getElementById("auto-send"),
  responseMode: document.getElementById("response-mode"),
  scenarioSelect: document.getElementById("scenario-select"),
  btnInsert: document.getElementById("btn-insert"),
  summaryGrid: document.getElementById("summary-grid"),
  absencesList: document.getElementById("absences-list"),
  studentsList: document.getElementById("students-list"),
  studentSearch: document.getElementById("student-search"),
  filterQuery: document.getElementById("filter-query"),
  filterGroup: document.getElementById("filter-group"),
  filterType: document.getElementById("filter-type"),
  filterFrom: document.getElementById("filter-from"),
  filterTo: document.getElementById("filter-to"),
  btnApplyFilters: document.getElementById("btn-apply-filters"),
  btnClearFilters: document.getElementById("btn-clear-filters"),
  btnExportStudents: document.getElementById("btn-export-students"),
  btnExportAbsences: document.getElementById("btn-export-absences"),
  fileImportStudents: document.getElementById("file-import-students"),
  fileImportAbsences: document.getElementById("file-import-absences"),
  actionsList: document.getElementById("actions-list"),
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  themeToggle: document.getElementById("btn-theme"),
  themeLabel: document.getElementById("theme-label"),
  googleButton: document.getElementById("google-button"),
  googleButtonGate: document.getElementById("google-button-gate"),
  googleHint: document.getElementById("google-hint"),
  googleHintGate: document.getElementById("google-hint-gate"),
  btnGuest: document.getElementById("btn-guest"),
  authUser: document.getElementById("auth-user"),
  authAvatar: document.getElementById("auth-avatar"),
  authName: document.getElementById("auth-name"),
  authEmail: document.getElementById("auth-email"),
  btnSignOut: document.getElementById("btn-signout"),
};

const THEME_KEY = "assistant_theme";
const GOOGLE_USER_KEY = "assistant_google_user";
const DRAFT_KEY = "assistant_draft";
const FOCUS_KEY = "assistant_focus";
const sessionId = initSession();
let typingMessage = null;
let recognitionActive = false;
let googleInitialized = false;
const state = {
  students: [],
  absences: [],
};
let micAudioContext = null;
let draftTimer = null;
let toastTimer = null;

const scenarioTemplates = {
  absences_student: "Покажи пропуски студента ФИО",
  record_absence: "Зафиксируй пропуск: ФИО, 03.02.2026, 2 занятия, причина — болезнь",
  add_student: "Добавь студента: ФИО, группа (ГРУППА), контакт — name@gmail.com",
  report_group: "Сделай отчет по группе (ГРУППА) за (ЧИСЛО)",
};

function initSession() {
  const key = "assistant_session_id";
  let value = localStorage.getItem(key);
  if (!value) {
    value = `s_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36)}`;
    localStorage.setItem(key, value);
  }
  return value;
}

function setTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = normalized;
  localStorage.setItem(THEME_KEY, normalized);
  if (ui.themeToggle) ui.themeToggle.setAttribute("aria-pressed", normalized === "dark");
  if (ui.themeLabel) ui.themeLabel.textContent = normalized === "dark" ? "Тёмная" : "Светлая";
}

function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(stored || (prefersDark ? "dark" : "light"));
  if (ui.themeToggle) {
    ui.themeToggle.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      setTheme(next);
    });
  }
}

function decodeJwt(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const base = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base + "=".repeat((4 - (base.length % 4)) % 4);
  try {
    return JSON.parse(atob(padded));
  } catch (err) {
    return null;
  }
}

function setAuthUser(user, persist = true) {
  document.body.dataset.auth = user ? "ready" : "required";
  if (persist) {
    if (user) {
      localStorage.setItem(GOOGLE_USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(GOOGLE_USER_KEY);
    }
  }

  if (ui.authUser) ui.authUser.hidden = !user;
  if (ui.btnSignOut) ui.btnSignOut.hidden = !user;
  if (ui.googleButton) ui.googleButton.hidden = !!user;
  if (ui.googleButtonGate) ui.googleButtonGate.hidden = !!user;

  if (ui.authAvatar) {
    if (user && user.picture) {
      ui.authAvatar.src = user.picture;
      ui.authAvatar.alt = user.name || "Пользователь";
      ui.authAvatar.hidden = false;
    } else {
      ui.authAvatar.hidden = true;
      ui.authAvatar.removeAttribute("src");
      ui.authAvatar.alt = "";
    }
  }

  if (ui.authName) ui.authName.textContent = user?.name || "—";
  if (ui.authEmail) ui.authEmail.textContent = user?.email || "";
  if (ui.googleHint && user) ui.googleHint.textContent = "";
  if (ui.googleHintGate && user) ui.googleHintGate.textContent = "";
}

function handleCredentialResponse(response) {
  if (!response || !response.credential) return;
  const profile = decodeJwt(response.credential);
  if (!profile) return;
  setAuthUser({
    name: profile.name,
    email: profile.email,
    picture: profile.picture,
  });
}

function initGoogle() {
  if (googleInitialized) return;
  const clientId = (document.body?.dataset.googleClientId || "").trim();
  if (!clientId || clientId === "YOUR_GOOGLE_CLIENT_ID") {
    const hint = "Укажите Google Client ID в data-google-client-id.";
    if (ui.googleHint) ui.googleHint.textContent = hint;
    if (ui.googleHintGate) ui.googleHintGate.textContent = hint;
    return;
  }
  if (!window.google || !google.accounts || !google.accounts.id) {
    const hint = "Не удалось загрузить Google Identity Services.";
    if (ui.googleHint) ui.googleHint.textContent = hint;
    if (ui.googleHintGate) ui.googleHintGate.textContent = hint;
    return;
  }

  googleInitialized = true;
  google.accounts.id.initialize({
    client_id: clientId,
    callback: handleCredentialResponse,
    auto_select: false,
    cancel_on_tap_outside: true,
  });

  const buttonTargets = [ui.googleButton, ui.googleButtonGate].filter(Boolean);
  buttonTargets.forEach((target) => {
    google.accounts.id.renderButton(target, {
      theme: "outline",
      size: "large",
      shape: "pill",
      text: "signin_with",
    });
  });

  if (ui.googleHint) ui.googleHint.textContent = "";
  if (ui.googleHintGate) ui.googleHintGate.textContent = "";
}

function initAuth() {
  if (ui.btnGuest) {
    ui.btnGuest.addEventListener("click", () => {
      setAuthUser({ name: "Гость", email: "", picture: "" });
    });
  }

  if (ui.btnSignOut) {
    ui.btnSignOut.addEventListener("click", () => {
      setAuthUser(null);
      if (window.google?.accounts?.id) {
        google.accounts.id.disableAutoSelect();
      }
    });
  }

  const stored = localStorage.getItem(GOOGLE_USER_KEY);
  if (stored) {
    try {
      setAuthUser(JSON.parse(stored), false);
    } catch (err) {
      localStorage.removeItem(GOOGLE_USER_KEY);
    }
  }

  window.handleCredentialResponse = handleCredentialResponse;
  if (document.readyState === "complete") {
    initGoogle();
  } else {
    window.addEventListener("load", initGoogle);
  }
}

function setStatus(state, text) {
  ui.status.classList.remove("online", "error");
  if (state) ui.status.classList.add(state);
  ui.statusText.textContent = "Сервер запущен";
}

function showToast(message) {
  if (!ui.toast) return;
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    ui.toast.classList.remove("show");
  }, 2200);
}

function scheduleDraftSave() {
  if (!ui.userInput) return;
  if (draftTimer) window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    localStorage.setItem(DRAFT_KEY, ui.userInput.value || "");
  }, 250);
}

function restoreDraft() {
  if (!ui.userInput) return;
  const draft = localStorage.getItem(DRAFT_KEY);
  if (draft) ui.userInput.value = draft;
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

function setFocusMode(enabled, persist = true) {
  document.body.dataset.focus = enabled ? "on" : "off";
  if (ui.btnFocus) {
    ui.btnFocus.setAttribute("aria-pressed", enabled ? "true" : "false");
    ui.btnFocus.textContent = enabled ? "Фокус: Вкл" : "Фокус";
    ui.btnFocus.classList.toggle("active", enabled);
  }
  if (persist) localStorage.setItem(FOCUS_KEY, enabled ? "on" : "off");
}

function toggleFocus() {
  const enabled = document.body.dataset.focus === "on";
  setFocusMode(!enabled);
  showToast(enabled ? "Фокус выключен." : "Фокус включен.");
}

function initFocus() {
  const stored = localStorage.getItem(FOCUS_KEY);
  setFocusMode(stored === "on", false);
}

function buildConversationText() {
  if (!ui.conversation) return "";
  const messages = Array.from(ui.conversation.querySelectorAll(".message"));
  return messages
    .map((node) => {
      const role = node.classList.contains("user") ? "Вы" : "Ассистент";
      const text = node.querySelector(".message-text")?.textContent?.trim() || "";
      return `${role}: ${text}`;
    })
    .join("\n");
}

async function copyConversation() {
  const text = buildConversationText();
  if (!text) {
    showToast("Диалог пуст.");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("Диалог скопирован.");
  } catch (err) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "absolute";
    area.style.left = "-9999px";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    showToast(ok ? "Диалог скопирован." : "Не удалось скопировать.");
  }
}

function playMicChime() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!micAudioContext) micAudioContext = new AudioContext();
    if (micAudioContext.state === "suspended") micAudioContext.resume();

    const now = micAudioContext.currentTime;
    const master = micAudioContext.createGain();
    master.gain.setValueAtTime(0, now);
    master.gain.linearRampToValueAtTime(0.14, now + 0.015);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    master.connect(micAudioContext.destination);

    const osc1 = micAudioContext.createOscillator();
    const osc1Gain = micAudioContext.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(600, now);
    osc1.frequency.exponentialRampToValueAtTime(900, now + 0.12);
    osc1Gain.gain.setValueAtTime(0.85, now);
    osc1.connect(osc1Gain);
    osc1Gain.connect(master);
    osc1.start(now);
    osc1.stop(now + 0.4);

    const osc2 = micAudioContext.createOscillator();
    const osc2Gain = micAudioContext.createGain();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(1200, now + 0.02);
    osc2Gain.gain.setValueAtTime(0.45, now);
    osc2.connect(osc2Gain);
    osc2Gain.connect(master);
    osc2.start(now + 0.02);
    osc2.stop(now + 0.28);
  } catch (err) {
    // Если звук недоступен, просто пропускаем.
  }
}

function playMicStopChime() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!micAudioContext) micAudioContext = new AudioContext();
    if (micAudioContext.state === "suspended") micAudioContext.resume();

    const now = micAudioContext.currentTime;
    const master = micAudioContext.createGain();
    master.gain.setValueAtTime(0, now);
    master.gain.linearRampToValueAtTime(0.12, now + 0.015);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    master.connect(micAudioContext.destination);

    const osc1 = micAudioContext.createOscillator();
    const osc1Gain = micAudioContext.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(750, now);
    osc1.frequency.exponentialRampToValueAtTime(420, now + 0.16);
    osc1Gain.gain.setValueAtTime(0.8, now);
    osc1.connect(osc1Gain);
    osc1Gain.connect(master);
    osc1.start(now);
    osc1.stop(now + 0.36);

    const osc2 = micAudioContext.createOscillator();
    const osc2Gain = micAudioContext.createGain();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(520, now + 0.03);
    osc2Gain.gain.setValueAtTime(0.35, now);
    osc2.connect(osc2Gain);
    osc2Gain.connect(master);
    osc2.start(now + 0.03);
    osc2.stop(now + 0.26);
  } catch (err) {
    // Если звук недоступен, просто пропускаем.
  }
}

function appendMessage(role, text, options = {}) {
  const message = document.createElement("div");
  message.className = `message ${role}`;
  if (options.typing) message.classList.add("typing");

  const roleEl = document.createElement("div");
  roleEl.className = "message-role";
  roleEl.textContent = role === "user" ? "Вы" : "Ассистент";

  const textEl = document.createElement("div");
  textEl.className = "message-text";
  textEl.textContent = text;

  message.append(roleEl, textEl);
  ui.conversation.append(message);
  ui.conversation.scrollTop = ui.conversation.scrollHeight;
  return message;
}

function removeTyping() {
  if (typingMessage) {
    typingMessage.remove();
    typingMessage = null;
  }
}

function renderSummary(summary) {
  if (!summary) return;
  const items = [
    { label: "Студенты", value: summary.students ?? 0 },
    { label: "Пропуски", value: summary.absences ?? 0 },
    { label: "Неуважит.", value: summary.unexcused ?? 0 },
    { label: "Риски", value: summary.at_risk ?? 0 },
  ];
  ui.summaryGrid.innerHTML = "";
  items.forEach((item) => {
    const block = document.createElement("div");
    block.className = "summary-item";
    block.innerHTML = `<strong>${item.value}</strong><span>${item.label}</span>`;
    ui.summaryGrid.append(block);
  });
}

function renderAbsences(items = []) {
  ui.absencesList.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "list-item";
    empty.textContent = "Нет записей по фильтрам.";
    ui.absencesList.append(empty);
    return;
  }
  items.forEach((row) => {
    const el = document.createElement("div");
    el.className = "list-item";
    el.innerHTML = `
      <strong>${row.student}</strong> <span class="pill">${row.group}</span><br />
      ${row.date} • ${row.lessons} занятий • ${row.type}
    `;
    ui.absencesList.append(el);
  });
}

function renderStudents(items = []) {
  ui.studentsList.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "list-item";
    empty.textContent = "Студентов пока нет.";
    ui.studentsList.append(empty);
    return;
  }
  items.forEach((row) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "list-item ghost";
    el.innerHTML = `${row.name} <span class="pill">${row.group}</span>`;
    el.addEventListener("click", () => {
      ui.userInput.value = `Покажи пропуски студента ${row.name}`;
      ui.userInput.focus();
    });
    ui.studentsList.append(el);
  });
}

function renderActions(items = []) {
  ui.actionsList.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "list-item";
    empty.textContent = "Действий пока нет.";
    ui.actionsList.append(empty);
    return;
  }
  items.slice(-5).reverse().forEach((row) => {
    const el = document.createElement("div");
    el.className = "list-item";
    el.textContent = row;
    ui.actionsList.append(el);
  });
}

function formatDate(value) {
  if (!value) return "—";
  const parts = String(value).split("-");
  if (parts.length === 3) {
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
  }
  return value;
}

function updateGroupFilter() {
  if (!ui.filterGroup) return;
  const current = ui.filterGroup.value || "all";
  const groups = Array.from(new Set(state.students.map((s) => s.group))).sort();
  ui.filterGroup.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "Все группы";
  ui.filterGroup.append(all);
  groups.forEach((group) => {
    const option = document.createElement("option");
    option.value = group;
    option.textContent = group;
    ui.filterGroup.append(option);
  });
  ui.filterGroup.value = groups.includes(current) ? current : "all";
}

function filteredStudents() {
  const query = (ui.studentSearch?.value || "").trim().toLowerCase();
  if (!query) return state.students;
  return state.students.filter((student) => {
    const haystack = `${student.name} ${student.group}`.toLowerCase();
    return haystack.includes(query);
  });
}

async function loadStudents() {
  try {
    const response = await fetch("/api/students");
    const payload = await response.json();
    state.students = payload.students || [];
    updateGroupFilter();
    renderStudents(filteredStudents());
  } catch (err) {
    renderStudents([]);
  }
}

function buildAbsenceQuery() {
  const params = new URLSearchParams();
  const query = ui.filterQuery?.value.trim();
  const group = ui.filterGroup?.value;
  const type = ui.filterType?.value;
  const dateFrom = ui.filterFrom?.value;
  const dateTo = ui.filterTo?.value;

  if (query) params.set("student_name", query);
  if (group && group !== "all") params.set("group", group);
  if (type && type !== "all") params.set("type", type);
  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);

  return params.toString();
}

async function loadAbsences() {
  try {
    const query = buildAbsenceQuery();
    const url = query ? `/api/absences?${query}` : "/api/absences";
    const response = await fetch(url);
    const payload = await response.json();
    const rows = payload.absences || [];
    state.absences = rows.map((row) => ({
      date: formatDate(row.date),
      student: row.name || row.student || "—",
      group: row.group_name || row.group || "—",
      lessons: row.lessons ?? 0,
      type: row.type || "—",
    }));
    renderAbsences(state.absences);
  } catch (err) {
    renderAbsences([]);
  }
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

async function exportCsv(type) {
  try {
    const response = await fetch(`/api/export?type=${encodeURIComponent(type)}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      appendMessage("assistant", payload.error || "Не удалось экспортировать CSV.");
      return;
    }
    const blob = await response.blob();
    downloadBlob(blob, `${type}.csv`);
  } catch (err) {
    appendMessage("assistant", "Ошибка экспорта CSV.");
  }
}

async function importCsv(file, type) {
  if (!file) return;
  try {
    const text = await file.text();
    const response = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, csv: text }),
    });
    const payload = await response.json();
    if (!response.ok) {
      appendMessage("assistant", payload.error || "Ошибка импорта CSV.");
      return;
    }
    appendMessage("assistant", payload.message || "Импорт завершен.");
    await loadStudents();
    await loadAbsences();
  } catch (err) {
    appendMessage("assistant", "Ошибка импорта CSV.");
  }
}

async function sendMessage(text) {
  const cleaned = text.trim();
  if (!cleaned) return;

  appendMessage("user", cleaned);
  ui.userInput.value = "";
  clearDraft();

  removeTyping();
  typingMessage = appendMessage("assistant", "Думаю…", { typing: true });

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: cleaned,
        session_id: sessionId,
        response_mode: ui.responseMode ? ui.responseMode.value : "brief",
      }),
    });

    const payload = await response.json();
    removeTyping();

    if (!response.ok) {
      appendMessage("assistant", payload.error || "Произошла ошибка при обработке.");
      setStatus("error", "Ошибка подключения к Gemini");
      return;
    }

    appendMessage("assistant", payload.reply || "Готово.");

    renderSummary(payload.summary);
    renderActions(payload.actions);
    loadStudents();
    loadAbsences();
    setStatus("online", "Подключено к Gemini и базе данных");
  } catch (err) {
    removeTyping();
    appendMessage("assistant", "Не удалось связаться с сервером. Проверьте, что assistant.py запущен.");
    setStatus("error", "Сервер недоступен");
  }
}

function bindShortcuts() {
  ui.userInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendMessage(ui.userInput.value);
    }
  });

  ui.btnSend.addEventListener("click", () => sendMessage(ui.userInput.value));

  ui.btnReset.addEventListener("click", async () => {
    await fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });
    ui.conversation.innerHTML = "";
    appendMessage("assistant", "Диалог очищен. Чем помочь дальше?");
    renderActions([]);
  });

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const prompt = chip.dataset.prompt || "";
      ui.userInput.value = prompt;
      sendMessage(prompt);
    });
  });

  document.querySelectorAll(".quick-card").forEach((card) => {
    card.addEventListener("click", () => {
      const prompt = card.dataset.prompt || "";
      if (!prompt) return;
      ui.userInput.value = prompt;
      sendMessage(prompt);
    });
  });

  if (ui.btnInsert) {
    ui.btnInsert.addEventListener("click", () => {
      const key = ui.scenarioSelect ? ui.scenarioSelect.value : "record_absence";
      const template = scenarioTemplates[key] || "";
      if (template) {
        ui.userInput.value = template;
        ui.userInput.focus();
      }
    });
  }

  if (ui.btnApplyFilters) {
    ui.btnApplyFilters.addEventListener("click", (event) => {
      event.preventDefault();
      loadAbsences();
    });
  }

  if (ui.btnClearFilters) {
    ui.btnClearFilters.addEventListener("click", (event) => {
      event.preventDefault();
      if (ui.filterQuery) ui.filterQuery.value = "";
      if (ui.filterGroup) ui.filterGroup.value = "all";
      if (ui.filterType) ui.filterType.value = "all";
      if (ui.filterFrom) ui.filterFrom.value = "";
      if (ui.filterTo) ui.filterTo.value = "";
      loadAbsences();
    });
  }

  if (ui.studentSearch) {
    ui.studentSearch.addEventListener("input", () => {
      renderStudents(filteredStudents());
    });
  }

  if (ui.btnExportStudents) {
    ui.btnExportStudents.addEventListener("click", () => exportCsv("students"));
  }

  if (ui.btnExportAbsences) {
    ui.btnExportAbsences.addEventListener("click", () => exportCsv("absences"));
  }

  if (ui.fileImportStudents) {
    ui.fileImportStudents.addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file) importCsv(file, "students");
      event.target.value = "";
    });
  }

  if (ui.fileImportAbsences) {
    ui.fileImportAbsences.addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file) importCsv(file, "absences");
      event.target.value = "";
    });
  }
  if (ui.btnCopy) {
    ui.btnCopy.addEventListener("click", () => copyConversation());
  }
  if (ui.btnFocus) {
    ui.btnFocus.addEventListener("click", () => toggleFocus());
  }
  if (ui.userInput) {
    ui.userInput.addEventListener("input", scheduleDraftSave);
  }
}

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    ui.btnMic.disabled = true;
    ui.btnMic.title = "Браузер не поддерживает распознавание речи";
    return;
  }

  ui.btnMic.addEventListener("click", () => {
    if (recognitionActive) return;
    playMicChime();
    const recognition = new SpeechRecognition();
    recognition.lang = "ru-RU";
    recognition.interimResults = true;
    recognitionActive = true;
    ui.btnMic.classList.add("listening");

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      ui.userInput.value = transcript.trim();

      const last = event.results[event.results.length - 1];
      if (last.isFinal && ui.autoSend.checked) {
        recognition.stop();
        sendMessage(ui.userInput.value);
      }
    };

    recognition.onend = () => {
      recognitionActive = false;
      ui.btnMic.classList.remove("listening");
      playMicStopChime();
      if (ui.autoSend.checked && ui.userInput.value.trim()) {
        sendMessage(ui.userInput.value);
      }
    };

    recognition.onerror = () => {
      recognitionActive = false;
      ui.btnMic.classList.remove("listening");
      playMicStopChime();
    };

    recognition.start();
  });
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    const payload = await response.json();
    if (!response.ok) {
      setStatus("error", payload.error || "Нет подключения");
      return;
    }

    if (!payload.api_key) {
      setStatus("error", "API‑ключ GEMINI_API_KEY не найден");
    } else {
      setStatus("online", "Подключено к Gemini и базе данных");
    }

    renderSummary(payload.summary);
    loadStudents();
    loadAbsences();
  } catch (err) {
    setStatus("error", "Сервер недоступен");
  }
}

initTheme();
initFocus();
initAuth();
bindShortcuts();
restoreDraft();
setupSpeechRecognition();
loadHealth();
