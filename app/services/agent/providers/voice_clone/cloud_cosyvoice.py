"""云端声音克隆：CosyVoice（阿里，待接入占位）。

CosyVoice 的云端接入依赖 DashScope / ModelScope 推理 API，形态随官方变化较大，本地下
尚未封装。此 Provider 已注册接口，调用时给出清晰指引，避免误用；待官方形态稳定后在此
补全 clone / synthesize（协议参考 cloud_minimax / cloud_elevenlabs）。
"""
from __future__ import annotations

from .. import VoiceCloneProvider, ProviderInfo, register
from .._common import ProviderUnavailable


@register
class CloudCosyVoiceProvider(VoiceCloneProvider):
    info = ProviderInfo(
        name="cloud_cosyvoice",
        label="CosyVoice（云端·待接入）",
        channel="cloud",
        requires_gpu=False,
    )

    @classmethod
    def from_config(cls, cfg):
        return cls()

    def clone(self, *, sample_audio: str, **kwargs) -> str:
        raise ProviderUnavailable(
            "CosyVoice 云端接入（DashScope/ModelScope 推理 API）尚未在本地封装，已预留接口；"
            "建议先用 cloud_minimax 或 cloud_elevenlabs。"
        )

    def synthesize(self, *, text: str, voice_id: str, **kwargs) -> str:
        raise ProviderUnavailable(
            "CosyVoice 云端接入尚未封装，已预留接口；建议先用 cloud_minimax 或 cloud_elevenlabs。"
        )
