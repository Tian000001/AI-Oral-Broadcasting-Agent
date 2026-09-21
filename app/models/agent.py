"""口播智能体人设（Persona）API 模型（Phase 1）。

请求模型复用 Phase 0 在 ``app.services.agent.persona`` 定义的
``DigitalHumanConfig`` / ``VoiceConfig``，保持存储层与 API 层字段一致；
响应直接复用 ``Persona``（pydantic 模型，可序列化）。
"""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from app.services.agent.persona import (
    DigitalHumanConfig,
    Persona,
    VoiceConfig,
)

__all__ = [
    "Persona",
    "DigitalHumanConfig",
    "VoiceConfig",
    "PersonaCreate",
    "PersonaUpdate",
    "ReferenceProcessRequest",
    "TitleCoverRequest",
    "ComplianceCheckRequest",
    "ComplianceCustomWordRequest",
    "AgentTaskCreate",
    "AgentBatchSubmitRequest",
    "AgentTaskView",
    "AgentBatchSubmitResponse",
    "AgentDashboardResponse",
    "AgentRetryResponse",
    "AgentReviewRequest",
]


class PersonaCreate(BaseModel):
    """新建人设请求：不含 id 与时间戳，由服务端生成。"""

    name: str = ""
    tone: str = ""  # 口吻描述，用于驱动文案风格
    style_preset: str = ""
    avatar_image: str = ""
    digital_human: DigitalHumanConfig = Field(default_factory=DigitalHumanConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)


class PersonaUpdate(BaseModel):
    """更新人设请求：所有字段可选，仅覆盖传入项。"""

    name: Optional[str] = None
    tone: Optional[str] = None
    style_preset: Optional[str] = None
    avatar_image: Optional[str] = None
    digital_human: Optional[DigitalHumanConfig] = None
    voice: Optional[VoiceConfig] = None


class ReferenceProcessRequest(BaseModel):
    """对标文案提取与仿写请求（Phase 4）。

    两种用法二选一：
    - ``transcript_text``：直接粘贴对标转写文案，跳过下载与转写；
    - ``source``：本地文件或网络链接，走 下载→提取音频→转写。
    ``persona_id`` 可选，用于注入人设口吻；``language`` 缺省读 config.reference。
    """

    source: Optional[str] = None
    transcript_text: Optional[str] = None
    persona_id: Optional[str] = None
    language: Optional[str] = None


class TitleCoverRequest(BaseModel):
    """标题 + 封面生成请求（Phase 5）。

    - ``video_subject`` / ``video_script``：用于生成标题与话题标签；
    - ``persona_id``：可选，注入人设口吻；
    - ``base_image``：可选，作为封面底图（图生图/图生视频的一帧）；
    - ``video_path`` + ``compose=True``：把生成的封面合成为成片片头。
    """

    video_subject: Optional[str] = ""
    video_script: Optional[str] = ""
    language: Optional[str] = ""
    persona_id: Optional[str] = None
    base_image: Optional[str] = ""
    video_path: Optional[str] = ""
    engine: Optional[str] = None
    compose: bool = False


class ComplianceCheckRequest(BaseModel):
    """文案 / 标题违禁词合规检测请求（Phase 6）。

    - ``script`` / ``title``：常规检测字段；
    - ``extra``：任意附加字段（如 描述 / 标签），键值对形式一并检测。
    留空字段不参与检测。
    """

    script: Optional[str] = None
    title: Optional[str] = None
    extra: Optional[Dict[str, str]] = None


