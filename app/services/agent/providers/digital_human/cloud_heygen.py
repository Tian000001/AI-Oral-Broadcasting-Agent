"""云端数字人：HeyGen。

HeyGen 走「Avatar（虚拟形象）」模式：用控制台创建的 avatar_id 作为形象标识，
配合公网音频 URL 生成口播视频。因此本 Provider 把抽象基类的 ``image_path`` 解释为
**HeyGen avatar_id**（纯字符串，非图片文件）。若你已用图片自定义了 Talking Photo，
请改用 cloud_did 或将图片托管为公开 URL 后走 D-ID。

注意：``audio_path`` 须为公网可访问的音频 URL。
"""
from __future__ import annotations

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

_HEYGEN_DEFAULT_BASE = "https://api.heygen.com"


@register
class CloudHeyGenProvider(DigitalHumanProvider):
    info = ProviderInfo(
        name="cloud_heygen",
        label="HeyGen（云端）",
        channel="cloud",
        supports_image=True,
        supports_video=False,
        requires_gpu=False,
    )

    @classmethod
    def from_config(cls, cfg):
        return cls()

    def _key(self) -> str:
        return read_api_credentials(dict(config.digital_human), key_env="HEYGEN_API_KEY")

    def generate(self, *, audio_path: str, image_path: str = "", video_path: str = "", **kwargs) -> str:
        avatar_id = (image_path or kwargs.get("avatar_id") or "").strip()
        if not avatar_id:
            raise ProviderConfigError(
                "HeyGen 走 avatar 模式，请在 image_path 传入 HeyGen avatar_id"
                "（在 HeyGen 控制台创建形象后获取）。"
            )
        if not is_url(audio_path):
            raise ProviderConfigError(
                "HeyGen 需要公网音频 URL（audio_path 传 http(s) 链接）。"
            )

        httpx = ensure_httpx()
        url = base_url(dict(config.digital_human), _HEYGEN_DEFAULT_BASE)
        headers = {"X-Api-Key": self._key(), "Content-Type": "application/json"}
        payload = {
            "video_inputs": [
                {
                    "character": {"type": "avatar", "avatar_id": avatar_id},
                    "voice": {"type": "audio", "audio_url": audio_path},
                }
            ],
            "dimension": {
                "width": int(kwargs.get("width", 1280)),
                "height": int(kwargs.get("height", 720)),
            },
            "output": {"format": "mp4"},
        }
        try:
            resp = httpx.post(f"{url}/v2/video", json=payload, headers=headers, timeout=60)
            resp.raise_for_status()
            data = resp.json().get("data", {})
        except Exception as exc:
            raise ProviderError(f"HeyGen 创建任务失败: {exc}") from exc

        video_id = data.get("video_id")
        if not video_id:
            raise ProviderError(f"HeyGen 未返回 video_id: {resp.text}")

        final = poll_until(
            lambda: httpx.get(f"{url}/v2/video/{video_id}", headers=headers, timeout=60).json(),
            lambda s: s.get("data", {}).get("status") == "completed",
        )
        result = final.get("data", {}).get("video_url")
        if not result:
            raise ProviderError(f"HeyGen 未返回视频地址: {final}")
        return download_to(result, unique_output("heygen", "mp4"))
