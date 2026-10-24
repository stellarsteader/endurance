"""The manager's settings, from the environment that server/install.sh writes to server/.env."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    # The token every request carries as `Authorization: Bearer <token>`; the app keeps it in the keychain.
    token: str
    # The Hugging Face cache as this container sees it, and as the host sees it (model containers mount the host path).
    hf_home: Path
    host_hf_home: str
    # Where the manager keeps each model's last settings.
    state_dir: Path
    # The vLLM image a model starts with unless the app names another for it.
    image: str
    # The GPU memory the shares are taken of (bytes); unified-memory machines such as DGX Spark count all of it.
    gpu_memory: int
    gpu_name: str
    # The Docker network the manager and the model containers share.
    network: str
    # Only private and VPN addresses may connect unless this is set.
    allow_public: bool

    @staticmethod
    def from_env() -> "Settings":
        token = os.environ.get("MANAGER_TOKEN", "")
        if len(token) < 24:
            raise SystemExit("MANAGER_TOKEN is missing or too short. Run server/install.sh.")
        return Settings(
            token=token,
            hf_home=Path(os.environ.get("HF_HOME", "/hf")),
            host_hf_home=os.environ.get("HOST_HF_HOME", ""),
            state_dir=Path(os.environ.get("STATE_DIR", "/state")),
            image=os.environ.get("VLLM_IMAGE", "vllm/vllm-openai:latest"),
            gpu_memory=int(os.environ.get("GPU_MEMORY_BYTES", "0") or 0),
            gpu_name=os.environ.get("GPU_NAME", ""),
            network=os.environ.get("DOCKER_NETWORK", "endurance"),
            allow_public=os.environ.get("ALLOW_PUBLIC", "") == "1",
        )
