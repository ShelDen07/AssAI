import csv
import io
import json
import os
import sqlite3
import threading
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import request, error
from urllib.parse import parse_qs, urlparse

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "assistant.db"
API_URL_TEMPLATE = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODEL = "gemini-2.5-flash"

SESSIONS = {}
SESSIONS_LOCK = threading.Lock()
DB_LOCK = threading.Lock()

SYSTEM_PROMPT = """
Вы — интеллектуальный ассистент для автоматизации учета пропущенных учебных дней студентов.
Отвечайте только на русском языке.
Сегодня: {today}.

Правила:
- Не выдумывайте данные. Любые факты о студентах и пропусках берите через инструменты.
- Если не хватает данных (ФИО, группа, дата, количество занятий, тип), задайте уточняющий вопрос.
- Для записи пропусков используйте инструмент record_absence.
- Для поиска студентов используйте find_students.
- Для отчетов используйте generate_report.
- В ответах будьте краткими и деловыми. В конце предлагайте следующий шаг.
""".strip()

FUNCTION_DECLARATIONS = [
  {
    "name": "add_student",
    "description": "Добавить студента в базу",
    "parameters": {
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "group": {"type": "string"},
        "contact": {"type": "string"}
      },
      "required": ["name", "group"]
    }
  },
  {
    "name": "find_students",
    "description": "Найти студентов по имени или группе",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {"type": "string"},
        "group": {"type": "string"}
      },
      "required": ["query"]
    }
  },
  {
    "name": "record_absence",
    "description": "Зафиксировать пропуск студента",
    "parameters": {
      "type": "object",
      "properties": {
        "student_name": {"type": "string"},
        "student_id": {"type": "integer"},
        "date": {"type": "string"},
        "lessons": {"type": "integer"},
        "type": {"type": "string", "enum": ["неуважительная", "уважительная", "медицинская"]},
        "reason": {"type": "string"},
        "doc": {"type": "boolean"}
      },
      "required": ["date", "lessons", "type"]
    }
  },
  {
    "name": "list_absences",
    "description": "Получить список пропусков с фильтрами",
    "parameters": {
      "type": "object",
      "properties": {
        "student_name": {"type": "string"},
        "group": {"type": "string"},
        "date_from": {"type": "string"},
        "date_to": {"type": "string"},
        "type": {"type": "string"}
      }
    }
  },
  {
    "name": "generate_report",
    "description": "Сформировать отчет по пропускам",
    "parameters": {
      "type": "object",
      "properties": {
        "scope": {"type": "string", "enum": ["student", "group", "all"]},
        "target": {"type": "string"},
        "date_from": {"type": "string"},
        "date_to": {"type": "string"},
        "unexcused_threshold": {"type": "integer"},
        "total_threshold": {"type": "integer"}
      },
      "required": ["scope"]
    }
  }
]


def init_db():
  with DB_LOCK:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute(
      """
      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        group_name TEXT NOT NULL,
        contact TEXT,
        created_at TEXT NOT NULL
      )
      """
    )
    conn.execute(
      """
      CREATE TABLE IF NOT EXISTS absences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        lessons INTEGER NOT NULL,
        type TEXT NOT NULL,
        reason TEXT,
        doc INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (student_id) REFERENCES students (id)
      )
      """
    )
    conn.commit()
    conn.close()


def db_connect():
  conn = sqlite3.connect(DB_PATH)
  conn.row_factory = sqlite3.Row
  return conn


def normalize_date(value):
  if not value:
    return None
  raw = str(value).strip().lower()
  today = datetime.now().date()
  if raw in {"сегодня", "today"}:
    return today.isoformat()
  if raw in {"вчера", "yesterday"}:
    return (today - timedelta(days=1)).isoformat()
  if raw in {"завтра", "tomorrow"}:
    return (today + timedelta(days=1)).isoformat()

  for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y"):
    try:
      return datetime.strptime(raw, fmt).date().isoformat()
    except ValueError:
      continue
  return None


