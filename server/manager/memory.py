"""How much GPU memory a model's vLLM process is given, decided before it starts.

vLLM takes a share of the GPU's whole memory (--gpu-memory-utilization) when it starts: the weights, then KV
cache for the window. Several models on one GPU each take their own share, and the shares must add up to less
than the whole. So the share is worked out from the model itself, never typed in:

    need  = weights + KV bytes per token x window x SEQUENCES + overhead
    share = need / GPU memory

and a model only starts when its share and the shares of the models already running stay under LIMIT. When it
does not fit, the refusal says what would: which running models to stop, or the largest window that fits now.
"""

from __future__ import annotations

from dataclasses import dataclass, field

GIB = 1024**3
# Sequences the KV cache is sized for at the full window: a chat and a few subagents at once.
SEQUENCES = 4
# CUDA context, activations and graphs, beside the weights and the KV cache.
OVERHEAD_BYTES = 2 * GIB
OVERHEAD_SHARE = 0.05
# What all running models may take of the GPU together; the rest is left to the system.
LIMIT = 0.9
# The least a share is rounded up to, so a tiny model still starts with room to work.
LEAST_SHARE = 0.05


def _text_config(config: dict) -> dict:
    """Vision-language models keep the language model's numbers under text_config."""
    nested = config.get("text_config")
    return nested if isinstance(nested, dict) else config


def kv_bytes_per_token(config: dict, cache_bytes: int = 2) -> int | None:
    """KV cache bytes one token takes: keys and values, every layer, every KV head. None when config does not say."""
    text = _text_config(config)
    layers = text.get("num_hidden_layers")
    heads = text.get("num_attention_heads")
    kv_heads = text.get("num_key_value_heads") or heads
    head_dim = text.get("head_dim") or (text.get("hidden_size") // heads if text.get("hidden_size") and heads else None)
    if not all(isinstance(value, int) and value > 0 for value in (layers, kv_heads, head_dim)):
        return None
    return 2 * layers * kv_heads * head_dim * cache_bytes


def max_window(config: dict) -> int | None:
    """The longest window the model was made for."""
    text = _text_config(config)
    for key in ("max_position_embeddings", "max_sequence_length", "seq_length"):
        value = text.get(key)
        if isinstance(value, int) and value > 0:
            return value
    return None


@dataclass
class Plan:
    """What starting a model at a window would take, and whether it fits beside the models running."""

    share: float
    need_bytes: int
    fits: bool
    # The largest window that fits beside the running models, when the asked one does not.
    largest_window: int | None = None
    # Running models whose shares would make room, largest first.
    stop: list[str] = field(default_factory=list)
    message: str = ""


def plan(
    *,
    weights: int,
    kv_per_token: int | None,
    window: int,
    total: int,
    running: dict[str, float],
    limit: float = LIMIT,
) -> Plan:
    if total <= 0:
        return Plan(share=0, need_bytes=0, fits=False, message="The GPU's memory is not known. Set GPU_MEMORY_BYTES in server/.env.")
    kv = (kv_per_token or 0) * window * SEQUENCES
    need = int((weights + kv + OVERHEAD_BYTES) * (1 + OVERHEAD_SHARE))
    share = max(LEAST_SHARE, round(need / total + 0.005, 2))
    taken = sum(running.values())
    if share + taken <= limit:
        return Plan(share=share, need_bytes=need, fits=True)
    # What would fit now: the window the free share leaves, and the running models that would free enough.
    free = (limit - taken) * total / (1 + OVERHEAD_SHARE) - weights - OVERHEAD_BYTES
    largest = int(free // ((kv_per_token or 1) * SEQUENCES)) if kv_per_token and free > 0 else None
    largest = (largest // 1024) * 1024 if largest and largest >= 1024 else None
    stop: list[str] = []
    freed = 0.0
    for name, used in sorted(running.items(), key=lambda item: -item[1]):
        if share + taken - freed <= limit:
            break
        stop.append(name)
        freed += used
    if share + taken - freed > limit:
        stop = []
    parts = [f"Needs about {need / GIB:.1f} GB ({share:.0%} of the GPU); {taken:.0%} is taken by running models and up to {limit:.0%} can be used."]
    if largest:
        parts.append(f"A window of up to {largest} tokens fits now.")
    if stop:
        parts.append(f"Stopping {', '.join(stop)} would make room.")
    if not largest and not stop:
        parts.append("The model does not fit on this GPU at this window.")
    return Plan(share=share, need_bytes=need, fits=False, largest_window=largest, stop=stop, message=" ".join(parts))
