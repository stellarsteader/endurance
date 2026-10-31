#!/usr/bin/env bash
# Installs the Endurance vLLM manager on this server: checks Docker and the NVIDIA runtime, picks the vLLM image
# for this machine, makes the access token, and starts the manager on 127.0.0.1 only. Then it puts Tailscale Serve
# in front, which takes HTTPS connections from devices on the tailnet and passes them to that port, and prints the
# address (https://<server>.<tailnet>.ts.net/v1). Serve needs Tailscale signed in, with MagicDNS and HTTPS
# certificates on for the tailnet; without them the manager still runs, for this machine only. Run it again to change
# settings or after setting up Tailscale; the token is kept unless NEW_TOKEN=1.
#
#   ./install.sh                      # defaults
#   VLLM_IMAGE=vllm/vllm-openai:v0.x.y ./install.sh
#   PORT=8200 HF_HOME_HOST=/data/hf ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || fail "Docker is not installed. Install Docker Engine first: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is missing (docker compose)."
docker info >/dev/null 2>&1 || fail "Docker is not running, or this user cannot use it (add it to the docker group)."
command -v nvidia-smi >/dev/null || fail "nvidia-smi was not found. Install the NVIDIA driver."
docker info 2>/dev/null | grep -qi nvidia || say "Warning: Docker does not list the NVIDIA runtime. Install the NVIDIA Container Toolkit if models fail to see the GPU."

# The GPU and the memory the models share. Unified-memory machines (DGX Spark, GB10) report no separate GPU
# memory, so the whole system memory is what the models share.
GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1 | xargs)"
GPU_MIB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n1 | xargs || true)"
if [[ "$GPU_MIB" =~ ^[0-9]+$ ]]; then
  GPU_MEMORY_BYTES=$((GPU_MIB * 1024 * 1024))
else
  GPU_MEMORY_BYTES=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) * 1024 ))
fi
ARCH="$(uname -m)"

# The image every model starts with unless the app names another for it. DGX Spark (GB10, aarch64) needs an
# image built for it; check https://catalog.ngc.nvidia.com/orgs/nvidia/containers/vllm for a newer tag.
if [[ -z "${VLLM_IMAGE:-}" ]]; then
  if [[ "$ARCH" == "aarch64" && "$GPU_NAME" == *GB10* ]]; then VLLM_IMAGE="nvcr.io/nvidia/vllm:25.09-py3"
  else VLLM_IMAGE="vllm/vllm-openai:latest"; fi
fi

HF_HOME_HOST="${HF_HOME_HOST:-$HOME/.cache/huggingface}"
mkdir -p "$HF_HOME_HOST" state
PORT="${PORT:-8100}"

TOKEN=""
if [[ -f .env && "${NEW_TOKEN:-}" != "1" ]]; then TOKEN="$(grep -E '^MANAGER_TOKEN=' .env | cut -d= -f2- || true)"; fi
if [[ -z "$TOKEN" ]]; then TOKEN="$(openssl rand -hex 24)"; fi

umask 077
cat > .env <<ENV
MANAGER_TOKEN=$TOKEN
VLLM_IMAGE=$VLLM_IMAGE
GPU_NAME=$GPU_NAME
GPU_MEMORY_BYTES=$GPU_MEMORY_BYTES
HOST_HF_HOME=$HF_HOME_HOST
PORT=$PORT
ENV

say "GPU: $GPU_NAME, $((GPU_MEMORY_BYTES / 1024 / 1024 / 1024)) GB shared by the models"
say "vLLM image: $VLLM_IMAGE"
say "Model files: $HF_HOME_HOST"
docker compose up -d --build
say "Pulling the vLLM image now, so the first model starts sooner…"
docker pull "$VLLM_IMAGE" || say "Warning: could not pull $VLLM_IMAGE. Check the name, or set VLLM_IMAGE and run again."

