"""Models in the server's Hugging Face cache: listing them, downloading one in the background with its progress,
and deleting one. A token for gated models comes with each download request from the app and is used for that
download only; it is never stored.
"""

from __future__ import annotations

import shutil
import threading
from dataclasses import dataclass, field
from pathlib import Path

from .models import describe

# Weights in other formats are left out when safetensors are there; vLLM reads safetensors.
IGNORE = ["*.pt", "*.pth", "*.bin", "*.onnx", "*.gguf", "*.h5", "*.msgpack", "original/*", "onnx/*"]


def repo_folder(cache: Path, repo: str) -> Path:
    return cache / f"models--{repo.replace('/', '--')}"


def valid_repo(repo: str) -> bool:
    parts = repo.split("/")
    return len(parts) == 2 and all(part and len(part) <= 96 and all(char.isalnum() or char in "-_." for char in part) for part in parts) and ".." not in repo


@dataclass
class Download:
    repo: str
    total: int = 0
    state: str = "downloading"  # downloading | done | failed
    error: str = ""
    thread: threading.Thread | None = field(default=None, repr=False)


class Hub:
    def __init__(self, hf_home: Path):
        self.cache = hf_home / "hub"
        self.downloads: dict[str, Download] = {}

    def snapshot(self, repo: str) -> Path | None:
        """The newest downloaded snapshot of the model."""
        snapshots = repo_folder(self.cache, repo) / "snapshots"
        if not snapshots.is_dir():
            return None
        found = sorted((path for path in snapshots.iterdir() if path.is_dir()), key=lambda path: path.stat().st_mtime)
        return found[-1] if found else None

    def size(self, repo: str) -> int:
        folder = repo_folder(self.cache, repo)
        return sum(path.stat().st_size for path in folder.rglob("*") if path.is_file() and not path.is_symlink()) if folder.is_dir() else 0

    def models(self) -> list[dict]:
        """Every model with a complete snapshot, with what its files say."""
        if not self.cache.is_dir():
            return []
        result = []
        for folder in sorted(self.cache.glob("models--*")):
            repo = folder.name.removeprefix("models--").replace("--", "/", 1)
            if repo in self.downloads and self.downloads[repo].state == "downloading":
                continue
            snapshot = self.snapshot(repo)
            if snapshot is None:
                continue
            result.append({"id": repo, "sizeBytes": self.size(repo), **describe(snapshot)})
        return result

    def download(self, repo: str, token: str | None = None, revision: str | None = None) -> Download:
        from huggingface_hub import HfApi, snapshot_download

        current = self.downloads.get(repo)
        if current and current.state == "downloading":
            return current
        api = HfApi(token=token or None)
        info = api.model_info(repo, revision=revision, files_metadata=True)
        import fnmatch

        total = sum(
            sibling.size or 0
            for sibling in info.siblings or []
            if not any(fnmatch.fnmatch(sibling.rfilename, pattern) for pattern in IGNORE)
        )
        job = Download(repo=repo, total=total)

        def run() -> None:
            try:
                snapshot_download(repo, revision=revision, token=token or None, cache_dir=str(self.cache), ignore_patterns=IGNORE)
                job.state = "done"
            except Exception as error:  # noqa: BLE001 - the app shows the reason
                job.state = "failed"
                job.error = str(error)[:500]

        job.thread = threading.Thread(target=run, daemon=True)
        self.downloads[repo] = job
        job.thread.start()
        return job

    def progress(self) -> list[dict]:
        return [
            {"id": job.repo, "state": job.state, "doneBytes": min(self.size(job.repo), job.total) if job.total else self.size(job.repo), "totalBytes": job.total, "error": job.error}
            for job in self.downloads.values()
        ]

    def delete(self, repo: str) -> bool:
        folder = repo_folder(self.cache, repo)
        if not folder.is_dir():
            return False
        shutil.rmtree(folder)
        self.downloads.pop(repo, None)
        return True
