"""Database layer for the Conference Management Toolkit.

SQLite storage, schema bootstrap, and rich demo seeding.
"""
import hashlib
import json
import os
import random
import smtplib
import sqlite3
from datetime import datetime, timezone
from email.message import EmailMessage

try:  # POSIX file locking (Linux/macOS). Not available on Windows.
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _pick_data_dir():
    """Where to keep conference.db and uploads/.

    Honours $DATA_DIR (e.g. a Render disk mounted at /var/data) but falls back
    to the project folder if that path is missing or not writable, so a bad
    DATA_DIR can never crash the app on boot.
    """
    candidates = []
    if os.environ.get("DATA_DIR"):
        candidates.append(os.environ["DATA_DIR"])
    candidates.append(BASE_DIR)
    for path in candidates:
        try:
            os.makedirs(path, exist_ok=True)
            probe = os.path.join(path, ".write_test")
            with open(probe, "w") as fh:
                fh.write("ok")
            os.remove(probe)
            return path
        except OSError:
            continue
    return BASE_DIR


DATA_DIR = _pick_data_dir()
DB_PATH = os.path.join(DATA_DIR, "conference.db")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    affiliation TEXT DEFAULT '',
    roles TEXT DEFAULT '["author"]',   -- JSON array: chair / reviewer / author
    disabled INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    abstract TEXT NOT NULL,
    topics TEXT DEFAULT '[]',
    track TEXT DEFAULT 'Main',
    status TEXT DEFAULT 'submitted',      -- submitted | withdrawn | desk_rejected
    decision TEXT DEFAULT '',             -- '' | accept | accept_poster | reject
    decision_comment TEXT DEFAULT '',
    submitted_by INTEGER NOT NULL,
    pdf_filename TEXT DEFAULT '',
    paper_text TEXT DEFAULT '',
    camera_ready_filename TEXT DEFAULT '',
    camera_ready_note TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submission_authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    affiliation TEXT DEFAULT '',
    position INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    reviewer_id INTEGER NOT NULL,
    assigned_by INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE(submission_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    reviewer_id INTEGER NOT NULL,
    score INTEGER DEFAULT 0,              -- 2=want, 1=maybe, 0=none, -1=conflict
    UNIQUE(submission_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    reviewer_id INTEGER NOT NULL,
    soundness INTEGER DEFAULT 0,
    presentation INTEGER DEFAULT 0,
    contribution INTEGER DEFAULT 0,
    overall INTEGER DEFAULT 0,
    confidence INTEGER DEFAULT 0,
    strengths TEXT DEFAULT '',
    weaknesses TEXT DEFAULT '',
    questions TEXT DEFAULT '',
    state TEXT DEFAULT 'draft',           -- draft | submitted
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(submission_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    visibility TEXT DEFAULT 'reviewers',  -- authors | reviewers | everyone
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- delivery: 'sent' (real SMTP), 'simulated' (no SMTP configured), 'failed'
    delivery TEXT DEFAULT 'simulated',
    delivery_detail TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT DEFAULT '',
    created_at TEXT NOT NULL
);
"""


# ---------------------------------------------------------------- helpers

def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hash_password(password: str, salt: str | None = None) -> str:
    if salt is None:
        salt = os.urandom(16).hex()
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), 120_000
    ).hex()
    return f"{salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, digest = stored.split("$", 1)
    except ValueError:
        return False
    check = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), 120_000
    ).hex()
    return check == digest


def get_db() -> sqlite3.Connection:
    # timeout: wait rather than fail instantly when a concurrent request holds
    # the write lock (multiple gunicorn workers share the same SQLite file).
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def log(conn, user_id, action, detail=""):
    conn.execute(
        "INSERT INTO audit_log(user_id, action, detail, created_at) VALUES (?,?,?,?)",
        (user_id, action, detail, now()),
    )


def notify(conn, user_id, subject, body):
    conn.execute(
        "INSERT INTO notifications(user_id, subject, body, read, created_at) VALUES (?,?,?,?,?)",
        (user_id, subject, body, 0, now()),
    )


# ------------------------------------------------------------------- email
# Every outbound message in the app funnels through send_mail(). By default it
# only records the message in the outbox (the demo behaviour, visible in the
# chair's Announcements page). Set the SMTP_* environment variables below and
# the same calls start delivering real email — no code change needed.
#
#   SMTP_HOST      e.g. smtp.postmarkapp.com / smtp.resend.com / smtp.gmail.com
#   SMTP_PORT      587 (STARTTLS, default) or 465 (SSL)
#   SMTP_USER      SMTP username (also used as the From address if SMTP_FROM unset)
#   SMTP_PASSWORD  SMTP password / API key
#   SMTP_FROM      optional From address, e.g. "CMT 2026 <chairs@myconf.org>"
#   SMTP_TLS       optional: starttls | ssl | none  (default: auto by port)
#   MAIL_DISABLED  set to 1 to force outbox-only even with SMTP configured
#
# Note: this sends synchronously, and a failed send never breaks the request —
# the message is still recorded in the outbox with a delivery status.


def smtp_configured() -> bool:
    return bool(os.environ.get("SMTP_HOST")) and os.environ.get("MAIL_DISABLED", "0") != "1"


def _deliver(to_email: str, subject: str, body: str):
    """Return (delivery, detail) for one message."""
    if os.environ.get("MAIL_DISABLED", "0") == "1":
        return "simulated", "MAIL_DISABLED=1"
    host = os.environ.get("SMTP_HOST")
    if not host:
        return "simulated", "no SMTP_HOST configured (outbox only)"
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASSWORD", "")
    sender = os.environ.get("SMTP_FROM") or user or f"noreply@{host}"
    mode = (os.environ.get("SMTP_TLS") or "").lower() or ("ssl" if port == 465 else "starttls")
    try:
        if mode == "ssl":
            server = smtplib.SMTP_SSL(host, port, timeout=20)
        else:
            server = smtplib.SMTP(host, port, timeout=20)
        with server:
            if mode == "starttls":
                server.ehlo()
                server.starttls()
                server.ehlo()
            if user:
                server.login(user, password)
            msg = EmailMessage()
            msg["From"] = sender
            msg["To"] = to_email
            msg["Subject"] = subject
            msg.set_content(body)
            server.send_message(msg)
        return "sent", f"{host}:{port}"
    except Exception as exc:  # never break the request because email failed
        return "failed", f"{type(exc).__name__}: {exc}"


def send_mail(conn, to_email, subject, body):
    delivery, detail = _deliver(to_email, subject, body)
    conn.execute(
        "INSERT INTO outbox(to_email, subject, body, created_at, delivery, delivery_detail)"
        " VALUES (?,?,?,?,?,?)",
        (to_email, subject, body, now(), delivery, detail),
    )


# ---------------------------------------------------------------- settings

DEFAULT_SETTINGS = {
    "conference_name": "AICON 2026",
    "conference_short": "AICON",
    "conference_description": (
        "International Conference on Advances in Intelligent Computing. "
        "Submit your research, bid for papers you want to review, and follow "
        "every step of the review pipeline from one workspace."
    ),
    "submission_deadline": "2026-11-01T23:59",
    "review_deadline": "2026-11-25T23:59",
    "rebuttal_deadline": "2026-12-05T23:59",
    "decision_deadline": "2026-12-15T23:59",
    "camera_ready_deadline": "2027-01-10T23:59",
    "submissions_open": 1,
    "reviewing_open": 1,
    "bidding_open": 1,
    "camera_ready_open": 1,
    "reviews_visible": 1,
    "decisions_released": 1,
    "blind_reviewing": 1,
    "author_see_reviewer_names": 0,
    "max_papers_per_author": 6,
    "reviews_per_paper": 3,
    "topics": [
        "Natural Language Processing",
        "Computer Vision",
        "Reinforcement Learning",
        "Trustworthy ML",
        "ML Systems",
        "Theory",
        "Graph Learning",
        "Healthcare ML",
    ],
    "review_scale": {
        "overall": ["Strong reject", "Reject", "Weak reject", "Borderline", "Weak accept", "Accept", "Strong accept"],
        "confidence": ["None", "Low", "Medium", "High", "Expert"],
    },
}


def get_settings(conn) -> dict:
    out = dict(DEFAULT_SETTINGS)
    for row in conn.execute("SELECT key, value FROM settings"):
        try:
            out[row["key"]] = json.loads(row["value"])
        except (json.JSONDecodeError, TypeError):
            out[row["key"]] = row["value"]
    return out


def set_settings(conn, updates: dict):
    for k, v in updates.items():
        conn.execute(
            "INSERT INTO settings(key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (k, json.dumps(v)),
        )


# ---------------------------------------------------------------- bootstrap

def _migrate(conn):
    """Add columns introduced after the first release to existing databases."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(outbox)")}
    if "delivery" not in cols:
        conn.execute("ALTER TABLE outbox ADD COLUMN delivery TEXT DEFAULT 'simulated'")
    if "delivery_detail" not in cols:
        conn.execute("ALTER TABLE outbox ADD COLUMN delivery_detail TEXT DEFAULT ''")


