# CMT on Oracle Cloud — Always Free, always on, $0/month

Oracle's **Always Free** tier gives you a real VM that never sleeps: **2 ARM cores, 12 GB RAM, 200 GB disk, 10 TB egress per month, free forever** — far beyond what this app needs. Your data lives on the VM's disk, so nothing is wiped and nothing expires.

Budget about 30 minutes the first time. Everything after that is `docker compose up -d`.

> **Heads-up on signup:** Oracle asks for a card to verify you (they don't charge it), and it sometimes rejects signups. If it refuses yours, retry with a different card/email or fall back to a **Hetzner CX23 (~€5.49/mo)** — every step below after step 3 is identical.

---

## Step 1 — Create the account and VM

1. Sign up at **cloud.oracle.com** → **Start for free**.
2. **Home region: pick `India West (Mumbai)`** (or Hyderabad). Free-tier capacity is tied to your home region and *cannot be changed later*, and Mumbai is closest to you.
3. When the account is ready: **Compute → Instances → Create instance**.
4. Fill in:

   | Field | Value |
   |---|---|
   | Name | `cmt` |
   | Image | **Ubuntu 22.04** (or 24.04) |
   | Shape | **Ampere → VM.Standard.A1.Flex** |
   | OCPUs / memory | 1 OCPU / 6 GB is plenty (you can use up to 2/12 free) |
   | Boot volume | default (or 50 GB) |
   | SSH keys | **Paste public key** — use your existing `~/.ssh/id_rsa.pub`, or let Oracle generate a key pair and download the private key |
   | Public IP | **Reserved public IP** ← important, see below |

   > **Why a reserved IP?** An ephemeral IP changes if the instance is stopped/started, which would break both your DNS record and your HTTPS certificate. Reserving it is free while attached to the instance.

   **"Out of capacity" error?** Very common on the free ARM shape. Try: a different **Availability Domain** (AD-2/AD-3), a smaller size (1 OCPU / 6 GB), or wait a few hours and retry — capacity frees up regularly. As a last resort, create a `VM.Standard.E2.1.Micro` (free x86) instead; the app runs fine there too, just with less RAM.

5. Once it's running, note the **Public IP address** and connect:
   ```bash
   ssh ubuntu@YOUR_PUBLIC_IP          # or: ssh -i /path/to/private.key ubuntu@YOUR_PUBLIC_IP
   ```

## Step 2 — Get CMT onto the server

**If your CMT repo is on GitHub:**
```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/YOUR_USERNAME/CMT.git && cd CMT
```

**If it isn't pushed anywhere yet**, copy it straight from your laptop (run this *on your laptop*, from the folder containing the CMT folder):
```bash
scp -r CMT ubuntu@YOUR_PUBLIC_IP:~
ssh ubuntu@YOUR_PUBLIC_IP "cd CMT"
```

## Step 3 — Run the setup script

From inside the `CMT` folder **on the server**:

```bash
bash deploy/oracle-setup.sh
```

It will:
- install Docker,
- open ports 80/443 in the VM's own firewall (and persist the rules),
- ask for your **hostname** and **email**, then write `.env` with a secure randomly-generated chair password,
- build and start the app, wait until it reports healthy,
- install a 5-minute keep-alive ping (saves you from Oracle's idle-instance reclamation and doubles as an uptime check).

Preview first if you like: `bash deploy/oracle-setup.sh --dry-run` changes nothing.

At the end it prints your URL and login. **Take a note of the generated password** — it's also in `.env` on the server.

## Step 4 — Open ports 80/443 in the Oracle console ⚠️

The VM firewall is open now, but the cloud-level firewall (VCN security list) still blocks web traffic until you do this:

**Networking → Virtual Cloud Networks → your VCN → Security Lists → Default Security List → Add Ingress Rules**

Add two rules (add a second one for 443):

| Field | Value |
|---|---|
| Stateless | No |
| Source Type | CIDR |
| Source CIDR | `0.0.0.0/0` |
| IP Protocol | **TCP** |
| Destination Port Range | `80` (then repeat with `443`) |
| Description | `HTTP` / `HTTPS` |

Then visit your URL — the site should load.

> If it doesn't load but `curl localhost` works on the server, the missing ingress rule is almost always the cause.

## Step 5 — DNS and HTTPS

**You already have a domain?** Add an **A record** pointing at your reserved IP (`cmt.yourconf.org → 1.2.3.4`). Caddy picks it up within a minute and issues the certificate automatically — no extra commands.

**No domain? You still get real HTTPS, free.** Use a hostname that encodes your IP:

```
http://203.0.113.10   →   https://203-0-113-10.sslip.io
```

Replace the dots in your reserved IP with dashes and add `.sslip.io`. It's a public hostname that resolves right back to your server, so Let's Encrypt can issue a certificate for it. Zero signup, zero cost.

Prettier option: create a free name at **duckdns.org** (e.g. `cmt-2026.duckdns.org`) and point it at your IP.

To switch to a hostname later, just edit `PUBLIC_HOST` in `.env` and restart:
```bash
nano .env                                   # set PUBLIC_HOST=...
docker compose -f docker-compose.https.yml up -d
```
(No hostname at all is fine too — then use `docker-compose.yml` alone for plain HTTP on port 80.)

## Step 6 — Make it a real conference

Sign in with your `ADMIN_EMAIL` / generated password and work through the checklist:

1. **Settings** — set the conference name and all **five deadlines** (they start blank on a clean install), plus the topics list and reviews-per-paper. `reviews_visible` and `decisions_released` start **off** — leave them off until you're ready to publish.
2. **People & roles** — add your co-chairs and reviewers. Authors can self-register once you share the URL.
3. **Assignments** — once papers arrive, use **Auto-assign** (bid-aware, conflict-avoiding, load-balanced) or assign manually.
4. **Email (optional)** — put SMTP details in `.env` and restart to send real notifications:
   ```
   SMTP_HOST=smtp.resend.com
   SMTP_PORT=587
   SMTP_USER=resend
   SMTP_PASSWORD=re_xxxxxxxx
   SMTP_FROM=chairs@yourconf.org
   ```
   Without SMTP, notifications still appear in each user's inbox and in the chair's **Announcements → outbox**, they just aren't emailed.

---

## Running it day to day

```bash
cd ~/CMT

docker compose ps                       # is it running?
docker compose logs -f cmt              # live app logs
docker compose logs -f caddy            # certificate / proxy logs
docker compose restart cmt              # restart the app
git pull && docker compose up -d --build   # deploy code changes
```

**Backups** — two things hold all your data: `conference.db` and `uploads/`, both inside the `cmt_data` volume.

```bash
# on the server: write a timestamped backup
docker run --rm -v cmt_cmt_data:/d -v "$PWD":/b alpine \
  tar czf "/b/backup-$(date +%F).tar.gz" -C /d .

# from your laptop: pull it down
scp ubuntu@YOUR_IP:~/CMT/backup-*.tar.gz .
```

Restore = copy the archive back into the volume and restart. The chair's **Export** page also gives you CSVs and a full JSON dump any time.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Site doesn't load, `curl localhost` works on the server | **Ingress rules missing** in the VCN security list — step 4. |
| Connection times out from outside | Also check the VM firewall: `sudo iptables -L INPUT -n \| head` should show ACCEPT rules for 80/443. Re-run `deploy/oracle-setup.sh`. |
| `docker: permission denied` | Your shell session predates the group change. `newgrp docker` or log out and back in (or prefix with `sudo`). |
| HTTPS never gets a certificate | `docker compose logs caddy`: usually DNS not pointing at the server yet. The certificate is requested as soon as it does; `https://YOUR_IP` will never work (Let's Encrypt won't issue for bare IPs — use sslip.io). |
| `PUBLIC_HOST` error on `up` | `.env` has no `PUBLIC_HOST`. Set it, or use the plain `docker-compose.yml`. |
| Port 80 already in use | Something else (apache/nginx) is listening: `sudo ss -ltnp \| grep :80`. |
| Instance stopped / reclaimed | Oracle can reclaim *genuinely idle* Always Free compute (7-day CPU and network under 20%). A live conference plus the installed keep-alive ping keeps it active. If it happens, the volume is intact — start the instance again and `docker compose up -d`. |
| Need to reset the whole install | `docker compose down -v` wipes the volume (DB + uploads). Back up first. |

## Why the app fits Always Free so well

- The Docker image is **multi-arch** — `python:3.12-slim` and `caddy:2-alpine` both have ARM builds, so the free Ampere A1 shape works unchanged (verified).
- SQLite + gunicorn with 2 workers is far below 1 OCPU for a conference of a few hundred papers.
- Only two outbound connections are ever needed: your SMTP provider (optional) and Let's Encrypt (Caddy).
- Everything is a single compose stack — nothing to patch, nothing to scale.
