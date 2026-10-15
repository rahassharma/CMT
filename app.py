"""Conference Management Toolkit — Flask API + static app server.

Roles:
  author   — submit, edit, withdraw, respond to reviews, upload camera-ready
  reviewer — bid, accept assignments, write reviews, discuss
  chair    — everything: configure the conference, manage users, assign
             reviewers, make decisions, release reviews, notify, export, audit
"""
import csv
import io
import json
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from flask import Flask, request, jsonify, send_from_directory, Response, g
from werkzeug.utils import secure_filename

import db as database

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = database.UPLOAD_DIR

app = Flask(__name__, static_folder="static", static_url_path="/static")
# Upload cap, overridable with MAX_UPLOAD_MB — useful on hosts with a small
# disk (PythonAnywhere free gives 512 MB total), where a tighter limit helps.
try:
    _max_upload_mb = max(1, min(200, int(os.environ.get("MAX_UPLOAD_MB", "25"))))
except ValueError:
    _max_upload_mb = 25
MAX_UPLOAD_BYTES = _max_upload_mb * 1024 * 1024
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


# ------------------------------------------------------------------ utils

def now():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat(timespec="seconds")


def parse_dt(value):
    if not value:
        return None
    try:
        v = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(v)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def err(message, status=400, **extra):
    payload = {"error": message}
    payload.update(extra)
    return jsonify(payload), status


def get_conn():
    if "conn" not in g:
        g.conn = database.get_db()
    return g.conn


@app.teardown_appcontext
def close_conn(exc):
    conn = g.pop("conn", None)
    if conn is not None:
        try:
            conn.commit()
        finally:
            conn.close()


def current_user():
    if "user" in g:
        return g.user
    token = request.headers.get("X-Token", "")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    g.user = None
    if token:
        conn = get_conn()
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token = ? AND s.expires_at > ?",
            (token, iso(now())),
        ).fetchone()
        if row and not row["disabled"]:
            g.user = row
    return g.user


def require_user():
    user = current_user()
    if not user:
        return None, err("Authentication required", 401)
    return user, None


def is_chair(user):
    return user and "chair" in json.loads(user["roles"] or "[]")


def require_chair():
    user, e = require_user()
    if e:
        return None, e
    if not is_chair(user):
        return None, err("Chair privileges required", 403)
    return user, None


def roles_of(user):
    return json.loads(user["roles"] or "[]")


def user_public(row, conn=None):
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "affiliation": row["affiliation"],
        "roles": json.loads(row["roles"] or "[]"),
        "disabled": bool(row["disabled"]),
        "created_at": row["created_at"],
    }


def settings_payload(conn):
    s = database.get_settings(conn)
    return s


def submission_authors(conn, sid):
    return [
        dict(r)
        for r in conn.execute(
            "SELECT name, email, affiliation, position FROM submission_authors "
            "WHERE submission_id=? ORDER BY position, id",
            (sid,),
        )
    ]


def is_submission_author(conn, sub, user):
    if user["id"] == sub["submitted_by"]:
        return True
    row = conn.execute(
        "SELECT 1 FROM submission_authors WHERE submission_id=? AND lower(email)=lower(?)",
        (sub["id"], user["email"]),
    ).fetchone()
    return row is not None


def review_visible_to(conn, sub, user, s):
    if is_chair(user):
        return True
    if is_submission_author(conn, sub, user):
        return bool(s.get("reviews_visible"))
    row = conn.execute(
        "SELECT 1 FROM assignments WHERE submission_id=? AND reviewer_id=?",
        (sub["id"], user["id"]),
    ).fetchone()
    return row is not None


def reviews_for(conn, sub, user, s):
    if not review_visible_to(conn, sub, user, s):
        return []
    show_names = is_chair(user) or (is_submission_author(conn, sub, user) and
                                    (s.get("author_see_reviewer_names") or not s.get("blind_reviewing")))
    out = []
    for r in conn.execute(
        "SELECT r.*, u.name AS reviewer_name FROM reviews r JOIN users u ON u.id=r.reviewer_id "
        "WHERE r.submission_id=? ORDER BY r.id",
        (sub["id"],),
    ):
        item = {
            "id": r["id"],
            "soundness": r["soundness"],
            "presentation": r["presentation"],
            "contribution": r["contribution"],
            "overall": r["overall"],
            "confidence": r["confidence"],
            "strengths": r["strengths"],
            "weaknesses": r["weaknesses"],
            "questions": r["questions"],
            "state": r["state"],
            "updated_at": r["updated_at"],
            "reviewer": r["reviewer_name"] if show_names else "Anonymous reviewer",
        }
        out.append(item)
    return out


def comments_for(conn, sub, user, s):
    out = []
    author_side = is_submission_author(conn, sub, user)
    chair = is_chair(user)
    reviewer_side = conn.execute(
        "SELECT 1 FROM assignments WHERE submission_id=? AND reviewer_id=?",
        (sub["id"], user["id"]),
    ).fetchone() is not None
    for c in conn.execute(
        "SELECT c.*, u.name AS author_name, u.roles AS author_roles FROM comments c "
        "JOIN users u ON u.id=c.user_id WHERE c.submission_id=? ORDER BY c.id",
        (sub["id"],),
    ):
        vis = c["visibility"]
        allow = chair or vis == "everyone"
        if not allow and vis == "authors" and author_side:
            allow = True
        if not allow and vis == "reviewers" and (reviewer_side or chair):
            allow = True
        if not allow:
            continue
        out.append({
            "id": c["id"],
            "body": c["body"],
            "visibility": vis,
            "author": c["author_name"],
            "roles": json.loads(c["author_roles"] or "[]"),
            "created_at": c["created_at"],
        })
    return out


