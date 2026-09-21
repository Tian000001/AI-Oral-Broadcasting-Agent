"""云端数字人：D-ID。

给定「肖像图 + 配音音频」产出对口型口播视频。D-ID 的 talks 接口直接接受
``source_url``（肖像图 URL）与 ``script.audio.url``（音频 URL），返回视频 URL，
协议清晰、最贴近本项目的「形象 + 音频 → 视频」抽象。

注意：云端引擎要求素材可公网访问，因此 ``image_path`` / ``audio_path`` 请传
http(s) 公网链接；传本地路径会抛出清晰的配置错误。
"""
from __future__ import annotations

import base64

from .. import DigitalHumanProvider, ProviderInfo, register
from .._common import (
    base_url,
    ensure_httpx,
    download_to,
    poll_until,
    unique_output,
    is_url,
    read_api_credentials,
    ProviderConfigError,
    ProviderError,
)

_DID_DEFAULT_BASE = "https://api.d-id.com"


@register
class CloudDIDProvider(DigitalHumanProvider):
    info = ProviderInfo(
        name="cloud_did",
        label="D-ID（云端）",
        channel="cloud",
        supports_image=True,
        supports_video=False,
        requires_gpu=False,
    )

    @classmethod
    def from_config(cls, cfg):
        return cls()

    def _headers(self) -> dict:
        key = read_api_credentials(dict(config.digital_human), key_env="DID_API_KEY")
        # D-ID 使用 Basic<clientId:clientSecret>；此处以 api_key 作为凭据前缀。
        token = base64.b64encode(f"{key}:".encode()).decode()
        return {
            "Authorization": f"Basic {token}",
            "Content-Type": "application/json",
        }

    def _resolve_source(self, image_path: str, kwargs: dict) -> str:
        src = (image_path or kwargs.get("source_image") or "").strip()
        if not src:
            raise ProviderConfigError("D-ID 需要 image_path（肖像图）。")
        if not is_url(src):
            raise ProviderConfigError(
                "D-ID 为云端引擎，需提供公网可访问的肖像图 URL（image_path 传 http(s) 链接）。"
            )
        return src

    def _resolve_audio(self, audio_path: str) -> str:
        if not audio_path or not is_url(audio_path):
            raise ProviderConfigError(
                "D-ID 为云端引擎，需提供公网可访问的音频 URL（audio_path 传 http(s) 链接）。"
            )
        return audio_path

    def generate(self, *, audio_path: str, image_path: str = "", video_path: str = "", **kwargs) -> str:
        httpx = ensure_httpx()
        url = base_url(dict(config.digital_human), _DID_DEFAULT_BASE)
        source = self._resolve_source(image_path, kwargs)
        audio = self._resolve_audio(audio_path)
        headers = self._headers()
        payload = {
            "source_url": source,
            "script": {"type": "audio", "audio_url": audio},
            "output": {"format": "mp4"},
        }
        try:
            resp = httpx.post(f"{url}/talks", json=payload, headers=headers, timeout=60)
            resp.raise_for_status()
            talk = resp.json()
        except Exception as exc:  # 网络 / 鉴权 / 结构错误统一包装
            raise ProviderError(f"D-ID 创建任务失败: {exc}") from exc

        talk_id = talk.get("id")
        if not talk_id:
            raise ProviderError(f"D-ID 未返回任务 id: {talk}")

        final = poll_until(
            lambda: httpx.get(f"{url}/talks/{talk_id}", headers=headers, timeout=60).json(),
            lambda s: s.get("status") in ("done", "error"),
        )
        if final.get("status") == "error":
            raise ProviderError(f"D-ID 任务执行失败: {final}")

        result = final.get("result_url")
        if not result:
            raise ProviderError(f"D-ID 未返回视频地址: {final}")
        return download_to(result, unique_output("did_talk", "mp4"))
