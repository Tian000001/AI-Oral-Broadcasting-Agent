"""本地数字人：SadTalker。

给定「肖像图 + 配音音频」在本地用 SadTalker 推理出对口型口播视频。SadTalker 依赖
PyTorch + GPU，无法塞进本项目便携发行版，因此通过 ``config.digital_human`` 的
``local_python``（独立环境解释器）+ ``local_script``（SadTalker 的 inference.py）以
subprocess 方式调用。本进程不 import 任何重型库，缺环境时抛出清晰配置错误。

约定 ``local_script`` 接受的参数（请让你的包装脚本兼容）：
    --driven_audio <音频> --source_image <肖像> --result_dir <输出目录>
    [--preprocess crop|resize] [--still] [--expression_scale <float>]
"""
from __future__ import annotations

import os
import subprocess

from app.config import config
from .. import DigitalHumanProvider, ProviderInfo, register
from .._common import (
    agent_output_dir,
    find_newest_file,
    resolve_local_engine,
    ProviderConfigError,
    ProviderError,
)


@register
class LocalSadTalkerProvider(DigitalHumanProvider):
    info = ProviderInfo(
        name="local_sadtalker",
        label="SadTalker（本地）",
        channel="local",
        supports_image=True,
        supports_video=False,
        requires_gpu=True,
    )

    @classmethod
    def from_config(cls, cfg):
        return cls()

    def generate(self, *, audio_path: str, image_path: str = "", video_path: str = "", **kwargs) -> str:
        if not image_path:
            raise ProviderConfigError("SadTalker 需要 image_path（肖像图）。")
        lp, script = resolve_local_engine("local_sadtalker", dict(config.digital_human))

        # SadTalker 的 inference 脚本启动时会 os.chdir 到其仓库目录，导致传入的相对
        # 路径在子进程内无法解析（FileNotFoundError: storage\dh_audio_xxx\audio.mp3）。
        # 在 subprocess 边界统一转成绝对路径，避免该问题。
        audio_path = os.path.abspath(audio_path)
        image_path = os.path.abspath(image_path) if image_path else ""
        out_dir = os.path.abspath(agent_output_dir("sadtalker"))
        cmd = [
            lp, script,
            "--driven_audio", audio_path,
            "--source_image", image_path,
            "--result_dir", out_dir,
        ]
        if kwargs.get("preprocess"):
            cmd += ["--preprocess", str(kwargs["preprocess"])]
        if kwargs.get("still"):
            cmd.append("--still")
        if kwargs.get("expression_scale") is not None:
            cmd += ["--expression_scale", str(kwargs["expression_scale"])]

        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        except subprocess.TimeoutExpired as exc:
            raise ProviderError("SadTalker 推理超时（>1800s）。") from exc
        except Exception as exc:  # 命令未找到等
            raise ProviderError(f"SadTalker 调用失败: {exc}") from exc

        if proc.returncode != 0:
            raise ProviderError(
                f"SadTalker 退出码 {proc.returncode}：{proc.stderr[-2000:] or proc.stdout[-2000:]}"
            )

        video = find_newest_file(out_dir, "mp4")
        if not video:
            raise ProviderError(f"SadTalker 未产出视频，输出目录：{out_dir}")
        return video