def submission_detail(conn, sub, user, s):
    reviews = reviews_for(conn, sub, user, s)
    avg = None
    if reviews:
        scored = [r["overall"] for r in reviews if r["overall"]]
        avg = round(sum(scored) / len(scored), 2) if scored else None
    decision = sub["decision"]
    decision_comment = sub["decision_comment"]
    if not is_chair(user) and not s.get("decisions_released"):
        decision, decision_comment = "", ""
    n_reviews_submitted = sum(1 for r in reviews if r["state"] == "submitted")
    decision_pending = (
        bool(sub["decision"]) and not s.get("decisions_released")
        and (is_chair(user) or is_submission_author(conn, sub, user))
    )
    return {
        "id": sub["id"],
        "title": sub["title"],
        "abstract": sub["abstract"],
        "topics": json.loads(sub["topics"] or "[]"),
        "track": sub["track"],
        "status": sub["status"],
        "decision": decision,
        "decision_comment": decision_comment,
        "decision_pending": decision_pending,
        "authors": submission_authors(conn, sub["id"]),
        "submitted_by": sub["submitted_by"],
        "pdf_filename": sub["pdf_filename"],
        "paper_text": sub["paper_text"],
        "camera_ready_filename": sub["camera_ready_filename"],
        "camera_ready_note": sub["camera_ready_note"],
        "created_at": sub["created_at"],
        "updated_at": sub["updated_at"],
        "reviews": reviews,
        "avg_overall": avg,
        "n_reviews_submitted": n_reviews_submitted,
        "comments": comments_for(conn, sub, user, s),
        "can_edit": can_edit(conn, sub, user, s),
    }


def can_edit(conn, sub, user, s):
    if is_chair(user):
        return True
    if sub["status"] != "submitted":
        return False
    if not is_submission_author(conn, sub, user):
        return False
    if not s.get("submissions_open"):
        return False
    deadline = parse_dt(s.get("submission_deadline"))
    return deadline is None or now() <= deadline


# ------------------------------------------------------------------ auth

@app.post("/api/auth/register")
def register():
    conn = get_conn()
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    name = (data.get("name") or "").strip()
    password = data.get("password") or ""
    affiliation = (data.get("affiliation") or "").strip()
    if not re.match(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return err("A valid email is required")
    if len(name) < 2:
        return err("Name is required")
    if len(password) < 6:
        return err("Password must be at least 6 characters")
    if conn.execute("SELECT 1 FROM users WHERE lower(email)=?", (email,)).fetchone():
        return err("An account with that email already exists", 409)
    pwd = database.hash_password(password)
    # Bootstrap: on a brand-new install with no accounts at all, the first
    # person to register becomes the chair, so a fresh deployment is never
    # locked out. (Set ADMIN_EMAIL/ADMIN_PASSWORD instead to create the chair
    # up front and leave registration for authors only.)
    first_user = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] == 0
    roles = ["chair", "author", "reviewer"] if first_user else ["author"]
    cur = conn.execute(
        "INSERT INTO users(email, name, password_hash, affiliation, roles, disabled, created_at) "
        "VALUES (?,?,?,?,?,0,?)",
        (email, name, pwd, affiliation, json.dumps(roles), database.now()),
    )
    uid = cur.lastrowid
    token = secrets.token_hex(24)
    conn.execute(
        "INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
        (token, uid, database.now(), iso(now() + timedelta(days=14))),
    )
    database.log(conn, uid, "register", email)
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return jsonify({"token": token, "user": user_public(row)})


@app.post("/api/auth/login")
def login():
    conn = get_conn()
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    row = conn.execute("SELECT * FROM users WHERE lower(email)=?", (email,)).fetchone()
    if not row or not database.verify_password(password, row["password_hash"]):
        return err("Invalid email or password", 401)
    if row["disabled"]:
        return err("This account has been disabled", 403)
    token = secrets.token_hex(24)
    conn.execute(
        "INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
        (token, row["id"], database.now(), iso(now() + timedelta(days=14))),
    )
    database.log(conn, row["id"], "login", email)
    conn.commit()
    return jsonify({"token": token, "user": user_public(row)})


@app.post("/api/auth/logout")
def logout():
    token = request.headers.get("X-Token", "")
    conn = get_conn()
    conn.execute("DELETE FROM sessions WHERE token=?", (token,))
    conn.commit()
    return jsonify({"ok": True})


@app.get("/api/auth/me")
def me():
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    return jsonify({"user": user_public(user), "settings": settings_payload(conn)})


@app.put("/api/auth/profile")
def update_profile():
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or user["name"]).strip()
    affiliation = (data.get("affiliation") or user["affiliation"]).strip()
    password = data.get("password") or ""
    conn.execute(
        "UPDATE users SET name=?, affiliation=? WHERE id=?", (name, affiliation, user["id"])
    )
    if password:
        if len(password) < 6:
            return err("Password must be at least 6 characters")
        conn.execute(
            "UPDATE users SET password_hash=? WHERE id=?",
            (database.hash_password(password), user["id"]),
        )
    database.log(conn, user["id"], "profile_update", user["email"])
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
    return jsonify({"user": user_public(row)})


# ------------------------------------------------------------------ public

@app.get("/api/health")
def health():
    return jsonify({"ok": True, "service": "conference-toolkit", "time": iso(now())})


@app.get("/api/conference")
def conference():
    user = current_user()
    conn = get_conn()
    s = settings_payload(conn)
    public = {
        "conference_name": s["conference_name"],
        "conference_short": s["conference_short"],
        "conference_description": s["conference_description"],
        "submission_deadline": s["submission_deadline"],
        "review_deadline": s["review_deadline"],
        "rebuttal_deadline": s["rebuttal_deadline"],
        "decision_deadline": s["decision_deadline"],
        "camera_ready_deadline": s["camera_ready_deadline"],
        "submissions_open": s["submissions_open"],
        "reviewing_open": s["reviewing_open"],
        "bidding_open": s["bidding_open"],
        "camera_ready_open": s["camera_ready_open"],
        "reviews_visible": s["reviews_visible"],
        "decisions_released": s["decisions_released"],
        "topics": s["topics"],
        # false on a production install (SEED_DEMO=0) — the login page uses this
        # to hide the one-click demo account buttons.
        "demo": os.environ.get("SEED_DEMO", "1") != "0",
    }
    return jsonify({"settings": public, "logged_in": bool(user)})


