"""The Endurance vLLM manager: one address for every model on this server.

- /v1/... is vLLM's OpenAI-compatible API, passed to the model's own container by the request's `model`. Its
  model list adds each model's `kind` (chat, embedding, speech or other), which vLLM itself does not report.
- /metrics is every running model's vLLM metrics together (each already labels its model).
- /manager/... lists the downloaded models with what their files say, starts and stops them at a window and
  memory share worked out here (./memory), downloads and deletes them, and shows their logs.

Every request needs the token (`Authorization: Bearer`), and comes from a private, loopback or VPN address
unless ALLOW_PUBLIC=1; the manager controls Docker, which is the whole server.
"""

from __future__ import annotations

import asyncio
import hmac
from contextlib import asynccontextmanager
import ipaddress
import json
import re
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

from .containers import Containers, Running
from .hub import Hub, valid_repo
from .memory import plan
from .models import snapshot_kind
from .settings import Settings

VERSION = "1"
# The window a model starts with when none is asked for and its files do not say.
FALLBACK_WINDOW = 8192
LEAST_WINDOW = 1024
VPN = ipaddress.ip_network("100.64.0.0/10")


def allowed_address(host: str | None) -> bool:
    """Loopback, private networks, link-local and the 100.64.0.0/10 range VPNs such as Tailscale use."""
    try:
        address = ipaddress.ip_address(host or "")
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_loopback or address.is_private or address.is_link_local or (address.version == 4 and address in VPN)


class Saved:
    """Each model's last window, image and arguments, so a start without them repeats the last one."""

    def __init__(self, folder: Path):
        self.file = folder / "models.json"

    def read(self) -> dict:
        try:
            value = json.loads(self.file.read_text())
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def get(self, repo: str) -> dict:
        value = self.read().get(repo)
        return value if isinstance(value, dict) else {}

    def put(self, repo: str, value: dict | None) -> None:
        data = self.read()
        if value is None:
            data.pop(repo, None)
        else:
            data[repo] = value
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_text(json.dumps(data, indent=2))


