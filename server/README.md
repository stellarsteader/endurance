# Endurance vLLM manager

Serves every vLLM model on a GPU server through one address for Endurance. Each model runs
in its own vLLM container, started at the context window you pick in Endurance, with a GPU memory share sized so the
running models fit together. The manager also downloads models from Hugging Face.

## Requirements

- Docker Engine with Compose v2
- NVIDIA driver and NVIDIA Container Toolkit
- Tailscale on the server and on every device that connects to it, signed in to the same tailnet, with MagicDNS and
  HTTPS Certificates turned on (admin console → DNS)

## Install

```bash
git clone <this repository> && cd endurance/server
./install.sh
```

The script:

1. Picks a vLLM image for this machine.
2. Creates an access token and writes the settings to `.env`.
3. Starts the manager on `127.0.0.1:8100`.
4. Sets up Tailscale Serve (with `sudo`) to forward `https://<server>.<tailnet>.ts.net` to that port.
5. Prints the address and token.

If Tailscale is missing, signed out, or has HTTPS certificates off, the manager still starts but only the server can
reach it, at `http://127.0.0.1:8100/v1`. Fix Tailscale and run the script again.

### Options

Set these as environment variables and rerun `./install.sh`:

| Variable | Default | |
|---|---|---|
| `VLLM_IMAGE` | picked per machine | Image models start with unless Endurance names another |
| `PORT` | `8100` | Loopback port the manager listens on |
| `HF_HOME_HOST` | `~/.cache/huggingface` | Where model files are stored |
| `NEW_TOKEN=1` | | Replace the token |

## Connect Endurance

In Settings → Connections → Add server, enter `https://<server>.<tailnet>.ts.net/v1` and use the token as the API
key. Mark the connection as **My server** to manage models from the app.

## API

All routes except `/health` need `Authorization: Bearer <token>`. Models are named `owner/name`, as on Hugging Face.

| Route | |
|---|---|
| `POST /v1/...` | vLLM's OpenAI-compatible API, routed to the model named in the request |
| `GET /v1/models` | Running, ready models and their windows |
| `GET /metrics` | vLLM metrics from every running model |
| `GET /health` | Liveness check |
| `GET /manager/info` | Version, default image, GPU name and memory |
| `GET /manager/models` | Downloaded models: kind, recommended sampling, max window, size, status |
| `POST /manager/models/{owner/name}/start` | Start or restart with `window`, `image`, `args`. Omitted fields reuse the last start |
| `POST /manager/models/{owner/name}/stop` | Stop |
| `DELETE /manager/models/{owner/name}` | Stop and delete the files |
| `GET /manager/models/{owner/name}/logs` | Recent container logs |
| `GET /manager/plan?model=&window=` | Check whether a model fits beside the running ones |
| `POST /manager/downloads` | Download from Hugging Face. Pass `token` for gated models; it is not stored |
| `GET /manager/downloads` | Download progress |

A start that doesn't fit is refused with the largest window that fits now and the models you could stop to make room.
Without a window, a model gets the largest one that fits.

## Security

The manager controls Docker, which means it controls the server.

- Every request needs the token.
- The port is bound to `127.0.0.1`. Other devices reach it only through Tailscale Serve, over HTTPS, from your
  tailnet.
- Model containers publish no ports.

Tailscale's HTTPS certificates appear in public certificate logs, so your server and tailnet names are public.

To check or turn off forwarding:

```bash
tailscale serve status
sudo tailscale serve --https=443 off
```
