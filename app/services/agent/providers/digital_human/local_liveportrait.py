"""本地数字人：LivePortrait。

以「源图片 + 参考视频（含嘴型）」驱动表情/嘴型迁移，产出视频。LivePortrait 不直接吃
音频对口型，因此它的输出视频**不含音轨**，上层流水线需把 ``audio_path`` 另行混音进去。
依赖 PyTorch + GPU，通过 ``config.digital_human`` 的 ``local_python`` + ``local_script``
以 subprocess 调用。

约定 ``local_script`` 接受的参数（请让你的包装脚本兼容）：
    --source <源图片> --driving <驱动视频> --output <输出视频>
"""
from __future__ import annotations

import os
import subprocess

from .. import DigitalHumanProvider, ProviderInfo, register
from .._common import (
    resolve_local_engine,
    unique_output,
    ProviderConfigError,
    ProviderError,
)


@register
class LocalLivePortraitProvider(DigitalHumanProvider):
    info = ProviderInfo(
        name="local_liveportrait",
        label="LivePortrait（本地）",
        channel="local",
        supports_image=True,
        supports_video=True,
        requires_gpu=True,
    )

    @classmethod
    def from_config(cls, cfg):
        return cls()

    def generate(self, *, audio_path: str, image_path: str = "", video_path: str = "", **kwargs) -> str:
        lp, script = resolve_local_engine("local_liveportrait", dict(config.digital_human))
        if not image_path:
            raise ProviderConfigError("LivePortrait 需要 image_path（源图片）。")
        if not video_path:
            raise ProviderConfigError(
                "LivePortrait 以参考视频驱动，需要 video_path（含嘴型的驱动视频）。"
            )
        out = unique_output("liveportrait", "mp4")
        cmd = [
            lp, script,
            "--source", image_path,
            "--driving", video_path,
            "--output", out,
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        except subprocess.TimeoutExpired as exc:
            raise ProviderError("LivePortrait 推理超时（>1800s）。") from exc
        except Exception as exc:
            raise ProviderError(f"LivePortrait 调用失败: {exc}") from exc

        if proc.returncode != 0:
            raise ProviderError(
                f"LivePortrait 退出码 {proc.returncode}：{proc.stderr[-2000:] or proc.stdout[-2000:]}"
            )
        if not (out and os.path.isfile(out)):
            raise ProviderError(f"LivePortrait 未产出视频：{out}")
        return out