def create_app(settings: Settings, hub: Hub, containers: Containers, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    client = httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(10.0, read=None))

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await client.aclose()

    app = FastAPI(title="Endurance vLLM manager", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    saved = Saved(settings.state_dir)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.url.path == "/health":
            return await call_next(request)
        if not settings.allow_public and not allowed_address(request.client.host if request.client else None):
            return JSONResponse({"error": {"message": "This address may not use the manager. Connect from the same network or a VPN."}}, status_code=403)
        given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(given.encode(), settings.token.encode()):
            return JSONResponse({"error": {"message": "The manager token is missing or wrong."}}, status_code=401)
        return await call_next(request)

    async def ready(item: Running) -> bool:
        if item.state != "running":
            return False
        try:
            return (await client.get(f"{item.url}/health", timeout=2.0)).status_code == 200
        except httpx.HTTPError:
            return False

    async def status(running: dict[str, Running]) -> dict[str, str]:
        states = await asyncio.gather(*(ready(item) for item in running.values()))
        return {repo: "ready" if ok else "starting" for repo, ok in zip(running, states)}

    def checked(repo: str) -> str:
        if not valid_repo(repo):
            raise HTTPException(400, "Name a model as owner/name, as on Hugging Face.")
        return repo

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.get("/manager/info")
    async def info():
        return {"version": VERSION, "image": settings.image, "gpu": {"name": settings.gpu_name, "memoryBytes": settings.gpu_memory}}

    @app.get("/manager/models")
    async def models():
        running = containers.running()
        states = await status(running)
        listed = []
        for model in hub.models():
            item = running.get(model["id"])
            listed.append(
                {
                    **model,
                    "status": states.get(model["id"], "stopped"),
                    **({"window": item.window, "share": item.share, "image": item.image} if item else {}),
                    "saved": saved.get(model["id"]),
                }
            )
        return {"models": listed}

    def planned(repo: str, window: int | None):
        snapshot = hub.snapshot(repo)
        if snapshot is None:
            raise HTTPException(404, f"{repo} is not downloaded on this server.")
        model = next((item for item in hub.models() if item["id"] == repo), None) or {}
        others = {name: item.share for name, item in containers.running().items() if name != repo}
        longest = model.get("maxWindow") or FALLBACK_WINDOW
        if window is None:
            # Unset is the most the model takes that fits beside the running models.
            first = plan(weights=model.get("weightsBytes", 0), kv_per_token=model.get("kvBytesPerToken"), window=longest, total=settings.gpu_memory, running=others)
            window = longest if first.fits else min(longest, first.largest_window or 0)
            if window < LEAST_WINDOW:
                return first, longest
        window = max(LEAST_WINDOW, min(window, longest))
        return plan(weights=model.get("weightsBytes", 0), kv_per_token=model.get("kvBytesPerToken"), window=window, total=settings.gpu_memory, running=others), window

    @app.get("/manager/plan")
    async def plan_route(model: str, window: int | None = None):
        result, used = planned(checked(model), window)
        return {"window": used, "share": result.share, "needBytes": result.need_bytes, "fits": result.fits, "largestWindow": result.largest_window, "stop": result.stop, "message": result.message}

    @app.post("/manager/models/{repo:path}/start")
    async def start(repo: str, request: Request):
        repo = checked(repo)
        body = await request.json() if await request.body() else {}
        last = saved.get(repo)
        window = body.get("window", last.get("window"))
        image = body.get("image") or last.get("image") or settings.image
        args = body.get("args", last.get("args", []))
        if window is not None and not isinstance(window, int):
            raise HTTPException(400, "window is a number of tokens.")
        if not isinstance(image, str) or not re.fullmatch(r"[\w.\-/:@]+", image):
            raise HTTPException(400, "image is a Docker image name.")
        if not isinstance(args, list) or len(args) > 64 or not all(isinstance(arg, str) and 0 < len(arg) <= 500 for arg in args):
            raise HTTPException(400, "args is a list of vLLM arguments.")
        result, used = planned(repo, window)
        if not result.fits:
            return JSONResponse({"error": {"message": result.message}, "largestWindow": result.largest_window, "stop": result.stop}, status_code=409)
        running = containers.start(repo, window=used, share=result.share, image=image, args=args)
        saved.put(repo, {"window": window, "image": None if image == settings.image else image, "args": args})
        return {"id": repo, "status": "starting", "window": running.window, "share": running.share, "image": running.image}

    @app.post("/manager/models/{repo:path}/stop")
    async def stop(repo: str):
        return {"stopped": containers.stop(checked(repo))}

    @app.delete("/manager/models/{repo:path}")
    async def delete(repo: str):
        repo = checked(repo)
        containers.stop(repo)
        saved.put(repo, None)
        if not hub.delete(repo):
            raise HTTPException(404, f"{repo} is not downloaded on this server.")
        return {"deleted": True}

    @app.get("/manager/models/{repo:path}/logs")
    async def logs(repo: str, tail: int = 200):
        return PlainTextResponse(containers.logs(checked(repo), max(1, min(tail, 5000))))

    @app.post("/manager/downloads")
    async def download(request: Request):
        body = await request.json()
        repo = checked(str(body.get("model", "")))
        token = body.get("token")
        try:
            job = await asyncio.to_thread(hub.download, repo, token if isinstance(token, str) else None, body.get("revision"))
        except Exception as error:  # noqa: BLE001 - Hugging Face says why (gated, missing, no network)
            raise HTTPException(400, f"Could not start downloading {repo}: {str(error)[:300]}") from error
        return {"id": job.repo, "state": job.state, "totalBytes": job.total}

    @app.get("/manager/downloads")
    async def downloads():
        return {"downloads": hub.progress()}

    @app.get("/v1/models")
    async def v1_models():
        running = containers.running()
        states = await status(running)
        ready = [repo for repo in running if states[repo] == "ready"]
        snapshots = {repo: hub.snapshot(repo) for repo in ready}
        kinds = {repo: snapshot_kind(snapshot) for repo, snapshot in snapshots.items() if snapshot is not None}
        return {
            "object": "list",
            "data": [{"id": repo, "object": "model", "owned_by": "vllm", "max_model_len": running[repo].window, **({"kind": kinds[repo]} if repo in kinds else {})} for repo in ready],
        }

    @app.get("/metrics")
    async def metrics():
        running = containers.running()
        texts = []
        for item in running.values():
            try:
                response = await client.get(f"{item.url}/metrics", timeout=3.0)
                if response.status_code == 200:
                    texts.append(response.text)
            except httpx.HTTPError:
                continue
        return PlainTextResponse("\n".join(texts))

    def model_of(body: bytes, content_type: str) -> str | None:
        if "multipart/form-data" in content_type:
            match = re.search(rb'name="model"\r\n\r\n([^\r\n]+)', body)
            return match.group(1).decode() if match else None
        try:
            value = json.loads(body)
        except ValueError:
            return None
        return value.get("model") if isinstance(value, dict) and isinstance(value.get("model"), str) else None

    @app.api_route("/v1/{path:path}", methods=["POST"])
    async def proxy(path: str, request: Request):
        body = await request.body()
        repo = model_of(body, request.headers.get("content-type", ""))
        running = containers.running()
        item = running.get(repo or "")
        if item is None:
            return JSONResponse({"error": {"message": f"The model `{repo}` does not exist on this server, or is stopped."}}, status_code=404)
        if not await ready(item):
            return JSONResponse({"error": {"message": f"{repo} is still starting. Try again in a moment."}}, status_code=503)
        upstream = client.build_request("POST", f"{item.url}/v1/{path}", content=body, headers={"content-type": request.headers.get("content-type", "application/json")})
        response = await client.send(upstream, stream=True)

        async def chunks():
            try:
                async for chunk in response.aiter_bytes():
                    yield chunk
            finally:
                await response.aclose()

        return StreamingResponse(chunks(), status_code=response.status_code, media_type=response.headers.get("content-type"))

    return app


def main() -> None:  # pragma: no cover - the container's entry point
    import uvicorn

    from .containers import DockerContainers

    settings = Settings.from_env()
    uvicorn.run(create_app(settings, Hub(settings.hf_home), DockerContainers(settings)), host="0.0.0.0", port=8100, proxy_headers=False)
