const ui = {
  absencesList: document.getElementById("absences-list"),
  absencesHint: document.getElementById("absences-hint"),
  metricTotal: document.getElementById("metric-total"),
  metricPoints: document.getElementById("metric-points"),
  toast: document.getElementById("toast"),
  themeToggle: document.getElementById("btn-theme"),
  themeLabel: document.getElementById("theme-label"),
  loginRole: document.getElementById("login-role"),
  loginEmail: document.getElementById("login-email"),
  loginPassword: document.getElementById("login-password"),
  btnLogin: document.getElementById("btn-login"),
  loginHint: document.getElementById("login-hint"),
  roleTabs: document.querySelectorAll(".role-tab"),
  authUser: document.getElementById("auth-user"),
  authAvatar: document.getElementById("auth-avatar"),
  authName: document.getElementById("auth-name"),
  authEmail: document.getElementById("auth-email"),
  btnSignOut: document.getElementById("btn-signout"),
};

const THEME_KEY = "assistant_theme";
const AUTH_USER_KEY = "assistant_auth_user";
let toastTimer = null;
let currentStudent = null;
let currentAbsences = [];
let requestMap = new Map();

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

function setAuthUser(user, persist = true) {
  document.body.dataset.auth = user ? "ready" : "required";
  if (persist) {
    if (user) {
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(AUTH_USER_KEY);
    }
  }

  if (ui.authUser) ui.authUser.hidden = !user;
  if (ui.btnSignOut) ui.btnSignOut.hidden = !user;

  if (ui.authAvatar) {
    ui.authAvatar.hidden = true;
    ui.authAvatar.removeAttribute("src");
    ui.authAvatar.alt = "";
  }

  const roleLabel =
    user?.role === "teacher"
      ? "Преподаватель"
      : user?.role === "student"
        ? "Студент"
        : "Демо";
  if (ui.authName) ui.authName.textContent = user?.name || roleLabel || "—";
  if (ui.authEmail) ui.authEmail.textContent = user?.email || "";
  if (ui.loginHint && user) ui.loginHint.textContent = "";

  if (!user) {
    currentStudent = null;
    currentAbsences = [];
    requestMap = new Map();
    renderAbsences([]);
    updateMetrics([]);
    setHint("");
  }

  if (user && user.role !== "student") {
    window.location.href = "index.html";
  }
}

function showLoginHint(message) {
  if (!ui.loginHint) return;
  ui.loginHint.textContent = message;
}

function updateLoginRole() {
  if (!ui.loginRole) return;
  const role = ui.loginRole.value;
  const isDemo = role === "demo";
  if (ui.roleTabs && ui.roleTabs.length) {
    ui.roleTabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.role === role);
    });
  }
  if (ui.loginEmail) {
    ui.loginEmail.disabled = isDemo;
    if (isDemo) ui.loginEmail.value = "";
  }
  if (ui.loginPassword) {
    ui.loginPassword.disabled = isDemo;
    if (isDemo) ui.loginPassword.value = "";
  }
  if (ui.loginHint && isDemo) {
    ui.loginHint.textContent = "Демо-вход без почты и пароля.";
  } else if (ui.loginHint) {
    ui.loginHint.textContent = "";
  }
}

async function loginWithCredentials() {
  const role = ui.loginRole ? ui.loginRole.value : "student";
  const email = ui.loginEmail ? ui.loginEmail.value.trim() : "";
  const password = ui.loginPassword ? ui.loginPassword.value : "";

  if (role !== "demo" && (!email || !password)) {
    showLoginHint("Введите почту и пароль.");
    return;
  }

  showLoginHint("Проверка данных...");

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, role }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showLoginHint(payload.error || "Не удалось войти.");
      return;
    }
    const user = payload.user || { email, role };
    setAuthUser(user, true);
    if (ui.loginPassword) ui.loginPassword.value = "";
    if (user.role === "student") {
      loadMyAbsences(user);
    }
  } catch (err) {
    showLoginHint("Не удалось войти. Проверьте сервер.");
  }
}

function initAuth() {
  if (ui.roleTabs && ui.roleTabs.length) {
    ui.roleTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        if (ui.loginRole) ui.loginRole.value = tab.dataset.role || "student";
        updateLoginRole();
      });
    });
  }
  if (ui.btnLogin) {
    ui.btnLogin.addEventListener("click", () => loginWithCredentials());
  }
  if (ui.loginPassword) {
    ui.loginPassword.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        loginWithCredentials();
      }
    });
  }
  if (ui.loginEmail) {
    ui.loginEmail.addEventListener("input", () => showLoginHint(""));
  }
  if (ui.loginRole) {
    ui.loginRole.addEventListener("change", () => updateLoginRole());
  }

  if (ui.btnSignOut) {
    ui.btnSignOut.addEventListener("click", () => {
      setAuthUser(null);
    });
  }

  const stored = localStorage.getItem(AUTH_USER_KEY);
  if (stored) {
    try {
      const user = JSON.parse(stored);
      setAuthUser(user, false);
      if (user?.role === "student") {
        loadMyAbsences(user);
      }
    } catch (err) {
      localStorage.removeItem(AUTH_USER_KEY);
    }
  }

  updateLoginRole();
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("ru-RU");
}

