#!/usr/bin/env bash
# =============================================================================
# One-time server bootstrap for a fresh Ubuntu 22.04/24.04 VPS (Hetzner / DigitalOcean, 4–8 GB).
# Run ONCE as root, on the server:
#
#   curl -fsSL https://raw.githubusercontent.com/<org>/bmstore/main/deploy/server-setup.sh -o server-setup.sh
#   sudo bash server-setup.sh --ssh-key "ssh-ed25519 AAAA... you@laptop" [--ci-key "ssh-ed25519 AAAA... github-deploy"]
#
# What it does (idempotent — safe to re-run):
#   * apt update/upgrade, base tools, Docker Engine + compose plugin (official repo), log rotation for containers
#   * user "deploy" (docker group, passwordless sudo), SSH key(s) installed, optional CI key locked to the deploy script
#   * SSH: keys only, no root login, no passwords  (validated with sshd -t before reload; your session stays open)
#   * ufw: deny in, allow SSH(port autodetected)/80/443(tcp+udp)
#   * fail2ban (sshd jail), unattended-upgrades (security, auto-reboot 04:45 UTC), 2 GB swap, UTC timezone
#   * directories: /opt/bmstore (deploy), /etc/bmstore (root:deploy 750), /var/lib/bmstore, /var/log/bmstore
# It does NOT clone the repo or write secrets — GO_LIVE.md continues from there.
# =============================================================================
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

DEPLOY_USER=deploy; SSH_KEY=""; CI_KEY=""; APP_DIR=/opt/bmstore
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) DEPLOY_USER="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --ssh-key-file) SSH_KEY="$(cat "$2")"; shift 2 ;;
    --ci-key) CI_KEY="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done
if [[ -z "$SSH_KEY" ]]; then
  # fall back to the key you logged in with as root (cloud providers put it in root's authorized_keys)
  if [[ -s /root/.ssh/authorized_keys ]]; then SSH_KEY="$(grep -v '^#' /root/.ssh/authorized_keys | head -n 5)"; echo "using root's authorized_keys for $DEPLOY_USER"; fi
fi
[[ -n "$SSH_KEY" ]] || { echo "no SSH public key given (--ssh-key) and none in /root/.ssh/authorized_keys — refusing: you would be locked out"; exit 2; }
log() { printf '\n==> %s\n' "$*"; }

log "packages"
apt-get update -q
apt-get -y -q upgrade
apt-get install -y -q ca-certificates curl gnupg lsb-release ufw fail2ban unattended-upgrades apt-listchanges git jq cron logrotate openssl

log "docker engine (official repository)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
install -d /etc/docker
if [[ ! -s /etc/docker/daemon.json ]]; then
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true,
  "default-address-pools": [ { "base": "172.20.0.0/16", "size": 24 } ]
}
JSON
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

log "user $DEPLOY_USER"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then adduser --disabled-password --gecos "BMStore deploy" "$DEPLOY_USER"; fi
usermod -aG docker,sudo "$DEPLOY_USER"
# Passwordless sudo: this user is root-equivalent anyway via the docker group. Tighten later if you add more admins.
echo "$DEPLOY_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$DEPLOY_USER"; chmod 440 "/etc/sudoers.d/90-$DEPLOY_USER"
HOME_DIR="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$HOME_DIR/.ssh"
touch "$HOME_DIR/.ssh/authorized_keys"
while IFS= read -r k; do [[ -n "$k" ]] && ! grep -qF "$k" "$HOME_DIR/.ssh/authorized_keys" && echo "$k" >> "$HOME_DIR/.ssh/authorized_keys"; done <<< "$SSH_KEY"
if [[ -n "$CI_KEY" ]]; then
  line="command=\"$APP_DIR/deploy/ci-entry.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $CI_KEY"
  grep -qF "$CI_KEY" "$HOME_DIR/.ssh/authorized_keys" || echo "$line" >> "$HOME_DIR/.ssh/authorized_keys"
fi
chmod 600 "$HOME_DIR/.ssh/authorized_keys"; chown -R "$DEPLOY_USER:$DEPLOY_USER" "$HOME_DIR/.ssh"

log "directories"
install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR" /var/lib/bmstore /var/log/bmstore
install -d -m 750 -o root -g "$DEPLOY_USER" /etc/bmstore

log "sshd hardening"
SSH_PORT="$(sshd -T 2>/dev/null | awk '$1=="port"{print $2; exit}')"; SSH_PORT="${SSH_PORT:-22}"
install -d /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/90-bmstore.conf <<'CONF'
# BMStore hardening (deploy/server-setup.sh). Keys only.
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
PermitEmptyPasswords no
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
CONF
# Ubuntu cloud images may ship a 50-cloud-init.conf that re-enables passwords; our 90- file wins only if it is parsed first.
# sshd uses the FIRST value seen, so move ours to the front:
mv /etc/ssh/sshd_config.d/90-bmstore.conf /etc/ssh/sshd_config.d/00-bmstore.conf
if sshd -t; then systemctl reload ssh 2>/dev/null || systemctl reload sshd; echo "sshd reloaded (port $SSH_PORT). Keep this session open and test a NEW login as $DEPLOY_USER before logging out."; else echo "sshd config test FAILED — not reloading"; rm -f /etc/ssh/sshd_config.d/00-bmstore.conf; fi

log "firewall (ufw)"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow "$SSH_PORT/tcp" comment 'SSH'
ufw allow 80/tcp comment 'HTTP (ACME + redirect)'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 443/udp comment 'HTTP/3'
ufw logging low
ufw --force enable
# Note: Docker publishes ports by writing iptables rules directly; only Caddy publishes anything (80/443), which matches this policy.

log "fail2ban"
cat > /etc/fail2ban/jail.local <<CONF
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
port    = $SSH_PORT
mode    = aggressive
CONF
systemctl enable --now fail2ban >/dev/null; systemctl restart fail2ban

log "unattended security upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Unattended-Upgrade "1";
CONF
cat > /etc/apt/apt.conf.d/52bmstore-unattended <<'CONF'
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:45";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
CONF
systemctl enable --now unattended-upgrades >/dev/null

log "swap + misc"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null; echo 'vm.swappiness=10' > /etc/sysctl.d/90-bmstore.conf
fi
timedatectl set-timezone UTC || true
systemctl enable --now cron >/dev/null

cat <<MSG

======================================================================
Server bootstrap complete.
  deploy user : $DEPLOY_USER   (ssh -p $SSH_PORT $DEPLOY_USER@<server-ip>)
  app dir     : $APP_DIR       env file: /etc/bmstore/production.env (not created yet)
  firewall    : $(ufw status | head -1) — SSH $SSH_PORT, 80, 443
IMPORTANT: open a NEW terminal and confirm you can log in as $DEPLOY_USER BEFORE closing this one.
Continue with docs/runbooks/GO_LIVE.md step 3.
======================================================================
MSG
