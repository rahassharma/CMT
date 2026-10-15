# Conference Management Toolkit

A full-stack conference management system with complete **author**, **reviewer**, and **chair** portals — submission, bidding, reviewing, rebuttals, auto-assignment, decisions, announcements, exports, and an audit trail.

Built with **Flask + SQLite** (backend) and a dependency-free **vanilla JS SPA** (frontend).

---

## Quick start

```bash
pip install flask            # or: pip install -r requirements.txt
python3 app.py               # seeds demo data on first run
# open http://localhost:8000
```

The database (`conference.db`) and uploads are created automatically and seeded with a rich demo conference (**AICON 2026** — 8 papers, 12 people, reviews in every state, bids, decisions, notifications).

### One-click demo logins (password: `demo123`)

| Role | Email | What you'll see |
|---|---|---|
| Chair | `chair@aicon.demo` | Full control room + also authors/reviews |
| Author | `priya@aicon.demo` | 3 papers: accepted, under review, pending |
| Reviewer | `rev1@aicon.demo` | 3 assigned papers, bidding board |

Or register a fresh account from the login page (starts as **author**; chairs grant more roles under *People & roles*).

---

## Author controls

- **Submit papers** — title, abstract, track, up to 5 topics, ordered author list (names, emails, affiliations), PDF upload (25 MB max)
- **Edit / withdraw / restore** submissions while the submission window is open
- **Reviews & rebuttal** — read released reviews (scores + text), post author responses and discuss with reviewers/chairs
- **Decision letters** — accept / poster / reject with the chairs' meta-review comment
- **Camera-ready** upload for accepted papers (with note to chairs)
- **Notifications inbox** — decisions, announcements; profile & password management
- Per-author cap on active submissions (chair-configurable)

## Reviewer controls

- **Bidding board** — Want / Maybe / No / Conflict for every paper (conflicts auto-remove assignments)
- **Assignment queue** with per-paper review state and progress
- **Review form** — overall (1–7), confidence, soundness / presentation / contribution (1–3), strengths, weaknesses, questions; save drafts or submit
- Discussion with authors during the rebuttal period

## Chair controls (control room)

- **Dashboard** — live stats: papers, reviews in/drafts, acceptance rate, score distribution, topic mix, papers needing attention
- **All submissions** — search & filter (status / decision / topic), bulk actions
- **Decision queue** — quick accept / poster / reject per paper or in bulk, with comment to authors (auto-notifies authors)
- **Release gates** — toggle reviews visible to authors and decisions released at any time
- **Auto-assignment** — greedy, bid-aware, conflict-avoiding, load-balanced to N reviewers/paper; plus manual assign/unassign with per-reviewer loads
- **People & roles** — create accounts (simulated invite email), grant chair/reviewer/author roles, reset passwords, disable accounts
- **Conference settings** — name/description, all five deadlines, policy switches (submissions open, reviewing open, bidding open, camera-ready open, double-blind, reviewer anonymity), topics editor, review scale, reviewer load policy
- **Announcements** — email + in-app notification to everyone / authors / reviewers / accepted authors, with a simulated outbox
- **Export** — `submissions.csv`, `reviews.csv`, `users.csv`, and a full JSON dump
- **Audit log** — every action by every user, with timestamps

## Architecture

```
CMT/
├── app.py               # Flask app: REST API + static hosting (40+ endpoints)
├── db.py                # SQLite schema, PBKDF2 hashing, demo seeder, SMTP mailer
├── requirements.txt     # flask + gunicorn
├── Dockerfile           # container image (any host, ARM + x86)
├── docker-compose.yml         # plain HTTP on port 80 (no domain needed)
├── docker-compose.https.yml   # + Caddy with automatic Let's Encrypt HTTPS
├── Caddyfile            # reverse proxy + TLS config
├── fly.toml             # Fly.io: always-on machine + persistent volume
├── render.yaml          # Render blueprint
├── Procfile             # gunicorn start command (generic PaaS)
├── .env.example         # copy to .env for docker compose
├── deploy/
│   ├── oracle-setup.sh  # one-shot setup for an Oracle/VPS server
│   └── pythonanywhere_wsgi.py   # paste-in WSGI file for PythonAnywhere
├── DEPLOY.md            # host comparison + deployment walkthrough
├── ORACLE.md            # Oracle Cloud Always Free, step by step
├── PYTHONANYWHERE.md    # free, no-credit-card hosting, step by step
├── tests/               # production-path tests (SMTP, bootstrap, role gating)
├── conference.db        # created + seeded on first run
├── uploads/             # paper & camera-ready PDFs
└── static/
    ├── index.html       # SPA shell
    ├── css/styles.css   # design system (no CDN dependencies)
    └── js/
        ├── core.js      # API client, state, UI helpers
        ├── author.js    # submission form, detail, reviews & rebuttal
        ├── reviewer.js  # queue, bidding, review forms
        ├── chair.js     # dashboard, submissions, assignments, users, settings…
        └── app.js       # router, login, home, notifications, profile
```

