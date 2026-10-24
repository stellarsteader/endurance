"""One vLLM container per model, started and stopped through Docker. A model's window, memory share and image are
written on its container as labels, so what runs is read back from Docker itself after the manager restarts.
Model containers publish no port: only the manager, on the same Docker network, reaches them.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Protocol

from .settings import Settings

LABEL = "dev.endurance.model"


def container_name(repo: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", repo.lower()).strip("-")[:40]
    return f"endurance-vllm-{slug}-{hashlib.sha256(repo.encode()).hexdigest()[:8]}"


@dataclass
class Running:
    repo: str
    window: int
    share: float
    image: str
    # created | running | exited | restarting …, as Docker says.
    state: str
    url: str


class Containers(Protocol):
    def running(self) -> dict[str, Running]: ...
    def start(self, repo: str, *, window: int, share: float, image: str, args: list[str]) -> Running: ...
    def stop(self, repo: str) -> bool: ...
    def logs(self, repo: str, tail: int) -> str: ...


class DockerContainers:
    def __init__(self, settings: Settings):
        import docker

        self.settings = settings
        self.client = docker.from_env()

    def _running(self, container) -> Running:
        labels = container.labels
        return Running(
            repo=labels[LABEL],
            window=int(labels.get(f"{LABEL}.window", "0")),
            share=float(labels.get(f"{LABEL}.share", "0")),
            image=labels.get(f"{LABEL}.image", ""),
            state=container.status,
            url=f"http://{container.name}:8000",
        )

    def running(self) -> dict[str, Running]:
        found = self.client.containers.list(all=True, filters={"label": LABEL})
        return {item.repo: item for item in (self._running(container) for container in found) if item.state != "exited"}

    def start(self, repo: str, *, window: int, share: float, image: str, args: list[str]) -> Running:
        import docker

        self.stop(repo)
        container = self.client.containers.run(
            image,
            entrypoint=["vllm", "serve"],
            command=[repo, "--served-model-name", repo, "--max-model-len", str(window), "--gpu-memory-utilization", f"{share:.2f}", "--host", "0.0.0.0", "--port", "8000", *args],
            name=container_name(repo),
            detach=True,
            network=self.settings.network,
            # The weights are read from the shared cache, never fetched at start.
            environment={"HF_HOME": "/hf", "HF_HUB_OFFLINE": "1"},
            volumes={self.settings.host_hf_home: {"bind": "/hf", "mode": "rw"}},
            device_requests=[docker.types.DeviceRequest(count=-1, capabilities=[["gpu"]])],
            ipc_mode="host",
            restart_policy={"Name": "unless-stopped"},
            labels={LABEL: repo, f"{LABEL}.window": str(window), f"{LABEL}.share": f"{share:.2f}", f"{LABEL}.image": image},
        )
        return self._running(container)

    def stop(self, repo: str) -> bool:
        import docker

        try:
            container = self.client.containers.get(container_name(repo))
        except docker.errors.NotFound:
            return False
        container.remove(force=True)
        return True

    def logs(self, repo: str, tail: int) -> str:
        import docker

        try:
            container = self.client.containers.get(container_name(repo))
        except docker.errors.NotFound:
            return ""
        return container.logs(tail=tail).decode("utf-8", errors="replace")
