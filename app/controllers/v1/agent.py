"""口播智能体人设（Persona）CRUD 控制器（Phase 1）。

路由前缀由 :func:`app.controllers.v1.base.new_router` 统一设为 ``/api/v1``，
因此对外路径为 ``/api/v1/agent/personas``。所有响应统一使用
:func:`app.utils.utils.get_response` 信封（``{status, data, message}``）。
"""
import os

from fastapi import Request
from fastapi.responses import StreamingResponse
from uuid import uuid4

from fastapi import Query

from app.controllers.v1.base import new_router
from app.controllers.manager.agent_manager import get_agent_manager
from app.models.agent import (
    AgentBatchSubmitRequest,
    AgentBatchSubmitResponse,
    AgentReviewRequest,
    AgentRetryResponse,
    AgentTaskCreate,
    AgentTaskView,
    ComplianceCheckRequest,
    ComplianceCustomWordRequest,
    DigitalHumanGenerateRequest,
    Persona,
    PersonaCreate,
    PersonaUpdate,
    ReferenceProcessRequest,
    TitleCoverRequest,
    TTSPreviewRequest,
    VoiceCloneRequest,
)
from app.models.exception import HttpException
from app.services.agent import persona as persona_store
from app.services.agent import reference as reference_service
from app.services.agent import title_cover as title_cover_service
from app.services.agent import compliance as compliance_service
from app.utils import utils
from loguru import logger

router = new_router()


@router.get(
    "/agent/personas",
    summary="列出全部人设",
)
def list_personas(request: Request):
    items = [p.model_dump() for p in persona_store.list_personas()]
    return utils.get_response(200, items)


@router.get(
    "/agent/personas/{persona_id}",
    summary="获取单个人设",
)
def get_persona(request: Request, persona_id: str):
    persona = persona_store.get_persona(persona_id)
    if persona is None:
        return utils.get_response(404, message="persona not found")
    return utils.get_response(200, persona.model_dump())


@router.post(
    "/agent/personas",
    summary="新建人设",
)
def create_persona(request: Request, body: PersonaCreate):
    persona = Persona(id=str(uuid4()), **body.model_dump())
    saved = persona_store.save_persona(persona)
    return utils.get_response(200, saved.model_dump())


@router.put(
    "/agent/personas/{persona_id}",
    summary="更新人设（仅覆盖传入字段）",
)
def update_persona(request: Request, persona_id: str, body: PersonaUpdate):
    existing = persona_store.get_persona(persona_id)
    if existing is None:
        return utils.get_response(404, message="persona not found")

    # 仅覆盖调用方真正传入的字段，保留未传字段原值。
    updates = body.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(existing, field, value)

    saved = persona_store.save_persona(existing)
    return utils.get_response(200, saved.model_dump())


@router.delete(
    "/agent/personas/{persona_id}",
    summary="删除人设",
)
def delete_persona(request: Request, persona_id: str):
    removed = persona_store.delete_persona(persona_id)
    if not removed:
        return utils.get_response(404, message="persona not found")
    return utils.get_response(200, {"id": persona_id})


@router.post(
    "/agent/reference/process",
    summary="对标文案提取与仿写（SSE 进度流）",
)
def process_reference(request: Request, body: ReferenceProcessRequest):
    """粘贴文案或给定对标链接/文件，逐阶段流式返回进度，最终返回转写与仿写口播稿。

    前端以 SSE（``text/event-stream``）消费：每条事件 ``data: {json}``，其中
    ``type`` 为 ``progress``（含 stage/pct/msg）、``done``（含 data 结果）或
    ``error``（含 status/message）。
    """
    import json
    import queue
    import threading

    from app.services.agent.reference import ReferenceError

    q: "queue.Queue" = queue.Queue()

    def progress(stage: str, pct: int, msg: str) -> None:
        q.put({"type": "progress", "stage": stage, "pct": pct, "msg": msg})

    def run() -> None:
        try:
            result = reference_service.process_reference(
                source=body.source,
                transcript_text=body.transcript_text,
                persona_id=body.persona_id,
                language=body.language,
                progress=progress,
            )
            q.put({"type": "done", "data": result})
        except ReferenceError as e:
            q.put({"type": "error", "status": 400, "message": str(e)})
        except Exception as e:  # 上游依赖（whisper/llm）异常统一收敛
            logger.error(f"reference process failed: {e}")
            q.put({"type": "error", "status": 500, "message": f"处理失败：{e}"})
        finally:
            q.put(None)  # 结束哨兵

    def gen():
        threading.Thread(target=run, daemon=True).start()
        while True:
            item = q.get()
            if item is None:
                break
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/agent/title-cover/generate",
    summary="生成标题 + 话题标签 + 封面",
)
def generate_title_cover(request: Request, body: TitleCoverRequest):
    """基于视频主题/文案（可选人设）生成吸睛标题、话题标签与封面图；

    若同时提供 ``video_path`` 且 ``compose=true``，还会把封面合成为成片片头。
    """
    from app.services.agent.title_cover import TitleCoverError

    try:
        result = title_cover_service.process_title_cover(
            video_subject=body.video_subject or "",
            video_script=body.video_script or "",
            language=body.language or "",
            persona_id=body.persona_id,
            base_image=body.base_image or "",
            video_path=body.video_path or "",
            engine=body.engine,
            compose=body.compose,
        )
    except TitleCoverError as e:
        return utils.get_response(400, message=str(e))
    except Exception as e:  # 上游依赖（llm/pillow/ffmpeg）异常统一收敛
        logger.error(f"title-cover generation failed: {e}")
        return utils.get_response(500, message=f"生成失败：{e}")
    return utils.get_response(200, result)


