"""口播智能体 · 对标文案提取与仿写（Phase 4）。

把「对标视频」变成「可套用的人设口播稿」：

    对标链接 / 本地文件 / 粘贴文案
            │
            ▼
      fetch_reference  （本地文件直接用；URL 走 yt-dlp；粘贴文案跳过）
            │
            ▼
      _extract_audio   （视频→音频，ffmpeg）
            │
            ▼
      transcribe_audio （faster-whisper 转写 → 纯文本）
            │
            ▼
      rewrite_script   （LLM 语义级仿写，保留人设口吻）
            │
            ▼
      { transcript, rewritten_script, source }

设计要点：
- 复用项目已有的 faster-whisper 与 LLM 引擎，不引入新重依赖。
- 任意一环缺依赖/缺模型都给出清晰、可操作的错误，而非崩溃。
- 支持「直接粘贴转写文案」跳过下载与转写，最稳妥也最常用。
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
from urllib.parse import urlparse

try:
    from faster_whisper import WhisperModel
except ImportError:
    WhisperModel = None

from app.config import config
from app.utils import utils

logger = logging.getLogger(__name__)

# faster-whisper 模型懒加载（与 subtitle.py 同策略）。
_whisper_model = None

# 仅保留 yt-dlp 确实没有解析器的平台（快手）。抖音/小红书/微博等 yt-dlp
# 已内置解析器，应当放行让其尝试下载，从而拿到「完整视频转写」而非仅标题。
# 下载失败（Unsupported URL / 需要登录等）会在 _download_with_ytdlp 中收敛为
# 清晰提示，或在对标仿写流程里回退到「分享文案标题」做仿写。
_UNSUPPORTED_HOST_HINTS = {
    "kuaishou.com": "快手",
}


class ReferenceError(RuntimeError):
    """对标处理链路中的可预期错误（缺依赖 / 缺模型 / 空转写等）。"""


# --------------------------------------------------------------------------- #
# 路径与下载
# --------------------------------------------------------------------------- #
def _cache_dir() -> str:
    """解析对标素材缓存目录（相对路径以项目根为基准）。"""
    base = config.reference.get("cache_dir", "storage/reference_cache")
    path = base if os.path.isabs(base) else os.path.join(utils.root_dir(), base)
    os.makedirs(path, exist_ok=True)
    return path


def _detect_unsupported_platform(source: str) -> str | None:
    """若链接属于 yt-dlp 默认不支持的平台，返回平台中文名，否则返回 None。"""
    host = (urlparse(source).hostname or "").lower()
    for bad_host, name in _UNSUPPORTED_HOST_HINTS.items():
        if host == bad_host or host.endswith("." + bad_host):
            return name
    return None


# --------------------------------------------------------------------------- #
# 平台分享文案解析（抖音 / 小红书 / 快手 / 微博 的「复制链接」分享文本）
# --------------------------------------------------------------------------- #
# 这类分享文本形如：
#   "8.79 复制打开抖音，看看【田哥的作品】随遇而安不也是一种生活# 城市的夜晚
#    https://v.douyin.com/xxxx/ 02/27 NWm:/ :7pm n@Q.kP"
# 其中既含真实短链，又含可直接用作对标文案的标题/口播内容。直接丢给
# fetch_reference 会因「不是链接/本地文件」报错；正确做法是抽取其中的标题文案。
_URL_RE = re.compile(r"https?://[^\s，。；！？]+")

_SHARE_BOILERPLATE = (
    "复制打开抖音，看看",
    "复制打开抖音",
    "打开抖音搜索",
    "打开抖音",
    "点击链接直接打开",
    "长按复制此链接",
    "长按复制",
    "复制此链接",
    "打开看看",
    "该作品仅供",
    "更多作品",
)
_SHARE_HOSTS = (
    "v.douyin.com",
    "xhslink.com",
    "v.kuaishou.com",
    "douyin.com",
    "xiaohongshu.com",
    "kuaishou.com",
    "weibo.com",
    "weibo.cn",
)
_SHARE_KEYWORDS = ("抖音", "小红书", "快手", "微博", "复制打开", "长按复制")


def _extract_url(text: str) -> str | None:
    """从文本中抽出第一个 http(s) 链接（识别分享文案里的真实短链）。"""
    if not text:
        return None
    m = _URL_RE.search(text)
    return m.group(0) if m else None


def _looks_like_share(text: str) -> bool:
    """文本是否像平台分享文案（含平台词或短链域名），需要清洗抽取。"""
    t = text or ""
    if any(k in t for k in _SHARE_KEYWORDS):
        return True
    low = t.lower()
    return any(h in low for h in _SHARE_HOSTS)


def _clean_share_text(text: str) -> str:
    """把抖音/小红书等分享文案清洗为可用标题/口播文案。

    去除：链接、作者标签【】、平台引导语、日期、尾部分享暗码，返回纯文案。
    清洗后中文过少（<6 字）视为抽取失败，返回空串交上层降级处理。
    """
    t = text or ""
    t = _URL_RE.sub(" ", t)  # 去链接
    t = re.sub(r"【[^】]{0,30}】", " ", t)  # 去【作者作品】
    t = re.sub(r"\[[^]]{0,30}\]", " ", t)  # 去 [..] 标签
    for phrase in _SHARE_BOILERPLATE:
        t = t.replace(phrase, " ")
    t = re.sub(r"\b\d{1,2}/\d{1,2}\b", " ", t)  # 02/27 日期
    t = re.sub(r"[A-Za-z0-9]{2,5}:/[^\s]*", " ", t)  # NWm:/... 暗码
    t = re.sub(r"\S*@\S*", " ", t)  # n@Q.kP 类尾部码
    t = re.sub(r":[A-Za-z0-9]{1,6}", " ", t)  # :7pm 类尾部时间码
    t = re.sub(r"^\s*\d+(?:\.\d+)?\s*", "", t)  # 8.79 开头点赞数
    t = re.sub(r"\s+", " ", t).strip()
    t = t.strip(" ，,。.：:；;-—")
    han = re.findall(r"[一-鿿]", t)
    return t if len(han) >= 6 else ""


def fetch_reference(source: str) -> str:
    """把对标来源解析为本地媒体文件路径。

    - 本地已存在的文件：直接返回。
    - http(s) 链接：需配置 ``reference.download_engine = "yt_dlp"`` 且已安装
      yt-dlp，否则抛出可操作的错误。已知不支持的平台（抖音/小红书/快手/微博）
      会在调用下载前给出明确提示，引导改用「粘贴转写文案」。
    """
    if not source or not source.strip():
        raise ReferenceError("未提供对标来源（链接 / 本地文件 / 粘贴文案）。")

    source = source.strip()
    # 本地文件：直接使用
    if os.path.isfile(source):
        return source

    # 网络链接
    if source.lower().startswith(("http://", "https://")):
        platform = _detect_unsupported_platform(source)
        if platform:
            raise ReferenceError(
                f"「{platform}」链接暂不支持自动下载（yt-dlp 无对应解析器）。\n"
                f"请改为：在{platform}打开该视频，复制其文案 / 字幕，"
                f"切到「粘贴转写文案」模式直接粘贴即可仿写。"
            )
        engine = (config.reference.get("download_engine") or "").strip().lower()
        if engine != "yt_dlp":
            raise ReferenceError(
                "当前未启用网络下载（reference.download_engine 未设为 'yt_dlp'）。\n"
                "可改为：提供本地媒体文件，或直接粘贴对标转写文案；"
                "若需下载网络视频，请先 `pip install yt-dlp` 并把 download_engine 设为 'yt_dlp'。"
            )
        return _download_with_ytdlp(source)

    raise ReferenceError(f"无法识别的对标来源（不是本地文件也不是链接）：{source}")


def _download_with_ytdlp(url: str) -> str:
    try:
        import yt_dlp  # 懒导入：绝大多数环境没有该依赖
    except ImportError:
        raise ReferenceError(
            "未安装 yt-dlp，无法下载网络视频。\n"
            "请先 `pip install yt-dlp`，或将 download_engine 设为 'yt_dlp'；"
            "也可直接提供本地文件或粘贴转写文案。"
        )

    out_tmpl = os.path.join(_cache_dir(), "%(id)s.%(ext)s")
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": out_tmpl,
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": False,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
    except Exception as e:  # yt-dlp 抛出的异常类型繁多，统一收敛
        msg = str(e)
        # 平台不支持 / 非直链：转成清晰、可操作的提示，避免原始报错外泄。
        if "Unsupported URL" in msg or "no suitable InfoExtractor" in msg:
            raise ReferenceError(
                "该链接 yt-dlp 无法解析（Unsupported URL）——可能是平台不支持，"
                "或链接不是可直接下载的视频地址（如精选页/分享页）。\n"
                "建议改用「粘贴转写文案」：复制视频文案后直接粘贴即可仿写。"
            ) from e
        raise ReferenceError(f"下载对标视频失败：{e}") from e

    if not filename or not os.path.isfile(filename):
        raise ReferenceError(f"下载完成但未找到媒体文件：{filename}")
    return filename


# --------------------------------------------------------------------------- #
# 音频提取与转写
# --------------------------------------------------------------------------- #
def _extract_audio(video_path: str, out_audio: str) -> str:
    """用项目自带 ffmpeg 把视频抽成 16k 单声道 wav（whisper 友好）。"""
    ffmpeg = utils.get_ffmpeg_binary()
    if not ffmpeg:
        raise ReferenceError(
            "未找到 ffmpeg，无法从视频提取音频。请检查 ffmpeg 安装或 IMAGEIO_FFMPEG_EXE 配置。"
        )
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        video_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        out_audio,
    ]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError as e:
        raise ReferenceError(f"ffmpeg 提取音频失败：{e}") from e
    if not os.path.isfile(out_audio):
        raise ReferenceError("ffmpeg 提取音频后未生成文件。")
    return out_audio


def _load_whisper_model():
    global _whisper_model
    if WhisperModel is None:
        raise ReferenceError("faster-whisper 不可用，无法转写音频。请安装 faster-whisper。")
    if _whisper_model is None:
        model_size = config.whisper.get("model_size", "large-v3")
        device = config.whisper.get("device", "cpu")
        compute_type = config.whisper.get("compute_type", "int8")
        model_path = f"{utils.root_dir()}/models/whisper-{model_size}"
        if not (os.path.isdir(model_path) and os.path.isfile(f"{model_path}/model.bin")):
            model_path = model_size
        logger.info(f"reference: loading whisper {model_path} ({device}/{compute_type})")
        _whisper_model = WhisperModel(
            model_size_or_path=model_path, device=device, compute_type=compute_type
        )
    return _whisper_model


def transcribe_audio(audio_path: str, language: str | None = None) -> str:
    """把音频转写为纯文本（无时间戳、无序号）。language=None 时自动检测。"""
    if not audio_path or not os.path.isfile(audio_path):
        raise ReferenceError(f"待转写音频不存在：{audio_path}")

    model = _load_whisper_model()
    segments, info = model.transcribe(
        audio_path,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
        **({"language": language} if language else {}),
    )
    if info and getattr(info, "language", None):
        logger.info(f"reference: detected language={info.language}")

    parts = [seg.text.strip() for seg in segments if seg.text and seg.text.strip()]
    return "\n".join(parts).strip()


# --------------------------------------------------------------------------- #
# LLM 仿写
# --------------------------------------------------------------------------- #
def _build_rewrite_prompt(
    transcript: str,
    *,
    persona_name: str = "",
    tone: str = "",
    video_subject: str = "",
    language: str = "zh",
    max_chars: int = 600,
) -> str:
    lang_label = {"zh": "中文", "en": "English", "ja": "日本語"}.get(language, language)
    tone_req = (
        f"以「{persona_name}」的人设口吻表达：{tone}"
        if persona_name or tone
        else "保持自然、专业、有观点的口吻"
    )
    subject_req = f"\n视频主题参考：{video_subject}\n" if video_subject else ""

    return (
        f"你是一位资深短视频口播文案改写专家。下面是一段对标视频的转写文案。"
        f"请在不抄袭原文的前提下，对其进行「语义级仿写」，输出一段全新的{lang_label}口播稿。\n\n"
        "要求：\n"
        "1. 保留原视频的核心观点、信息结构与叙事节奏，但用全新表达重写；\n"
        "2. 改写成适合单人数字人口播的短视频脚本，语言口语化、有感染力；\n"
        f"3. 字数控制在 {max_chars} 字左右，分 3-5 段，段落之间空一行；\n"
        f"4. {tone_req}；\n"
        "5. 直接给正文，不要出现小标题、序号、项目符号或 Markdown 符号。\n"
        f"{subject_req}\n"
        "对标转写文案：\n"
        f"\"\"\"\n{transcript}\n\"\"\""
    )


def rewrite_script(
    transcript: str,
    *,
    persona_name: str = "",
    tone: str = "",
    video_subject: str = "",
    language: str = "zh",
    max_chars: int = 600,
) -> str:
    """用语义级仿写把对标转写改写成口播稿。失败抛 ReferenceError。"""
    transcript = (transcript or "").strip()
    if not transcript:
        raise ReferenceError("转写文案为空，无法仿写。")

    from app.services import llm

    prompt = _build_rewrite_prompt(
        transcript,
        persona_name=persona_name,
        tone=tone,
        video_subject=video_subject,
        language=language,
        max_chars=max_chars,
    )
    try:
        response = llm._generate_response(prompt=prompt)
    except Exception as e:
        raise ReferenceError(f"LLM 仿写调用失败：{e}") from e

    if not response or not response.strip():
        raise ReferenceError("LLM 返回了空结果，仿写失败。")

    # 去除模型偶尔夹带的 Markdown 符号，保持纯文案。
    cleaned = re.sub(r"```[a-zA-Z0-9]*\s*|\s*```", "", response).strip()
    cleaned = cleaned.replace("*", "").replace("#", "")
    return cleaned


# --------------------------------------------------------------------------- #
# 编排
# --------------------------------------------------------------------------- #
def process_reference(
    *,
    source: str | None = None,
    transcript_text: str | None = None,
    persona_id: str | None = None,
    language: str | None = None,
    progress: "Callable[[str, int, str], None] | None" = None,
) -> dict:
    """对标处理编排入口。

    入参二选一：``transcript_text``（粘贴文案，跳过下载/转写）或 ``source``
    （本地文件 / 网络链接，走 下载→提取音频→转写）。``persona_id`` 用于注入
    人设口吻。返回 ``{source, transcript, rewritten_script, persona_id, language}``。

    ``progress`` 为可选回调，签名 ``progress(stage, pct, msg)``，在各阶段被调用以
    支持前端进度条（SSE）。传入 ``None`` 时静默（保持 task.py 调用兼容）。
    """
    """对标处理编排入口。

    入参二选一：``transcript_text``（粘贴文案，跳过下载/转写）或 ``source``
    （本地文件 / 网络链接，走 下载→提取音频→转写）。``persona_id`` 用于注入
    人设口吻。返回 ``{source, transcript, rewritten_script, persona_id, language}``。
    """
    language = (language or config.reference.get("language") or "zh").strip()
    keep_tone = bool(config.reference.get("rewrite_keep_tone", True))

    # 进度回调（安全包装：回调抛错不影响主流程）
    def _emit(stage: str, pct: int, msg: str) -> None:
        if callable(progress):
            try:
                progress(stage, pct, msg)
            except Exception:
                pass

    _emit("preparing", 8, "准备参数…")

    persona_name = ""
    tone = ""
    if persona_id:
        from app.services.agent import persona as persona_store

        persona = persona_store.get_persona(persona_id)
        if persona is None:
            raise ReferenceError(f"人设不存在：{persona_id}")
        persona_name = persona.name or ""
        tone = persona.tone if (keep_tone and persona.tone) else ""

    # 0) 粘贴文案若本身就是平台分享文本（含链接/平台词），先抽取标题文案去除噪声
    transcript = (transcript_text or "").strip()
    if transcript and _looks_like_share(transcript):
        cleaned = _clean_share_text(transcript)
        transcript = cleaned or transcript  # 抽不到也保留原文，交给 LLM

    # 1) 解析转写文案
    resolved_source = source or "pasted_text"
    if not transcript:
        if not source or not source.strip():
            raise ReferenceError("请提供对标链接 / 本地文件，或直接粘贴转写文案。")
        # 优先尝试「下载视频 → 抽音频 → 转写」拿到完整口播文字（抖音/小红书/
        # 微博/B站 yt-dlp 均支持）。分享文案里的链接优先于裸链接；若下载失败，
        # 分享文本中通常还嵌着标题文案，可退回用标题文案做仿写。
        url = _extract_url(source)
        is_bare_link = bool(url) and source.lower().startswith(("http://", "https://"))
        fetch_url = url or source
        _emit("fetching", 20, "下载 / 读取对标素材…")
        try:
            media = fetch_reference(fetch_url)
            resolved_source = fetch_url
        except ReferenceError as dl_err:
            # 下载/解析失败：分享文本里通常含标题文案，退回用标题文案仿写。
            cleaned = _clean_share_text(source) if not is_bare_link else ""
            if cleaned:
                transcript = cleaned
                resolved_source = url or source
            else:
                raise dl_err
        if not transcript:
            # 下载成功：抽音频 → 转写，得到完整视频口播文字
            ext = os.path.splitext(media)[1].lower()
            audio_for_transcribe = media
            if ext in (".mp4", ".mov", ".mkv", ".webm", ".avi", ".flv", ".m4v"):
                _emit("audio", 45, "抽取音频…")
                audio_path = os.path.join(_cache_dir(), f"{os.path.basename(media)}.wav")
                audio_for_transcribe = _extract_audio(media, audio_path)
            _emit("transcribing", 65, "whisper 转写中…")
            transcript = transcribe_audio(audio_for_transcribe, language=language)
            if not transcript:
                raise ReferenceError("转写结果为空，可能无法识别音频语言或音频无语音内容。")

    # 2) 仿写
    _emit("rewriting", 88, "LLM 仿写中…")
    rewritten = rewrite_script(
        transcript,
        persona_name=persona_name,
        tone=tone,
        language=language,
    )

    return {
        "source": resolved_source,
        "transcript": transcript,
        "rewritten_script": rewritten,
        "persona_id": persona_id,
        "language": language,
    }
