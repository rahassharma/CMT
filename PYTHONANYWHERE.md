# CMT on PythonAnywhere — free, no credit card, always on

PythonAnywhere's **Beginner** account needs **no card at all**, and unlike most free tiers it is **always on** (no sleep) with a **persistent disk**. For a conference of a few hundred papers it's genuinely enough — I measured the app against the free tier's limits, numbers below.

**Total setup time: ~15 minutes.** No Docker, no server admin.

> **Two things to know up front:**
> 1. **No custom domain on free** — your URL is `https://YOURUSERNAME.pythonanywhere.com`. Custom domain + real email needs the $10/mo Developer plan.
> 2. **Keep it active.** Free web apps expire after ~1 month of not being used; PythonAnywhere emails you a renewal link. Log in and hit your site occasionally, or treat this as a pre-launch/light-use host.

---

## What the free tier gives you, measured

| Limit | What you get | How CMT does |
|---|---|---|
| Disk | **512 MB** | Dependencies 4.7 MB + app 0.5 MB + DB 0.1 MB ≈ **5 MB used**, leaving ~507 MB for PDFs. At the 10 MB upload cap that's ~50 full-size papers; typical 2 MB papers ≈ 250. |
| CPU | **100 CPU-seconds/day** | Measured ~1 ms per request, so roughly **100,000 page loads / day**. A conference won't come close. |
| Web apps | 1, always on | Enough. No sleep, no cold starts. |
| Outbound internet | whitelist only | CMT makes **no outbound calls** by default. Email is skipped (see below); everything else works. |
| Python | 3.10+ | App verified to parse under 3.10; no 3.11+ syntax. |
| MySQL / scheduled tasks | not on new free accounts | Not needed — CMT uses SQLite. |
| WebSockets | unsupported | CMT doesn't use any. |

**The one real gap: email.** Free accounts can only reach whitelisted hosts, so SMTP won't work. Notifications still land in each user's in-app inbox and in the chair's **Announcements → outbox** page — they're just not emailed. If email matters, upgrade to Developer ($10/mo) and add the `SMTP_*` values from `.env.example`.

---

## Step 1 — Create the account

1. Go to **pythonanywhere.com** → **Pricing & signup** → **Create a Beginner account**.
2. Pick a username — it becomes your URL (`yourname.pythonanywhere.com`), so choose something conference-appropriate. **No card, no payment details.**
3. Verify your email.

## Step 2 — Get the code in and install Flask

Open a **Bash console** (Dashboard → *New console* → *Bash*) and run:

```bash
# dependencies — no gunicorn needed, PythonAnywhere runs the WSGI app itself
pip install --user flask

# your code (use your own repo URL)
git clone https://github.com/YOUR_USERNAME/CMT.git
cd CMT && ls          # you should see app.py, db.py, static/, ...
```

**No GitHub repo yet?** Either push one first, or upload a zip via the **Files** tab (`New file` / *Upload*) into `/home/YOURUSERNAME/`, then `cd ~ && unzip CMT.zip -d CMT`.

> The folder **must** be named `CMT` in your home directory — the WSGI file below points at `/home/YOURUSERNAME/CMT`.

## Step 3 — Paste the WSGI file (the only fiddly bit)

1. Go to the **Web** tab → **Add a new web app** → **Next** → choose **Manual configuration** (not the Flask wizard) → pick **Python 3.10** or newer → **Next**.
2. On the web app page, click the **WSGI configuration file** link (`/var/www/YOURUSERNAME_pythonanywhere_com_wsgi.py`).
3. Select **everything** in that editor, delete it, and paste the whole contents of [`deploy/pythonanywhere_wsgi.py`](deploy/pythonanywhere_wsgi.py) from this repo.
4. Edit just the top block:

```python
USERNAME = "YOURUSERNAME"                     # your PythonAnywhere username

os.environ["SEED_DEMO"] = "0"                 # empty conference, no demo data
os.environ["ADMIN_EMAIL"] = "you@yourconf.org"
os.environ["ADMIN_PASSWORD"] = "pick-a-strong-password"
os.environ["ADMIN_NAME"] = "Conference Chair"
os.environ["CONFERENCE_NAME"] = "My Conference 2027"
os.environ["CONFERENCE_SHORT"] = "MC27"
os.environ["MAX_UPLOAD_MB"] = "10"            # keeps the 512 MB disk happy
```

5. **Save.**

> The file raises a clear error if it can't find the project, so a typo in the username or folder name shows up immediately instead of a blank page.

