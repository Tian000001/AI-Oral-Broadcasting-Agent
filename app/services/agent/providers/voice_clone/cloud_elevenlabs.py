"""云端声音克隆：ElevenLabs。

ElevenLabs 提供成熟的声音克隆（Voice Cloning）：
- 克隆：``POST /v1/voices/add``（multipart 上传音频，返回 voice_id）。
- 合成：``POST /v1/text-to-speech/{voice_id}``（返回音频二进制）。

鉴权使用 ``xi-api-key``（来自 [voice_clone] 段或环境变量 ELEVENLABS_API_KEY）。
"""
from __future__ import annotations

import os
import uuid

from .. import VoiceCloneProvider, ProviderInfo, register
from .._common import (
    ensure_httpx,
    unique_output,
    read_api_credentials,
    ProviderConfigError,
    ProviderError,
)

_ELEVEN_BASE = "https://api.elevenlabs.io"


@register
class CloudElevenLabsVoiceProvider(VoiceCloneProvider):
    info = ProviderInfo(
        name="cloud_elevenlabs",
        label="ElevenLabs 声音克隆（云端）",
        channel="cloud",
        requires_gpu=False,
    )

    @classmethod
    def from_config(cls, cfg):
        return cls()

    def _key(self) -> str:
        return read_api_credentials(dict(config.voice_clone), key_env="ELEVENLABS_API_KEY")

    def clone(self, *, sample_audio: str, **kwargs) -> str:
        if not os.path.isfile(sample_audio):
            raise ProviderConfigError(f"参考音频不存在: {sample_audio}")
        httpx = ensure_httpx()
        name = kwargs.get("name") or f"mpt_clone_{uuid.uuid4().hex[:8]}"
        with open(sample_audio, "rb") as fp:
            try:
                resp = httpx.post(
                    f"{_ELEVEN_BASE}/v1/voices/add",
                    headers={"xi-api-key": self._key()},
                    data={"name": name},
                    files={"files": (os.path.basename(sample_audio), fp, "audio/mpeg")},
                    timeout=120,
                )
                resp.raise_for_status()
                return resp.json()["voice_id"]
            except Exception as exc:
                raise ProviderError(f"ElevenLabs 声音克隆失败: {exc}") from exc

    def synthesize(self, *, text: str, voice_id: str, **kwargs) -> str:
        httpx = ensure_httpx()
        model_id = kwargs.get("model_id", "eleven_multilingual_v2")
        try:
            resp = httpx.post(
                f"{_ELEVEN_BASE}/v1/text-to-speech/{voice_id}",
                headers={
                    "xi-api-key": self._key(),
                    "Content-Type": "application/json",
                },
                json={"text": text, "model_id": model_id},
                timeout=180,
            )
            resp.raise_for_status()
            content = resp.content
            if not content:
                raise ProviderError("ElevenLabs 合成返回空音频。")
        except Exception as exc:
            raise ProviderError(f"ElevenLabs 语音合成失败: {exc}") from exc
        out = unique_output("eleven_voice", "mp3")
        with open(out, "wb") as fp:
            fp.write(content)
        return out
