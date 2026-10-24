# Endurance vLLM manager

Runs on your own GPU server (for example a DGX Spark) and gives Endurance one address for every model on it. vLLM
serves one model per process and has no API to change a model's window or to download one, so the manager does
that: each model runs in its own vLLM container, started at the window you choose in Endurance, with a memory share
worked out so the models fit together.

## Install

Needs Docker Engine with Compose v2, the NVIDIA driver and the NVIDIA Container Toolkit.

```bash
git clone <this repository> && cd endurance/server
./install.sh
```

The script picks the vLLM image for the machine (`nvcr.io/nvidia/vllm` for DGX Spark, `vllm/vllm-openai` elsewhere),
makes an access token, starts the manager on port 8100 and prints what to enter in Endurance:

- Settings → Connections → Add server: the address it prints (`http://<server>:8100/v1`) and the token as the API key.
- Mark the connection as **My server**.

Options, as environment variables: `VLLM_IMAGE` (another default image), `PORT`, `HF_HOME_HOST` (where model files
go; `~/.cache/huggingface` by default), `NEW_TOKEN=1` (replace the token). Run the script again to apply them.

## What it does

| Route | |
|---|---|
| `POST /v1/...` | vLLM's OpenAI-compatible API, passed to the model named in the request |
| `GET /v1/models` | The models that are running and ready, with their window |
| `GET /metrics` | Every running model's vLLM metrics |
| `GET /manager/models` | Downloaded models: kind (chat, embedding, speech), recommended sampling, longest window, size, status |
| `POST /manager/models/{owner/name}/start` | Start, or restart with a new `window` (tokens), `image` or `args` |
| `POST /manager/models/{owner/name}/stop` | Stop |
| `DELETE /manager/models/{owner/name}` | Stop and delete its files |
| `GET /manager/models/{owner/name}/logs` | The container's last lines |
| `GET /manager/plan?model=&window=` | Whether it fits beside the running models, before starting |
| `POST /manager/downloads` / `GET /manager/downloads` | Download from Hugging Face (`token` for gated models, used once, not stored), and progress |

A start that does not fit is refused before anything starts, with the largest window that fits now and which running
models would make room. A model started without a window gets the most it takes that fits.

## Security

The manager controls Docker, which is the whole server. Every request needs the token, and only loopback, private
network and VPN (100.64.0.0/10, as Tailscale uses) addresses may connect. Use a VPN rather than opening the port to
the internet; `ALLOW_PUBLIC=1` in `.env` lifts the address check, but put it behind HTTPS if you do.

## Using it from outside your network

Use Tailscale rather than forwarding a port: nothing is opened to the internet, and the manager already accepts
Tailscale addresses (100.64.0.0/10).

1. Install Tailscale on the server and sign in: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`.
2. Install Tailscale on the Mac and sign in with the same account.
3. In Endurance, use the server's Tailscale address in the connection: `http://<server>.<tailnet>.ts.net:8100/v1`
   (or its `100.x.y.z` address, from `tailscale ip -4` on the server), with the same token.

Only the manager's port is used; the model containers publish none.