## Step 4 — Point the web app at your code

Still on the **Web** tab:

| Setting | Value |
|---|---|
| Source code | `/home/YOURUSERNAME/CMT` |
| Working directory | `/home/YOURUSERNAME/CMT` |
| Virtualenv | leave empty (Flask is installed with `--user`) |

**Optional but worth it** — let PythonAnywhere serve the frontend files directly instead of spending your CPU quota on them. Under **Static files**, add:

| URL | Directory |
|---|---|
| `/static/` | `/home/YOURUSERNAME/CMT/static` |

## Step 5 — Reload and sign in

Hit the green **Reload** button. Then open:

```
https://YOURUSERNAME.pythonanywhere.com/api/health
```

You should see `{"ok":true,"service":"conference-toolkit",...}`. Now open the site root and sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` you set in Step 3. The first load creates the database and your chair account.

If something's wrong, check **Web → Error log** — it shows the Python traceback.

## Step 6 — Make it a real conference

Sign in as chair, then:

1. **Settings** — set the conference name and all **five deadlines** (they start blank), the topics list, and reviews-per-paper. Leave `reviews_visible` and `decisions_released` **off** until you're ready to publish.
2. **People & roles** — add co-chairs and reviewers. Share the site URL with authors; self-registration creates author accounts.
3. **Assignments → Auto-assign** once papers arrive (bid-aware, conflict-avoiding, load-balanced), or assign by hand.
4. Set decisions, then flip **decisions_released** on to publish them.

## Updating the code later

```bash
cd ~/CMT && git pull
```

Then press **Reload** on the Web tab. (Reload is required — PythonAnywhere caches the loaded app.)

## Backups

Two files hold everything: `conference.db` and the `uploads/` folder.

```bash
cd ~/CMT && tar czf ~/cmt-backup-$(date +%F).tar.gz conference.db uploads
```

Then download it from the **Files** tab (or use `scp`/the API if you have a paid account). The chair's **Export** page also produces CSVs and a full JSON dump any time — worth doing before every deadline passes.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `CMT not found at /home/.../CMT` in the error log | The folder isn't named `CMT` in your home dir, or `USERNAME` in the WSGI file is misspelled. |
| Blank page / 500 error | **Web → Error log**. Almost always a wrong `PROJECT_DIR` or an unrun `pip install --user flask`. |
| `ModuleNotFoundError: No module named 'flask'` | Run `pip install --user flask` in a Bash console, then Reload. |
| Changes don't appear | Press **Reload** on the Web tab. |
| "CPU seconds exceeded" | You've hit 100 CPU-sec/day. Static file mapping (Step 4) plus waiting for the daily reset fixes it. |
| Site says it's disabled/expired | Free web apps lapse after ~1 month of inactivity — click the renewal link PythonAnywhere emails you, or just log in and reload. |
| Uploads rejected | The 10 MB cap from `MAX_UPLOAD_MB`. Raise it only if your disk has room. |
| Email never arrives | Expected on free — outbound is whitelisted. Notifications are still in-app and in the chair's outbox. |

---

## If PythonAnywhere turns out to be too tight

Ranked by "no card required":

1. **A computer you control + Cloudflare Tunnel** — free, no card, full disk, real HTTPS. Runs `docker compose up -d` (or plain `python3 app.py`) on a desktop/NUC at home or in your lab, with `cloudflared` giving it a public HTTPS URL without port forwarding:
   ```bash
   # on your machine, with the app already running on :8000
   cloudflared tunnel --url http://localhost:8000    # prints a trycloudflare.com HTTPS URL
   ```
   For a permanent URL, create a free Cloudflare account and a *named* tunnel on your own domain. Downside: your machine must stay on — no good if power/internet is unreliable.
2. **Render free web service** — no card per most recent reports (some users are asked for one), never expires, but it **sleeps after 15 minutes** and its filesystem is **ephemeral**: the database and PDFs are wiped on every deploy or restart. Fine for a public demo, not for real submissions.
3. **GitHub Student Developer Pack** — if you're a student, it includes **$200 DigitalOcean credit** (and Azure credit) with no card needed for the DO offer. That's years of a $5/month droplet with full root, a real domain, and persistent storage. Worth checking first if you're eligible.
4. **PythonAnywhere Developer plan ($10/mo)** — the same setup you just built, plus a custom domain, real email, 5 GB disk, and unrestricted outbound.

Everything in the Oracle/VPS instructions still applies the day you get access to a card or a machine — the app and compose files don't change.