def _production_settings():
    """Neutral starting settings for a real conference (no demo data).

    Safe by default: nothing is released to authors, decisions stay private
    until a chair publishes them, and deadlines start empty so the chair must
    set them deliberately. Override the name with CONFERENCE_NAME / _SHORT.
    """
    defaults = dict(DEFAULT_SETTINGS)
    defaults.update({
        "conference_name": os.environ.get("CONFERENCE_NAME", "My Conference"),
        "conference_short": os.environ.get("CONFERENCE_SHORT", "CONF"),
        "conference_description": "",
        "submission_deadline": "",
        "review_deadline": "",
        "rebuttal_deadline": "",
        "decision_deadline": "",
        "camera_ready_deadline": "",
        # Private until the chair publishes them:
        "reviews_visible": 0,
        "decisions_released": 0,
        "submissions_open": 1,
        "reviewing_open": 1,
        "bidding_open": 1,
        "camera_ready_open": 0,
    })
    return defaults


def _create_admin(conn) -> bool:
    """Create the first chair account from ADMIN_EMAIL / ADMIN_PASSWORD."""
    email = (os.environ.get("ADMIN_EMAIL") or "").strip().lower()
    password = os.environ.get("ADMIN_PASSWORD") or ""
    name = (os.environ.get("ADMIN_NAME") or "Conference Chair").strip()
    if not email or not password:
        return False
    conn.execute(
        "INSERT INTO users(email, name, password_hash, affiliation, roles, disabled, created_at)"
        " VALUES (?,?,?,?,?,0,?)",
        (email, name, hash_password(password), os.environ.get("ADMIN_AFFILIATION", ""),
         json.dumps(["chair", "author", "reviewer"]), now()),
    )
    conn.execute(
        "INSERT INTO audit_log(user_id, action, detail, created_at) VALUES (?,?,?,?)",
        (conn.execute("SELECT id FROM users WHERE lower(email)=?", (email,)).fetchone()["id"],
         "bootstrap", f"initial chair account created for {email}", now()),
    )
    return True


