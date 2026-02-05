const ui = {
  query: document.getElementById("student-query"),
  group: document.getElementById("student-group"),
  list: document.getElementById("student-list"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnExport: document.getElementById("btn-export"),
  fileImport: document.getElementById("file-import"),
  form: document.getElementById("student-form"),
  formTitle: document.getElementById("form-title"),
  formName: document.getElementById("form-name"),
  formGroup: document.getElementById("form-group"),
  formContact: document.getElementById("form-contact"),
  btnCancel: document.getElementById("btn-cancel"),
  metricTotal: document.getElementById("metric-total"),
  metricGroups: document.getElementById("metric-groups"),
  toast: document.getElementById("toast"),
  themeToggle: document.getElementById("btn-theme"),
  themeLabel: document.getElementById("theme-label"),
};

const THEME_KEY = "assistant_theme";
let editId = null;
let searchTimer = null;
let toastTimer = null;

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

function showToast(message) {
  if (!ui.toast) return;
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    ui.toast.classList.remove("show");
  }, 2200);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("ru-RU");
}

function updateMetrics(allStudents) {
  if (!allStudents) return;
  const groups = new Set(allStudents.map((row) => row.group_name || row.group).filter(Boolean));
  if (ui.metricTotal) ui.metricTotal.textContent = String(allStudents.length || 0);
  if (ui.metricGroups) ui.metricGroups.textContent = String(groups.size || 0);
}

function updateGroupOptions(allStudents) {
  if (!ui.group) return;
  const current = ui.group.value || "all";
  const groups = Array.from(
    new Set(allStudents.map((row) => row.group_name || row.group).filter(Boolean))
  ).sort();
  ui.group.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "Все группы";
  ui.group.append(all);
  groups.forEach((group) => {
    const option = document.createElement("option");
    option.value = group;
    option.textContent = group;
    ui.group.append(option);
  });
  ui.group.value = groups.includes(current) ? current : "all";
}

function renderList(rows) {
  ui.list.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "student-empty";
    empty.textContent = "Студенты не найдены.";
    ui.list.append(empty);
    return;
  }

  rows.forEach((row) => {
    const card = document.createElement("div");
    card.className = "student-row";

    const main = document.createElement("div");
    main.className = "student-main";
    const name = document.createElement("strong");
    name.textContent = row.name || "—";
    const contact = document.createElement("span");
    contact.className = "student-contact";
    contact.textContent = row.contact || "—";
    main.append(name, contact);

    const group = document.createElement("div");
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = row.group_name || row.group || "—";
    group.append(pill);

    const meta = document.createElement("div");
    meta.className = "student-meta";
    meta.textContent = `Добавлен: ${formatDate(row.created_at)}`;

    const actions = document.createElement("div");
    actions.className = "student-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "ghost";
    editBtn.textContent = "Изменить";
    editBtn.addEventListener("click", () => {
      setEditMode(row);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "ghost danger";
    deleteBtn.textContent = "Удалить";
    deleteBtn.addEventListener("click", () => {
      handleDelete(row);
    });

    actions.append(editBtn, deleteBtn);
    card.append(main, group, meta, actions);
    ui.list.append(card);
  });
}

function setEditMode(row) {
  editId = row.id;
  ui.formTitle.textContent = "Редактировать студента";
  ui.formName.value = row.name || "";
  ui.formGroup.value = row.group_name || row.group || "";
  ui.formContact.value = row.contact || "";
  ui.formName.focus();
}

function clearForm() {
  editId = null;
  ui.formTitle.textContent = "Добавить студента";
  ui.formName.value = "";
  ui.formGroup.value = "";
  ui.formContact.value = "";
}

function buildQuery() {
  const params = new URLSearchParams();
  const query = (ui.query?.value || "").trim();
  const group = ui.group?.value || "all";
  if (query) params.set("query", query);
  if (group && group !== "all") params.set("group", group);
  return params.toString();
}

async function loadStudents() {
  const qs = buildQuery();
  const url = qs ? `/api/students?${qs}` : "/api/students";
  try {
    const response = await fetch(url);
    const payload = await response.json();
    const rows = payload.students || [];
    renderList(rows);
  } catch (err) {
    renderList([]);
  }
}

async function refreshGroups() {
  try {
    const response = await fetch("/api/students");
    const payload = await response.json();
    const rows = payload.students || [];
    updateGroupOptions(rows);
    updateMetrics(rows);
  } catch (err) {
    updateGroupOptions([]);
    updateMetrics([]);
  }
}

async function saveStudent() {
  const name = ui.formName.value.trim();
  const group = ui.formGroup.value.trim();
  const contact = ui.formContact.value.trim();
  if (!name || !group) {
    showToast("Заполните имя и группу.");
    return;
  }

  const payload = {
    action: editId ? "update" : "create",
    id: editId,
    name,
    group,
    contact,
  };

  try {
    const response = await fetch("/api/students", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      showToast(data.error || "Не удалось сохранить.");
      return;
    }
    showToast(editId ? "Студент обновлен." : "Студент добавлен.");
    clearForm();
    await refreshGroups();
    await loadStudents();
  } catch (err) {
    showToast("Ошибка сохранения.");
  }
}

async function handleDelete(row) {
  const ok = confirm(`Удалить студента ${row.name}?`);
  if (!ok) return;
  try {
    const response = await fetch("/api/students", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id: row.id }),
    });
    const data = await response.json();
    if (!response.ok) {
      showToast(data.error || "Не удалось удалить.");
      return;
    }
    showToast("Студент удален.");
    await refreshGroups();
    await loadStudents();
  } catch (err) {
    showToast("Ошибка удаления.");
  }
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

async function exportJson() {
  try {
    const response = await fetch("/api/export?type=students");
    if (!response.ok) {
      showToast("Не удалось экспортировать JSON.");
      return;
    }
    const blob = await response.blob();
    downloadBlob(blob, "students.json");
  } catch (err) {
    showToast("Ошибка экспорта JSON.");
  }
}

async function importJson(file) {
  if (!file) return;
  try {
    const text = await file.text();
    try {
      JSON.parse(text);
    } catch (err) {
      showToast("Некорректный JSON.");
      return;
    }
    const response = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "students", json: text }),
    });
    const payload = await response.json();
    if (!response.ok) {
      showToast(payload.error || "Ошибка импорта JSON.");
      return;
    }
    showToast(payload.message || "Импорт завершен.");
    await refreshGroups();
    await loadStudents();
  } catch (err) {
    showToast("Ошибка импорта JSON.");
  }
}

function bindEvents() {
  if (ui.query) {
    ui.query.addEventListener("input", () => {
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        loadStudents();
      }, 250);
    });
  }

  if (ui.group) {
    ui.group.addEventListener("change", () => loadStudents());
  }

  if (ui.btnRefresh) {
    ui.btnRefresh.addEventListener("click", () => loadStudents());
  }

  if (ui.form) {
    ui.form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveStudent();
    });
  }

  if (ui.btnCancel) {
    ui.btnCancel.addEventListener("click", () => clearForm());
  }

  if (ui.btnExport) {
    ui.btnExport.addEventListener("click", () => exportJson());
  }

  if (ui.fileImport) {
    ui.fileImport.addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file) importJson(file);
      event.target.value = "";
    });
  }
}

initTheme();
bindEvents();
refreshGroups();
loadStudents();