@app.get("/api/notifications")
def notifications():
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100", (user["id"],)
    ).fetchall()
    return jsonify({"notifications": [dict(r) for r in rows]})


@app.post("/api/notifications/read")
def notifications_read():
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    data = request.get_json(silent=True) or {}
    if data.get("all"):
        conn.execute("UPDATE notifications SET read=1 WHERE user_id=?", (user["id"],))
    else:
        conn.execute(
            "UPDATE notifications SET read=1 WHERE user_id=? AND id=?", (user["id"], data.get("id"))
        )
    conn.commit()
    return jsonify({"ok": True})


# ------------------------------------------------------------------ submissions (author)

def allowed_submission_payload(data, s):
    title = (data.get("title") or "").strip()
    abstract = (data.get("abstract") or "").strip()
    topics = [t for t in (data.get("topics") or []) if isinstance(t, str)]
    track = (data.get("track") or "Main").strip() or "Main"
    authors = data.get("authors") or []
    if len(title) < 4:
        return None, None, err("Title must be at least 4 characters")
    if len(abstract) < 20:
        return None, None, err("Abstract must be at least 20 characters")
    if len(topics) > 5:
        return None, None, err("Choose at most 5 topics")
    if not isinstance(authors, list) or not authors:
        return None, None, err("At least one author is required")
    clean_authors = []
    for i, a in enumerate(authors):
        name = (a.get("name") or "").strip()
        if not name:
            return None, None, err(f"Author {i + 1} needs a name")
        clean_authors.append({
            "name": name,
            "email": (a.get("email") or "").strip(),
            "affiliation": (a.get("affiliation") or "").strip(),
        })
    return {"title": title, "abstract": abstract, "topics": topics, "track": track,
            "authors": clean_authors}, None, None


def write_authors(conn, sid, authors):
    conn.execute("DELETE FROM submission_authors WHERE submission_id=?", (sid,))
    for i, a in enumerate(authors):
        conn.execute(
            "INSERT INTO submission_authors(submission_id, name, email, affiliation, position) VALUES (?,?,?,?,?)",
            (sid, a["name"], a.get("email", ""), a.get("affiliation", ""), i),
        )


@app.get("/api/submissions")
def my_submissions():
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    rows = conn.execute("SELECT * FROM submissions ORDER BY id").fetchall()
    out = []
    for sub in rows:
        if is_chair(user) or is_submission_author(conn, sub, user):
            out.append(submission_detail(conn, sub, user, s))
    return jsonify({"submissions": out, "settings": s})


@app.post("/api/submissions")
def create_submission():
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    if not s.get("submissions_open"):
        return err("Submissions are closed", 403)
    deadline = parse_dt(s.get("submission_deadline"))
    if deadline and now() > deadline and not is_chair(user):
        return err("The submission deadline has passed", 403)
    data = request.get_json(silent=True) or {}
    payload, _, e2 = allowed_submission_payload(data, s)
    if e2:
        return e2
    count = conn.execute(
        "SELECT COUNT(*) FROM submissions WHERE submitted_by=? AND status='submitted'", (user["id"],)
    ).fetchone()[0]
    if count >= s.get("max_papers_per_author", 6) and not is_chair(user):
        return err(f"You have reached the maximum of {s['max_papers_per_author']} active submissions", 403)
    cur = conn.execute(
        "INSERT INTO submissions(title, abstract, topics, track, status, decision, decision_comment,"
        " submitted_by, pdf_filename, paper_text, created_at, updated_at) VALUES (?, ?,?,?,'submitted','','', ?, '', '', ?, ?)",
        (payload["title"], payload["abstract"], json.dumps(payload["topics"]), payload["track"],
         user["id"], database.now(), database.now()),
    )
    sid = cur.lastrowid
    write_authors(conn, sid, payload["authors"])
    database.log(conn, user["id"], "submission_create", f"#{sid} {payload['title'][:60]}")
    conn.commit()
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    return jsonify({"submission": submission_detail(conn, sub, user, s)}), 201


@app.get("/api/submissions/<int:sid>")
def get_submission(sid):
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    if not sub:
        return err("Submission not found", 404)
    if not (is_chair(user) or is_submission_author(conn, sub, user)
            or conn.execute("SELECT 1 FROM assignments WHERE submission_id=? AND reviewer_id=?",
                            (sid, user["id"])).fetchone()):
        return err("You do not have access to this submission", 403)
    return jsonify({"submission": submission_detail(conn, sub, user, s), "settings": s})


@app.put("/api/submissions/<int:sid>")
def update_submission(sid):
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    if not sub:
        return err("Submission not found", 404)
    if not (is_chair(user) or is_submission_author(conn, sub, user)):
        return err("Not allowed to edit this submission", 403)
    if not can_edit(conn, sub, user, s):
        return err("This submission can no longer be edited (deadline passed or withdrawn)", 403)
    data = request.get_json(silent=True) or {}
    payload, _, e2 = allowed_submission_payload(data, s)
    if e2:
        return e2
    conn.execute(
        "UPDATE submissions SET title=?, abstract=?, topics=?, track=?, updated_at=? WHERE id=?",
        (payload["title"], payload["abstract"], json.dumps(payload["topics"]), payload["track"],
         database.now(), sid),
    )
    write_authors(conn, sid, payload["authors"])
    database.log(conn, user["id"], "submission_update", f"#{sid}")
    conn.commit()
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    return jsonify({"submission": submission_detail(conn, sub, user, s)})


@app.post("/api/submissions/<int:sid>/withdraw")
def withdraw_submission(sid):
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    if not sub:
        return err("Submission not found", 404)
    if not (is_chair(user) or is_submission_author(conn, sub, user)):
        return err("Not allowed", 403)
    conn.execute("UPDATE submissions SET status='withdrawn', updated_at=? WHERE id=?", (database.now(), sid))
    database.log(conn, user["id"], "submission_withdraw", f"#{sid}")
    conn.commit()
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    return jsonify({"submission": submission_detail(conn, sub, user, s)})