class ComplianceCustomWordRequest(BaseModel):
    """新增用户自定义违禁词请求（Phase 6）。

    ``words`` 每行一条，格式与行业词库相同（``模式 | 级别 | 建议 | 变体``）。
    """

    words: List[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Phase 8 · 批量任务调度与监控
# ---------------------------------------------------------------------------
class AgentTaskCreate(BaseModel):
    """单个口播创作任务定义。

    - ``topic``：创作主题/话题（必填）；
    - ``persona_id`` / ``channel`` / ``script`` / ``title``：可选上下文；
    - ``priority``：优先级，数值越大越紧急（默认 0）；
    - ``params``：透传给真实口播流水线的额外生成参数（Phase 9 使用）；
    - ``simulate_fail`` / ``simulate_review``：演示/测试开关（默认 handler 支持）。
    """

    topic: str = Field(..., description="创作主题/话题")
    persona_id: Optional[str] = None
    channel: Optional[str] = None
    script: Optional[str] = None
    title: Optional[str] = None
    priority: int = 0
    params: Optional[Dict[str, Any]] = None
    simulate_fail: bool = False
    simulate_review: bool = False
    fail_reason: Optional[str] = None
    review_reason: Optional[str] = None


class AgentBatchSubmitRequest(BaseModel):
    """批量提交请求。"""

    tasks: List[AgentTaskCreate] = Field(default_factory=list)
    batch_name: Optional[str] = None


class AgentTaskView(BaseModel):
    """任务状态视图（读自 sm.state）。"""

    task_id: str
    batch_id: Optional[str] = None
    batch_name: Optional[str] = None
    topic: Optional[str] = None
    persona_id: Optional[str] = None
    channel: Optional[str] = None
    priority: int = 0
    state: int = 0
    progress: int = 0
    attempt: int = 0
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    error: Optional[str] = None
    last_error: Optional[str] = None
    review_reason: Optional[str] = None
    review_decision: Optional[str] = None
    review_note: Optional[str] = None
    videos: List[str] = Field(default_factory=list)  # 成片可播放 URL（绝对路径已转 /tasks/...）
    combined_videos: List[str] = Field(default_factory=list)  # 合并成片 URL


class AgentBatchSubmitResponse(BaseModel):
    batch_id: str
    task_ids: List[str]
    count: int


class AgentDashboardResponse(BaseModel):
    total: int = 0
    pending: int = 0
    processing: int = 0
    complete: int = 0
    failed: int = 0
    review: int = 0
    cancelled: int = 0


class AgentRetryResponse(BaseModel):
    task_id: str
    state: int
    retried: bool


class AgentReviewRequest(BaseModel):
    approve: bool = True
    note: Optional[str] = None


# ------------------------------------------------------------------ #
# TTS / 声音克隆
# ------------------------------------------------------------------ #
class TTSPreviewRequest(BaseModel):
    """试听音色请求。"""
    service: str = "azure-tts-v1"          # tts_server 值
    voice_name: str = ""                    # 具体音色名
    text: str = "你好，这是一段试听音频。"  # 试听文本（默认短句）
    volume: float = 1.0                     # 音量 0~2
    rate: float = 1.0                       # 语速 0.5~2.0


class VoiceCloneRequest(BaseModel):
    """声音克隆请求。"""
    provider: str = "local_xtts"            # none | cloud_cosyvoice | cloud_minimax | local_xtts
    sample_audio: str = ""                  # 已上传到服务器的样本音频路径（或 base64）
    voice_id: Optional[str] = None          # 远程克隆时可指定 ID（不指定则自动生成）


class DigitalHumanGenerateRequest(BaseModel):
    """独立数字人生成请求：给定口播文案 + 肖像图（或人设），产出对口型口播视频。

    - 若传 ``persona_id``，则复用该人设已配置的数字人形象（provider + source_image）。
    - 否则需显式传 ``provider`` + ``image_path``（或先在前端上传到服务器拿到路径）。
    - 配音音频由后端用 ``voice_name`` 即时合成（无需预先准备音频文件）。
    """
    text: str = ""                                      # 口播文案
    voice_name: str = "zh-CN-XiaoxiaoNeural-Female"     # 配音音色
    voice_rate: float = 1.0                             # 语速 0.5~2
    voice_volume: float = 1.0                           # 音量 0~2
    persona_id: str = ""                                # 可选：复用已建人设的数字人形象
    provider: str = ""                                  # 可选：local_sadtalker 等（persona_id 缺时必填）
    image_path: str = ""                                # 可选：肖像图路径（persona_id 缺时必填）
    video_path: str = ""                                # 可选：参考视频路径（视频驱动 provider）
    preprocess: str = ""                                # 可选：sadtalker --preprocess
    still: bool = False                                 # 可选：sadtalker --still（头不动）
    expression_scale: Optional[float] = None            # 可选：sadtalker --expression_scale
