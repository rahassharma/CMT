#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  CMT — one-shot setup for an Oracle Cloud "Always Free" VM (Ubuntu 22.04/24.04)
#
#  Run this ON THE SERVER, from inside the CMT folder:
#      bash deploy/oracle-setup.sh                    # interactive
#      bash deploy/oracle-setup.sh --domain=cmt.example.org
#      bash deploy/oracle-setup.sh --dry-run          # preview, changes nothing
#
#  It installs Docker, opens ports 80/443 in the VM's own firewall, writes .env
#  with a generated chair password, starts the app, and prints your login.
#
#  Ports 80/443 must ALSO be opened in the Oracle console (VCN security list) —
#  see ORACLE.md. This script can't do that part; it's a web-console click.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DRY_RUN=0
DOMAIN=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --domain=*) DOMAIN="${arg#*=}" ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 1 ;;
  esac
done

ok()   { printf "\033[32m%s\033[0m\n" "$*"; }
info() { printf "\033[36m%s\033[0m\n" "$*"; }
warn() { printf "\033[33m%s\033[0m\n" "$*"; }
step() { printf "\n\033[1m== %s\033[0m\n" "$*"; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf "  \033[90m[dry-run]\033[0m %s\n" "$*"; else "$@"; fi; }
runsh(){ if [ "$DRY_RUN" = 1 ]; then printf "  \033[90m[dry-run]\033[0m bash -c \"%s\"\n" "$1"; else bash -c "$1"; fi; }

[ "$DRY_RUN" = 1 ] && warn "DRY RUN — nothing will be changed."

# ── 0. sanity checks ─────────────────────────────────────────────────────────
step "Checking we're in the CMT folder"
for f in docker-compose.yml docker-compose.https.yml Caddyfile app.py; do
  if [ ! -f "$f" ]; then
    echo "ERROR: $f not found. Run this from the CMT project folder." >&2
    exit 1
  fi
done
ok "project files found in $(pwd)"

if ! sudo -n true 2>/dev/null; then
  warn "sudo may ask for your password (that's fine, it's your own VM)."
fi

# ── 1. domain / hostname ─────────────────────────────────────────────────────
step "Public hostname (for HTTPS)"
if [ -z "$DOMAIN" ] && [ -t 0 ]; then
  PUBLIC_IP="$(curl -fsS -m 5 https://ifconfig.me 2>/dev/null || echo "")"
  echo "  Options:"
  echo "    • your own domain          e.g. cmt.yourconf.org"
  if [ -n "$PUBLIC_IP" ]; then
    echo "    • free hostname, no domain e.g. ${PUBLIC_IP//./-}.sslip.io   (real HTTPS, costs nothing)"
  fi
  echo "    • leave blank              plain HTTP on port 80, no certificate"
  printf "  Enter hostname: "
  read -r DOMAIN || DOMAIN=""
fi
DOMAIN="$(echo "${DOMAIN:-}" | tr -d '[:space:]')"

if [ -n "$DOMAIN" ]; then
  ok "HTTPS mode: https://$DOMAIN"
  INFO_IP="$(curl -fsS -m 5 https://ifconfig.me 2>/dev/null || echo "")"
  RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
  if [ -n "$RESOLVED" ] && [ -n "$INFO_IP" ] && [ "$RESOLVED" != "$INFO_IP" ]; then
    warn "Note: $DOMAIN currently resolves to $RESOLVED but this server is $INFO_IP."
    warn "Point the DNS record here, or Caddy won't be able to get a certificate (it retries automatically)."
  fi
  COMPOSE_ARGS=(-f docker-compose.https.yml)
else
  ok "Plain HTTP mode: http://<server-ip>"
  COMPOSE_ARGS=()
fi

# ── 2. docker ────────────────────────────────────────────────────────────────
step "Installing Docker (if needed)"
if command -v docker >/dev/null 2>&1; then
  ok "docker already installed: $(docker --version 2>/dev/null || echo present)"
else
  runsh "curl -fsSL https://get.docker.com | sudo sh"
  run sudo usermod -aG docker "$USER"
  ok "docker installed (group change applies on your next login)"
fi

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
fi

# ── 3. firewall ──────────────────────────────────────────────────────────────
step "Opening ports 80 and 443 in the VM firewall"
run sudo apt-get update -qq
run sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent
run sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
run sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
run sudo netfilter-persistent save
if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
  run sudo ufw allow 80/tcp
  run sudo ufw allow 443/tcp
fi
ok "VM firewall open for 80/443"
warn "Remember: the Oracle console's VCN security list must allow 80/443 too — see ORACLE.md step 4."

