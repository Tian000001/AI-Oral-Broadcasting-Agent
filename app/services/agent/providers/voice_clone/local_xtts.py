"""本地声音克隆：Coqui XTTS。

XTTS 在本地用参考音频做零样本（zero-shot）克隆说话人，再用克隆出的说话人合成语音。
依赖 PyTorch + GPU，通过 ``config.voice_clone.xtts`` 的 ``local_python`` +
``local_script`` 以 subprocess 调用 ``storage/engines/xtts/xtts_engine.py``。

约定 ``local_script`` 接受的参数（详见该引擎脚本）：
- 克隆：``--mode clone --sample <参考音频> --speaker_out <speaker 元数据 json>``
- 合成：``--mode synth --speaker <speaker 元数据 json> --text <文本> --output <输出音频>``

``voice_id`` 在本实现中等价于「speaker 元数据 json 文件路径」，由 clone 阶段产出并返回；
该文件记录参考音频路径与语种，合成阶段据此做零样本推理。
"""
from __future__ import annotations

import os
import subprocess

from app.config import config

from .. import VoiceCloneProvider, ProviderInfo, register
from .._common import (
    unique_output,
    resolve_local_engine,
    convert_audio,
    ProviderConfigError,
    ProviderError,
)


@register
class LocalXTTSVoiceProvider(VoiceCloneProvider):
    info = ProviderInfo(
        name="local_xtts",
        label="XTTS（本地）",
        channel="local",
        requires_gpu=True,
    )

    @classmethod
    def from_config(cls, cfg):
        return cls()

    def _engine_cfg(self) -> dict:
        sub = config.voice_clone.get("xtts", {}) or {}
        return dict(sub) if isinstance(sub, dict) else {}

    def clone(self, *, sample_audio: str, **kwargs) -> str:
        if not os.path.isfile(sample_audio):
            raise ProviderConfigError(f"参考音频不存在: {sample_audio}")
        lp, script = resolve_local_engine("local_xtts", self._engine_cfg())
        speaker_path = unique_output("xtts_speaker", "json")
        cmd = [
            lp, script,
            "--mode", "clone",
            "--sample", sample_audio,
            "--speaker_out", speaker_path,
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        except subprocess.TimeoutExpired as exc:
            raise ProviderError("XTTS 克隆超时（>600s）。") from exc
        except Exception as exc:
            raise ProviderError(f"XTTS 克隆调用失败: {exc}") from exc
        if proc.returncode != 0 or not os.path.isfile(speaker_path):
            raise ProviderError(
                f"XTTS 克隆失败（退出码 {proc.returncode}）：{proc.stderr[-2000:] or proc.stdout[-2000:]}"
            )
        return speaker_path

    def synthesize(self, *, text: str, voice_id: str, **kwargs) -> str:
        if not os.path.isfile(voice_id):
            raise ProviderConfigError(f"XTTS speaker 模型不存在: {voice_id}")
        lp, script = resolve_local_engine("local_xtts", self._engine_cfg())
        requested = kwargs.get("output") or unique_output("xtts_voice", "wav")
        # 本地引擎只产出 wav（soundfile/libsndfile 不支持写 mp3 等），而试听预览与
        # 视频合成普遍要求 .mp3；故先生成 wav，再转码到调用方要求的扩展名。
        wav_path = (
            requested
            if os.path.splitext(requested)[1].lower() == ".wav"
            else unique_output("xtts_voice", "wav")
        )
        cmd = [
            lp, script,
            "--mode", "synth",
            "--speaker", voice_id,
            "--text", text,
            "--output", wav_path,
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        except subprocess.TimeoutExpired as exc:
            raise ProviderError("XTTS 合成超时（>600s）。") from exc
        except Exception as exc:
            raise ProviderError(f"XTTS 合成调用失败: {exc}") from exc
        if proc.returncode != 0 or not os.path.isfile(wav_path):
            raise ProviderError(
                f"XTTS 合成失败（退出码 {proc.returncode}）：{proc.stderr[-2000:] or proc.stdout[-2000:]}"
            )
        if wav_path == requested:
            return wav_path
        try:
            return convert_audio(wav_path, requested)
        finally:
            if os.path.isfile(wav_path):
                try:
                    os.remove(wav_path)
                except OSError:
                    pass