@app.post("/api/submissions/<int:sid>/restore")
def restore_submission(sid):
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    if not sub:
        return err("Submission not found", 404)
    if not (is_chair(user) or is_submission_author(conn, sub, user)):
        return err("Not allowed", 403)
    if sub["status"] == "withdrawn" and not is_chair(user) and not s.get("submissions_open"):
        return err("Submissions are closed; only a chair can restore", 403)
    conn.execute("UPDATE submissions SET status='submitted', updated_at=? WHERE id=?", (database.now(), sid))
    database.log(conn, user["id"], "submission_restore", f"#{sid}")
    conn.commit()
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    return jsonify({"submission": submission_detail(conn, sub, user, s)})


def handle_upload(sid, field, prefix):
    user, e = require_user()
    if e:
        return e, None
    conn = get_conn()
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    if not sub:
        return err("Submission not found", 404), None
    if not (is_chair(user) or is_submission_author(conn, sub, user)):
        return err("Not allowed", 403), None
    file = request.files.get(field) or request.files.get("file")
    if not file or not file.filename:
        return err("No file uploaded"), None
    filename = secure_filename(file.filename)
    if not filename.lower().endswith(".pdf"):
        return err("Only PDF files are accepted"), None
    stored = f"{prefix}_{sid}_{uuid.uuid4().hex[:8]}.pdf"
    file.save(os.path.join(UPLOAD_DIR, stored))
    return None, (stored, filename)


@app.post("/api/submissions/<int:sid>/pdf")
def upload_pdf(sid):
    e, res = handle_upload(sid, "file", "paper")
    if e:
        return e
    stored, original = res
    conn = get_conn()
    final_name = f"paper_{sid}.pdf"
    os.replace(os.path.join(UPLOAD_DIR, stored), os.path.join(UPLOAD_DIR, final_name))
    conn.execute("UPDATE submissions SET pdf_filename=?, updated_at=? WHERE id=?",
                 (final_name, database.now(), sid))
    user = current_user()
    database.log(conn, user["id"], "pdf_upload", f"#{sid} {original}")
    conn.commit()
    s = settings_payload(conn)
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    return jsonify({"submission": submission_detail(conn, sub, user, s)})


@app.get("/api/submissions/<int:sid>/pdf")
def download_pdf(sid):
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    if not sub or not sub["pdf_filename"]:
        return err("No PDF for this submission", 404)
    if not (is_chair(user) or is_submission_author(conn, sub, user)
            or conn.execute("SELECT 1 FROM assignments WHERE submission_id=? AND reviewer_id=?",
                            (sid, user["id"])).fetchone()):
        return err("Not allowed", 403)
    path = os.path.join(UPLOAD_DIR, sub["pdf_filename"])
    if not os.path.exists(path):
        return err("File missing on server", 404)
    return Response(
        open(path, "rb").read(),
        mimetype="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{sub["pdf_filename"]}"'},
    )


@app.post("/api/submissions/<int:sid>/camera-ready")
def camera_ready(sid):
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    if not sub:
        return err("Submission not found", 404)
    if not (is_chair(user) or is_submission_author(conn, sub, user)):
        return err("Not allowed", 403)
    if not s.get("camera_ready_open") and not is_chair(user):
        return err("Camera-ready upload is closed", 403)
    if sub["decision"] not in ("accept", "accept_poster") and not is_chair(user):
        return err("Camera-ready is only available for accepted papers", 403)
    note = (request.form.get("note") or (request.get_json(silent=True) or {}).get("note") or "").strip()
    file = request.files.get("file")
    stored = f"camera_{sid}.pdf"
    if file and file.filename:
        filename = secure_filename(file.filename)
        if not filename.lower().endswith(".pdf"):
            return err("Only PDF files are accepted")
        file.save(os.path.join(UPLOAD_DIR, stored))
    elif not sub["camera_ready_filename"]:
        return err("No file uploaded")
    conn.execute(
        "UPDATE submissions SET camera_ready_filename=?, camera_ready_note=?, updated_at=? WHERE id=?",
        (stored, note, database.now(), sid),
    )
    database.log(conn, user["id"], "camera_ready_upload", f"#{sid}")
    conn.commit()
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    return jsonify({"submission": submission_detail(conn, sub, user, settings_payload(conn))})


