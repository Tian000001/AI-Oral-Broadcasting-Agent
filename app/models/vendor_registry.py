"""供应商能力登记表（Vendor Capability Registry）。

解决「一家供应商既提供文字模型，也提供 TTS / 数字人」时的配置与映射问题：

- 历史实现中 LLM、TTS、数字人各自配置、各自解析，同一厂商的 key 散落在
  ``[app].<prov>_*``、``[minimax_tts]``、``[digital_human]`` 等多处，无法「一家配一次、
  多能力对应多模型」。
- 这里把「供应商」提升为一等概念：每个供应商声明它支持哪些能力
  （``llm`` / ``tts`` / ``digital_human``），每项能力指向既有的适配器（``target``）
  并带默认 ``model`` / ``voice``。
- 运行期由 :func:`resolve_vendor_override` 把 ``(vendor, capability)`` 翻译成凭据与模型
  覆盖；配置向后兼容——只有当存在 ``[vendors.<id>]`` 段时才覆盖，否则各能力继续走
  legacy 配置路径，不破坏现有行为。

设计要点：
- 本模块**不**读取运行时配置，避免与 ``app.config.config`` 产生循环依赖；调用方
  （``llm.py`` / ``voice.py``）传入 ``vendors_cfg``（即 ``config.vendors``）。
- ``status`` 标记能力落地情况：``live``（适配器已实现，可直接用）/ ``planned``
  （供应商确有该 API，但本项目尚未实现对应 provider，UI 展示为「待接入」）。
- 不在登记表中虚构能力：某供应商若无数字人 API（如硅基流动），就不登记
  ``digital_human``，避免前端出现无法兑现的选项。
"""
from __future__ import annotations

from dataclasses import dataclass


# 能力类型常量（与设置页、Resolver 共用）
CAP_LLM = "llm"
CAP_TTS = "tts"
CAP_DH = "digital_human"
CAP_IMAGE = "image"


@dataclass(frozen=True, slots=True)
class VendorCapability:
    """供应商下某一项能力（llm / tts / digital_human）的静态声明。"""

    capability: str           # CAP_LLM / CAP_TTS / CAP_DH
    target: str               # 既有适配器 id：llm 用 LLM provider_id；tts 用 tts service id；dh 用 DH provider 名
    default_model: str = ""   # 该能力的默认模型名（用户未填时用）
    default_voice: str = ""   # TTS 默认音色（仅 tts 用）
    status: str = "live"      # "live" | "planned"


@dataclass(frozen=True, slots=True)
class VendorSpec:
    """供应商静态声明：支持哪些能力、共享凭据的默认 base_url、各项能力默认模型。"""

    vendor_id: str
    label: str
    api_key_url: str = ""
    default_base_url: str = ""
    capabilities: tuple[VendorCapability, ...] = ()

    def capability(self, cap: str) -> "VendorCapability | None":
        for c in self.capabilities:
            if c.capability == cap:
                return c
        return None


