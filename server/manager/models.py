"""What a downloaded model is, read from its own files in the Hugging Face cache: what it is for, the sampling it
recommends, the longest window it takes and its KV cache per token. Nothing here is guessed: a value the files
do not hold stays unknown.
"""

from __future__ import annotations

import json
from pathlib import Path

from .memory import kv_bytes_per_token, max_window

# Sampling fields the app shows, as generation_config.json names them.
SAMPLING = {
    "temperature": "temperature",
    "top_p": "topP",
    "top_k": "topK",
    "min_p": "minP",
    "repetition_penalty": "repetitionPenalty",
    "presence_penalty": "presencePenalty",
}


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def kind(config: dict, files: set[str]) -> str:
    """What the model is for, by its architecture: chat, embedding, speech (to text) or other."""
    names = [name for name in config.get("architectures") or [] if isinstance(name, str)]
    model_type = str(config.get("model_type", ""))
    if any("Whisper" in name for name in names) or model_type == "whisper":
        return "speech"
    if "modules.json" in files or "sentence_bert_config.json" in files:
        return "embedding"
    if any(name.endswith(("ForCausalLM", "ForConditionalGeneration", "LMHeadModel")) for name in names):
        return "chat"
    if any(name.endswith(("Model", "ForSequenceClassification", "ForMaskedLM")) for name in names):
        return "embedding"
    return "other"


def snapshot_kind(snapshot: Path) -> str:
    """What the model in one snapshot is for, without reading the rest of its description."""
    files = {path.name for path in snapshot.iterdir()} if snapshot.is_dir() else set()
    return kind(read_json(snapshot / "config.json"), files)


def sampling(generation: dict) -> dict:
    """The sampling the model recommends, under the app's names, as numbers only."""
    values = {}
    for source, target in SAMPLING.items():
        value = generation.get(source)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            values[target] = value
    return values


def describe(snapshot: Path) -> dict:
    """What the files in one snapshot say about the model."""
    files = {path.name for path in snapshot.iterdir()} if snapshot.is_dir() else set()
    config = read_json(snapshot / "config.json")
    weights = sum(path.stat().st_size for path in snapshot.glob("*.safetensors") if path.exists())
    return {
        "kind": kind(config, files),
        "sampling": sampling(read_json(snapshot / "generation_config.json")),
        "maxWindow": max_window(config),
        "kvBytesPerToken": kv_bytes_per_token(config),
        "weightsBytes": weights,
    }