# --------------------------------------------------------------------------- #
# 合规 / 违禁词检测（Phase 6）
# --------------------------------------------------------------------------- #
@router.post(
    "/agent/compliance/check",
    summary="文案/标题违禁词合规检测",
)
def compliance_check(request: Request, body: ComplianceCheckRequest):
    """对文案 + 标题（+ 任意附加字段）做违禁词检测，返回命中分级、改写建议与是否阻断。"""
    try:
        result = compliance_service.check(
            script=body.script or "",
            title=body.title or "",
            extra=body.extra,
        )
    except Exception as e:
        logger.error(f"compliance check failed: {e}")
        return utils.get_response(500, message=f"检测失败：{e}")
    return utils.get_response(200, result.model_dump())


@router.get(
    "/agent/compliance/industries",
    summary="已加载的违禁词行业列表",
)
def compliance_industries(request: Request):
    """返回当前已加载词库的行业名（含 custom / legacy），用于前端展示词库规模。"""
    return utils.get_response(200, compliance_service.industries())


@router.get(
    "/agent/compliance/stats",
    summary="各违禁词行业规则条数",
)
def compliance_stats(request: Request):
    """返回每个行业的规则条数，便于了解词库覆盖度。"""
    return utils.get_response(200, compliance_service.stats())


@router.post(
    "/agent/compliance/reload",
    summary="热重载违禁词库",
)
def compliance_reload(request: Request):
    """修改词库文件（行业词库或自定义词）后调用，无需重启服务即可生效。"""
    count = compliance_service.reload_dictionaries()
    return utils.get_response(200, {"entries": count})


@router.get(
    "/agent/compliance/custom-words",
    summary="列出用户自定义违禁词",
)
def compliance_custom_words(request: Request):
    """读取 storage/forbidden_words/custom.txt 中的自定义词原始行。"""
    return utils.get_response(200, compliance_service.list_custom_words())


@router.post(
    "/agent/compliance/custom-words",
    summary="新增用户自定义违禁词",
)
def compliance_add_custom_words(request: Request, body: ComplianceCustomWordRequest):
    """追加自定义词（每行一条，格式与行业词库相同）。返回实际新增条数。"""
    added = compliance_service.add_custom_words(body.words)
    if added == 0:
        return utils.get_response(400, message="未提供有效的自定义词")
    return utils.get_response(200, {"added": added})


@router.delete(
    "/agent/compliance/custom-words",
    summary="删除用户自定义违禁词",
)
def compliance_remove_custom_word(request: Request, word: str):
    """按整行或触发词（第一字段）删除自定义词。"""
    removed = compliance_service.remove_custom_word(word)
    if not removed:
        return utils.get_response(404, message="custom word not found")
    return utils.get_response(200, {"word": word})