function setHint(text) {
  if (!ui.absencesHint) return;
  ui.absencesHint.textContent = text || "";
}

function calcPoints(lessons, absencePoints) {
  const base = Number.parseInt(lessons, 10);
  const points = Number.parseInt(absencePoints, 10);
  if (Number.isNaN(base) || Number.isNaN(points)) return 0;
  return Math.max(0, base * points);
}

function updateMetrics(rows = [], student) {
  if (ui.metricTotal) ui.metricTotal.textContent = String(rows.length);
  const absencePoints = Number.parseInt(student?.absence_points ?? 1, 10);
  const totalPoints = rows.reduce((sum, row) => sum + calcPoints(row.lessons, absencePoints), 0);
  if (ui.metricPoints) ui.metricPoints.textContent = String(totalPoints);
}

function renderAbsences(rows = [], student) {
  if (!ui.absencesList) return;
  ui.absencesList.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "list-item";
    empty.textContent = "Пропусков пока нет.";
    ui.absencesList.append(empty);
    return;
  }

  const absencePoints = Number.parseInt(student?.absence_points ?? 1, 10);
  rows.forEach((row) => {
    const el = document.createElement("div");
    el.className = "list-item makeup-item";

    const meta = document.createElement("div");
    meta.className = "makeup-meta";
    const reason = row.reason ? ` • ${row.reason}` : "";
    const points = calcPoints(row.lessons, absencePoints);
    meta.innerHTML = `
      <strong>${formatDate(row.date)}</strong>
      <span class="pill">${row.type || "—"}</span>
      <div class="makeup-details">${row.lessons ?? 0} занятий • ${points} баллов${reason}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "makeup-actions";
    const request = requestMap.get(row.id);
    if (request) {
      const status = document.createElement("div");
      status.className = "makeup-status";
      const label = request.status === "approved"
        ? "Заявка одобрена"
        : request.status === "rejected"
          ? "Заявка отклонена"
          : "Заявка отправлена";
      status.textContent = label;
      actions.append(status);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost makeup-btn";
      btn.textContent = "Взять отработку";
      btn.addEventListener("click", () => requestMakeup(row.id));
      actions.append(btn);
    }

    el.append(meta, actions);
    ui.absencesList.append(el);
  });
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

async function fetchStudents(query) {
  const qs = query ? `?query=${encodeURIComponent(query)}` : "";
  const response = await fetch(`/api/students${qs}`, { cache: "no-store" });
  if (!response.ok) return [];
  const payload = await response.json().catch(() => ({}));
  return payload.students || [];
}

async function loadMyRequests(studentId) {
  requestMap = new Map();
  if (!studentId) return;
  const response = await fetch(`/api/makeup-requests?student_id=${encodeURIComponent(studentId)}`, {
    cache: "no-store",
  });
  if (!response.ok) return;
  const payload = await response.json().catch(() => ({}));
  const rows = payload.requests || [];
  rows.forEach((row) => {
    if (row.absence_id != null) {
      requestMap.set(row.absence_id, row);
    }
  });
}

async function requestMakeup(absenceId) {
  if (!currentStudent || !absenceId) return;
  try {
    const response = await fetch("/api/makeup-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        student_id: currentStudent.id,
        absence_id: absenceId,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(payload.error || "Не удалось отправить заявку.");
      return;
    }
    if (payload.request?.absence_id != null) {
      requestMap.set(payload.request.absence_id, payload.request);
      renderAbsences(currentAbsences, currentStudent);
      showToast("Заявка на отработку отправлена.");
    }
  } catch (err) {
    showToast("Не удалось отправить заявку.");
  }
}

function pickBestMatch(rows, user) {
  if (!rows.length) return null;
  const email = normalize(user.email);
  const name = normalize(user.name);
  if (email) {
    const byContact = rows.find((row) => normalize(row.contact) === email);
    if (byContact) return byContact;
  }
  if (name) {
    const byName = rows.find((row) => normalize(row.name) === name);
    if (byName) return byName;
  }
  if (rows.length === 1) return rows[0];
  return null;
}

async function resolveStudent(user) {
  const queries = [];
  const email = normalize(user.email);
  if (email) queries.push(email);
  const name = normalize(user.name);
  if (name && name !== "студент") queries.push(name);

  for (const query of queries) {
    const rows = await fetchStudents(query);
    const match = pickBestMatch(rows, user);
    if (match) return match;
  }
  return null;
}

async function loadMyAbsences(user) {
  if (!user) return;
  setHint("");
  try {
    const student = await resolveStudent(user);
    if (!student) {
      currentStudent = null;
      currentAbsences = [];
      renderAbsences([]);
      updateMetrics([]);
      setHint("Не удалось найти вашу запись. Проверьте, что в контактах указан ваш email.");
      return;
    }

    currentStudent = student;
    await loadMyRequests(student.id);
    const response = await fetch(`/api/absences?student_name=${encodeURIComponent(String(student.id))}`, {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    const rows = payload.absences || [];
    currentAbsences = rows;
    renderAbsences(rows, student);
    updateMetrics(rows, student);
    if (!rows.length) {
      setHint("Пропусков пока нет.");
    }
  } catch (err) {
    showToast("Не удалось загрузить пропуски.");
  }
}

initTheme();
initAuth();
