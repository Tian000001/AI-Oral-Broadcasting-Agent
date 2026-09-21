"""数字人 Provider 子包：汇聚所有具体实现，导入即触发 @register 注册。

新增数字人 Provider 时，在此文件补一行 import 即可（具体类用 @register 装饰后，
会自动登记进 ``app.services.agent.providers.PROVIDER_REGISTRY``）。
"""
from .cloud_did import CloudDIDProvider
from .cloud_heygen import CloudHeyGenProvider
from .cloud_siliconflow import CloudSiliconflowProvider
from .local_heygem import LocalHeyGemProvider
from .local_liveportrait import LocalLivePortraitProvider
from .local_sadtalker import LocalSadTalkerProvider

__all__ = [
    "CloudDIDProvider",
    "CloudHeyGenProvider",
    "CloudSiliconflowProvider",
    "LocalHeyGemProvider",
    "LocalLivePortraitProvider",
    "LocalSadTalkerProvider",
]