# --------------------------------------------------------------------------- #
# TTS 服务 & 试听（声音克隆页）
# --------------------------------------------------------------------------- #
@router.get("/agent/tts/services", summary="列出可用 TTS 服务及音色")
def list_tts_services(request: Request):
    """返回已配置的 TTS 服务列表，每项含 service_id / label / voices（音色名数组）。

    前端用此数据填充「配音服务」下拉和「配音声音」下拉。
    """
    import os
    from app.services.voice import (
        get_all_azure_voices,
        get_siliconflow_voices,
        get_gemini_voices,
        get_mimo_voices,
        get_minimax_voices,
        get_elevenlabs_voices,
        get_chatterbox_voices,
    )
    from app.config import config

    services = []
    cfg = config

    # 各子配置段都是 _SynchronizedConfig(dict)：必须用 .get() 字典访问，不能用
    # getattr(...)，否则 dict 没有对应属性、永远取到 None（即此前云端服务始终不出现的原因）。
    # [app] 段里的 key（gemini_api_key / mimo_api_key / minimax_api_key）通过 cfg.app.get() 读取。

    # --- 微软 TTS（免费 / Edge，无需 Azure key）---
    # azure_tts_v1 底层走 edge_tts，免费、无需订阅 key，因此即使未配置
    # [azure].speech_key 也应暴露给前端；真正的付费云端 Azure SDK 是 azure_tts_v2。
    try:
        az_voices = get_all_azure_voices()
        # 中文用户优先：把 zh-CN 音色排到最前，其余语种按原序在后，
        # 避免按字母截断时中文（在列表末尾）被裁掉、前端看不到。
        zh_voices = [v for v in az_voices if v.startswith("zh-CN")]
        other_voices = [v for v in az_voices if not v.startswith("zh-CN")]
        az_voices = zh_voices + other_voices
        services.append({
            "id": "azure-tts-v1", "label": "微软 TTS（免费）", "channel": "free",
            "voices": az_voices,
        })
    except Exception:
        services.append({"id": "azure-tts-v1", "label": "微软 TTS（免费）", "channel": "free", "voices": [], "error": "无法获取音色列表"})

    # --- SiliconFlow ---
    if getattr(cfg, "siliconflow", None) and cfg.siliconflow.get("api_key"):
        try:
            sf = get_siliconflow_voices()
            services.append({"id": "siliconflow", "label": "SiliconFlow (CosyVoice)", "channel": "cloud", "voices": sf})
        except Exception:
            services.append({"id": "siliconflow", "label": "SiliconFlow", "channel": "cloud", "voices": []})

    # --- Gemini TTS（key 在 [app] 段）---
    if cfg.app.get("gemini_api_key"):
        try:
            gm = get_gemini_voices()
            services.append({"id": "gemini-tts", "label": "Gemini TTS", "channel": "cloud", "voices": gm})
        except Exception:
            services.append({"id": "gemini-tts", "label": "Gemini TTS", "channel": "cloud", "voices": []})

    # --- Mimo TTS（key 在 [app] 段）---
    if cfg.app.get("mimo_api_key"):
        try:
            mm = get_mimo_voices()
            services.append({"id": "mimo-tts", "label": "Mimo TTS", "channel": "cloud", "voices": mm})
        except Exception:
            services.append({"id": "mimo-tts", "label": "Mimo TTS", "channel": "cloud", "voices": []})

    # --- MiniMax TTS ---
    if getattr(cfg, "minimax_tts", None) and (
        cfg.minimax_tts.get("model_id") or cfg.app.get("minimax_api_key")
    ):
        try:
            mx = get_minimax_voices()
            services.append({"id": "minimax-tts", "label": "MiniMax TTS", "channel": "cloud", "voices": mx})
        except Exception:
            services.append({"id": "minimax-tts", "label": "MiniMax TTS", "channel": "cloud", "voices": []})

    # --- ElevenLabs ---
    if getattr(cfg, "elevenlabs", None) and cfg.elevenlabs.get("api_key"):
        try:
            el = get_elevenlabs_voices(cfg.elevenlabs.get("api_key", ""))
            services.append({"id": "elevenlabs", "label": "ElevenLabs", "channel": "cloud", "voices": el})
        except Exception:
            services.append({"id": "elevenlabs", "label": "ElevenLabs", "channel": "cloud", "voices": []})

    # --- Chatterbox（本地自托管 OpenAI 兼容服务，无需 api_key）---
    if getattr(cfg, "chatterbox", None) and cfg.chatterbox.get("base_url"):
        try:
            cb = get_chatterbox_voices()
            services.append({"id": "chatterbox", "label": "Chatterbox（本地）", "channel": "local", "voices": cb})
        except Exception:
            services.append({"id": "chatterbox", "label": "Chatterbox（本地）", "channel": "local", "voices": []})

    # --- 本地 XTTS（需配置 [voice_clone.xtts].local_script 指向的引擎；脚本文件存在即出现）---
    _xtts = cfg.voice_clone.get("xtts", {}) or {}
    if isinstance(_xtts, dict) and _xtts.get("local_script") and os.path.isfile(_xtts["local_script"]):
        try:
            from app.services.voice import get_local_xtts_voices
            services.append({"id": "local_xtts", "label": "本地 XTTS", "channel": "local", "voices": get_local_xtts_voices()})
        except Exception:
            services.append({"id": "local_xtts", "label": "本地 XTTS", "channel": "local", "voices": []})

    # --- 本地 CosyVoice（需配置 [voice_clone.cosyvoice].local_script 指向的引擎）---
    _cv = cfg.voice_clone.get("cosyvoice", {}) or {}
    if isinstance(_cv, dict) and _cv.get("local_script") and os.path.isfile(_cv["local_script"]):
        try:
            from app.services.voice import get_local_cosyvoice_voices
            services.append({"id": "local_cosyvoice", "label": "本地 CosyVoice", "channel": "local", "voices": get_local_cosyvoice_voices()})
        except Exception:
            services.append({"id": "local_cosyvoice", "label": "本地 CosyVoice", "channel": "local", "voices": []})

    # --- 供应商聚合（vendor registry）：把已配置供应商的 TTS 能力并入下拉 ---
    # 这样用户在「系统设置 → 供应商聚合」里填好的 KEY/地址能直接作为配音服务商
    # 出现，而不必再到各 legacy 区段重复配置。live 且已配 key 的能力可选；
    # planned 能力置灰标注「待接入」。与上方 legacy 段去重（同 id 不重复列）。
    try:
        from app.models.vendor_registry import list_vendors as _vlist, CAP_TTS as _CAP_TTS
        from app.services.voice import (
            get_deepsea_voices,
            get_minimax_voices,
            get_siliconflow_voices,
        )

        _existing_ids = {s.get("id") for s in services}
        _voices_getters = {
            "deepsea": get_deepsea_voices,
            "minimax": get_minimax_voices,
            "siliconflow": get_siliconflow_voices,
        }
        for _v in _vlist():
            _cap = _v.capability(_CAP_TTS)
            if _cap is None:
                continue
            _sid = _cap.target
            if _sid in _existing_ids:
                continue  # 已由 legacy 区段列出，避免重复
            _vblock = getattr(cfg, "vendors", {}) or {}
            _vblock = _vblock.get(_v.vendor_id, {}) if isinstance(_vblock, dict) else {}
            _has_key = bool(_vblock.get("api_key")) if isinstance(_vblock, dict) else False
            if _cap.status == "live" and not _has_key:
                # live 但用户尚未填 KEY：不列以免选了却合成失败（去供应商卡片填即可）
                continue
            try:
                _getter = _voices_getters.get(_v.vendor_id)
                _voices = _getter() if _getter else []
            except Exception:
                _voices = []
            services.append({
                "id": _sid,
                "label": f"{_v.label} TTS" + ("" if _cap.status == "live" else "（待接入）"),
                "channel": "cloud",
                "voices": _voices,
                "planned": _cap.status != "live",
            })
    except Exception as _e:  # 登记表异常不应阻断其余 TTS 服务
        logger.warning(f"vendor registry tts bridge failed: {_e}")

    # 当前默认值（[ui] 段）
    _ui = cfg.ui if getattr(cfg, "ui", None) else None
    current_service = _ui.get("tts_server", "azure-tts-v1") if _ui else "azure-tts-v1"
    current_voice = _ui.get("voice_name", "") if _ui else ""

    return utils.get_response(200, {
        "services": services,
        "current_service": current_service,
        "current_voice": current_voice,
    })


