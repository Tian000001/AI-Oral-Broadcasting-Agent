"""云端声音克隆：MiniMax 声音复刻。

MiniMax 提供「声音复刻」能力：传入参考音频克隆出 voice_id，再用该 voice_id 合成语音。
- 克隆：``POST /v1/voice_clone``（form 上传音频 + 自定义 voice_id）。
- 合成：``POST /v1/t2a_v2``（speech-02 系列模型）。

鉴权使用 Bearer api_key（来自 [voice_clone] 段或环境变量 MINIMAX_API_KEY）。
"""
from __future__ import annotations

import base64
import json
import os
import uuid

from .. import VoiceCloneProvider, ProviderInfo, register
from .._common import (
    base_url,
    ensure_httpx,
    unique_output,
    read_api_credentials,
    ProviderConfigError,
    ProviderError,
)

_MINIMAX_CLONE_URL = "https://api.minimax.io/v1/voice_clone"
_MINIMAX_TTS_URL = "https://api.minimax.io/v1/t2a_v2"


@register
class CloudMiniMaxVoiceProvider(VoiceCloneProvider):
    info = ProviderInfo(
        name="cloud_minimax",
        label="MiniMax 声音复刻（云端）",
        channel="cloud",
        requires_gpu=False,
    )

    @classmethod
    def from_config(cls, cfg):
        return cls()

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._key()}"}

    def _key(self) -> str:
        return read_api_credentials(dict(config.voice_clone), key_env="MINIMAX_API_KEY")

    def clone(self, *, sample_audio: str, **kwargs) -> str:
        if not os.path.isfile(sample_audio):
            raise ProviderConfigError(f"参考音频不存在: {sample_audio}")
        httpx = ensure_httpx()
        url = base_url(dict(config.voice_clone), _MINIMAX_CLONE_URL)
        voice_id = kwargs.get("voice_id") or f"mpt_clone_{uuid.uuid4().hex[:12]}"
        with open(sample_audio, "rb") as fp:
            b64 = base64.b64encode(fp.read()).decode()
        payload = {
            "voice_id": voice_id,
            "file": b64,
            "extra_param": json.dumps({"bitrate": 128000, "channel": 1}),
        }
        try:
            resp = httpx.post(url, json=payload, headers=self._headers(), timeout=120)
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            raise ProviderError(f"MiniMax 声音克隆失败: {exc}") from exc
        return data.get("voice_id") or voice_id

    def synthesize(self, *, text: str, voice_id: str, **kwargs) -> str:
        httpx = ensure_httpx()
        url = base_url(dict(config.voice_clone), _MINIMAX_TTS_URL)
        payload = {
            "model": kwargs.get("model", "speech-02-hd"),
            "text": text,
            "voice_setting": {
                "voice_id": voice_id,
                "speed": float(kwargs.get("speed", 1.0)),
                "vol": float(kwargs.get("vol", 1.0)),
                "pitch": float(kwargs.get("pitch", 0.0)),
            },
            "audio_setting": {
                "sample_rate": int(kwargs.get("sample_rate", 32000)),
                "bitrate": int(kwargs.get("bitrate", 128000)),
                "format": kwargs.get("format", "mp3"),
            },
        }
        try:
            resp = httpx.post(url, json=payload, headers=self._headers(), timeout=180)
            resp.raise_for_status()
            content = resp.content
            ctype = resp.headers.get("content-type", "")
            if "application/json" in ctype:
                content = base64.b64decode(resp.json().get("data", {}).get("audio", ""))
            if not content:
                raise ProviderError("MiniMax 合成返回空音频。")
        except Exception as exc:
            raise ProviderError(f"MiniMax 语音合成失败: {exc}") from exc
        out = unique_output("minimax_voice", "mp3")
        with open(out, "wb") as fp:
            fp.write(content)
        return out