def _bootstrap():
    """Create the schema, then either seed demo data or start clean."""
    conn = get_db()
    conn.executescript(SCHEMA)
    _migrate(conn)

    has_users = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] > 0
    has_settings = conn.execute("SELECT 1 FROM settings LIMIT 1").fetchone() is not None

    if not has_users:
        if os.environ.get("SEED_DEMO", "1") != "0":
            seed_demo(conn)                      # demo conference (default)
            print("[cmt] seeded demo conference — set SEED_DEMO=0 for a clean start")
        else:
            set_settings(conn, _production_settings())
            if _create_admin(conn):
                print(f"[cmt] created chair account for {os.environ['ADMIN_EMAIL']}")
            else:
                print("[cmt] empty database — the first account to register becomes chair")
    elif not has_settings:
        # pre-existing database without settings rows
        set_settings(conn, DEFAULT_SETTINGS)

    conn.commit()
    conn.close()


def init_db():
    """Initialise the database. Safe to call from several processes at once.

    Production servers (gunicorn on Fly/Render, for example) boot multiple
    workers in parallel, and each one imports the app. Without a lock they would
    race to create the schema and seed the data, one of them losing with a
    UNIQUE constraint error and failing to boot. An exclusive file lock makes
    the first worker do the work and the rest wait, re-check, and move on.
    """
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    if fcntl is None:
        _bootstrap()
        return
    lock_path = os.path.join(DATA_DIR, ".init.lock")
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            _bootstrap()
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def _user(conn, email, name, roles, affiliation=""):
    pwd = hash_password("demo123")
    cur = conn.execute(
        "INSERT INTO users(email, name, password_hash, affiliation, roles, disabled, created_at) "
        "VALUES (?,?,?,?,?,0,?)",
        (email, name, pwd, affiliation, json.dumps(roles), now()),
    )
    return cur.lastrowid


