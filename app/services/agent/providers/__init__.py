"""口播智能体 Provider 抽象层。

数字人（:class:`DigitalHumanProvider`）与声音克隆（:class:`VoiceCloneProvider`）均通过
抽象基类约束统一入参/出参，具体实现——本地 SadTalker / HeyGem / LivePortrait，云端
HeyGen / D-ID / 硅基流动，以及 CosyVoice / MiniMax / XTTS 声音克隆——在 Phase 2 以可插拔
方式接入，运行时由 ``config.digital_human`` / ``config.voice_clone`` 的 ``provider`` 字段选择。

设计要点：
- 入参统一：数字人固定收「形象（图片或视频）+ 音频」，出参统一为视频文件路径；
  声音克隆固定收「参考音频」克隆出 voice_id，再按 voice_id 合成音频。
- 可发现：通过 :data:`PROVIDER_REGISTRY` 集中登记所有实现，便于运行时枚举、配置校验与 UI 展示。
- 可插拔：新增实现只要在包内 ``register`` 即可，无需改动调用方。
"""
from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import Dict, List, Optional, Type


@dataclass(frozen=True)
class ProviderInfo:
    """Provider 元信息，用于运行时枚举与展示。"""

    name: str  # 唯一标识，如 cloud_hegen
    label: str  # 展示名，如 "HeyGen（云端）"
    channel: str  # local | cloud
    supports_image: bool = True  # 是否支持图片驱动（肖像图）
    supports_video: bool = False  # 是否支持视频驱动（参考视频）
    requires_gpu: bool = False  # 是否需本地 GPU 环境


class DigitalHumanProvider(abc.ABC):
    """数字人驱动抽象基类。

    给定「形象（图片或视频）+ 音频」，产出对口型口播视频。
    """

    info: ProviderInfo

    @abc.abstractmethod
    def generate(
        self,
        *,
        audio_path: str,
        image_path: str = "",
        video_path: str = "",
        **kwargs,
    ) -> str:
        """生成口播视频，返回输出视频文件路径。

        :param audio_path: 配音音频路径（必填）。
        :param image_path: 肖像图片路径（图片驱动时必填）。
        :param video_path: 参考视频路径（视频驱动时必填）。
        :param kwargs: 各 Provider 私有参数（分辨率、表情强度等）。
        """
        raise NotImplementedError

    @classmethod
    def from_config(cls, cfg: "DigitalHumanConfig") -> "DigitalHumanProvider":
        """由配置构造实例，未实现时报错提示。"""
        raise NotImplementedError(
            f"{cls.__name__} 尚未实现 from_config；具体 Provider 在 Phase 2 接入。"
        )


class VoiceCloneProvider(abc.ABC):
    """声音克隆抽象基类。"""

    info: ProviderInfo

    @abc.abstractmethod
    def clone(self, *, sample_audio: str, **kwargs) -> str:
        """从参考音频克隆音色，返回 voice_id。"""
        raise NotImplementedError

    @abc.abstractmethod
    def synthesize(self, *, text: str, voice_id: str, **kwargs) -> str:
        """用指定音色合成语音，返回输出音频文件路径。"""
        raise NotImplementedError

    @classmethod
    def from_config(cls, cfg: "VoiceConfig") -> "VoiceCloneProvider":
        """由配置构造实例，未实现时报错提示。"""
        raise NotImplementedError(
            f"{cls.__name__} 尚未实现 from_config；具体 Provider 在 Phase 2 接入。"
        )


# 可插拔注册表：name -> 具体 Provider 类。Phase 2 各实现通过 register() 登记。
PROVIDER_REGISTRY: Dict[str, Type] = {}


def register(provider_cls: Type) -> Type:
    """装饰器：将具体 Provider 登记到 :data:`PROVIDER_REGISTRY`。

    用法::

        @register
        class CloudHeyGenProvider(DigitalHumanProvider):
            ...

    登记键取自类的 ``info.name``，因此实现类必须先定义 ``info`` 类属性。
    """
    info = getattr(provider_cls, "info", None)
    if not isinstance(info, ProviderInfo):
        raise TypeError(
            f"{provider_cls.__name__} 必须定义类属性 info: ProviderInfo 才能被 register"
        )
    PROVIDER_REGISTRY[info.name] = provider_cls
    return provider_cls


def get_provider(name: str) -> Optional[Type]:
    """按 name 取已登记的 Provider 类，未登记返回 None。"""
    return PROVIDER_REGISTRY.get(name)


def _autodiscover() -> None:
    """导入各子包以触发 @register，确保 providers 包被导入时所有实现已登记。

    具体实现（云端/本地、数字人/声音克隆）分散在 ``digital_human`` 与 ``voice_clone``
    子包内，每个实现类用 ``@register`` 装饰；此处统一导入子包即可完成注册，无需调用方
    关心具体模块路径。
    """
    from . import digital_human, voice_clone  # noqa: F401


_autodiscover()


def list_providers(
    channel: Optional[str] = None,
    kind: Optional[Type] = None,
) -> List["ProviderInfo"]:
    """列出已登记的 Provider 元信息。

    :param channel: 按通道过滤（``"local"`` / ``"cloud"``），为空返回全部。
    :param kind: 按基类过滤（``DigitalHumanProvider`` / ``VoiceCloneProvider``），为空返回全部。
    """
    result: List["ProviderInfo"] = []
    for cls in PROVIDER_REGISTRY.values():
        info = getattr(cls, "info", None)
        if info is None:
            continue
        if channel is not None and info.channel != channel:
            continue
        if kind is not None and not issubclass(cls, kind):
            continue
        result.append(info)
    return result