# This machine's Tailscale state, read without jq: the backend state ("Running" once signed in), the MagicDNS name
# without its trailing dot, and whether the tailnet issues HTTPS certificates (yes or no), one per line.
tailscale_state() {
  local json
  json="$(tailscale status --json 2>/dev/null)" || return 0
  if command -v python3 >/dev/null; then
    printf '%s' "$json" | python3 -c '
import json, sys
status = json.load(sys.stdin)
print(status.get("BackendState") or "")
print(((status.get("Self") or {}).get("DNSName") or "").rstrip("."))
print("yes" if status.get("CertDomains") else "no")' 2>/dev/null || true
  else
    # The output is indented JSON, one field per line, and Self comes before Peer, so the first DNSName is this machine's.
    printf '%s\n' "$json" | sed -n 's/^ *"BackendState": *"\([^"]*\)".*/\1/p' | head -n1
    printf '%s\n' "$json" | sed -n 's/^ *"DNSName": *"\([^"]*\)".*/\1/p' | head -n1 | sed 's/\.$//'
    if printf '%s\n' "$json" | grep -q '"CertDomains": *\['; then say yes; else say no; fi
  fi
}

# Whether Serve already passes https://<name>:443/ to the manager's port, so a re-run need not ask for sudo.
serve_configured() {
  command -v python3 >/dev/null || return 1
  tailscale serve status --json 2>/dev/null | python3 -c '
import json, sys
name, target = sys.argv[1], sys.argv[2]
web = (json.load(sys.stdin) or {}).get("Web") or {}
handler = ((web.get(name + ":443") or {}).get("Handlers") or {}).get("/") or {}
sys.exit(0 if handler.get("Proxy") == target else 1)' "$1" "http://127.0.0.1:$PORT" 2>/dev/null
}

as_root() { if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi; }

CERT_LOG_NOTE="Tailscale's HTTPS certificates are listed in public certificate logs, so this machine's and the tailnet's names become public."
LOCAL="The manager listens only on this machine, where http://127.0.0.1:$PORT/v1 works. Other devices cannot reach it yet."

TS_STATE="" TS_NAME="" TS_CERTS=""
if command -v tailscale >/dev/null; then
  { read -r TS_STATE; read -r TS_NAME; read -r TS_CERTS; } < <(tailscale_state) || true
fi

say ""
if ! command -v tailscale >/dev/null || [[ "$TS_STATE" != "Running" ]]; then
  say "$LOCAL"
  say "Other devices connect through Tailscale. To set it up:"
  if command -v tailscale >/dev/null; then
    say "  1. Sign in to Tailscale on this server: sudo tailscale up"
  else
    say "  1. Install Tailscale on this server and sign in: curl -fsSL https://tailscale.com/install.sh | sh, then sudo tailscale up"
  fi
  say "  2. Run ./install.sh again."
  say "API key:  $TOKEN"
  exit 0
fi

if [[ -z "$TS_NAME" || "$TS_CERTS" != "yes" ]]; then
  say "$LOCAL"
  say "Tailscale is signed in, but HTTPS certificates are off for this tailnet, so Tailscale Serve cannot give the manager an HTTPS address."
  say "Turn on MagicDNS and HTTPS Certificates in the Tailscale admin console (https://login.tailscale.com/admin/dns), then run ./install.sh again."
  say "$CERT_LOG_NOTE"
  say "API key:  $TOKEN"
  exit 0
fi

if serve_configured "$TS_NAME"; then
  say "Tailscale Serve already passes https://$TS_NAME to the manager."
else
  [[ $EUID -eq 0 ]] || say "Setting up Tailscale Serve needs root, so it runs with sudo (it may ask for your password)."
  if ! as_root tailscale serve --bg "$PORT"; then
    say ""
    say "$LOCAL"
    say "Tailscale Serve could not be set up. Check that MagicDNS and HTTPS Certificates are on in the Tailscale admin"
    say "console (https://login.tailscale.com/admin/dns) and that Tailscale is up to date, then run ./install.sh again."
    say "API key:  $TOKEN"
    exit 1
  fi
fi

say ""
say "The manager is running. In Endurance, open Settings → Connections → Add server and enter:"
say "  Address:  https://$TS_NAME/v1"
say "  API key:  $TOKEN"
say "Then mark it as My server. The Mac must be signed in to the same tailnet."
say "$CERT_LOG_NOTE"