@app.get("/api/submissions/<int:sid>/camera-ready")
def download_camera_ready(sid):
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    if not sub or not sub["camera_ready_filename"]:
        return err("No camera-ready file", 404)
    if not (is_chair(user) or is_submission_author(conn, sub, user)):
        return err("Not allowed", 403)
    path = os.path.join(UPLOAD_DIR, sub["camera_ready_filename"])
    if not os.path.exists(path):
        return err("File missing on server", 404)
    return Response(open(path, "rb").read(), mimetype="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="camera_ready_{sid}.pdf"'})


@app.post("/api/submissions/<int:sid>/comments")
def add_comment(sid):
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    if not sub:
        return err("Submission not found", 404)
    author_side = is_submission_author(conn, sub, user) or is_chair(user)
    reviewer_side = conn.execute(
        "SELECT 1 FROM assignments WHERE submission_id=? AND reviewer_id=?", (sid, user["id"])
    ).fetchone() is not None
    if not (author_side or reviewer_side):
        return err("Not allowed", 403)
    data = request.get_json(silent=True) or {}
    body = (data.get("body") or "").strip()
    if not body:
        return err("Comment body is required")
    visibility = data.get("visibility")
    if visibility not in ("authors", "reviewers", "everyone"):
        visibility = "authors" if author_side else "reviewers"
    conn.execute(
        "INSERT INTO comments(submission_id, user_id, body, visibility, created_at) VALUES (?,?,?,?,?)",
        (sid, user["id"], body, visibility, database.now()),
    )
    database.log(conn, user["id"], "comment", f"#{sid}")
    conn.commit()
    return jsonify({"comments": comments_for(conn, sub, user, s)})


# ------------------------------------------------------------------ reviewer

@app.get("/api/reviewer/queue")
def reviewer_queue():
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    rows = conn.execute(
        "SELECT sub.* FROM assignments a JOIN submissions sub ON sub.id=a.submission_id "
        "WHERE a.reviewer_id=? ORDER BY sub.id",
        (user["id"],),
    ).fetchall()
    queue = []
    for sub in rows:
        rev = conn.execute(
            "SELECT * FROM reviews WHERE submission_id=? AND reviewer_id=?",
            (sub["id"], user["id"]),
        ).fetchone()
        queue.append({
            "submission": submission_detail(conn, sub, user, s),
            "my_review": dict(rev) if rev else None,
        })
    return jsonify({"queue": queue, "settings": s})


@app.get("/api/reviewer/bids")
def get_bids():
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    rows = conn.execute(
        "SELECT b.submission_id, b.score FROM bids b WHERE b.reviewer_id=?", (user["id"],)
    ).fetchall()
    return jsonify({"bids": {str(r["submission_id"]): r["score"] for r in rows}})


@app.get("/api/reviewer/all-papers")
def reviewer_all_papers():
    """Papers available for bidding: active, non-conflicted (reviewer is not an author)."""
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    out = []
    for sub in conn.execute("SELECT * FROM submissions WHERE status='submitted' ORDER BY id"):
        conflict = conn.execute(
            "SELECT 1 FROM submission_authors WHERE submission_id=? AND lower(email)=lower(?)",
            (sub["id"], user["email"]),
        ).fetchone()
        if conflict or sub["submitted_by"] == user["id"]:
            continue
        authors = submission_authors(conn, sub["id"])
        out.append({
            "id": sub["id"],
            "title": sub["title"],
            "abstract": sub["abstract"],
            "topics": json.loads(sub["topics"] or "[]"),
            "authors": [{"name": a["name"]} for a in authors],
        })
    return jsonify({"papers": out})


@app.put("/api/reviewer/bids")
def put_bids():
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    if not s.get("bidding_open") and not is_chair(user):
        return err("Bidding is closed", 403)
    data = request.get_json(silent=True) or {}
    bids = data.get("bids") or {}
    for sid, score in bids.items():
        try:
            sid_i, score_i = int(sid), int(score)
        except (TypeError, ValueError):
            continue
        if score_i not in (-1, 0, 1, 2):
            continue
        if score_i == -1:
            conn.execute(
                "DELETE FROM assignments WHERE submission_id=? AND reviewer_id=?", (sid_i, user["id"])
            )
        conn.execute(
            "INSERT INTO bids(submission_id, reviewer_id, score) VALUES (?,?,?) "
            "ON CONFLICT(submission_id, reviewer_id) DO UPDATE SET score=excluded.score",
            (sid_i, user["id"], score_i),
        )
    database.log(conn, user["id"], "bids_update", f"{len(bids)} papers")
    conn.commit()
    return jsonify({"ok": True})


@app.put("/api/reviewer/reviews/<int:sid>")
def upsert_review(sid):
    user, e = require_user()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    if not s.get("reviewing_open") and not is_chair(user):
        return err("Reviewing is closed", 403)
    assigned = conn.execute(
        "SELECT 1 FROM assignments WHERE submission_id=? AND reviewer_id=?", (sid, user["id"])
    ).fetchone()
    if not assigned and not is_chair(user):
        return err("You are not assigned to this submission", 403)
    data = request.get_json(silent=True) or {}
    state = data.get("state") or "draft"
    if state not in ("draft", "submitted"):
        state = "draft"
    fields = {
        "soundness": int(data.get("soundness") or 0),
        "presentation": int(data.get("presentation") or 0),
        "contribution": int(data.get("contribution") or 0),
        "overall": int(data.get("overall") or 0),
        "confidence": int(data.get("confidence") or 0),
        "strengths": (data.get("strengths") or "").strip(),
        "weaknesses": (data.get("weaknesses") or "").strip(),
        "questions": (data.get("questions") or "").strip(),
    }
    if state == "submitted":
        if not (1 <= fields["overall"] <= 7):
            return err("Overall score (1-7) is required to submit a review")
        if not fields["strengths"] or not fields["weaknesses"]:
            return err("Strengths and weaknesses are required to submit a review")
    existing = conn.execute(
        "SELECT * FROM reviews WHERE submission_id=? AND reviewer_id=?", (sid, user["id"])
    ).fetchone()
    if existing:
        conn.execute(
            "UPDATE reviews SET soundness=?, presentation=?, contribution=?, overall=?, confidence=?,"
            " strengths=?, weaknesses=?, questions=?, state=?, updated_at=? WHERE id=?",
            (fields["soundness"], fields["presentation"], fields["contribution"], fields["overall"],
             fields["confidence"], fields["strengths"], fields["weaknesses"], fields["questions"],
             state, database.now(), existing["id"]),
        )
    else:
        conn.execute(
            "INSERT INTO reviews(submission_id, reviewer_id, soundness, presentation, contribution,"
            " overall, confidence, strengths, weaknesses, questions, state, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, user["id"], fields["soundness"], fields["presentation"], fields["contribution"],
             fields["overall"], fields["confidence"], fields["strengths"], fields["weaknesses"],
             fields["questions"], state, database.now(), database.now()),
        )
    database.log(conn, user["id"], f"review_{state}", f"#{sid}")
    conn.commit()
    rev = conn.execute(
        "SELECT * FROM reviews WHERE submission_id=? AND reviewer_id=?", (sid, user["id"])
    ).fetchone()
    return jsonify({"review": dict(rev)})


# ------------------------------------------------------------------ chair