### API surface (summary)

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/register·login·logout`, `GET /api/auth/me`, `PUT /api/auth/profile` |
| Submissions | `GET·POST /api/submissions`, `GET·PUT /api/submissions/:id`, `withdraw·restore`, `pdf·camera-ready` upload/download, `comments` |
| Reviewer | `queue`, `bids` (GET/PUT), `reviews/:id` (draft/submit), `all-papers` |
| Chair | `stats`, `submissions`, `settings`, `users`, `assign·assign/auto`, `decide`, `release`, `notify`, `outbox`, `audit`, `export/:kind` |

### Data model

`users`, `sessions`, `settings`, `submissions`, `submission_authors`, `assignments`, `bids`, `reviews`, `comments`, `notifications`, `outbox`, `audit_log` — SQLite with WAL; passwords hashed with PBKDF2-SHA256 (120k iterations); session tokens expire after 14 days.

## Running it for real (production)

Deployable as-is with **Docker** (`Dockerfile`, `docker-compose.yml`, `docker-compose.https.yml`, `Caddyfile`), on **Fly.io** (`fly.toml`), **Render** (`render.yaml`), **PythonAnywhere**, or any VPS. See **[DEPLOY.md](DEPLOY.md)** for the host comparison and click-by-click steps.

**No credit card?** **[PYTHONANYWHERE.md](PYTHONANYWHERE.md)** — free, always-on, persistent disk, no card at any point, ~15 minutes, no Docker. Paste [`deploy/pythonanywhere_wsgi.py`](deploy/pythonanywhere_wsgi.py) into the WSGI field and you're live at `you.pythonanywhere.com`.

**Have a card or a VPS?**
- **[ORACLE.md](ORACLE.md)** — Oracle Cloud Always Free, $0 forever, full root VM. On the server: `cd CMT && bash deploy/oracle-setup.sh` (installs Docker, opens the firewall, writes `.env`, starts the stack). HTTPS works without buying a domain using a free `sslip.io` hostname.
- **Fly.io** — `fly.toml` included; always-on machine + volume, ~$3–5/mo.

Two environment variables turn the demo into a live conference:

```bash
SEED_DEMO=0                       # empty conference — no demo data, no demo123 accounts
ADMIN_EMAIL=you@yourconf.org      # your chair account, created at first boot
ADMIN_PASSWORD=a-strong-password
CONFERENCE_NAME="My Conference 2027"
```

(If you set `SEED_DEMO=0` and forget the admin credentials, the first account to register becomes chair — you can never be locked out.)

**Real email** (off by default): set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` and every notification is actually delivered — the outbox row is marked `sent`, and a dead mail server marks it `failed` without ever breaking a request.

- Production server: `gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --threads 4`
- **Persistent data:** set `DATA_DIR` to a mounted volume path (e.g. `/data`) so `conference.db` and `uploads/` survive deploys. The Docker image defaults to `/data`.
- Safe under multiple workers: boot-time schema/seed runs under a cross-process file lock, so concurrent gunicorn workers can't race.
- On a clean install, `reviews_visible` and `decisions_released` both default to **off** — nothing reaches authors until a chair publishes it.

### Notes

- Email is **simulated** (stored in an outbox table, visible in the chair's Announcements page) — wire to SMTP/SES for production.
- Single active conference per installation (HotCRP-style); all conference metadata is chair-editable in Settings.
- Blinded review is the default: authors see reviews anonymously unless the chair enables reviewer names or turns off double-blind.
