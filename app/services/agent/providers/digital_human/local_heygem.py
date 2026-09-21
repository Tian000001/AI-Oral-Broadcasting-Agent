"""本地数字人：HeyGem（本地版）。

HeyGem 本地版以参考图片/视频 + 音频驱动对口型。依赖 PyTorch + GPU，通过
``config.digital_human`` 的 ``local_python`` + ``local_script``（你的 HeyGem 包装脚本）
以 subprocess 方式调用。

约定 ``local_script`` 接受的参数（请让你的包装脚本兼容）：
    --audio <音频> --image <肖像/参考视频> --output <输出视频>
    [--mode image|video]
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
class LocalHeyGemProvider(DigitalHumanProvider):
    info = ProviderInfo(
        name="local_heygem",
        label="HeyGem（本地）",
        channel="local",
        supports_image=True,
        supports_video=True,
        requires_gpu=True,
    )

    @classmethod
    def from_config(cls, cfg):
        return cls()

    def generate(self, *, audio_path: str, image_path: str = "", video_path: str = "", **kwargs) -> str:
        lp, script = resolve_local_engine("local_heygem", dict(config.digital_human))
        # MuseTalk 推理子进程 cwd 会被切到仓库目录，传入相对路径会解析失败，
        # 统一在边界处转成绝对路径。
        audio_path = os.path.abspath(audio_path)
        if video_path:
            src, mode = video_path, "video"
        elif image_path:
            src, mode = image_path, "image"
        else:
            raise ProviderConfigError("HeyGem 需要 image_path（肖像图）或 video_path（参考视频）。")
        src = os.path.abspath(src)

        out = unique_output("heygem", "mp4")
        cmd = [
            lp, script,
            "--audio", audio_path,
            "--image", src,
            "--output", out,
            "--mode", mode,
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        except subprocess.TimeoutExpired as exc:
            raise ProviderError("HeyGem 推理超时（>1800s）。") from exc
        except Exception as exc:
            raise ProviderError(f"HeyGem 调用失败: {exc}") from exc

        if proc.returncode != 0:
            raise ProviderError(
                f"HeyGem 退出码 {proc.returncode}：{proc.stderr[-2000:] or proc.stdout[-2000:]}"
            )
        if not (out and os.path.isfile(out)):
            raise ProviderError(f"HeyGem 未产出视频：{out}")
        return out