def format_date(value):
  if not value:
    return "—"
  try:
    return datetime.strptime(value, "%Y-%m-%d").strftime("%d.%m.%Y")
  except ValueError:
    return value


def to_int(value, default):
  try:
    return int(value)
  except (TypeError, ValueError):
    return default


def to_int_optional(value):
  try:
    return int(value)
  except (TypeError, ValueError):
    return None

def parse_bool(value):
  if value is None:
    return False
  if isinstance(value, bool):
    return value
  raw = str(value).strip().lower()
  return raw in {"1", "true", "yes", "y", "да", "истина", "t"}


def export_students_csv():
  rows = list_students()
  output = io.StringIO()
  writer = csv.writer(output)
  writer.writerow(["name", "group", "contact"])
  for row in rows:
    writer.writerow([row.get("name"), row.get("group_name"), row.get("contact", "")])
  return output.getvalue()


def export_absences_csv():
  rows = list_absences()
  output = io.StringIO()
  writer = csv.writer(output)
  writer.writerow(["student_name", "group", "date", "lessons", "type", "reason", "doc"])
  for row in rows:
    writer.writerow([
      row.get("name"),
      row.get("group_name"),
      row.get("date"),
      row.get("lessons"),
      row.get("type"),
      row.get("reason", ""),
      1 if row.get("doc") else 0,
    ])
  return output.getvalue()


def import_students_csv(text):
  reader = csv.DictReader(io.StringIO(text or ""))
  count = 0
  for row in reader:
    name = (row.get("name") or row.get("student") or row.get("full_name") or "").strip()
    group = (row.get("group") or row.get("group_name") or "").strip()
    contact = (row.get("contact") or row.get("email") or row.get("phone") or "").strip()
    if not name or not group:
      continue
    create_student(name, group, contact)
    count += 1
  return count


def import_absences_csv(text):
  reader = csv.DictReader(io.StringIO(text or ""))
  count = 0
  for row in reader:
    student_id = to_int_optional(row.get("student_id"))
    name = (row.get("student_name") or row.get("name") or "").strip()
    group = (row.get("group") or row.get("group_name") or "").strip()
    if not student_id:
      student = None
      if name and group:
        student = get_student_by_name_group(name, group)
        if not student:
          student = create_student(name, group, row.get("contact", ""))
      elif name:
        matches = find_students(name)
        if len(matches) == 1:
          student = matches[0]
      if student:
        student_id = student.get("id")

    if not student_id:
      continue

    date_value = row.get("date") or row.get("absence_date")
    lessons = to_int(row.get("lessons"), 1)
    abs_type = (row.get("type") or "неуважительная").strip().lower()
    if abs_type not in {"неуважительная", "уважительная", "медицинская"}:
      abs_type = "неуважительная"
    reason = row.get("reason") or ""
    doc = parse_bool(row.get("doc"))

    if record_absence(student_id, date_value, lessons, abs_type, reason, doc):
      count += 1
  return count

def create_student(name, group, contact=""):
  with DB_LOCK:
    conn = db_connect()
    existing = conn.execute(
      "SELECT * FROM students WHERE lower(name) = lower(?) AND group_name = ?",
      (name, group),
    ).fetchone()
    if existing:
      conn.execute("UPDATE students SET contact = ? WHERE id = ?", (contact or existing["contact"], existing["id"]))
      conn.commit()
      conn.close()
      return dict(existing)

    now = datetime.now().isoformat(timespec="seconds")
    cursor = conn.execute(
      "INSERT INTO students (name, group_name, contact, created_at) VALUES (?, ?, ?, ?)",
      (name, group, contact, now),
    )
    conn.commit()
    student_id = cursor.lastrowid
    row = conn.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    conn.close()
    return dict(row)