@router.get("/agent/vendors", summary="列出供应商能力登记表（一家多模型）")
def list_vendors_endpoint(request: Request):
    """返回供应商聚合登记表：每家供应商支持的能力（llm/tts/digital_human）、

    指向的既有适配器、默认模型/音色、落地状态，以及当前已配置的 ``[vendors]`` 段。
    前端「系统设置 → 大模型/视频（常用）」据此按供应商分组渲染，实现「一家配一次、
    多能力对应多模型」。
    """
    from app.config import config as cfg_module
    from app.models.vendor_registry import list_vendors, CAP_LLM, CAP_TTS, CAP_DH

    cap_label = {CAP_LLM: "大模型", CAP_TTS: "配音", CAP_DH: "数字人"}
    data = []
    for v in list_vendors():
        caps = [
            {
                "capability": c.capability,
                "label": cap_label.get(c.capability, c.capability),
                "target": c.target,
                "default_model": c.default_model,
                "default_voice": c.default_voice,
                "status": c.status,
            }
            for c in v.capabilities
        ]
        data.append({
            "vendor_id": v.vendor_id,
            "label": v.label,
            "api_key_url": v.api_key_url,
            "default_base_url": v.default_base_url,
            "capabilities": caps,
        })
    current = dict(getattr(cfg_module, "vendors", {}) or {})
    return utils.get_response(200, {"vendors": data, "config": current})


