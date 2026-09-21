"""云端数字人：硅基流动（SiliconFlow）占位。

硅基流动目前主要提供大模型 / 语音 / 文生图推理能力，暂无稳定的「图片 + 音频 → 对口型
视频」公开 API。此 Provider 已预留接口并注册，调用时给出清晰指引，避免误用。
待官方开放数字人能力后可在此处补全实现（协议与 cloud_heygen / cloud_did 类似）。
"""
from __future__ import annotations

from .. import DigitalHumanProvider, ProviderInfo, register
from .._common import ProviderUnavailable


@register
class CloudSiliconflowProvider(DigitalHumanProvider):
    info = ProviderInfo(
        name="cloud_siliconflow",
        label="硅基流动（云端·待接入）",
        channel="cloud",
        supports_image=True,
        supports_video=False,
        requires_gpu=False,
    )

    @classmethod
    def from_config(cls, cfg):
        return cls()

    def generate(self, *, audio_path: str, image_path: str = "", video_path: str = "", **kwargs) -> str:
        raise ProviderUnavailable(
            "硅基流动（SiliconFlow）暂无稳定的「图片+音频→对口型视频」公开 API。"
            "该 Provider 接口已预留，待官方开放数字人能力后接入；"
            "当前建议使用 cloud_heygen 或 cloud_did。"
        )