@app.get("/api/chair/stats")
def chair_stats():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    total = conn.execute("SELECT COUNT(*) FROM submissions").fetchone()[0]
    active = conn.execute("SELECT COUNT(*) FROM submissions WHERE status='submitted'").fetchone()[0]
    withdrawn = conn.execute("SELECT COUNT(*) FROM submissions WHERE status='withdrawn'").fetchone()[0]
    accepted = conn.execute("SELECT COUNT(*) FROM submissions WHERE decision IN ('accept','accept_poster')").fetchone()[0]
    rejected = conn.execute("SELECT COUNT(*) FROM submissions WHERE decision='reject'").fetchone()[0]
    assigned = conn.execute("SELECT COUNT(*) FROM assignments").fetchone()[0]
    reviews_done = conn.execute("SELECT COUNT(*) FROM reviews WHERE state='submitted'").fetchone()[0]
    reviews_draft = conn.execute("SELECT COUNT(*) FROM reviews WHERE state='draft'").fetchone()[0]
    users = conn.execute("SELECT COUNT(*) FROM users WHERE disabled=0").fetchone()[0]
    reviewers = conn.execute("SELECT COUNT(*) FROM users WHERE roles LIKE '%reviewer%' AND disabled=0").fetchone()[0]
    scores = conn.execute(
        "SELECT overall, COUNT(*) AS n FROM reviews WHERE state='submitted' GROUP BY overall"
    ).fetchall()
    by_topic = conn.execute("SELECT topics, COUNT(*) AS n FROM submissions GROUP BY topics").fetchall()
    topic_counts = {}
    for r in by_topic:
        for t in json.loads(r["topics"] or "[]"):
            topic_counts[t] = topic_counts.get(t, 0) + r["n"]
    missing = conn.execute(
        "SELECT COUNT(*) FROM (SELECT a.submission_id, "
        " (SELECT COUNT(*) FROM reviews r WHERE r.submission_id=a.submission_id AND r.state='submitted') AS done "
        " FROM (SELECT DISTINCT submission_id FROM assignments) a) WHERE done = 0"
    ).fetchone()[0]
    return jsonify({
        "stats": {
            "total_submissions": total,
            "active_submissions": active,
            "withdrawn": withdrawn,
            "accepted": accepted,
            "rejected": rejected,
            "undecided": active - accepted - rejected,
            "assignments": assigned,
            "reviews_submitted": reviews_done,
            "reviews_draft": reviews_draft,
            "users": users,
            "reviewers": reviewers,
            "score_distribution": {str(r["overall"]): r["n"] for r in scores},
            "topic_counts": topic_counts,
            "papers_without_reviews": missing,
            "acceptance_rate": round(100 * accepted / (accepted + rejected), 1) if (accepted + rejected) else 0,
        }
    })


@app.get("/api/chair/submissions")
def chair_submissions():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    rows = conn.execute("SELECT * FROM submissions ORDER BY id").fetchall()
    out = []
    for sub in rows:
        detail = submission_detail(conn, sub, user, s)
        revs = conn.execute(
            "SELECT r.*, u.name AS reviewer_name FROM reviews r JOIN users u ON u.id=r.reviewer_id "
            "WHERE r.submission_id=?",
            (sub["id"],),
        ).fetchall()
        assigns = conn.execute(
            "SELECT a.*, u.name AS reviewer_name FROM assignments a JOIN users u ON u.id=a.reviewer_id "
            "WHERE a.submission_id=?",
            (sub["id"],),
        ).fetchall()
        scored = [r["overall"] for r in revs if r["state"] == "submitted" and r["overall"]]
        detail["reviewers"] = [
            {"id": a["id"], "name": a["reviewer_name"], "reviewer_id": a["reviewer_id"],
             "review_state": next((r["state"] for r in revs if r["reviewer_id"] == a["reviewer_id"]), "none")}
            for a in assigns
        ]
        detail["avg_score"] = round(sum(scored) / len(scored), 2) if scored else None
        out.append(detail)
    return jsonify({"submissions": out, "settings": s})


@app.put("/api/chair/settings")
def chair_settings():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    data = request.get_json(silent=True) or {}
    allowed = set(database.DEFAULT_SETTINGS.keys())
    updates = {k: v for k, v in data.items() if k in allowed}
    for k in ("submissions_open", "reviewing_open", "bidding_open", "camera_ready_open",
              "reviews_visible", "decisions_released", "blind_reviewing", "author_see_reviewer_names",
              "max_papers_per_author", "reviews_per_paper"):
        if k in updates:
            updates[k] = int(updates[k])
    database.set_settings(conn, updates)
    database.log(conn, user["id"], "settings_update", ", ".join(updates.keys()))
    conn.commit()
    return jsonify({"settings": settings_payload(conn)})


@app.get("/api/chair/users")
def chair_users():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    rows = conn.execute("SELECT * FROM users ORDER BY name").fetchall()
    out = []
    for r in rows:
        item = user_public(r)
        item["stats"] = {
            "submissions": conn.execute(
                "SELECT COUNT(*) FROM submissions WHERE submitted_by=?", (r["id"],)
            ).fetchone()[0],
            "assignments": conn.execute(
                "SELECT COUNT(*) FROM assignments WHERE reviewer_id=?", (r["id"],)
            ).fetchone()[0],
            "reviews_done": conn.execute(
                "SELECT COUNT(*) FROM reviews WHERE reviewer_id=? AND state='submitted'", (r["id"],)
            ).fetchone()[0],
        }
        out.append(item)
    return jsonify({"users": out})


