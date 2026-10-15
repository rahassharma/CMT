# ─────────────────────────────────────────────────────────────────────────────
#  CMT on PythonAnywhere — paste this into your WSGI configuration file.
#
#  Where: Web tab → your web app → "WSGI configuration file" → click the link,
#         select ALL the existing text, delete it, paste this in, then Save.
#
#  Then:  Web tab → Reload.  Your app is live at https://USERNAME.pythonanywhere.com
#
#  Two things to edit below: USERNAME (twice) and your chair email/password.
# ─────────────────────────────────────────────────────────────────────────────
import os
import sys

# ---------------------------------------------------------------- your settings
# These MUST be set before importing the app.
USERNAME = "YOURUSERNAME"                 # your PythonAnywhere username

os.environ["SEED_DEMO"] = "0"             # empty conference — no demo data
os.environ["ADMIN_EMAIL"] = "you@yourconf.org"
os.environ["ADMIN_PASSWORD"] = "pick-a-strong-password"
os.environ["ADMIN_NAME"] = "Conference Chair"
os.environ["CONFERENCE_NAME"] = "My Conference 2027"
os.environ["CONFERENCE_SHORT"] = "MC27"

# Keep the upload cap modest: PythonAnywhere free accounts have 512 MB of disk
# for BOTH the database and the PDFs. 10 MB is a reasonable cap for papers.
os.environ["MAX_UPLOAD_MB"] = "10"

# Email: free accounts can only reach whitelisted hosts, so leave SMTP unset —
# notifications still appear in each user's inbox and in the chair's
# Announcements/outbox page, they're just not emailed. On a paid plan ($10/mo)
# you can add SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM.
# os.environ["SMTP_HOST"] = "smtp.resend.com"
# os.environ["SMTP_PORT"] = "587"
# os.environ["SMTP_USER"] = "resend"
# os.environ["SMTP_PASSWORD"] = "re_xxxxxxxxxxxx"
# os.environ["SMTP_FROM"] = "chairs@yourconf.org"
# -------------------------------------------------------------- end settings

# Put the project folder on the import path. DATA_DIR defaults to the project
# folder, so conference.db and uploads/ live right there and persist.
PROJECT_DIR = f"/home/{USERNAME}/CMT"
if not os.path.isdir(PROJECT_DIR):
    raise RuntimeError(
        f"CMT not found at {PROJECT_DIR}. "
        f"In a PythonAnywhere Bash console run: "
        f"git clone https://github.com/YOUR_USERNAME/CMT.git /home/{USERNAME}/CMT"
    )
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

# Create the database/seed on first load and expose the WSGI application.
from app import app as application  # noqa: E402,F401
