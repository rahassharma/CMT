# Deploying CMT — running for real, not a demo

Your repo is **CMT**. Everything needed ships in this folder: `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `Procfile`, `fly.toml`, `render.yaml`, `requirements.txt`.

There are two things that make a deployment "real" instead of a demo, and both are one environment variable:

| Setting | Effect |
|---|---|
| `SEED_DEMO=0` | Starts with an **empty conference** — no demo papers, no `demo123` accounts, and the one-click demo buttons disappear from the login page. |
| `ADMIN_EMAIL` + `ADMIN_PASSWORD` | Creates **your chair account** at first boot. (If you forget these, the first person to register becomes chair, so you can never be locked out.) |

Everything else — reviews, decisions, notifications — defaults to private (`reviews_visible=0`, `decisions_released=0`), so nothing leaks to authors until you publish it deliberately.

---

## Step 0 — push CMT to GitHub

Every host below deploys from a Git repo (none of them accept a zip upload). From inside the `CMT` folder:

```bash
git init
git add .
git commit -m "Conference management toolkit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/CMT.git
git push -u origin main
```

`.gitignore` keeps `conference.db`, `uploads/`, and `__pycache__/` out of the repo, so no local data or secrets get published.

**No git installed?** Open your empty repo on github.com → **Add file → Upload files** → drag the contents of the `CMT` folder in → commit. Make sure `app.py`, `requirements.txt`, `Dockerfile`, and the `static/` folder all land at the repo root.

---

## Which host? (2026 prices)

| Option | Cost | Always on? | Data survives? | Card needed? | Notes |
|---|---|---|---|---|---|
| **PythonAnywhere** ⭐ no-card pick | **$0** | **Yes** (no sleep) | **Yes** (512 MB) | **No** | Python-native, ~15 min setup, no Docker. Free tier: no custom domain (uses `you.pythonanywhere.com`), no outbound email. Full guide: **[PYTHONANYWHERE.md](PYTHONANYWHERE.md)** |
| **Oracle Cloud Always Free** ⭐ | **$0** | Yes | Yes (200 GB) | **Yes** — Oracle asks for a card at signup | Best specs anywhere (2 ARM cores / 12 GB). See **[ORACLE.md](ORACLE.md)**. |
| **A machine you own + Cloudflare Tunnel** | $0 | Only while it's powered on | Yes | No | `cloudflared tunnel --url http://localhost:8000` gives a public HTTPS URL, no port forwarding. Needs an always-on computer. |
| **Fly.io** | ~$3–5/mo | Yes | Yes (volume) | Yes | Best "real" hosting if a card is available. `fly.toml` included. |
| **Hetzner / DigitalOcean VPS** | ~€5.5/mo | Yes | Yes | Yes | Same docker compose steps as Oracle. |
| **GitHub Student Pack** → DigitalOcean | $200 credit | Yes | Yes | Depends on the offer | If you're a student, check this before paying for anything. |
| **Render free** | $0 | **No** (~15 min sleep) | **No** (wiped on deploy) | Sometimes | Demo only — see notes below. |
| Koyeb / Railway | free tier / ~$5 | Partial | Limited | **Yes** (Koyeb asks for a card with a $29 hold) | Not for real data on the free plan. |

**Recommendation:** with no card, go **[PythonAnywhere](PYTHONANYWHERE.md)** — it's the only free tier that is simultaneously no-card, always-on, and persistent. Fly.io or Oracle are better hosts the moment a card is available.

---

## Option A — Fly.io (recommended, ~15 min)

```bash
# 1. Install flyctl and sign in
curl -L https://fly.io/install.sh | sh
fly auth signup          # or: fly auth login

# 2. From inside the CMT folder — reuse the included fly.toml
fly launch --no-deploy --copy-config
#    (if it asks, keep the app name "cmt" or pick another; region: bom = Mumbai)

# 3. Create the persistent volume for the database + uploaded PDFs
fly volumes create cmt_data --size 1 --region bom

# 4. Set your chair account + conference name as secrets
fly secrets set \
  ADMIN_EMAIL="you@yourconf.org" \
  ADMIN_PASSWORD="a-strong-password-here" \
  CONFERENCE_NAME="My Conference 2027" \
  CONFERENCE_SHORT="MC27"

# 5. Ship it
fly deploy
fly open
```

`fly.toml` already sets `auto_stop_machines = false` and `min_machines_running = 1`, so it **never sleeps** — no cold starts. A 512 MB shared-CPU machine is about **$3–4/month**, plus $0.15/GB for the 1 GB volume.