@app.post("/api/chair/users")
def chair_create_user():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    name = (data.get("name") or "").strip()
    password = data.get("password") or "welcome123"
    roles = data.get("roles") or ["author"]
    roles = [r for r in roles if r in ("chair", "reviewer", "author")] or ["author"]
    affiliation = (data.get("affiliation") or "").strip()
    if not re.match(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return err("A valid email is required")
    if not name:
        return err("Name is required")
    if conn.execute("SELECT 1 FROM users WHERE lower(email)=?", (email,)).fetchone():
        return err("That email already exists", 409)
    cur = conn.execute(
        "INSERT INTO users(email, name, password_hash, affiliation, roles, disabled, created_at) VALUES (?,?,?,?,?,0,?)",
        (email, name, database.hash_password(password), affiliation, json.dumps(roles), database.now()),
    )
    uid = cur.lastrowid
    database.send_mail(conn, email, f"Welcome to {database.DEFAULT_SETTINGS['conference_name']}",
                       f"An account has been created for you. Login: {email} / {password}")
    database.notify(conn, uid, "Account created", "A chair created your account. Welcome!")
    database.log(conn, user["id"], "user_create", email)
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return jsonify({"user": user_public(row)}), 201


@app.put("/api/chair/users/<int:uid>")
def chair_update_user(uid):
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not row:
        return err("User not found", 404)
    data = request.get_json(silent=True) or {}
    roles = data.get("roles")
    if roles is not None:
        roles = [r for r in roles if r in ("chair", "reviewer", "author")]
        if not roles:
            roles = ["author"]
        conn.execute("UPDATE users SET roles=? WHERE id=?", (json.dumps(roles), uid))
    if "disabled" in data:
        conn.execute("UPDATE users SET disabled=? WHERE id=?", (1 if data["disabled"] else 0, uid))
    if data.get("password"):
        conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                     (database.hash_password(data["password"]), uid))
        database.send_mail(conn, row["email"], "Password reset",
                           f"Your new password is: {data['password']}")
    database.log(conn, user["id"], "user_update", row["email"])
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return jsonify({"user": user_public(row)})


@app.post("/api/chair/assign/auto")
def chair_auto_assign():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    target = int(s.get("reviews_per_paper", 3))
    reviewers = conn.execute(
        "SELECT * FROM users WHERE disabled=0 AND roles LIKE '%reviewer%'"
    ).fetchall()
    if not reviewers:
        return err("No reviewers available")
    loads = {r["id"]: 0 for r in reviewers}
    for a in conn.execute("SELECT reviewer_id, COUNT(*) AS n FROM assignments GROUP BY reviewer_id"):
        if a["reviewer_id"] in loads:
            loads[a["reviewer_id"]] = a["n"]
    bid_map = {}
    for b in conn.execute("SELECT * FROM bids"):
        bid_map[(b["submission_id"], b["reviewer_id"])] = b["score"]
    author_emails = {}
    for a in conn.execute("SELECT submission_id, lower(email) AS em FROM submission_authors"):
        author_emails.setdefault(a["submission_id"], set()).add(a["em"])
    subs = conn.execute(
        "SELECT id FROM submissions WHERE status='submitted' ORDER BY id"
    ).fetchall()
    added = 0
    for sub in subs:
        sid = sub["id"]
        existing = {
            r["reviewer_id"]
            for r in conn.execute("SELECT reviewer_id FROM assignments WHERE submission_id=?", (sid,))
        }
        candidates = []
        for r in reviewers:
            rid = r["id"]
            if rid in existing:
                continue
            if r["email"].lower() in author_emails.get(sid, set()):
                continue  # conflict of interest
            if bid_map.get((sid, rid)) == -1:
                continue
            bid = bid_map.get((sid, rid), 0)
            candidates.append((bid, -loads[rid], -rid, rid))
        candidates.sort(reverse=True)
        need = target - len(existing)
        for _, _, _, rid in candidates[:max(0, need)]:
            conn.execute(
                "INSERT OR IGNORE INTO assignments(submission_id, reviewer_id, assigned_by, created_at) VALUES (?,?,?,?)",
                (sid, rid, user["id"], database.now()),
            )
            loads[rid] += 1
            added += 1
            database.notify(conn, rid, "Reviewing assignment",
                            f"You have been assigned paper #{sid} ({s['conference_name']}). "
                            f"Reviews are due {s['review_deadline']}.")
    database.log(conn, user["id"], "assign_auto", f"{added} assignments added")
    conn.commit()
    return jsonify({"added": added, "target_per_paper": target})


@app.post("/api/chair/assign")
def chair_assign_one():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    data = request.get_json(silent=True) or {}
    sid, rid = data.get("submission_id"), data.get("reviewer_id")
    if not sid or not rid:
        return err("submission_id and reviewer_id are required")
    if not conn.execute("SELECT 1 FROM submissions WHERE id=?", (sid,)).fetchone():
        return err("Submission not found", 404)
    if not conn.execute("SELECT 1 FROM users WHERE id=?", (rid,)).fetchone():
        return err("Reviewer not found", 404)
    conn.execute(
        "INSERT OR IGNORE INTO assignments(submission_id, reviewer_id, assigned_by, created_at) VALUES (?,?,?,?)",
        (sid, rid, user["id"], database.now()),
    )
    database.log(conn, user["id"], "assign_manual", f"#{sid} -> user {rid}")
    conn.commit()
    return jsonify({"ok": True})


@app.delete("/api/chair/assign")
def chair_unassign():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    data = request.get_json(silent=True) or {}
    sid, rid = data.get("submission_id"), data.get("reviewer_id")
    conn.execute("DELETE FROM assignments WHERE submission_id=? AND reviewer_id=?", (sid, rid))
    database.log(conn, user["id"], "unassign", f"#{sid} -> user {rid}")
    conn.commit()
    return jsonify({"ok": True})


@app.post("/api/chair/decide")
def chair_decide():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    data = request.get_json(silent=True) or {}
    decisions = data.get("decisions") or []
    if not decisions:
        return err("No decisions supplied")
    valid = ("accept", "accept_poster", "reject", "")
    changed = 0
    for d in decisions:
        sid = d.get("id")
        dec = d.get("decision", "")
        comment = (d.get("comment") or "").strip()
        if dec not in valid:
            continue
        sub = conn.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
        if not sub:
            continue
        conn.execute(
            "UPDATE submissions SET decision=?, decision_comment=?, updated_at=? WHERE id=?",
            (dec, comment, database.now(), sid),
        )
        changed += 1
        if dec:
            label = {"accept": "accepted", "accept_poster": "accepted as poster", "reject": "not accepted"}[dec]
            database.notify(conn, sub["submitted_by"], f"Decision on paper #{sid}",
                            f"Your paper '{sub['title'][:60]}…' has been {label}." +
                            (f" Comment: {comment}" if comment else ""))
            row = conn.execute("SELECT email FROM users WHERE id=?", (sub["submitted_by"],)).fetchone()
            if row:
                database.send_mail(conn, row["email"], f"Decision on paper #{sid}",
                                   f"Your paper has been {label}." + (f"\n\n{comment}" if comment else ""))
    database.log(conn, user["id"], "decisions", f"{changed} papers updated")
    conn.commit()
    return jsonify({"updated": changed})