# 顺序即设置页下拉顺序。每家只登记其**真实存在**的能力。
VENDOR_REGISTRY = (
    VendorSpec(
        "minimax",
        "MiniMax",
        api_key_url="https://platform.minimax.io/",
        default_base_url="https://api.minimax.io",
        capabilities=(
            VendorCapability(CAP_LLM, "minimax", default_model="MiniMax-M3"),
            VendorCapability(CAP_TTS, "minimax-tts", default_model="speech-2.8-hd", default_voice="English_expressive_narrator"),
            # MiniMax 确有数字人/视频合成 API，但本项目尚未实现对应 DH provider。
            VendorCapability(CAP_DH, "cloud_minimax", status="planned"),
            # MiniMax 图像生成 API 尚未接入本项目适配器，UI 展示为「待接入」。
            VendorCapability(CAP_IMAGE, "openai_image", status="planned"),
        ),
    ),
    VendorSpec(
        "siliconflow",
        "硅基流动 SiliconFlow",
        api_key_url="https://cloud.siliconflow.cn/account/ak",
        default_base_url="https://api.siliconflow.cn/v1",
        capabilities=(
            # 硅基流动 LLM 为 OpenAI 兼容；默认模型由用户填写（如 deepseek-ai/DeepSeek-V3）。
            VendorCapability(CAP_LLM, "siliconflow", default_model=""),
            # 硅基流动 TTS 走 CosyVoice，适配器已实现。
            VendorCapability(CAP_TTS, "siliconflow", default_model=""),
            # 硅基流动图像生成（KOLORS / FLUX 等）走 OpenAI 兼容 /images/generations。
            VendorCapability(CAP_IMAGE, "openai_image", default_model="Kwai-Kolors/Kolors", status="live"),
            # 硅基流动目前无数字人 API，不登记 digital_human。
        ),
    ),
    VendorSpec(
        "volcengine",
        "火山方舟 VolcEngine",
        api_key_url="https://console.volcengine.com/ark",
        default_base_url="https://ark.cn-beijing.volces.com/api/v3",
        capabilities=(
            VendorCapability(CAP_LLM, "volcengine", default_model="doubao-seed-2-1-turbo-260628"),
            VendorCapability(CAP_TTS, "volcengine-tts", status="planned"),
            # 火山方舟图像生成（doubao-image 等）走 OpenAI 兼容 /images/generations。
            VendorCapability(CAP_IMAGE, "openai_image", default_model="doubao-image-generation", status="live"),
            VendorCapability(CAP_DH, "cloud_volcengine", status="planned"),
        ),
    ),
    VendorSpec(
        "qwen",
        "阿里云百炼 DashScope",
        api_key_url="https://dashscope.console.aliyun.com/apiKey",
        default_base_url="",
        capabilities=(
            VendorCapability(CAP_LLM, "qwen", default_model="qwen-max"),
            VendorCapability(CAP_TTS, "qwen-tts", status="planned"),
            # 阿里云百炼（DashScope）万相 wanx 图像生成走 OpenAI 兼容 /images/generations。
            VendorCapability(CAP_IMAGE, "openai_image", default_model="wanx2.1-t2i-turbo", status="live"),
            VendorCapability(CAP_DH, "cloud_qwen", status="planned"),
        ),
    ),
    VendorSpec(
        "deepsea",
        "DeepSea",
        # 用户暂未提供 base_url / 申请 key 地址 / 默认模型，留空待设置页填写。
        # DeepSea LLM 为 OpenAI 兼容；TTS 适配器 deepsea_tts（voice.py，同样走 OpenAI
        # 兼容 /audio/speech）已实现，故 llm/tts 均标记 live（设置页可选、Resolver 驱动、
        # 供应商卡片保存时自动把活动供应商切过去）。数字人暂无对应 provider，仍 planned。
        api_key_url="",
        default_base_url="",
        capabilities=(
            # DeepSea LLM 为 OpenAI 兼容接口，且其 [vendors.deepsea] 已由用户在设置页
            # 填写 api_key / base_url，故标记为 live（设置页可选、Resolver 可直接驱动）。
            VendorCapability(CAP_LLM, "deepsea", status="live"),
            VendorCapability(CAP_TTS, "deepsea-tts", default_voice="default", status="live"),
            # DeepSea 为 OpenAI 兼容聚合网关，图像生成同样走 /images/generations，
            # 模型名由 [vendors.deepsea.capabilities.image] 指定（如 gpt-image-1）。
            VendorCapability(CAP_IMAGE, "openai_image", default_model="gpt-image-1", status="live"),
            VendorCapability(CAP_DH, "cloud_deepsea", status="planned"),
        ),
    ),
)

VENDORS = {v.vendor_id: v for v in VENDOR_REGISTRY}

if len(VENDORS) != len(VENDOR_REGISTRY):
    raise RuntimeError("duplicate vendor id in VENDOR_REGISTRY")


def get_vendor(vendor_id: str) -> "VendorSpec | None":
    return VENDORS.get((vendor_id or "").lower())


def list_vendors() -> list[VendorSpec]:
    return list(VENDOR_REGISTRY)


def resolve_vendor_override(
    vendor_id: str,
    capability: str,
    vendors_cfg: dict | None = None,
) -> dict | None:
    """把 ``(vendor, capability)`` 解析为凭据/模型覆盖。

    :param vendor_id: 供应商 id（与 ``[app].llm_provider`` 等一致，如 ``minimax``）。
    :param capability: ``CAP_LLM`` / ``CAP_TTS`` / ``CAP_DH``。
    :param vendors_cfg: 运行期 ``config.vendors``（dict）。为 ``None`` 或空时直接返回
        ``None``，表示不覆盖、走 legacy 配置。
    :return: 覆盖字典 ``{api_key, base_url, model, voice, target, status}``；若该供应商
        不支持此能力，或没有任何 ``[vendors.<id>]`` 配置块，则返回 ``None``。
        仅返回用户**显式填写**的字段（空字符串视为未覆盖）。
    """
    spec = get_vendor(vendor_id)
    if spec is None:
        return None
    cap = spec.capability(capability)
    if cap is None:
        return None

    vblock = (vendors_cfg or {}).get(vendor_id, {})
    if not isinstance(vblock, dict) or not vblock:
        return None  # 无 [vendors.<id>] 块 → 纯 legacy，不覆盖

    caps = vblock.get("capabilities", {}) or {}
    ccfg = caps.get(capability, {}) or {} if isinstance(caps, dict) else {}

    return {
        "api_key": vblock.get("api_key") or None,
        "base_url": vblock.get("base_url") or None,
        "model": (ccfg.get("model") if isinstance(ccfg, dict) else None) or None,
        "voice": (ccfg.get("voice") if isinstance(ccfg, dict) else None) or None,
        "target": cap.target,
        "status": cap.status,
    }