**Real email on Fly** (optional — by default notifications are recorded in the chair's Announcements/outbox view instead of being sent):

```bash
fly secrets set \
  SMTP_HOST="smtp.resend.com" SMTP_PORT="587" \
  SMTP_USER="resend" SMTP_PASSWORD="re_xxxxxxxx" \
  SMTP_FROM="chairs@yourconf.org"
```

Any SMTP provider works (Resend, Postmark, Brevo, Gmail app passwords, your university's SMTP). Verified behaviour: when SMTP is configured every notification is actually delivered and the outbox row is marked `sent`; if the mail server is down the request still succeeds and the row is marked `failed` with the reason.

**Custom domain:** `fly certs add cmt.yourconf.org`, then add the DNS records it prints.

---

## Option B — Oracle Cloud Always Free + docker compose ($0 forever) ⭐

**Full walkthrough: [ORACLE.md](ORACLE.md).** The short version:

1. Sign up at cloud.oracle.com → **Always Free**, home region **Mumbai** (can't be changed later).
2. **Compute → Instances → Create**: Ubuntu 22.04, shape **VM.Standard.A1.Flex** (1 OCPU / 6 GB), **reserved** public IP, your SSH key. ("Out of capacity" is common on the free ARM shape — try another availability domain or retry later.)
3. SSH in, put the code on the server (`git clone` or `scp -r CMT ubuntu@IP:~`), then run:
   ```bash
   cd CMT && bash deploy/oracle-setup.sh     # add --dry-run to preview
   ```
   The script installs Docker, opens 80/443 in the VM firewall, writes `.env` with a generated chair password, builds and starts the stack, waits for a healthy app, and installs a 5-minute keep-alive ping.
4. **Open 80/443 in the Oracle console** (VCN → Security Lists → Default Security List → Add Ingress Rules, source `0.0.0.0/0`, TCP, ports 80 and 443). This is the step everyone misses.
5. **HTTPS without buying a domain:** use your IP as `<ip-with-dashes>.sslip.io` (e.g. `203-0-113-10.sslip.io`) as `PUBLIC_HOST`, or create a free DuckDNS name. Caddy then gets a real Let's Encrypt certificate automatically. With your own domain, point an A record at the reserved IP.

Both compose files are self-contained: `docker-compose.yml` runs plain HTTP on port 80; `docker-compose.https.yml` adds Caddy and publishes 80/443 with the app not exposed. The `cmt_data` volume holds `conference.db` and the PDFs, so data survives restarts and redeploys. The same steps work on a **Hetzner CX23 (~€5.49/mo)** or DigitalOcean droplet if Oracle's capacity hunt wears you down.

**Useful commands** (add `-f docker-compose.https.yml` if you used the HTTPS file):

```bash
docker compose logs -f cmt        # live logs
docker compose logs -f caddy      # certificate / proxy logs
docker compose restart cmt        # restart the app
git pull && docker compose up -d --build      # deploy code changes
docker compose exec cmt sh -c 'ls -la /data'  # inspect the volume
docker compose down -v            # ⚠️ wipes the database + uploads
```

**Backups** — everything is two things: the SQLite file and the uploads folder.

```bash
# from your laptop, once a day
ssh ubuntu@YOUR_SERVER 'docker run --rm -v cmt_cmt_data:/d -v /tmp:/b alpine \
  tar czf /b/cmt-backup.tar.gz -C /d .' && scp ubuntu@YOUR_SERVER:/tmp/cmt-backup.tar.gz .
```

The chair's **Export** page also produces `submissions.csv`, `reviews.csv`, `users.csv` and a full JSON dump at any time.

---

## Option C — PythonAnywhere free (no card, no server admin) ⭐

**Full walkthrough: [PYTHONANYWHERE.md](PYTHONANYWHERE.md).** Always-on, persistent disk, SQLite included, ~15 minutes, no Docker. The ready-to-paste WSGI file is at [`deploy/pythonanywhere_wsgi.py`](deploy/pythonanywhere_wsgi.py).

Measured against the free tier: about **5 MB of the 512 MB disk** for code + dependencies (leaving ~500 MB for PDFs) and roughly **1 ms of CPU per request** — so ~100,000 page loads a day against the 100 CPU-second daily quota. The only real gap is email: free accounts can't reach SMTP hosts, so notifications stay in-app and in the chair's outbox view.

---

## Option D — Stay on Render, but make it real

Two changes in the dashboard (or uncomment the blocks at the bottom of `render.yaml`):

1. **Instance type → Starter** ($7/mo). Free instances can't attach disks and sleep after 15 minutes.
2. **Add a disk** — mount path `/var/data`, 1 GB ($0.25/mo), then add an environment variable `DATA_DIR=/var/data`.

Then set `SEED_DEMO=0`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` in **Environment**, and set your start command to:

```
gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --threads 4 --timeout 60
```

Total ≈ **$7.25/month**, always on, data that survives deploys.

---

## After any deploy — go-live checklist

1. Visit `https://your-url/api/health` → `{"ok":true,...}`.
2. Sign in as your `ADMIN_EMAIL` account and open **Settings**:
   - Set the conference name and **all five deadlines** (submission, review, rebuttal, decision, camera-ready). They start blank on a clean install.
   - Set `reviews_per_paper` (default 3) and the topics list for your conference.
   - Leave `reviews_visible` and `decisions_released` **off** until the right moment — these are the release gates.
3. **People & roles** → add your co-chairs and reviewers, or share the registration link with authors (self-registration creates author accounts; you grant reviewer/chair from here).
4. Have authors submit, then **Assignments → Auto-assign** (bid-aware, conflict-avoiding, load-balanced), or assign reviewers manually.
5. When reviews are in: **Decisions** → set decisions → flip **decisions_released** on to publish them.
6. Back up the SQLite file + uploads folder, or export CSVs from the chair **Export** page.

## Notes and gotchas

- **Multiple copies of the app on one machine** share `/data` only if they're the same deployment. `DATA_DIR` is what separates them.
- **The seed only runs when the database is empty** — to re-plan a conference, wipe `conference.db` and the `uploads/` folder on the volume (back up first).
- **SQLite is a single-writer database.** Keep workers low (2 as configured). This comfortably handles a conference of a few hundred papers; if you ever outgrow it, migrate to Postgres.
- **Sessions last 14 days**; there's no "forgot password" email unless SMTP is configured. As chair you can reset any user's password from **People & roles**.
- **Demo buttons on the login page** disappear automatically when `SEED_DEMO=0` — no risk of a stray `demo123` account on the live site.