def seed_demo(conn):
    """Populate a lively demo conference so every screen has content."""
    rng = random.Random(42)
    set_settings(conn, DEFAULT_SETTINGS)

    chair = _user(conn, "chair@aicon.demo", "Dr. Meera Raghavan",
                  ["chair", "author", "reviewer"], "IIT Jammu")
    authors = {
        "priya": _user(conn, "priya@aicon.demo", "Priya Sharma", ["author", "reviewer"], "IIT Delhi"),
        "arjun": _user(conn, "arjun@aicon.demo", "Arjun Mehta", ["author"], "TCS Research"),
        "sarah": _user(conn, "sarah@aicon.demo", "Sarah Chen", ["author", "reviewer"], "NUS Singapore"),
        "david": _user(conn, "david@aicon.demo", "David Okafor", ["author"], "University of Lagos"),
        "lin":   _user(conn, "lin@aicon.demo", "Lin Zhang", ["author"], "Tsinghua University"),
    }
    reviewers = {
        "r1": _user(conn, "rev1@aicon.demo", "Dr. Aisha Khan", ["reviewer"], "IIIT Hyderabad"),
        "r2": _user(conn, "rev2@aicon.demo", "Prof. Tom Baker", ["reviewer"], "University of Edinburgh"),
        "r3": _user(conn, "rev3@aicon.demo", "Dr. Elena Petrova", ["reviewer"], "ETH Zürich"),
        "r4": _user(conn, "rev4@aicon.demo", "Dr. Kenji Sato", ["reviewer"], "University of Tokyo"),
        "r5": _user(conn, "rev5@aicon.demo", "Prof. Maria Rossi", ["reviewer"], "Politecnico di Milano"),
        "r6": _user(conn, "rev6@aicon.demo", "Dr. Samuel Adeyemi", ["reviewer"], "Cape Town"),
    }
    all_reviewers = list(reviewers.values()) + [chair, authors["priya"], authors["sarah"]]

    subs = [
        dict(
            title="Sparse Mixture-of-Experts Routing for Low-Resource Neural Machine Translation",
            abstract="We propose a sparse mixture-of-experts routing scheme tailored to low-resource "
                     "machine translation. By conditioning expert selection on typological features of "
                     "the source language, our method improves BLEU by up to 3.1 points across twelve "
                     "low-resource pairs while training 2.4x faster than dense baselines.",
            topics=["Natural Language Processing", "ML Systems"],
            author=("Priya Sharma", "priya@aicon.demo", "IIT Delhi"),
            extra=[("Arjun Mehta", "arjun@aicon.demo", "TCS Research"),
                   ("Dr. Meera Raghavan", "chair@aicon.demo", "IIT Jammu")],
            status="submitted", decision="accept",
            decision_comment="Meta-review: strong empirical results with clear novelty. Congratulations!",
        ),
        dict(
            title="Calibrated Uncertainty Estimation for Deployed Medical Imaging Models",
            abstract="Clinical deployment of imaging models requires reliable uncertainty estimates. "
                     "We introduce a post-hoc calibration method combining temperature scaling with "
                     "conformal prediction, evaluated on five public radiology datasets. Selective "
                     "accuracy at 90% coverage improves by 6.8 points over the best prior method.",
            topics=["Healthcare ML", "Trustworthy ML"],
            author=("Sarah Chen", "sarah@aicon.demo", "NUS Singapore"),
            extra=[("David Okafor", "david@aicon.demo", "University of Lagos")],
            status="submitted", decision="accept_poster",
            decision_comment="Accepted as poster. Please address reviewer calibration baselines in camera-ready.",
        ),
        dict(
            title="Federated Learning under Concept Drift: A Survey and Reproducible Benchmark",
            abstract="Concept drift invalidates federated models silently. This paper surveys 41 "
                     "methods, formalises drift taxonomies for FL, and releases FLU-Bench: a "
                     "reproducible benchmark with eleven drift scenarios and four datasets.",
            topics=["Trustworthy ML", "ML Systems"],
            author=("Arjun Mehta", "arjun@aicon.demo", "TCS Research"),
            extra=[("Lin Zhang", "lin@aicon.demo", "Tsinghua University")],
            status="submitted", decision="reject",
            decision_comment="Meta-review: useful benchmark, but the survey lacks depth in formal analysis. "
                             "We encourage a revised submission with stronger theoretical contributions.",
        ),
        dict(
            title="Token Pruning for Efficient Long-Context Transformers",
            abstract="Long-context transformers are bottlenecked by attention over redundant tokens. "
                     "We present Adaptive Token Pruning (ATP), a training-free method that scores "
                     "tokens by attention entropy and drops up to 70% of the sequence with under 1% "
                     "perplexity degradation on PG-19 and SCROLLS.",
            topics=["Natural Language Processing", "ML Systems"],
            author=("Lin Zhang", "lin@aicon.demo", "Tsinghua University"),
            extra=[("Priya Sharma", "priya@aicon.demo", "IIT Delhi")],
            status="submitted", decision="",
            decision_comment="",
        ),
        dict(
            title="Self-Supervised Graph Learning for Molecular Property Prediction",
            abstract="We propose a multi-view contrastive pretraining objective for molecular graphs "
                     "that aligns 2D topology with 3D conformer views. On MoleculeNet, our approach "
                     "sets new state-of-the-art on three of seven tasks and is robust to scaffold shifts.",
            topics=["Graph Learning", "Healthcare ML"],
            author=("David Okafor", "david@aicon.demo", "University of Lagos"),
            extra=[("Sarah Chen", "sarah@aicon.demo", "NUS Singapore")],
            status="submitted", decision="",
            decision_comment="",
        ),
        dict(
            title="Robust Reinforcement Learning with Constraint-Aware Reward Shaping",
            abstract="Safe RL agents must respect constraints during training and deployment. We "
                     "introduce constraint-aware reward shaping that provably preserves the optimal "
                     "policy while accelerating convergence by 35% on Safety-Gym benchmarks.",
            topics=["Reinforcement Learning", "Theory"],
            author=("Priya Sharma", "priya@aicon.demo", "IIT Delhi"),
            extra=[],
            status="submitted", decision="",
            decision_comment="",
        ),
        dict(
            title="On the Geometry of Loss Surfaces in Deep Ensembles",
            abstract="We characterise connectivity between ensemble modes via loss-surface geometry, "
                     "showing that mode connectivity is predicted by a spectral measure of the Hessian. "
                     "This yields a practical diversity criterion for constructing better ensembles.",
            topics=["Theory", "Trustworthy ML"],
            author=("Dr. Meera Raghavan", "chair@aicon.demo", "IIT Jammu"),
            extra=[("Arjun Mehta", "arjun@aicon.demo", "TCS Research")],
            status="submitted", decision="",
            decision_comment="",
        ),
        dict(
            title="Privacy-Preserving Analytics for Smart City Sensor Streams",
            abstract="We design a streaming analytics architecture combining local differential "
                     "privacy with sketch-based aggregation for city-scale sensor telemetry.",
            topics=["ML Systems", "Trustworthy ML"],
            author=("Sarah Chen", "sarah@aicon.demo", "NUS Singapore"),
            extra=[],
            status="withdrawn", decision="",
            decision_comment="",
        ),
    ]

    sid_map = {}
    for i, s in enumerate(subs, start=1):
        owner_id = _id_by_email(conn, s["author"][1])
        cur = conn.execute(
            "INSERT INTO submissions(title, abstract, topics, track, status, decision, decision_comment,"
            " submitted_by, pdf_filename, paper_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                s["title"], s["abstract"], json.dumps(s["topics"]), "Main",
                s["status"], s["decision"], s["decision_comment"],
                owner_id, f"paper_{i:02d}.pdf", f"[Full text of paper {i} — upload a PDF in production.]",
                now(), now(),
            ),
        )
        sid = cur.lastrowid
        sid_map[i] = sid
        conn.execute(
            "INSERT INTO submission_authors(submission_id, name, email, affiliation, position) VALUES (?,?,?,?,?)",
            (sid, s["author"][0], s["author"][1], s["author"][2], 0),
        )
        for pos, (n, e, a) in enumerate(s["extra"], start=1):
            conn.execute(
                "INSERT INTO submission_authors(submission_id, name, email, affiliation, position) VALUES (?,?,?,?,?)",
                (sid, n, e, a, pos),
            )

    # bids
    bid_scores = [2, 1, 0, -1]
    for rid in all_reviewers:
        for sid in sid_map.values():
            if rng.random() < 0.55:
                conn.execute(
                    "INSERT OR IGNORE INTO bids(submission_id, reviewer_id, score) VALUES (?,?,?)",
                    (sid, rid, rng.choice(bid_scores)),
                )

    # assignments
    assign_plan = {
        1: ["r1", "r2", "r3"],
        2: ["r2", "r4", "r5"],
        3: ["r1", "r3", "r6"],
        4: ["r3", "r4", "r5"],
        5: ["r1", "r2", "r6"],
        6: ["r2", "r5"],
        7: ["r3"],
    }
    key_to_id = {
        "r1": reviewers["r1"], "r2": reviewers["r2"], "r3": reviewers["r3"],
        "r4": reviewers["r4"], "r5": reviewers["r5"], "r6": reviewers["r6"],
    }
    for si, keys in assign_plan.items():
        for k in keys:
            conn.execute(
                "INSERT OR IGNORE INTO assignments(submission_id, reviewer_id, assigned_by, created_at) VALUES (?,?,?,?)",
                (sid_map[si], key_to_id[k], chair, now()),
            )

    def review(sid, key, overall, conf, s_, p_, c_, strengths, weaknesses, questions, state):
        conn.execute(
            "INSERT INTO reviews(submission_id, reviewer_id, soundness, presentation, contribution,"
            " overall, confidence, strengths, weaknesses, questions, state, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, key_to_id[key], s_, p_, c_, overall, conf, strengths, weaknesses, questions,
             state, now(), now()),
        )

    review(sid_map[1], "r1", 6, 4, 3, 3, 2,
           "Elegant routing scheme; strong low-resource results; reproducible.",
           "Typological feature extraction is under-specified.", "How sensitive is the router to feature noise?", "submitted")
    review(sid_map[1], "r2", 6, 3, 3, 3, 3,
           "Impressive speedups; solid ablations.",
           "Only compares to dense baselines; missing MoE baselines.", "Can this extend to multilingual pretraining?", "submitted")
    review(sid_map[1], "r3", 5, 3, 3, 2, 2,
           "Clear writing, convincing experiments on 12 language pairs.",
           "Marginal gains on high-resource pairs.", "Any failure cases documented?", "submitted")
    review(sid_map[2], "r2", 5, 3, 3, 3, 3,
           "Clinically relevant; conformal calibration is well executed.",
           "Limited to 2D imaging; no report-generation tasks.", "Would the method work with vision-language report models?", "submitted")
    review(sid_map[2], "r4", 5, 3, 2, 2, 3,
           "Strong coverage guarantees and clean evaluation protocol.",
           "Novelty over existing conformal pipelines is incremental.", "Compare with risk-controlling prediction sets?", "submitted")
    review(sid_map[2], "r5", 4, 3, 2, 2, 3,
           "Good dataset coverage.", "Calibration drift over time is not studied.", "Is there a deployment case study?", "submitted")
    review(sid_map[3], "r1", 3, 2, 2, 2, 2,
           "Benchmark is genuinely useful and reproducible.",
           "Survey organisation is uneven; formal analysis is thin.", "Which open problems does FLU-Bench resolve?", "submitted")
    review(sid_map[3], "r3", 2, 2, 1, 2, 2,
           "Broad literature coverage.", "Taxonomy overlaps heavily with prior surveys; limited new insight.",
           "What is the theoretical treatment of drift detection?", "submitted")
    review(sid_map[3], "r6", 3, 2, 2, 2, 2,
           "Nice engineering effort on the benchmark.",
           "Missing key baselines from 2025-2026.", "Plans for a living benchmark?", "submitted")
    review(sid_map[4], "r3", 4, 3, 3, 3, 2,
           "Training-free pruning is practical and fast.",
           "Perplexity-only evaluation; no downstream QA.", "How does ATP compose with quantization?", "submitted")
    review(sid_map[4], "r4", 5, 3, 3, 3, 3,
           "Well-tuned attention-entropy heuristic; strong speed numbers.",
           "Theoretical justification for the entropy score is thin.", "What happens beyond 128k context?", "draft")
    review(sid_map[5], "r1", 4, 3, 2, 2, 2,
           "3D/2D contrastive alignment is a sensible idea.",
           "Gains on four of seven tasks are within error bars.", "Scaffold-split protocol details?", "submitted")
    review(sid_map[5], "r2", 3, 2, 2, 2, 1,
           "Comprehensive MoleculeNet evaluation.",
           "Conformers generated by RDKit only; limited 3D quality study.", "How costly is conformer generation at scale?", "draft")
    review(sid_map[7], "r3", 4, 3, 2, 3, 2,
           "Interesting Hessian-spectrum diversity criterion.",
           "Empirical validation is limited to image classification.", "Does this hold for transformers?", "draft")

    # comments / rebuttals
    conn.execute(
        "INSERT INTO comments(submission_id, user_id, body, visibility, created_at) VALUES (?,?,?,?,?)",
        (sid_map[4], _id_by_email(conn, "lin@aicon.demo"),
         "Author response: thank you for the careful reviews. ATP composes with INT8 quantization "
         "(we will add these results); downstream QA results show <1 point drop at 70% pruning.",
         "everyone", now()),
    )
    conn.execute(
        "INSERT INTO comments(submission_id, user_id, body, visibility, created_at) VALUES (?,?,?,?,?)",
        (sid_map[1], chair,
         "Camera-ready: please merge sections 4 and 5 and add the requested MoE baseline discussion.",
         "authors", now()),
    )

    # notifications & outbox
    for uid, subj, body in [
        (authors["priya"], "Paper #1 accepted",
         "Your paper 'Sparse Mixture-of-Experts Routing…' has been accepted to AICON 2026. "
         "Camera-ready is due 2027-01-10."),
        (authors["sarah"], "Paper #2 accepted as poster",
         "'Calibrated Uncertainty Estimation…' was accepted as a poster. Congratulations!"),
        (authors["arjun"], "Decision on Paper #3",
         "'Federated Learning under Concept Drift…' was not accepted. Meta-review is available on the paper page."),
        (reviewers["r1"], "Reviewing assignment",
         "You have been assigned 3 papers. Reviews are due 2026-11-25."),
    ]:
        notify(conn, uid, subj, body)
        email = conn.execute("SELECT email FROM users WHERE id=?", (uid,)).fetchone()["email"]
        send_mail(conn, email, subj, body)

    log(conn, chair, "seed", "Demo conference data created")
    log(conn, chair, "settings", "Configured AICON 2026 deadlines and review policy")
    log(conn, chair, "assign", "Auto-assigned reviewers to 7 submissions")


def _id_by_email(conn, email):
    row = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    return row["id"] if row else 1


if __name__ == "__main__":
    init_db()
    print("Database initialised at", DB_PATH)