@app.post("/api/chair/release")
def chair_release():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    data = request.get_json(silent=True) or {}
    what = data.get("what")
    value = 1 if data.get("value") else 0
    if what not in ("reviews_visible", "decisions_released", "submissions_open",
                    "reviewing_open", "bidding_open", "camera_ready_open"):
        return err("Unknown release flag")
    database.set_settings(conn, {what: value})
    database.log(conn, user["id"], "release", f"{what}={value}")
    conn.commit()
    return jsonify({"settings": settings_payload(conn)})


@app.post("/api/chair/notify")
def chair_notify():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    data = request.get_json(silent=True) or {}
    audience = data.get("audience") or "all"
    subject = (data.get("subject") or "Message from the program chairs").strip()
    body = (data.get("body") or "").strip()
    if not body:
        return err("Message body is required")
    targets = []
    if audience == "authors":
        targets = conn.execute(
            "SELECT DISTINCT u.* FROM users u JOIN submissions s ON s.submitted_by=u.id"
        ).fetchall()
    elif audience == "reviewers":
        targets = conn.execute(
            "SELECT * FROM users WHERE roles LIKE '%reviewer%' AND disabled=0"
        ).fetchall()
    elif audience == "accepted":
        targets = conn.execute(
            "SELECT DISTINCT u.* FROM users u JOIN submissions s ON s.submitted_by=u.id "
            "WHERE s.decision IN ('accept','accept_poster')"
        ).fetchall()
    else:
        targets = conn.execute("SELECT * FROM users WHERE disabled=0").fetchall()
    for t in targets:
        database.notify(conn, t["id"], subject, body)
        database.send_mail(conn, t["email"], subject, body)
    database.log(conn, user["id"], "notify", f"{audience}: {len(targets)} recipients")
    conn.commit()
    return jsonify({"sent": len(targets)})


@app.get("/api/chair/outbox")
def chair_outbox():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    rows = conn.execute("SELECT * FROM outbox ORDER BY id DESC LIMIT 200").fetchall()
    return jsonify({"outbox": [dict(r) for r in rows]})


@app.get("/api/chair/audit")
def chair_audit():
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    rows = conn.execute(
        "SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id "
        "ORDER BY a.id DESC LIMIT 300"
    ).fetchall()
    return jsonify({"log": [dict(r) for r in rows]})


@app.get("/api/chair/export/<kind>")
def chair_export(kind):
    user, e = require_chair()
    if e:
        return e
    conn = get_conn()
    s = settings_payload(conn)
    if kind == "submissions.csv":
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["id", "title", "status", "decision", "topics", "authors", "emails",
                    "reviews_submitted", "avg_overall", "created_at"])
        for sub in conn.execute("SELECT * FROM submissions ORDER BY id"):
            revs = conn.execute(
                "SELECT overall FROM reviews WHERE submission_id=? AND state='submitted'", (sub["id"],)
            ).fetchall()
            scored = [r["overall"] for r in revs if r["overall"]]
            authors = submission_authors(conn, sub["id"])
            w.writerow([
                sub["id"], sub["title"], sub["status"], sub["decision"],
                "; ".join(json.loads(sub["topics"] or "[]")),
                "; ".join(a["name"] for a in authors),
                "; ".join(a["email"] for a in authors),
                len(scored), round(sum(scored) / len(scored), 2) if scored else "",
                sub["created_at"],
            ])
        return Response(out.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": "attachment; filename=submissions.csv"})
    if kind == "reviews.csv":
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["submission_id", "title", "reviewer", "state", "overall", "confidence",
                    "soundness", "presentation", "contribution"])
        for r in conn.execute(
            "SELECT r.*, s.title, u.name FROM reviews r JOIN submissions s ON s.id=r.submission_id "
            "JOIN users u ON u.id=r.reviewer_id ORDER BY r.submission_id"
        ):
            w.writerow([r["submission_id"], r["title"], r["name"], r["state"], r["overall"],
                        r["confidence"], r["soundness"], r["presentation"], r["contribution"]])
        return Response(out.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": "attachment; filename=reviews.csv"})
    if kind == "users.csv":
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["id", "name", "email", "affiliation", "roles", "disabled"])
        for u in conn.execute("SELECT * FROM users ORDER BY id"):
            w.writerow([u["id"], u["name"], u["email"], u["affiliation"], u["roles"], u["disabled"]])
        return Response(out.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": "attachment; filename=users.csv"})
    if kind == "all.json":
        dump = {
            "settings": s,
            "users": [user_public(u) for u in conn.execute("SELECT * FROM users")],
            "submissions": [
                submission_detail(conn, sub, user, s)
                for sub in conn.execute("SELECT * FROM submissions")
            ],
            "assignments": [dict(r) for r in conn.execute("SELECT * FROM assignments")],
            "bids": [dict(r) for r in conn.execute("SELECT * FROM bids")],
            "reviews": [dict(r) for r in conn.execute("SELECT * FROM reviews")],
            "comments": [dict(r) for r in conn.execute("SELECT * FROM comments")],
            "audit_log": [dict(r) for r in conn.execute("SELECT * FROM audit_log")],
        }
        return Response(json.dumps(dump, indent=2), mimetype="application/json",
                        headers={"Content-Disposition": "attachment; filename=conference_dump.json"})
    return err("Unknown export kind", 404)


# ------------------------------------------------------------------ static

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/favicon.ico")
def favicon():
    return Response("", status=204)


# Ensure the schema + demo seed exist whenever the module is imported, so the
# app works under gunicorn/uvicorn (Render) as well as `python3 app.py`.
database.init_db()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=False)
