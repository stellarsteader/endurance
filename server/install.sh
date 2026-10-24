#!/usr/bin/env bash
# Installs the Endurance vLLM manager on this server: checks Docker and the NVIDIA runtime, picks the vLLM image
# for this machine, makes the access token, and starts the manager. Run it again to change settings; the token is
# kept unless NEW_TOKEN=1.
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

ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
say ""
say "The manager is running. In Endurance, open Settings → Connections → Add server and enter:"
say "  Address:  http://${ADDRESS:-<this server>}:$PORT/v1"
say "  API key:  $TOKEN"
say "Then mark it as My server. It accepts only private and VPN addresses (such as Tailscale)."