@router.get("/agent/vendors/{vendor_id}/fetch-models", summary="从供应商服务器拉取可用模型/音色")
def fetch_vendor_models(vendor_id: str, capability: str = Query(default="tts")):
    """让后端以用户已填的 API Key / Base URL 去供应商服务器枚举可用模型与音色，
    避免用户手填模型名出错（如 ``Model does not exist``）。

    - 模型：调用 OpenAI 兼容的 ``GET {base_url}/models``（兼容网关普遍支持）。
    - 音色：尽力调用 ``GET {base_url}/audio/voices``，失败则留空（多数网关音色为固定枚举）。
    返回 ``{models:[...], voices:[...]}``。
    """
    import requests
    from app.config import config as cfg_module
    from app.models.vendor_registry import get_vendor, resolve_vendor_override

    if get_vendor(vendor_id) is None:
        return utils.get_response(404, message="未知供应商")
    ov = resolve_vendor_override(vendor_id, capability, getattr(cfg_module, "vendors", {})) or {}
    api_key = (ov.get("api_key") or "").strip()
    base_url = (ov.get("base_url") or "").strip().rstrip("/")
    if not api_key or not base_url:
        return utils.get_response(
            400,
            message="请先在「供应商聚合 → " + vendor_id + "」填写共享 API Key 与 Base URL 后再拉取",
        )

    models, voices = [], []
    try:
        r = requests.get(
            f"{base_url}/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=20,
        )
        if r.status_code == 200:
            for m in (r.json().get("data") or []):
                mid = (m.get("id") or "").strip()
                if mid:
                    models.append(mid)
        else:
            logger.warning(f"fetch models from {vendor_id} failed: {r.status_code} {r.text[:120]}")
    except Exception as e:
        logger.warning(f"fetch models from {vendor_id} error: {e}")

    try:
        rv = requests.get(
            f"{base_url}/audio/voices",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=20,
        )
        if rv.status_code == 200:
            for v in (rv.json().get("data") or []):
                vid = (v.get("voice") or v.get("id") or "").strip()
                if vid:
                    voices.append(vid)
    except Exception:
        pass  # 音色接口非标准，缺失不影响模型拉取

    return utils.get_response(200, {"models": models, "voices": voices})