def update_student(student_id, name, group, contact=""):
  with DB_LOCK:
    conn = db_connect()
    existing = conn.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    if not existing:
      conn.close()
      return None

    next_name = name or existing["name"]
    next_group = group or existing["group_name"]
    next_contact = contact if contact is not None else existing["contact"]

    conn.execute(
      "UPDATE students SET name = ?, group_name = ?, contact = ? WHERE id = ?",
      (next_name, next_group, next_contact, student_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_student(student_id):
  with DB_LOCK:
    conn = db_connect()
    count = conn.execute("SELECT COUNT(*) AS total FROM absences WHERE student_id = ?", (student_id,)).fetchone()["total"]
    if count > 0:
      conn.close()
      return False, f"Нельзя удалить студента: есть пропуски ({count})."
    conn.execute("DELETE FROM students WHERE id = ?", (student_id,))
    conn.commit()
    deleted = conn.total_changes > 0
    conn.close()
    return deleted, None


def find_students(query, group=None):
  with DB_LOCK:
    conn = db_connect()
    sql = "SELECT * FROM students WHERE lower(name) LIKE ?"
    params = [f"%{query.lower()}%"]
    if group:
      sql += " AND group_name = ?"
      params.append(group)
    sql += " ORDER BY name"
    rows = [dict(row) for row in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows


def list_students(query=None, group=None):
  with DB_LOCK:
    conn = db_connect()
    sql = "SELECT * FROM students WHERE 1=1"
    params = []
    if query:
      sql += " AND lower(name) LIKE ?"
      params.append(f"%{query.lower()}%")
    if group:
      sql += " AND group_name = ?"
      params.append(group)
    sql += " ORDER BY name"
    rows = [dict(row) for row in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows


def get_student_by_id(student_id):
  with DB_LOCK:
    conn = db_connect()
    row = conn.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_student_by_name_group(name, group):
  with DB_LOCK:
    conn = db_connect()
    row = conn.execute(
      "SELECT * FROM students WHERE lower(name) = lower(?) AND group_name = ?",
      (name, group),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def record_absence(student_id, date_value, lessons, abs_type, reason="", doc=False):
  with DB_LOCK:
    conn = db_connect()
    student = conn.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()
    if not student:
      conn.close()
      return None

    normalized = normalize_date(date_value)
    if not normalized:
      conn.close()
      return None

    now = datetime.now().isoformat(timespec="seconds")
    conn.execute(
      "INSERT INTO absences (student_id, date, lessons, type, reason, doc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      (student_id, normalized, lessons, abs_type, reason, 1 if doc else 0, now),
    )
    conn.commit()
    row = conn.execute(
      "SELECT a.*, s.name, s.group_name FROM absences a JOIN students s ON s.id = a.student_id WHERE a.id = last_insert_rowid()"
    ).fetchone()
    conn.close()
    return dict(row)


def list_absences(student_name=None, group=None, date_from=None, date_to=None, abs_type=None):
  with DB_LOCK:
    conn = db_connect()
    sql = """
      SELECT a.*, s.name, s.group_name
      FROM absences a
      JOIN students s ON s.id = a.student_id
      WHERE 1=1
    """
    params = []
    if student_name:
      sql += " AND lower(s.name) LIKE ?"
      params.append(f"%{student_name.lower()}%")
    if group:
      sql += " AND s.group_name = ?"
      params.append(group)
    if abs_type:
      sql += " AND a.type = ?"
      params.append(abs_type)
    if date_from:
      normalized = normalize_date(date_from)
      if normalized:
        sql += " AND a.date >= ?"
        params.append(normalized)
    if date_to:
      normalized = normalize_date(date_to)
      if normalized:
        sql += " AND a.date <= ?"
        params.append(normalized)

    sql += " ORDER BY a.date DESC"
    rows = [dict(row) for row in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows


def student_stats(group=None, date_from=None, date_to=None):
  with DB_LOCK:
    conn = db_connect()
    sql = """
      SELECT s.id, s.name, s.group_name,
        COALESCE(SUM(a.lessons), 0) as total_lessons,
        COALESCE(SUM(CASE WHEN a.type = 'неуважительная' THEN a.lessons ELSE 0 END), 0) as unexcused
      FROM students s
      LEFT JOIN absences a ON a.student_id = s.id
    """
    params = []
    where = []
    if date_from:
      normalized = normalize_date(date_from)
      if normalized:
        where.append("a.date >= ?")
        params.append(normalized)
    if date_to:
      normalized = normalize_date(date_to)
      if normalized:
        where.append("a.date <= ?")
        params.append(normalized)
    if group:
      where.append("s.group_name = ?")
      params.append(group)
    if where:
      sql += " WHERE " + " AND ".join(where)
    sql += " GROUP BY s.id ORDER BY total_lessons DESC"

    rows = [dict(row) for row in conn.execute(sql, params).fetchall()]
    conn.close()
    return rows


def get_summary():
  with DB_LOCK:
    conn = db_connect()
    students = conn.execute("SELECT COUNT(*) AS total FROM students").fetchone()["total"]
    absences = conn.execute("SELECT COUNT(*) AS total FROM absences").fetchone()["total"]
    unexcused = conn.execute("SELECT COALESCE(SUM(lessons),0) AS total FROM absences WHERE type = 'неуважительная'").fetchone()["total"]
    conn.close()
  at_risk = len([row for row in student_stats() if row["unexcused"] >= 3 or row["total_lessons"] >= 6])
  return {
    "students": students,
    "absences": absences,
    "unexcused": unexcused,
    "at_risk": at_risk,
  }


def get_recent_absences():
  rows = list_absences()
  recent = []
  for row in rows[:5]:
    recent.append({
      "date": format_date(row["date"]),
      "student": row["name"],
      "group": row["group_name"],
      "lessons": row["lessons"],
      "type": row["type"],
    })
  return recent


def generate_report(scope, target=None, date_from=None, date_to=None, unexcused_threshold=3, total_threshold=6):
  group = None
  student_name = None
  if scope == "group":
    group = target
  if scope == "student":
    student_name = target

  stats = student_stats(group=group, date_from=date_from, date_to=date_to)
  if student_name:
    stats = [row for row in stats if student_name.lower() in row["name"].lower()]

  at_risk = [
    row for row in stats
    if row["unexcused"] >= unexcused_threshold or row["total_lessons"] >= total_threshold
  ]

  return {
    "scope": scope,
    "target": target,
    "period": {
      "from": normalize_date(date_from) if date_from else None,
      "to": normalize_date(date_to) if date_to else None,
    },
    "thresholds": {
      "unexcused": unexcused_threshold,
      "total": total_threshold,
    },
    "totals": {
      "students": len(stats),
      "at_risk": len(at_risk),
    },
    "students": stats,
    "at_risk_list": at_risk,
  }


def handle_tool_call(name, args):
  if name == "add_student":
    student = create_student(args.get("name", "").strip(), args.get("group", "").strip(), args.get("contact", ""))
    action = f"Добавлен студент: {student['name']} ({student['group_name']})"
    return {"ok": True, "student": student}, action

  if name == "find_students":
    students = find_students(args.get("query", ""), args.get("group"))
    return {"ok": True, "students": students}, None

  if name == "record_absence":
    student_id = args.get("student_id")
    student_name = args.get("student_name")
    if not student_id and student_name:
      matches = find_students(student_name)
      if len(matches) == 1:
        student_id = matches[0]["id"]
      elif len(matches) > 1:
        return {
          "ok": False,
          "error": "Найдено несколько студентов. Уточните группу или ФИО.",
          "candidates": matches,
        }, None
      else:
        return {"ok": False, "error": "Студент не найден. Добавьте его в базу."}, None

    lessons = to_int(args.get("lessons", 1), 1)
    lessons = max(1, min(10, lessons))
    abs_type = args.get("type", "неуважительная")
    row = record_absence(student_id, args.get("date"), lessons, abs_type, args.get("reason", ""), args.get("doc", False))
    if not row:
      return {"ok": False, "error": "Не удалось записать пропуск. Проверьте дату и данные."}, None
    action = f"Пропуск зафиксирован: {row['name']} ({row['group_name']}) {format_date(row['date'])}"
    return {"ok": True, "absence": row}, action

  if name == "list_absences":
    rows = list_absences(
      student_name=args.get("student_name"),
      group=args.get("group"),
      date_from=args.get("date_from"),
      date_to=args.get("date_to"),
      abs_type=args.get("type"),
    )
    return {"ok": True, "absences": rows}, None

  if name == "generate_report":
    report = generate_report(
      scope=args.get("scope", "all"),
      target=args.get("target"),
      date_from=args.get("date_from"),
      date_to=args.get("date_to"),
      unexcused_threshold=to_int(args.get("unexcused_threshold", 3), 3),
      total_threshold=to_int(args.get("total_threshold", 6), 6),
    )
    return {"ok": True, "report": report}, None

  return {"ok": False, "error": "Неизвестная команда"}, None


def gemini_request(contents, model):
  api_key = os.getenv("GEMINI_API_KEY")
  if not api_key:
    raise RuntimeError("GEMINI_API_KEY is not set")

  payload = {
    "contents": contents,
    "systemInstruction": {
      "parts": [{"text": SYSTEM_PROMPT.format(today=datetime.now().strftime("%d.%m.%Y"))}],
    },
    "tools": [{"functionDeclarations": FUNCTION_DECLARATIONS}],
    "generationConfig": {
      "temperature": 0.2,
      "maxOutputTokens": 650,
    },
  }

  data = json.dumps(payload).encode("utf-8")
  req = request.Request(
    API_URL_TEMPLATE.format(model=model),
    data=data,
    method="POST",
    headers={
      "Content-Type": "application/json",
      "x-goog-api-key": api_key,
    },
  )
  try:
    with request.urlopen(req, timeout=40) as resp:
      raw = resp.read().decode("utf-8")
      return json.loads(raw)
  except error.HTTPError as exc:
    body = exc.read().decode("utf-8")
    raise RuntimeError(body) from exc


def gemini_validate_key():
  api_key = os.getenv("GEMINI_API_KEY")
  if not api_key:
    return False, "GEMINI_API_KEY не задан"

  payload = {
    "contents": [{"role": "user", "parts": [{"text": "ping"}]}],
    "generationConfig": {"maxOutputTokens": 1},
  }
  data = json.dumps(payload).encode("utf-8")
  req = request.Request(
    API_URL_TEMPLATE.format(model=DEFAULT_MODEL),
    data=data,
    method="POST",
    headers={
      "Content-Type": "application/json",
      "x-goog-api-key": api_key,
    },
  )
  try:
    with request.urlopen(req, timeout=20) as resp:
      resp.read()
      return True, "Gemini ключ корректен"
  except error.HTTPError as exc:
    body = exc.read().decode("utf-8")
    return False, f"Gemini ошибка: {body}"
  except Exception as exc:
    return False, f"Gemini ошибка: {exc}"

def get_candidate_content(response):
  candidates = response.get("candidates", [])
  if not candidates:
    return {"role": "model", "parts": []}
  return candidates[0].get("content", {"role": "model", "parts": []})


def extract_text_from_content(content):
  parts = content.get("parts", [])
  texts = []
  for part in parts:
    if isinstance(part, dict) and part.get("text"):
      texts.append(part.get("text"))
  return "".join(texts).strip()


def extract_function_calls(content):
  parts = content.get("parts", [])
  calls = []
  for part in parts:
    if not isinstance(part, dict):
      continue
    call = part.get("functionCall") or part.get("function_call")
    if call:
      calls.append(call)
  return calls


def parse_call_args(call):
  args = call.get("args") if isinstance(call, dict) else None
  if args is None and isinstance(call, dict):
    args = call.get("arguments")
  if isinstance(args, str):
    try:
      return json.loads(args)
    except json.JSONDecodeError:
      return {}
  if isinstance(args, dict):
    return args
  return {}


def chat_with_model(session, message, model):
  history = session.setdefault("history", [])
  actions = []
  history.append({"role": "user", "parts": [{"text": message}]})

  response = gemini_request(history, model or DEFAULT_MODEL)
  content = get_candidate_content(response)
  history.append(content)
  calls = extract_function_calls(content)
  loops = 0

  while calls and loops < 4:
    for call in calls:
      name = call.get("name")
      args = parse_call_args(call)
      result, action = handle_tool_call(name, args)
      if action:
        actions.append(action)

      history.append({
        "role": "function",
        "parts": [{
          "functionResponse": {
            "name": name,
            "response": result,
          }
        }],
      })

    response = gemini_request(history, model or DEFAULT_MODEL)
    content = get_candidate_content(response)
    history.append(content)
    calls = extract_function_calls(content)
    loops += 1

  if len(history) > 80:
    session["history"] = history[-80:]

  return extract_text_from_content(content), actions


def get_session(session_id):
  with SESSIONS_LOCK:
    session = SESSIONS.get(session_id)
    if not session:
      session = {"history": [], "actions": []}
      SESSIONS[session_id] = session
    return session


class AssistantHandler(SimpleHTTPRequestHandler):
  def __init__(self, *args, **kwargs):
    super().__init__(*args, directory=str(BASE_DIR), **kwargs)

  def _parse_path(self):
    parsed = urlparse(self.path)
    params = {key: values[0] for key, values in parse_qs(parsed.query).items()}
    return parsed.path, params

  def do_GET(self):
    path, params = self._parse_path()
    if path.startswith("/api/health"):
      payload = {
        "ok": True,
        "api_key": bool(os.getenv("GEMINI_API_KEY")),
        "summary": get_summary(),
        "recent": get_recent_absences(),
      }
      self._send_json(payload)
      return
    if path.startswith("/api/students"):
      self._handle_students(params)
      return
    if path.startswith("/api/absences"):
      self._handle_absences(params)
      return
    if path.startswith("/api/export"):
      self._handle_export(params)
      return
    super().do_GET()

  def do_POST(self):
    path, params = self._parse_path()
    if path.startswith("/api/students"):
      self._handle_students_post()
      return
    if path.startswith("/api/chat"):
      self._handle_chat()
      return
    if path.startswith("/api/reset"):
      self._handle_reset()
      return
    if path.startswith("/api/import"):
      self._handle_import()
      return
    self.send_error(404, "Not Found")

  def _handle_students(self, params):
    query = (params.get("query") or "").strip()
    group = (params.get("group") or "").strip()
    if group == "all":
      group = ""
    rows = list_students(query=query or None, group=group or None)
    students = []
    for row in rows:
      item = dict(row)
      item["group"] = item.get("group_name")
      students.append(item)
    self._send_json({"students": students})

  def _handle_students_post(self):
    data = self._read_json() or {}
    action = (data.get("action") or "create").strip().lower()

    if action in {"create", "add", "new"}:
      name = (data.get("name") or "").strip()
      group = (data.get("group") or "").strip()
      contact = (data.get("contact") or "").strip()
      if not name or not group:
        self._send_json({"error": "Нужно указать имя и группу."}, status=400)
        return
      student = create_student(name, group, contact)
      self._send_json({"ok": True, "student": student})
      return

    if action in {"update", "edit", "save"}:
      student_id = to_int_optional(data.get("id"))
      if not student_id:
        self._send_json({"error": "Не указан id студента."}, status=400)
        return
      name = (data.get("name") or "").strip()
      group = (data.get("group") or "").strip()
      contact = (data.get("contact") if data.get("contact") is not None else "").strip()
      if not name or not group:
        self._send_json({"error": "Нужно указать имя и группу."}, status=400)
        return
      student = update_student(student_id, name, group, contact)
      if not student:
        self._send_json({"error": "Студент не найден."}, status=404)
        return
      self._send_json({"ok": True, "student": student})
      return

    if action in {"delete", "remove"}:
      student_id = to_int_optional(data.get("id"))
      if not student_id:
        self._send_json({"error": "Не указан id студента."}, status=400)
        return
      ok, err = delete_student(student_id)
      if not ok:
        self._send_json({"error": err or "Не удалось удалить."}, status=400)
        return
      self._send_json({"ok": True})
      return

    self._send_json({"error": "Неизвестное действие."}, status=400)

  def _handle_absences(self, params):
    group = (params.get("group") or "").strip()
    if group == "all":
      group = ""
    abs_type = (params.get("type") or "").strip()
    if abs_type == "all":
      abs_type = ""
    rows = list_absences(
      student_name=params.get("student_name"),
      group=group or None,
      date_from=params.get("date_from"),
      date_to=params.get("date_to"),
      abs_type=abs_type or None,
    )
    self._send_json({"absences": rows})

  def _handle_export(self, params):
    export_type = (params.get("type") or "").strip().lower()
    if export_type == "students":
      csv_text = export_students_csv()
      filename = "students.csv"
    elif export_type == "absences":
      csv_text = export_absences_csv()
      filename = "absences.csv"
    else:
      self._send_json({"error": "Неизвестный тип экспорта"}, status=400)
      return

    body = csv_text.encode("utf-8")
    self.send_response(200)
    self.send_header("Content-Type", "text/csv; charset=utf-8")
    self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def _handle_import(self):
    data = self._read_json() or {}
    import_type = (data.get("type") or "").strip().lower()
    csv_text = data.get("csv") or ""
    if not csv_text:
      self._send_json({"error": "Пустой CSV"}, status=400)
      return
    if import_type == "students":
      count = import_students_csv(csv_text)
    elif import_type == "absences":
      count = import_absences_csv(csv_text)
    else:
      self._send_json({"error": "Неизвестный тип импорта"}, status=400)
      return

    self._send_json({"ok": True, "message": f"Импортировано: {count}"})

  def _handle_chat(self):
    data = self._read_json()
    if not data or not data.get("message"):
      self._send_json({"error": "Пустое сообщение"}, status=400)
      return

    if not os.getenv("GEMINI_API_KEY"):
      self._send_json({"error": "GEMINI_API_KEY не задан"}, status=400)
      return

    session_id = data.get("session_id") or "default"
    session = get_session(session_id)

    try:
      reply, actions = chat_with_model(session, data["message"], DEFAULT_MODEL)
    except RuntimeError as exc:
      self._send_json({"error": f"Ошибка Gemini: {exc}"}, status=500)
      return

    session["actions"].extend(actions)

    self._send_json({
      "reply": reply or "Готово.",
      "summary": get_summary(),
      "recent": get_recent_absences(),
      "actions": session["actions"],
    })

  def _handle_reset(self):
    data = self._read_json() or {}
    session_id = data.get("session_id") or "default"
    with SESSIONS_LOCK:
      if session_id in SESSIONS:
        SESSIONS[session_id] = {"history": [], "actions": []}
    self._send_json({"ok": True})

  def _read_json(self):
    try:
      length = int(self.headers.get("Content-Length", 0))
      if length == 0:
        return None
      raw = self.rfile.read(length).decode("utf-8")
      return json.loads(raw)
    except Exception:
      return None

  def _send_json(self, payload, status=200):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)


if __name__ == "__main__":
  init_db()
  print("Проверка ключей...")
  gemini_ok, gemini_msg = gemini_validate_key()
  print(f"- {gemini_msg}")
  if not gemini_ok:
    print("Внимание: часть ключей не прошла проверку. Сервер все равно запустится.")
  server = ThreadingHTTPServer(("127.0.0.1", 8000), AssistantHandler)
  print("Сервер запущен на http://127.0.0.1:8000")
  server.serve_forever()
  