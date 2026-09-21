"""声音克隆 Provider 子包：汇聚所有具体实现，导入即触发 @register 注册。"""
from .cloud_cosyvoice import CloudCosyVoiceProvider
from .cloud_elevenlabs import CloudElevenLabsVoiceProvider
from .cloud_minimax import CloudMiniMaxVoiceProvider
from .local_cosyvoice import LocalCosyVoiceVoiceProvider
from .local_xtts import LocalXTTSVoiceProvider

__all__ = [
    "CloudCosyVoiceProvider",
    "CloudElevenLabsVoiceProvider",
    "CloudMiniMaxVoiceProvider",
    "LocalCosyVoiceVoiceProvider",
    "LocalXTTSVoiceProvider",
]