# ── 4. .env ──────────────────────────────────────────────────────────────────
step "Configuring the conference (.env)"
if [ -f .env ]; then
  ok ".env already exists — keeping it (edit it by hand to change anything)"
  ADMIN_EMAIL_SHOW="$(grep -E '^ADMIN_EMAIL=' .env | cut -d= -f2- || true)"
  ADMIN_PASS_SHOW="$(grep -E '^ADMIN_PASSWORD=' .env | cut -d= -f2- || true)"
else
  if [ -t 0 ]; then
    printf "  Your email (chair login): "
    read -r ADMIN_EMAIL_IN || ADMIN_EMAIL_IN=""
    printf "  Conference name [My Conference 2027]: "
    read -r CONF_NAME || CONF_NAME=""
  else
    ADMIN_EMAIL_IN=""
    CONF_NAME=""
  fi
  ADMIN_EMAIL_IN="${ADMIN_EMAIL_IN:-chair@example.org}"
  CONF_NAME="${CONF_NAME:-My Conference 2027}"
  ADMIN_PASS_GEN="$(openssl rand -base64 24 2>/dev/null | tr -d '/+=' | cut -c1-20 || echo "changeme$(date +%s)")"
  SHORT="$(echo "$CONF_NAME" | tr '[:lower:]' '[:upper:]' | tr -cd 'A-Z0-9' | cut -c1-6)"
  SHORT="${SHORT:-CONF}"

  if [ "$DRY_RUN" = 1 ]; then
    printf "  \033[90m[dry-run]\033[0m write .env (SEED_DEMO=0, ADMIN_EMAIL=%s, generated password)\n" "$ADMIN_EMAIL_IN"
  else
    # Values are quoted so the file is safe for both docker compose and shell use.
    cat > .env <<EOF
# Generated by deploy/oracle-setup.sh — keep this file private.
SEED_DEMO="0"
ADMIN_EMAIL="$ADMIN_EMAIL_IN"
ADMIN_PASSWORD="$ADMIN_PASS_GEN"
ADMIN_NAME="Conference Chair"
CONFERENCE_NAME="$CONF_NAME"
CONFERENCE_SHORT="$SHORT"
PUBLIC_HOST="$DOMAIN"
EOF
    chmod 600 .env
  fi
  ADMIN_EMAIL_SHOW="$ADMIN_EMAIL_IN"
  ADMIN_PASS_SHOW="$ADMIN_PASS_GEN"
  ok ".env written (chmod 600)"
fi

# ── 5. start the app ─────────────────────────────────────────────────────────
step "Building and starting CMT"
run $DOCKER compose "${COMPOSE_ARGS[@]}" up -d --build
if [ "$DRY_RUN" = 0 ]; then
  info "waiting for the app to come up…"
  for _ in $(seq 1 30); do
    if $DOCKER compose "${COMPOSE_ARGS[@]}" exec -T cmt \
        python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=3)" >/dev/null 2>&1; then
      ok "app is healthy"
      break
    fi
    sleep 2
  done
fi

# ── 6. keep-alive ping (also satisfies Oracle's idle-instance rule) ──────────
step "Adding a 5-minute keep-alive ping"
PING="*/5 * * * * curl -fsS -m 10 http://localhost/api/health >/dev/null 2>&1"
if crontab -l 2>/dev/null | grep -qF "$PING"; then
  ok "keep-alive already installed"
else
  runsh "(crontab -l 2>/dev/null; echo '$PING') | crontab -"
  ok "keep-alive installed (pings the app every 5 minutes)"
fi

# ── 7. summary ───────────────────────────────────────────────────────────────
PUBLIC_IP="$(curl -fsS -m 5 https://ifconfig.me 2>/dev/null || echo YOUR_SERVER_IP)"
printf "\n\033[1m────────────────────────────────────────────────────────────\033[0m\n"
ok "CMT is up."
if [ -n "$DOMAIN" ]; then
  printf "  URL           https://%s\n" "$DOMAIN"
  printf "                (Caddy gets the certificate within ~30s of DNS pointing here)\n"
else
  printf "  URL           http://%s\n" "$PUBLIC_IP"
fi
printf "  Chair login   %s\n" "${ADMIN_EMAIL_SHOW:-your .env ADMIN_EMAIL}"
printf "  Password      %s\n" "${ADMIN_PASS_SHOW:-your .env ADMIN_PASSWORD}"
printf "\n  Logs          %s compose logs -f cmt\n" "$DOCKER"
EXTRA="${COMPOSE_ARGS[*]:-}"
printf "  Restart       %s compose %srestart\n" "$DOCKER" "${EXTRA:+$EXTRA }"
printf "  Stop          %s compose %sdown\n" "$DOCKER" "${EXTRA:+$EXTRA }"
printf "  Backup        see 'Backups' in DEPLOY.md\n"
printf "\033[1m────────────────────────────────────────────────────────────\033[0m\n"
warn "Still to do in the Oracle console: allow TCP 80 and 443 in the VCN security list (ORACLE.md step 4)."
