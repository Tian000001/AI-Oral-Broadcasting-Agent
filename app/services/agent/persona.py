"""口播智能体人设（Persona）数据模型与文件存储层。

Phase 0 脚手架：仅提供可复用的人设存储抽象，控制器与 WebUI 在 Phase 1 接入。

人设是「智能体感」的核心载体——它把稳定的名称、口吻、数字人形象与克隆音色打包成
一份配置，后续任务可一键套用，从而驱动文案风格、数字人形象与音色选择保持一致。
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from typing import List, Optional

import pydantic
from pydantic import BaseModel, Field

from app.config import config
from app.config.config import root_dir

_persona_lock = threading.RLock()


class DigitalHumanConfig(BaseModel):
    """数字人形象配置。

    Phase 0 只定义载体字段；具体字段语义由 Phase 2 各 Provider 解释。
    """

    provider: str = "auto"  # auto | cloud_hegen | cloud_did | cloud_siliconflow | local_sadtalker | local_heygem
    source_image: str = ""  # 图片驱动：肖像图片路径
    source_video: str = ""  # 视频驱动：参考视频路径
    extra: dict = Field(default_factory=dict)  # 各 Provider 私有参数


class VoiceConfig(BaseModel):
    """克隆音色配置。"""

    provider: str = "none"  # none | cloud_cosyvoice | cloud_minimax | local_xtts
    voice_id: str = ""  # 云端/本地克隆得到的音色标识
    sample_audio: str = ""  # 克隆用参考音频路径
    extra: dict = Field(default_factory=dict)


class Persona(BaseModel):
    """一个稳定的智能体人设。"""

    id: str
    name: str = ""
    tone: str = ""  # 口吻描述，用于驱动文案风格
    style_preset: str = ""  # 风格预设名
    avatar_image: str = ""  # 人设头像（UI 展示）
    digital_human: DigitalHumanConfig = Field(default_factory=DigitalHumanConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    created_at: str = ""
    updated_at: str = ""

    def touch(self, *, is_new: bool = False) -> None:
        """刷新时间戳。新建时同时写入 created_at / updated_at。"""
        now = datetime.now(timezone.utc).isoformat()
        if is_new or not self.created_at:
            self.created_at = now
        self.updated_at = now


def _storage_dir() -> str:
    """解析人设存储目录（相对路径以项目根为基准）。"""
    base = config.persona.get("storage_dir", "storage/personas")
    path = base if os.path.isabs(base) else os.path.join(root_dir, base)
    os.makedirs(path, exist_ok=True)
    return path


def _load(path: str) -> Persona:
    with open(path, mode="r", encoding="utf-8") as fp:
        return Persona.model_validate(json.load(fp))


def list_personas() -> List[Persona]:
    """返回全部人设，按文件名排序。"""
    with _persona_lock:
        result: List[Persona] = []
        storage = _storage_dir()
        for filename in sorted(os.listdir(storage)):
            if not filename.endswith(".json"):
                continue
            full_path = os.path.join(storage, filename)
            try:
                result.append(_load(full_path))
            except (OSError, pydantic.ValidationError, json.JSONDecodeError):
                # 跳过损坏或不符合结构的人设文件，避免单点故障拖垮整个列表。
                continue
        return result


def get_persona(persona_id: str) -> Optional[Persona]:
    """按 ID 读取单个人设，不存在返回 None。"""
    path = os.path.join(_storage_dir(), f"{persona_id}.json")
    if not os.path.isfile(path):
        return None
    with _persona_lock:
        return _load(path)


def save_persona(persona: Persona) -> Persona:
    """写入/更新人设，返回写入后的实例。"""
    persona.touch(is_new=not persona.created_at)
    path = os.path.join(_storage_dir(), f"{persona.id}.json")
    with _persona_lock:
        with open(path, mode="w", encoding="utf-8") as fp:
            fp.write(persona.model_dump_json(indent=2))
    return persona


def delete_persona(persona_id: str) -> bool:
    """删除人设，返回是否实际删除成功。"""
    path = os.path.join(_storage_dir(), f"{persona_id}.json")
    with _persona_lock:
        if os.path.isfile(path):
            os.remove(path)
            return True
    return False