@router.post("/agent/tts/preview", summary="试听音色（生成短音频）")
def tts_preview(request: Request, body: TTSPreviewRequest):
    """用指定服务+音色+参数合成一段短音频，返回可播放的文件路径（asset URL）。

    前端拿到路径后用 ``<audio>`` 播放。
    """
    import tempfile
    from pathlib import Path
    from app.services.voice import tts

    text = (body.text or "你好，这是一段试听音频。").strip()
    voice_name = body.voice_name or ""
    service = body.service or "azure-tts-v1"
    volume = max(0.0, min(2.0, body.volume or 1.0))
    rate = max(0.5, min(2.0, body.rate or 1.0))

    if not voice_name:
        return utils.get_response(400, message="请选择配音声音")

    # 输出到临时目录，前端通过 /api/v1/asset 播放
    out_dir = Path(tempfile.mkdtemp(prefix="tts_preview_", dir="storage"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = str(out_dir / "preview.mp3")

    try:
        result = tts(
            text=text,
            voice_name=voice_name,
            voice_file=out_file,
            voice_rate=rate,
            voice_volume=volume,
        )
        if result is None or not Path(out_file).exists():
            return utils.get_response(500, message="TTS 合成失败：未产出音频文件")
        # 返回相对路径供 asset 端点使用
        rel = str(out_file).replace("\\", "/")
        m = rel.match(r"(storage/.*)$") if hasattr(rel, "match") else None
        if not m:
            import re as _re
            m = _re.search(r"(storage/.*)$", rel)
        asset_path = m.group(1) if m else rel
        duration = getattr(result, "duration", None) if hasattr(result, "duration") else None
        return utils.get_response(200, {
            "audio_url": f"/api/v1/asset?path={asset_path}",
            "duration": round(duration, 2) if duration else None,
        })
    except Exception as e:
        logger.error(f"TTS preview failed: {e}")
        return utils.get_response(500, message=f"试听失败：{e}")


@router.post(
    "/agent/voice/clone",
    summary="声音克隆（SSE 进度流）",
)
def voice_clone(request: Request, body: VoiceCloneRequest):
    """上传样本音频 → 调用指定 Provider 的 clone() → 返回 voice_id。

    SSE 流式返回进度（与对标仿写一致）：progress → done(error)。
    """
    import json
    import queue
    import threading

    q: "queue.Queue" = queue.Queue()

    def progress(stage: str, pct: int, msg: str) -> None:
        q.put({"type": "progress", "stage": stage, "pct": pct, "msg": msg})

    def run() -> None:
        try:
            provider_name = (body.provider or "local_xtts").strip()
            sample_audio = (body.sample_audio or "").strip()

            if not sample_audio:
                q.put({"type": "error", "status": 400, "message": "请提供样本音频（先上传到服务器）"})
                return
            if not __import__("os").path.isfile(sample_audio):
                q.put({"type": "error", "status": 400, "message": f"样本音频文件不存在: {sample_audio}"})
                return

            progress("cloning", 20, f"正在用 {provider_name} 克隆音色…")

            from app.services.agent.providers import VoiceCloneProvider, PROVIDER_REGISTRY

            cls = PROVIDER_REGISTRY.get(provider_name)
            if cls is None:
                q.put({"type": "error", "status": 400, "message": f"未知的克隆 Provider: {provider_name}"})
                return

            # 构造最小配置实例
            from app.services.agent.persona import VoiceConfig
            vc_cfg = VoiceConfig(provider=provider_name, sample_audio=sample_audio)
            try:
                inst = cls.from_config(vc_cfg)
            except NotImplementedError:
                q.put({"type": "error", "status": 400, "message": f"{provider_name} 未配置或不可用，请检查 [voice_clone] 区段"})
                return

            progress("cloning", 50, "上传样本 / 训练中…")
            voice_id = inst.clone(sample_audio=sample_audio)

            progress("done", 100, "克隆完成 ✓")
            q.put({"type": "done", "data": {"voice_id": voice_id, "provider": provider_name}})
        except Exception as e:
            logger.error(f"voice clone failed: {e}")
            q.put({"type": "error", "status": 500, "message": f"克隆失败: {e}"})
        finally:
            q.put(None)

    def gen():
        threading.Thread(target=run, daemon=True).start()
        while True:
            item = q.get()
            if item is None:
                break
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/agent/digital-human/generate",
    summary="独立数字人生成（SSE 进度流）",
)
def digital_human_generate(request: Request, body: DigitalHumanGenerateRequest):
    """脱离完整任务流水线，单独合成一段对口型口播视频。

    流程：① 解析数字人配置（persona_id 优先，否则用 provider+image_path）；
    ② 用 ``voice_name`` 即时合成配音音频；③ 调用对应 Provider 的 generate()
    产出对口型视频。SSE 流式返回 progress → done(error)。
    """
    import json
    import os
    import queue
    import re
    import tempfile
    import threading

    from pathlib import Path

    from app.services.voice import tts
    from app.services.agent.providers import (
        get_provider,
        DigitalHumanProvider,
    )
    from app.services.agent.providers._common import agent_output_dir

    q: "queue.Queue" = queue.Queue()

    def progress(stage: str, pct: int, msg: str) -> None:
        q.put({"type": "progress", "stage": stage, "pct": pct, "msg": msg})

    def run() -> None:
        try:
            text = (body.text or "").strip()
            if not text:
                q.put({"type": "error", "status": 400, "message": "请填写口播文案"})
                return

            # ① 解析数字人配置
            provider_name = (body.provider or "").strip()
            image_path = (body.image_path or "").strip()
            video_path = (body.video_path or "").strip()
            if body.persona_id:
                progress("prepare", 5, "读取人设数字人形象…")
                persona = persona_store.get_persona(body.persona_id)
                if persona is None:
                    q.put({"type": "error", "status": 404, "message": "persona not found"})
                    return
                dh = persona.digital_human
                provider_name = provider_name or dh.provider
                image_path = image_path or dh.source_image
                video_path = video_path or dh.source_video
            if not provider_name or provider_name in ("", "auto"):
                q.put({"type": "error", "status": 400, "message": "未指定数字人 Provider（人设需将 provider 设为 local_sadtalker 等）"})
                return
            if not image_path and not video_path:
                q.put({"type": "error", "status": 400, "message": "缺少肖像图或参考视频"})
                return

            # ② 合成配音音频
            progress("tts", 20, "正在合成配音音频…")
            from app.services.agent.providers._common import ProviderConfigError, ProviderError
            from app.config.config import root_dir
            audio_dir = Path(tempfile.mkdtemp(prefix="dh_audio_", dir=os.path.join(root_dir, "storage")))
            audio_dir.mkdir(parents=True, exist_ok=True)
            audio_file = str(audio_dir / "audio.mp3")
            sub_maker = tts(
                text=text,
                voice_name=body.voice_name or "zh-CN-XiaoxiaoNeural-Female",
                voice_file=audio_file,
                voice_rate=max(0.5, min(2.0, body.voice_rate or 1.0)),
                voice_volume=max(0.0, min(2.0, body.voice_volume or 1.0)),
            )
            if sub_maker is None or not Path(audio_file).exists():
                q.put({"type": "error", "status": 500, "message": "配音音频合成失败，请检查 voice_name 或 TTS 连通性"})
                return

            # ③ 调用 Provider 生成对口型视频
            progress("generate", 55, f"正在用 {provider_name} 生成数字人视频…（需 GPU，可能较慢）")
            cls = get_provider(provider_name)
            if cls is None or not issubclass(cls, DigitalHumanProvider):
                q.put({"type": "error", "status": 400, "message": f"未知的数字人 Provider: {provider_name}"})
                return
            cfg = {
                "provider": provider_name,
                "source_image": image_path,
                "source_video": video_path,
            }
            try:
                inst = cls.from_config(cfg)
            except NotImplementedError:
                inst = cls()
            out = None
            try:
                out = inst.generate(
                    audio_path=audio_file,
                    image_path=image_path,
                    video_path=video_path,
                    preprocess=body.preprocess or None,
                    still=body.still or None,
                    expression_scale=body.expression_scale,
                )
            except (ProviderConfigError, ProviderError) as e:
                q.put({"type": "error", "status": 500, "message": f"数字人生成失败: {e}"})
                return
            if not out or not os.path.isfile(out):
                q.put({"type": "error", "status": 500, "message": "数字人未产出视频文件"})
                return

            progress("done", 100, "数字人视频生成完成 ✓")
            rel = out.replace("\\", "/")
            m = re.search(r"(storage/.*)$", rel)
            asset_path = m.group(1) if m else rel
            q.put({"type": "done", "data": {
                "video_url": f"/api/v1/asset?path={asset_path}",
                "video_path": asset_path,
            }})
        except Exception as e:
            logger.error(f"digital human generate failed: {e}")
            q.put({"type": "error", "status": 500, "message": f"生成失败: {e}"})
        finally:
            q.put(None)

    def gen():
        threading.Thread(target=run, daemon=True).start()
        while True:
            item = q.get()
            if item is None:
                break
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Phase 8 · 批量任务调度与监控
# ---------------------------------------------------------------------------
def _abs_to_task_url(path: str) -> str:
    """把 storage/tasks 下的绝对路径转成前端可播放/下载的 /tasks/... URL。

    非 tasks 目录下的路径（如临时文件）原样返回，由前端降级为禁用链接。
    """
    if not path:
        return ""
    try:
        rel = os.path.relpath(path, utils.task_dir())
        if not rel.startswith(".."):
            return "/tasks/" + rel.replace("\\", "/")
    except Exception:
        pass
    return path


def _task_to_view(task: dict) -> dict:
    spec = task.get("spec") or {}
    result = task.get("result") or {}
    videos = [_abs_to_task_url(v) for v in (result.get("videos") or [])]
    combined = [_abs_to_task_url(v) for v in (result.get("combined_videos") or [])]
    return AgentTaskView(
        task_id=task.get("task_id", ""),
        batch_id=task.get("batch_id"),
        batch_name=task.get("batch_name"),
        topic=spec.get("topic") or task.get("topic"),
        persona_id=spec.get("persona_id") or task.get("persona_id"),
        channel=spec.get("channel") or task.get("channel"),
        priority=int(task.get("priority", 0)),
        state=int(task.get("state", 0)),
        progress=int(task.get("progress", 0)),
        attempt=int(task.get("attempt", 0)),
        created_at=task.get("created_at"),
        updated_at=task.get("updated_at"),
        started_at=task.get("started_at") or None,
        finished_at=task.get("finished_at") or None,
        error=task.get("error") or None,
        last_error=task.get("last_error") or None,
        review_reason=task.get("review_reason") or None,
        review_decision=task.get("review_decision") or None,
        review_note=task.get("review_note") or None,
        videos=videos,
        combined_videos=combined,
    ).model_dump()


@router.post(
    "/agent/tasks/batch",
    response_model=AgentBatchSubmitResponse,
    summary="批量提交口播创作任务",
)
def submit_agent_tasks(request: Request, body: AgentBatchSubmitRequest):
    """提交多个创作任务，按各自 priority 进入优先级队列。"""
    if not body.tasks:
        return utils.get_response(400, message="tasks is empty")

    manager = get_agent_manager()
    specs = [t.model_dump() for t in body.tasks]
    try:
        result = manager.submit_batch(specs, batch_name=body.batch_name)
    except Exception as e:  # 队列满等
        logger.warning(f"agent batch submit rejected: {e}")
        raise HttpException(
            task_id="", status_code=429, message=f"提交失败：{e}"
        )
    return utils.get_response(200, result)


@router.get(
    "/agent/tasks/dashboard",
    summary="调度看板聚合统计",
)
def agent_dashboard(request: Request):
    manager = get_agent_manager()
    return utils.get_response(200, manager.dashboard_stats())


@router.get(
    "/agent/tasks",
    summary="列出口播任务（可按状态过滤/分页/排序）",
)
def list_agent_tasks(
    request: Request,
    status: int = Query(None, description="状态过滤：0待处理/4处理中/1完成/-1失败/5复审/6取消"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    sort_by_priority: bool = Query(True),
):
    manager = get_agent_manager()
    result = manager.list_tasks(
        status_filter=status,
        page=page,
        page_size=page_size,
        sort_by_priority=sort_by_priority,
    )
    result["tasks"] = [_task_to_view(t) for t in result["tasks"]]
    return utils.get_response(200, result)


@router.get(
    "/agent/tasks/{task_id}",
    summary="查询单个口播任务",
)
def get_agent_task(request: Request, task_id: str):
    manager = get_agent_manager()
    task = manager.list_tasks(page_size=10000)["tasks"]
    hit = next((t for t in task if t.get("task_id") == task_id), None)
    if not hit:
        raise HttpException(task_id=task_id, status_code=404, message="task not found")
    return utils.get_response(200, _task_to_view(hit))


@router.post(
    "/agent/tasks/{task_id}/retry",
    response_model=AgentRetryResponse,
    summary="手动重试失败/复审/取消的任务",
)
def retry_agent_task(request: Request, task_id: str):
    manager = get_agent_manager()
    ok = manager.retry(task_id)
    task = manager.list_tasks(page_size=10000)["tasks"]
    hit = next((t for t in task if t.get("task_id") == task_id), None)
    state = int(hit.get("state", 0)) if hit else 0
    if not ok:
        return utils.get_response(409, message="该任务当前状态不可重试", result={"task_id": task_id, "retried": False})
    return utils.get_response(200, {"task_id": task_id, "state": state, "retried": True})


@router.post(
    "/agent/tasks/{task_id}/review",
    summary="人工复审决议（通过/驳回）",
)
def review_agent_task(request: Request, task_id: str, body: AgentReviewRequest):
    manager = get_agent_manager()
    ok = manager.resolve_review(task_id, approve=body.approve, note=body.note)
    if not ok:
        return utils.get_response(409, message="该任务当前状态不可复审")
    return utils.get_response(200, {"task_id": task_id, "approved": body.approve})


@router.post(
    "/agent/tasks/{task_id}/cancel",
    summary="取消任务（待处理/处理中）",
)
def cancel_agent_task(request: Request, task_id: str):
    manager = get_agent_manager()
    ok = manager.cancel(task_id)
    if not ok:
        return utils.get_response(409, message="该任务当前状态不可取消")
    return utils.get_response(200, {"task_id": task_id, "cancelled": True})


@router.delete(
    "/agent/tasks/{task_id}",
    summary="删除已结束/失败的任务",
)
def delete_agent_task(request: Request, task_id: str):
    manager = get_agent_manager()
    ok = manager.delete(task_id)
    if not ok:
        return utils.get_response(409, message="仅可删除已结束或失败的任务")
    return utils.get_response(200, {"task_id": task_id, "deleted": True})
