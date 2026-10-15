"""Production-path tests: real SMTP delivery + first-user-becomes-chair.

Run:  python3 tests/test_production_paths.py
Uses Flask's test client and a throwaway fake SMTP server — no network needed.
"""
import os
import shutil
import socket
import sys
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

DATA_DIR = "/tmp/cmt_prodpaths"
shutil.rmtree(DATA_DIR, ignore_errors=True)

os.environ.update({
    "DATA_DIR": DATA_DIR,
    "SEED_DEMO": "0",
    "ADMIN_EMAIL": "chair@myconf.org",
    "ADMIN_PASSWORD": "strongpass123",
    "ADMIN_NAME": "Prof. Chair",
    "CONFERENCE_NAME": "TestConf 2027",
    "CONFERENCE_SHORT": "TC27",
    "SMTP_HOST": "127.0.0.1",
    "SMTP_PORT": "2525",
    "SMTP_TLS": "none",
    "SMTP_FROM": "chairs@myconf.org",
})

PASS, FAIL = [], []


def check(label, condition, detail=""):
    (PASS if condition else FAIL).append(label)
    print(f"{'PASS' if condition else 'FAIL'}  {label}{'  — ' + str(detail) if detail else ''}")


class FakeSMTP(threading.Thread):
    """Minimal SMTP server that records the messages it receives."""

    def __init__(self, port):
        super().__init__(daemon=True)
        self.messages = []
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", port))
        self.srv.listen(5)

    def run(self):
        while True:
            try:
                conn, _ = self.srv.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        f = conn.makefile("rwb")

        def send(line):
            f.write((line + "\r\n").encode())
            f.flush()

        send("220 fake ESMTP ready")
        in_data, buf = False, []
        while True:
            raw = f.readline()
            if not raw:
                break
            text = raw.decode(errors="replace").rstrip("\r\n")
            if in_data:
                if text == ".":
                    self.messages.append("\n".join(buf))
                    buf, in_data = [], False
                    send("250 OK queued")
                else:
                    buf.append(text)
                continue
            up = text.upper()
            if up.startswith(("EHLO", "HELO")):
                send("250-fake")
                send("250 SIZE 10485760")
            elif up.startswith("MAIL FROM"):
                send("250 OK")
            elif up.startswith("RCPT TO"):
                send("250 OK")
            elif up.startswith("DATA"):
                send("354 End data with <CR><LF>.<CR><LF>")
                in_data = True
            elif up.startswith("QUIT"):
                send("221 Bye")
                break
            else:
                send("250 OK")
        conn.close()


smtp = FakeSMTP(2525)
smtp.start()

import app as appmod  # noqa: E402  (env must be set before import)
import db  # noqa: E402

client = appmod.app.test_client()


def login(email, password):
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    return (r.get_json() or {}).get("token")


print("\n— 1. production bootstrap (SEED_DEMO=0, ADMIN_*) —")
with db.get_db() as conn:
    users = conn.execute("SELECT email, roles FROM users").fetchall()
    subs = conn.execute("SELECT COUNT(*) AS n FROM submissions").fetchone()["n"]
    settings = db.get_settings(conn)
check("only the admin account exists", len(users) == 1, [u["email"] for u in users])
check("admin has all three roles", set(__import__("json").loads(users[0]["roles"])) == {"chair", "author", "reviewer"})
check("no demo submissions", subs == 0)
check("conference name taken from env", settings["conference_name"] == "TestConf 2027", settings["conference_name"])
check("reviews NOT released by default", settings["reviews_visible"] == 0)
check("decisions NOT released by default", settings["decisions_released"] == 0)

print("\n— 2. public /api/conference reports demo=false —")
conf = client.get("/api/conference").get_json()["settings"]
check("demo flag is false", conf.get("demo") is False, conf.get("demo"))

print("\n— 3. admin login + real email delivery —")
token = login("chair@myconf.org", "strongpass123")
check("admin can log in", bool(token))
headers = {"X-Token": token or ""}

r = client.post("/api/chair/notify", headers=headers, json={
    "audience": "all", "subject": "Reviews open", "body": "Please bid for papers by Friday.",
})
check("notify endpoint accepted", r.status_code == 200, r.get_json())

outbox = client.get("/api/chair/outbox", headers=headers).get_json()["outbox"]
check("one message in outbox", len(outbox) == 1, len(outbox))
check("delivery marked 'sent'", outbox and outbox[0]["delivery"] == "sent", outbox[0]["delivery"] if outbox else None)
check("SMTP server actually received it", len(smtp.messages) == 1, len(smtp.messages))
if smtp.messages:
    raw = smtp.messages[0]
    check("subject delivered", "Reviews open" in raw)
    check("body delivered", "bid for papers" in raw)
    check("From header is the configured sender", "chairs@myconf.org" in raw)
    check("To header is the chair address", "chair@myconf.org" in raw)

print("\n— 4. register: non-first user gets author only —")
r = client.post("/api/auth/register", json={
    "email": "author1@lab.edu", "name": "Test Author", "password": "authorpass1", "affiliation": "IIT",
})
check("registration succeeds", r.status_code == 200, r.get_json())
check("roles limited to author", r.get_json()["user"]["roles"] == ["author"], r.get_json()["user"]["roles"])

print("\n— 5. SMTP failure never breaks the request —")
os.environ["SMTP_PORT"] = "2599"        # nothing listening here
r = client.post("/api/chair/notify", headers=headers, json={
    "audience": "all", "subject": "Dead SMTP test", "body": "Should still succeed.",
})
check("notify still returns 200", r.status_code == 200, r.get_json())
outbox = client.get("/api/chair/outbox", headers=headers).get_json()["outbox"]
check("failure recorded, not raised", outbox[0]["delivery"] == "failed", outbox[0]["delivery"])
check("failure reason captured", "ConnectionRefused" in outbox[0]["delivery_detail"], outbox[0]["delivery_detail"])
os.environ["SMTP_PORT"] = "2525"

print("\n— 6. role gating still enforced —")
author_token = login("author1@lab.edu", "authorpass1")
r = client.get("/api/chair/stats", headers={"X-Token": author_token})
check("author blocked from chair API (403)", r.status_code == 403, r.status_code)

print("\n— 7. first-user-becomes-chair on an unaided install —")
shutil.rmtree("/tmp/cmt_firstuser", ignore_errors=True)
os.environ.update({"DATA_DIR": "/tmp/cmt_firstuser", "ADMIN_EMAIL": "", "ADMIN_PASSWORD": ""})
for mod in ("app", "db"):
    sys.modules.pop(mod, None)
import db as db2  # noqa: E402
import app as appmod2  # noqa: E402

db2.init_db()
c2 = appmod2.app.test_client()
r = c2.post("/api/auth/register", json={"email": "founder@lab.edu", "name": "Founder", "password": "founderpass"})
roles = (r.get_json() or {}).get("user", {}).get("roles")
check("first registrant becomes chair", roles and "chair" in roles, roles)

print(f"\n{'=' * 60}\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("FAILED: " + ", ".join(FAIL))
sys.exit(1 if FAIL else 0)
