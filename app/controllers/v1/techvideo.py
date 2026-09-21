"""科技视频（Remotion 子项目）渲染接口。

独立于 TTQ-Video 原有流水线：接收前端传来的配色与场景脚本，
调用 Remotion CLI 在本地离线渲染成 MP4 并返回。渲染依赖 techvideo/ 子项目
（含 node_modules，首次渲染会使用已缓存的 headless Chrome / Remotion compositor）。

- ``POST /api/v1/techvideo/render``  入参 ``{color1, color2, scenes:[{title,points}]}``
"""
import asyncio
import datetime
import glob
import json
import os
import pathlib
import shutil
import base64
import subprocess
import tempfile
import threading
import urllib.request
import urllib.parse
import uuid

from fastapi import Request
from fastapi.responses import FileResponse
from loguru import logger
from pydantic import BaseModel

from app.controllers.v1.base import new_router
from app.models.exception import HttpException
from app.config import config as app_config
from app.utils import utils
from app.models.vendor_registry import resolve_vendor_override, CAP_IMAGE, VENDOR_REGISTRY
from app.services.material import get_api_key as _pexels_get_api_key, _get_tls_verify
from app.services.agent import asset as asset_store
import ssl

# PlanVideo 渲染帧率（与 techvideo/src/PlanVideo.tsx 保持一致）。
FPS = 30

# AI 找图（Pexels）每次返回的随机图片数量。改这里即可调整挑选池大小。
PEXELS_PICK_COUNT = 6

router = new_router()


def _apply_rhythm(scene: dict, dur: float) -> int:
    """按 LLM 节奏标记决定场景时长（帧）。

    - 不低于口播/估算时长（保证说话能播完）；
    - 若 LLM 给出 durationSec 且合理（2-20s），取 max 作为「拉长/留白」节奏。
    同时写入 snake(duration_frames) 与 camel(durationFrames)，避免前后端字段错位。
    """
    try:
        ds = float(scene.get("durationSec") or 0)
    except (ValueError, TypeError):
        ds = 0
    if ds and 2 <= ds <= 20:
        eff = max(dur, ds)
    else:
        eff = dur
    frames = max(FPS, round(eff * FPS))
    scene["duration_frames"] = frames
    scene["durationFrames"] = frames
    return frames

# techvideo/ 子项目根目录（与本项目根同级）。
ROOT = pathlib.Path(__file__).resolve().parents[3]
TECHVIDEO_DIR = ROOT / "techvideo"
RENDER_SCRIPT = TECHVIDEO_DIR / "render-node.mjs"
# P2：背景音乐目录（可放 mp3/wav/m4a/ogg/aac；用户可自行添加，前端列表动态读取）。
BGM_DIR = TECHVIDEO_DIR / "bgm"


def _resolve_node() -> str:
    """解析可用的 node 可执行文件，尽量不依赖启动进程的 PATH。

    WorkBuddy 自带终端会把 node 注入 PATH，但用户双击 start_app.bat 拉起的
    普通 cmd 窗口往往没有 node，导致 create_subprocess_exec('node') 抛
    FileNotFoundError -> 500。这里依次尝试：PATH -> WorkBuddy 管理二进制
    （按 USERPROFILE/LOCALAPPDATA 通配）-> 常见系统安装目录。
    """
    found = shutil.which("node")
    if found:
        return found
    # 允许用户通过 config.toml [app] techvideo_node_path 显式指定。
    explicit = ""
    try:
        explicit = (app_config.app or {}).get("techvideo_node_path", "") or ""
    except Exception:  # noqa: BLE001
        explicit = ""
    if explicit and os.path.exists(explicit):
        return explicit
    bases = [
        os.environ.get("USERPROFILE", ""),
        os.environ.get("LOCALAPPDATA", ""),
    ]
    for base in bases:
        if not base:
            continue
        matches = sorted(
            glob.glob(
                os.path.join(
                    base, ".workbuddy", "binaries", "node", "versions", "*", "node.exe"
                )
            )
        )
        if matches:
            return matches[-1]
    for p in (
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ):
        if os.path.exists(p):
            return p
    logger.warning("node executable not found via PATH or known locations")
    return "node"


def _resolve_ffmpeg() -> str:
    """解析 ffmpeg 可执行文件：PATH -> 已知安装目录（FormatFactory / WorkBuddy 媒体二进制 / 项目 ffmpeg）。"""
    found = shutil.which("ffmpeg")
    if found:
        return found
    candidates = [
        r"C:\Program Files (x86)\FormatFactory\ffmpeg.exe",
        r"C:\Users\admin\.workbuddy\binaries\media\ffmpeg.exe",
        r"C:\Users\admin\.workbuddy\binaries\media\ffmpeg",
        str(ROOT / "ffmpeg" / "ffmpeg.exe"),
    ]
    for p in candidates:
        if p and os.path.exists(p):
            return p
    return ""


def _resolve_ffprobe() -> str:
    found = shutil.which("ffprobe")
    if found:
        return found
    candidates = [
        r"C:\Program Files (x86)\FormatFactory\ffprobe.exe",
        r"C:\Users\admin\.workbuddy\binaries\media\ffprobe.exe",
        r"C:\Users\admin\.workbuddy\binaries\media\ffprobe",
        str(ROOT / "ffmpeg" / "ffprobe.exe"),
    ]
    for p in candidates:
        if p and os.path.exists(p):
            return p
    return ""


def _probe_media_duration(path: str) -> float:
    """用 ffprobe 取媒体时长（秒），失败返回 0。

    用于口播素材时长兜底：前端未读到时长时，渲染前在服务端探测，
    保证「总时长 = 素材时长」（视频不循环、不截断）。
    """
    ffprobe = _resolve_ffprobe()
    if not ffprobe:
        return 0.0
    try:
        proc = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        return float((proc.stdout or "").strip() or 0)
    except Exception:  # noqa: BLE001
        return 0.0


def _probe_video_codecs(path: str) -> dict:
    """用 ffprobe 取视频/音频编码与旋转信息，用于判断是否需要转码。"""
    ffprobe = _resolve_ffprobe()
    if not ffprobe:
        return {}
    try:
        proc = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,codec_name:stream_tags=rotate",
                "-of",
                "json",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        data = json.loads(proc.stdout or "{}")
    except Exception:  # noqa: BLE001
        return {}
    video = audio = rotate = None
    for s in data.get("streams", []):
        ct = s.get("codec_type")
        if ct == "video" and video is None:
            video = s.get("codec_name")
            rotate = (s.get("tags") or {}).get("rotate")
        elif ct == "audio" and audio is None:
            audio = s.get("codec_name")
    return {"video": video, "audio": audio, "rotate": rotate}


def _transcode_video_for_remotion(src: pathlib.Path, dst: pathlib.Path) -> bool:
    """把用户上传的视频转码为 Remotion 离线渲染可靠解码的 H.264/AAC/MP4(faststart)。

    - 已是 H.264 + AAC（或无声）+ 无旋转：直接 remux（无损、极快）。
    - 其余（HEVC/VP9/AV1、非常规音频、带旋转元数据）：重编码为 H.264/yuv420p/AAC，
      旋转在重编码时被烘焙进画面，避免 Remotion 渲染出横竖颠倒。
    返回 True 表示转码成功且产物存在。
    """
    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        return False
    info = _probe_video_codecs(str(src))
    v, a, rotate = info.get("video"), info.get("audio"), info.get("rotate")
    safe_video = v in ("h264",)
    safe_audio = a in (None, "aac", "mp3")
    needs_rotate = rotate not in (None, "0", 0)
    if safe_video and safe_audio and not needs_rotate:
        cmd = [ffmpeg, "-y", "-i", str(src), "-c", "copy", "-movflags", "+faststart", str(dst)]
    else:
        cmd = [
            ffmpeg,
            "-y",
            "-i",
            str(src),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            str(dst),
        ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        return proc.returncode == 0 and dst.exists()
    except Exception:  # noqa: BLE001
        return False


# 画廊索引：渲染成功后登记，供前端「生成画廊」展示。线程安全、限最近若干条。
_GALLERY_LOCK = threading.Lock()
_GALLERY_MAX = 50

# 渲染串行锁：离线渲染会拉起 headless Chrome 并占用较多资源，串行化可避免
# 并发渲染争抢端口（localhost:3001 bundle 服务）与内存导致整体失败。
_render_lock = None


def _get_render_lock() -> "asyncio.Lock":
    global _render_lock
    if _render_lock is None:
        _render_lock = asyncio.Lock()
    return _render_lock


def _gallery_index_path() -> pathlib.Path:
    return pathlib.Path(utils.storage_dir("techvideo", create=True)) / "gallery.json"


def _read_gallery() -> list[dict]:
    p = _gallery_index_path()
    if not p.exists():
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _record_gallery(
    out_path: pathlib.Path,
    color1: str,
    color2: str,
    scenes_out: list[dict],
    has_audio: bool,
) -> dict:
    """渲染成功后登记一条画廊记录（去重 + 最新在前 + 限 _GALLERY_MAX 条）。"""
    title = (scenes_out[0].get("title") if scenes_out else "") or "未命名视频"
    total_frames = sum(int(s.get("durationFrames", 90)) for s in scenes_out)
    entry = {
        "id": out_path.stem,
        "filename": out_path.name,
        "title": title,
        "created_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "scene_count": len(scenes_out),
        "duration_sec": round(total_frames / FPS, 1) if total_frames else 0,
        "color1": color1,
        "color2": color2,
        "has_audio": bool(has_audio),
        "size": out_path.stat().st_size if out_path.exists() else 0,
    }
    with _GALLERY_LOCK:
        items = _read_gallery()
        items = [it for it in items if it.get("filename") != out_path.name]
        items.insert(0, entry)
        items = items[:_GALLERY_MAX]
        with open(_gallery_index_path(), "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
    return entry


class SubtitleModel(BaseModel):
    start: float
    end: float
    text: str


class ChartModel(BaseModel):
    kind: str = "bar"
    unit: str = ""
    labels: list[str] = []
    values: list[float] = []
    series: list[dict] = []  # 多系列：[{name, values:[...]}]


class SceneModel(BaseModel):
    type: str = "points"
    title: str
    points: list[str] = []
    narration: str = ""
    keywords: list[str] = []
    subtitles: list[SubtitleModel] = []
    chart: ChartModel | None = None
    durationFrames: int = 0
    # —— 新增场景类型字段 ——
    imageUrl: str = ""
    caption: str = ""
    quote: str = ""
    events: list[dict] = []
    columns: list[dict] = []
    source: str = ""
    author: str = ""
    # —— 样式参数化（白名单优先 + 允许自定义色值）——
    color1: str = ""
    color2: str = ""
    fontScale: float = 0
    titleScale: float = 0
    layout: str = ""
    animation: str = ""
    # —— 节奏标记（P1）——
    durationSec: float = 0
    emphasis: list[str] = []
    # —— 封面模板（P3）/ AI 配图插页（P4）——
    kicker: str = ""          # 封面眉标（eyebrow），如「科技洞察」「3 分钟读懂」
    imagePrompt: str = ""     # AI 配图建议（image 类型场景的配图提示词）
    # —— 场景级口播叠加方式（underlay/cross-cut/pip；空=跟随全局 video_layout）——
    videoLayout: str = ""
    # —— 场景级画中画小窗覆盖（仅本场景 pip 时生效；0/空=跟随全局 pip_size/pip_pos）——
    pipSize: float = 0
    pipPos: str = ""
    # —— 场景级视频覆盖（v1.9.4）：本节点可插自己的视频，留空回退全局 person_video ——
    sceneVideo: str = ""
    # —— 场景级文字精细化（v1.9.2 新增）：每场景可独立覆盖文字色 + 字号 —
    kickerColor: str = ""
    titleColor: str = ""
    pointsColor: str = ""
    quoteColor: str = ""
    captionColor: str = ""
    narrationColor: str = ""
    kickerScale: float = 0
    pointsScale: float = 0
    quoteScale: float = 0


class RenderRequest(BaseModel):
    color1: str = "#91EAE4"
    color2: str = "#86A8E7"
    audio_url: str = ""
    scenes: list[SceneModel] = []
    bg_theme: str = "dark"
    watermark: str = ""
    # —— 自动视频：口播素材叠加 ——
    person_video: str = ""          # 口播素材相对路径（uploads/xxx.mp4）
    video_layout: str = "cross-cut"  # cross-cut（硬切）/ pip（画中画）
    aspect: str = "16:9"             # 16:9 / 9:16（抖音竖屏）
    audio_mode: str = "footage"      # footage（用口播原声）/ tts（用配音）
    person_video_duration: float = 0  # 口播素材时长（秒）；>0 时总时长以此为准，不裁剪素材
    # —— 统一转场（P3）——
    transition: str = "fade"         # fade / slide / zoom / blur / wipe / none
    # —— 预览/导出 显示开关（隐藏字幕 / 隐藏旁白）——
    show_subtitle: bool = True       # 是否渲染底部字幕条
    show_narration: bool = True      # 是否在场景内容区显示旁白说明
    transparent: bool = False        # 透明底导出：仅渲染文字卡片叠加层（不烘焙口播底片），输出 MOV(ProRes 4444 + alpha) 供进剪映合成
    video_dim: int = 0              # underlay 视频压暗强度（0-90%）；0=原亮度直出，预览与导出一致（完整成片模式）
    # —— 画中画（pip）小窗参数：大小=边长占宽百分比；位置=九宫格（tl/tc/tr/ml/center/mr/bl/bc/br）——
    pip_size: int = 32
    pip_pos: str = "br"
    # —— 导出成片直接归档进资产管理（仅口播工作台开启）：渲染成功后复制成片为视频资产 ——
    save_to_assets: bool = False


@router.post(
    "/techvideo/render",
    summary="渲染科技视频（Remotion 离线渲染为 MP4）",
)
async def render_techvideo(request: Request, body: RenderRequest):
    if not TECHVIDEO_DIR.exists() or not RENDER_SCRIPT.exists():
        raise HttpException(
            task_id="",
            status_code=400,
            message="未找到 techvideo 子项目，请确认已将其迁移到项目根目录的 techvideo/。",
        )
    if not body.scenes:
        raise HttpException(task_id="", status_code=400, message="scenes 不能为空。")

    node_bin = _resolve_node()
    out_dir = pathlib.Path(utils.storage_dir("techvideo", create=True))
    # 透明底导出用 MOV（ProRes 4444 + alpha，剪映/Premiere/FCP 通用）；否则 MP4（h264）。
    # 之前用 WebM(vp9+alpha)，剪映不支持 VP9 alpha 通道（导入后仍显示黑底），故弃用。
    out_ext = ".mov" if body.transparent else ".mp4"
    out_path = out_dir / f"{uuid.uuid4().hex}{out_ext}"

    # 配音音轨：generate 端点把音频放在 /techvideo-media/<file>，导出时
    # 复制到 Remotion 的 public 目录，用 staticFile 引用（Node 渲染可靠加载）。
    # 口播叠加且 audio_mode=footage 时，改用口播素材原声，忽略 TTS 配音。
    audio_src = ""
    if body.audio_url and not (body.person_video and body.audio_mode == "footage"):
        fname = body.audio_url.split("/")[-1].split("?")[0]
        media_file = utils.storage_dir("techvideo_media") / fname
        if media_file.exists():
            public_dir = TECHVIDEO_DIR / "public"
            public_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(media_file, public_dir / fname)
            audio_src = fname

    scenes_out = []
    for s in body.scenes:
        chart_out = None
        if s.chart and s.chart.labels and s.chart.values:
            chart_out = {
                "kind": s.chart.kind or "bar",
                "unit": s.chart.unit or "",
                "labels": list(s.chart.labels),
                "values": [float(v) for v in s.chart.values],
                "series": [
                    {"name": ser.get("name", ""), "values": [float(v) for v in ser.get("values", [])]}
                    for ser in (s.chart.series or [])
                    if isinstance(ser, dict)
                ],
            }
        scenes_out.append(
            {
                "type": s.type or "points",
                "title": s.title,
                "points": list(s.points),
                "narration": s.narration or "",
                "keywords": list(s.keywords),
                "subtitles": [
                    {"start": x.start, "end": x.end, "text": x.text}
                    for x in s.subtitles
                ],
                "chart": chart_out,
                "durationFrames": int(s.durationFrames) if s.durationFrames else 90,
                # 新增类型 / 样式字段（透传，渲染器按需取用）
                "imageUrl": s.imageUrl or "",
                "caption": s.caption or "",
                "quote": s.quote or "",
                "events": [{"time": e.get("time", ""), "text": e.get("text", "")} for e in s.events if isinstance(e, dict)],
                "columns": [{"name": c.get("name", ""), "items": list(c.get("items", []))} for c in s.columns if isinstance(c, dict)],
                "source": s.source or "",
                "author": s.author or "",
                "color1": s.color1 or "",
                "color2": s.color2 or "",
                "fontScale": float(s.fontScale) if s.fontScale else 0,
                "titleScale": float(s.titleScale) if s.titleScale else 0,
                "layout": s.layout or "",
                "animation": s.animation or "",
                # 节奏标记（P1）：透传，渲染器用于时长与强调高亮
                "durationSec": float(s.durationSec) if s.durationSec else 0,
                "emphasis": list(s.emphasis),
                # 封面模板（P3）/ AI 配图插页（P4）：透传
                "kicker": s.kicker or "",
                "imagePrompt": s.imagePrompt or "",
                # 场景级口播叠加方式：透传（空=跟随全局 videoLayout）
                "videoLayout": s.videoLayout or "",
                # 场景级画中画小窗覆盖：透传（0/空=跟随全局）
                "pipSize": float(s.pipSize) if s.pipSize else 0,
                "pipPos": s.pipPos or "",
                # 场景级视频覆盖（v1.9.4）：透传（空=回退全局 person_video）
                "sceneVideo": s.sceneVideo or "",
                # 场景级文字精细化（v1.9.2）：透传（空=跟随全局/palette 默认色；0=不缩放）
                "kickerColor": s.kickerColor or "",
                "titleColor": s.titleColor or "",
                "pointsColor": s.pointsColor or "",
                "quoteColor": s.quoteColor or "",
                "captionColor": s.captionColor or "",
                "narrationColor": s.narrationColor or "",
                "kickerScale": float(s.kickerScale) if s.kickerScale else 0,
                "pointsScale": float(s.pointsScale) if s.pointsScale else 0,
                "quoteScale": float(s.quoteScale) if s.quoteScale else 0,
            }
        )
    # 口播素材时长：前端读到则直接用；未读到（0）时服务端 ffprobe 兜底探测。
    # 两种导出模式都受益：完整成片按素材全长输出（视频不循环、不截断），
    # 透明叠加层也与底片等长（进剪映完美对齐）。
    person_video = (body.person_video or "").strip()
    person_video_duration = float(body.person_video_duration or 0)
    if person_video and person_video_duration <= 0 and person_video.startswith("uploads/"):
        pv_path = (TECHVIDEO_DIR / "public" / person_video.lstrip("/")).resolve()
        if pv_path.exists() and pv_path.is_file():
            person_video_duration = _probe_media_duration(str(pv_path))
            if person_video_duration > 0:
                logger.info(f"person video duration probed: {person_video_duration:.2f}s")

    props = {
        "color1": body.color1,
        "color2": body.color2,
        "audioSrc": audio_src,
        "scenes": scenes_out,
        "bgTheme": (body.bg_theme or "dark").strip() or "dark",
        "watermark": (body.watermark or "").strip(),
        # 自动视频：口播素材叠加（渲染器按需取用；aspect 由 render-node 选 composition）
        "personVideo": person_video,
        "personVideoDuration": person_video_duration,
        "videoLayout": (body.video_layout or "cross-cut").strip() or "cross-cut",
        "aspect": (body.aspect or "16:9").strip() or "16:9",
        # 统一转场（P3）：场景级 animation 覆盖全局 transition
        "transition": (body.transition or "fade").strip() or "fade",
        # 预览/导出显示开关：隐藏字幕 / 隐藏旁白（默认都显示）
        "showSubtitle": bool(body.show_subtitle),
        "showNarration": bool(body.show_narration),
        "transparent": bool(body.transparent),
        # underlay 视频压暗（完整成片模式）：0=原亮度直出，预览与导出一致
        "videoDim": max(0, min(90, int(body.video_dim or 0))),
        # 画中画小窗参数：预览与导出一致（大小=边长%，位置=九宫格）
        "pipSize": max(8, min(80, int(body.pip_size or 32))),
        "pipPos": (body.pip_pos or "br").strip() or "br",
    }
    # 用 props 文件避免命令行 JSON 转义问题（含中文与引号）。
    fd, props_path = tempfile.mkstemp(suffix=".json", dir=str(TECHVIDEO_DIR))
    try:
        with open(fd, "w", encoding="utf-8") as f:
            json.dump(props, f, ensure_ascii=False)

        # 渲染串行化：离线渲染会拉起 headless Chrome 并占用较多资源，
        # 串行可避免并发渲染争抢 bundle 服务端口（localhost:3001）与内存导致整体失败。
        async with _get_render_lock():
            # 调用 techvideo/render-node.mjs：bundle -> getComposition -> 按 scenes
            # 数量修正时长 -> renderMedia，离线渲染为 MP4。
            try:
                proc = await asyncio.create_subprocess_exec(
                    node_bin,
                    str(RENDER_SCRIPT),
                    str(out_path),
                    props_path,
                    cwd=str(TECHVIDEO_DIR),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
            except FileNotFoundError:
                raise HttpException(
                    task_id="",
                    status_code=500,
                    message=(
                        "未找到 node 可执行文件。请确认已安装 Node.js 并加入 PATH；"
                        "或在 config.toml 的 [app] 下配置 techvideo_node_path 指向 node.exe。"
                    ),
                )
            except Exception as e:  # noqa: BLE001
                raise HttpException(
                    task_id="", status_code=500, message=f"渲染进程启动失败：{e}"
                )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=900)
            except asyncio.TimeoutError:
                proc.kill()
                raise HttpException(task_id="", status_code=504, message="渲染超时（>15 分钟）。")

            if proc.returncode != 0 or not out_path.exists():
                detail = (stderr or stdout or b"").decode("utf-8", "ignore")
                # Remotion 的 delayRender 超时等根因在 stderr 头部，尾部只是 React 调用栈，
                # 仅取尾部会丢失真正的报错。这里取头部根因 + 尾部调用栈，方便定位。
                head = detail[:1400]
                tail = detail[-900:] if len(detail) > 2400 else ""
                msg = "渲染失败：" + head + ("\n…[中间省略]…\n" + tail if tail else "")
                raise HttpException(task_id="", status_code=500, message=msg)

            # 渲染成功：登记到画廊索引，供前端「生成画廊」展示。
            _record_gallery(out_path, body.color1, body.color2, scenes_out, bool(audio_src))

            # 口播成片直接归档进资产管理（v1.9.5）：复制成片为一条视频资产，
            # 便于在「资产管理」里复用（如作数字人口播底片 / 二次剪辑素材）。
            # 失败不影响成片下载，仅记录告警。
            if body.save_to_assets:
                try:
                    asset_record = asset_store.add_from_path(
                        str(out_path),
                        name="口播成片",
                        category="口播成片",
                    )
                except Exception as e:  # noqa: BLE001
                    asset_record = None
                    logger.warning(f"口播成片存入资产管理失败（不影响成片下载）：{e}")
    finally:
        try:
            pathlib.Path(props_path).unlink()
        except OSError:
            pass

    # 口播工作台选择归档时返回 JSON（含下载地址 + 资产记录），
    # 便于前端提示「已存入资产管理」；其余调用方仍走原始二进制下载。
    if body.save_to_assets:
        return utils.get_response(
            200,
            {
                "download_url": f"/techvideo-videos/{out_path.name}",
                "filename": out_path.name,
                "asset": asset_record,
            },
        )

    return FileResponse(
        str(out_path),
        media_type="video/quicktime" if body.transparent else "video/mp4",
        filename=out_path.name,
    )


@router.post(
    "/techvideo/upload",
    summary="上传科技视频本地媒体（图片卡 / 口播素材用）",
)
async def upload_techvideo_image(request: Request):
    """接收 multipart 媒体（图片或视频），落盘到 techvideo/public/uploads。

    返回 ``{url: "uploads/<filename>"}``：
    - 落盘路径：``techvideo/public/uploads/<filename>``（离线渲染时由 Remotion
      staticFile 同一目录读取）。
    - 预览路径：``/techvideo-public/uploads/<filename>``（由 FastAPI 静态挂载提供，
      浏览器预览可直接加载）。

    图片用于图片卡 ``imageUrl``；视频用于「自动视频」口播素材 ``personVideo``。两者
    预览与导出共用同一份文件。做了扩展名白名单 + 文件名随机化，防止目录穿越与脚本注入。
    """
    form = await request.form()
    file = form.get("file") if form else None
    if file is None:
        raise HttpException(task_id="", status_code=400, message="未收到文件（字段名 file）。")

    filename = getattr(file, "filename", "") or ""
    ext = pathlib.Path(filename).suffix.lower()
    if ext not in _ALLOWED_UPLOAD_EXT:
        raise HttpException(
            task_id="",
            status_code=400,
            message=f"不支持的媒体格式：{ext or '(无扩展名)'}，仅允许 {', '.join(sorted(_ALLOWED_UPLOAD_EXT))}。",
        )

    uploads_dir = TECHVIDEO_DIR / "public" / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)

    # 随机文件名，丢弃原始文件名（防目录穿越 / 中文乱码 / 覆盖）。
    stored = f"{uuid.uuid4().hex}{ext}"
    dest = uploads_dir / stored
    try:
        content = await file.read()
        with open(dest, "wb") as f:
            f.write(content)
    except Exception as e:  # noqa: BLE001
        raise HttpException(task_id="", status_code=500, message=f"保存图片失败：{e}")

    # 视频类素材：离线渲染前统一转码为 Remotion 可靠的 H.264/AAC/MP4(faststart)。
    # HEVC/VP9/旋转等会导致 headless Chrome 解码失败、<Video> delayRender 超时（渲染 500）。
    # 已是 H.264+AAC 无旋转则 remux（极快无损），否则重编码为 H.264/yuv420p 并烘焙旋转。
    final_url = f"uploads/{stored}"
    if ext in _VIDEO_EXT:
        out_name = f"{uuid.uuid4().hex}.mp4"
        out_path = uploads_dir / out_name
        if _transcode_video_for_remotion(dest, out_path):
            final_url = f"uploads/{out_name}"
            try:
                dest.unlink()
            except OSError:
                pass
        else:
            logger.warning(f"video transcode failed, keep original upload: {dest}")

    return utils.get_response(200, {"url": final_url})


class GenerateRequest(BaseModel):
    theme: str = ""
    script: str = ""
    language: str = "zh-CN"
    scene_count: int = 0                # 0 表示不限制，由 AI 自动决定
    voice_name: str = ""
    voice_rate: float = 1.0
    bgm: str = ""                      # P2：背景音乐文件名（留空=无 BGM）


def _extract_cues(sub_maker, offset: float) -> list[dict]:
    """从 SubMaker 提取逐句字幕，并把时间戳平移到「完整音轨」坐标系。"""
    cues = getattr(sub_maker, "cues", None)
    if not cues:
        return []
    out = []
    for c in cues:
        if isinstance(c, dict):
            text = c.get("text", "")
            start = float(c.get("start", 0) or 0)
            end = float(c.get("end", 0) or 0)
        else:
            text = getattr(c, "text", "")
            start = getattr(c, "start", None)
            end = getattr(c, "end", None)
            start = start.total_seconds() if hasattr(start, "total_seconds") else float(start or 0)
            end = end.total_seconds() if hasattr(end, "total_seconds") else float(end or 0)
        if not text:
            continue
        out.append(
            {
                "start": round(start + offset, 3),
                "end": round(end + offset, 3),
                "text": str(text).strip(),
            }
        )
    return out


def _concat_audio(seg_paths: list[str], full_path: str) -> bool:
    """用 ffmpeg 把多段配音首尾拼接为一条完整音轨。"""
    if not seg_paths:
        return False
    if len(seg_paths) == 1:
        try:
            shutil.copyfile(seg_paths[0], full_path)
            return True
        except Exception:
            return False

    ffmpeg_bin = _resolve_ffmpeg() or str(ROOT / "ffmpeg" / "ffmpeg.exe")
    inputs = " ".join(f'-i "{p}"' for p in seg_paths)
    filter_complex = f"concat=n={len(seg_paths)}:v=0:a=1[out]"
    cmd = (
        f'"{ffmpeg_bin}" {inputs} -filter_complex "{filter_complex}" '
        f'-map "[out]" -y "{full_path}"'
    )
    try:
        proc = subprocess.run(cmd, shell=True, capture_output=True, timeout=180)
        return proc.returncode == 0 and os.path.exists(full_path)
    except Exception as e:
        logger.warning(f"concat audio failed: {e}")
        return False


# —— P2：背景音乐（BGM）闪避混音 ——
_ALLOWED_BGM_EXT = (".mp3", ".wav", ".m4a", ".ogg", ".aac")


def list_bgm() -> list[dict]:
    """扫描 BGM 目录，返回可选项 ``[{name, label}]``（按文件名排序）。"""
    BGM_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(BGM_DIR.iterdir()):
        if f.suffix.lower() in _ALLOWED_BGM_EXT:
            label = f.stem.replace("_", " ").replace("-", " ").title()
            out.append({"name": f.name, "label": label})
    return out


def _mix_bgm(voice_path: str, bgm_name: str, out_path: str) -> bool:
    """把 BGM 与对白混音，人声起时 BGM 自动闪避(ducking)，人声落回升。

    - BGM 用 ``aloop`` 循环铺满对白时长；
    - ``sidechaincompress`` 以对白为触发侧，语音能量超阈值即压低 BGM 音量；
    - ``amix`` 把压低后的 BGM 与原始对白混合（duration=first 以对白时长为准）。
    """
    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        logger.warning("mix bgm: ffmpeg 不可用")
        return False
    bgm_file = BGM_DIR / bgm_name
    if not bgm_file.exists() or bgm_file.suffix.lower() not in _ALLOWED_BGM_EXT:
        logger.warning(f"mix bgm: 文件不存在或类型不支持: {bgm_name}")
        return False
    filter_complex = (
        "[1:a]aloop=loop=-1:size=2147483647,aresample=44100,volume=0.5[bgm];"
        "[bgm][0:a]sidechaincompress=threshold=0.02:ratio=10:attack=12:release=300:"
        "level_in=1:makeup=1.5[duck];"
        "[0:a][duck]amix=inputs=2:duration=first:dropout_transition=0[out]"
    )
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        voice_path,
        "-i",
        str(bgm_file),
        "-filter_complex",
        filter_complex,
        "-map",
        "[out]",
        "-ar",
        "44100",
        "-ac",
        "2",
        out_path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            logger.warning("mix bgm failed: " + (proc.stderr or proc.stdout or "")[:600])
            return False
        return os.path.exists(out_path)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"mix bgm exception: {e}")
        return False


# —— P4：AI 配图插页（OpenAI 兼容图像生成，未配置则明确提示）——
def _call_openai_image(
    prompt: str, size: str, *, api_key: str, base_url: str, model: str
):
    """调用 OpenAI 兼容的 ``/images/generations``，落盘到 public/uploads。

    返回 ``(url, error)``：成功时 url 为 ``uploads/<file>``，error 为空；
    失败/未配置时 url 为空，error 为可读原因。
    """
    base = (base_url or "https://api.openai.com/v1").strip().rstrip("/")
    model = (model or "gpt-image-1").strip()
    url = f"{base}/images/generations"
    body = json.dumps(
        {"model": model, "prompt": prompt, "n": 1, "size": size}
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return None, f"图像生成请求失败：{e}"

    item = ((data.get("data") or [{}]) or [{}])[0] if data.get("data") else {}
    item = item if isinstance(item, dict) else {}
    img_url = item.get("url")
    b64 = item.get("b64_json")

    uploads_dir = TECHVIDEO_DIR / "public" / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    if img_url:
        try:
            with urllib.request.urlopen(img_url, timeout=120) as r:
                content = r.read()
            fn = f"{uuid.uuid4().hex}.png"
            (uploads_dir / fn).write_bytes(content)
            return f"uploads/{fn}", ""
        except Exception as e:  # noqa: BLE001
            return None, f"配图下载失败：{e}"
    if b64:
        try:
            fn = f"{uuid.uuid4().hex}.png"
            (uploads_dir / fn).write_bytes(base64.b64decode(b64))
            return f"uploads/{fn}", ""
        except Exception as e:  # noqa: BLE001
            return None, f"配图解码失败：{e}"
    return None, "图像生成返回为空（无 url 或 b64_json）。"


def _generate_illustration(prompt: str, size: str = "1024x1024"):
    """调用 OpenAI 兼容的图像生成接口生成一张配图（legacy：取 ``config.toml [app]`` 的
    ``techvideo_image_*``）。返回 ``(url, error)``。"""
    cfg = (app_config.app or {}) if hasattr(app_config, "app") else {}
    key = (cfg.get("techvideo_image_api_key") or "").strip() if isinstance(cfg, dict) else ""
    if not key:
        return None, (
            "未配置图像生成服务：在 config.toml 的 [app] 段设置 "
            "techvideo_image_api_key（可选 techvideo_image_base_url / techvideo_image_model）。"
        )
    base = (cfg.get("techvideo_image_base_url") or "https://api.openai.com/v1").strip().rstrip("/")
    model = (cfg.get("techvideo_image_model") or "gpt-image-1").strip()
    return _call_openai_image(prompt, size, api_key=key, base_url=base, model=model)


# —— P6：AI 生图（供应商聚合 image 能力）+ AI 找图（Pexels 图片）——
# 各供应商图像模型建议列表（下拉候选；用户也可自由填写模型名）。
IMAGE_MODEL_SUGGESTIONS = {
    "openai": ["gpt-image-1", "dall-e-3"],
    "deepsea": ["gpt-image-1"],
    "siliconflow": [
        "Kwai-Kolors/Kolors",
        "black-forest-labs/FLUX.1-schnell",
        "stabilityai/stable-diffusion-xl-base-1.0",
    ],
    "volcengine": ["doubao-image-generation"],
    "qwen": ["wanx2.1-t2i-turbo", "wanx-v1"],
}


def _image_capable_vendors() -> list[dict]:
    """列出已登记 image 能力的供应商（供前端下拉选择）。

    default_model 优先取用户在系统设置里为该供应商配置的图像模型
    （``[vendors.<id>.capabilities.image].model``），否则回退到登记表默认值。
    """
    vendors_cfg = getattr(app_config, "vendors", {}) or {}
    out = []
    for v in VENDOR_REGISTRY:
        cap = v.capability(CAP_IMAGE)
        if cap is None:
            continue
        configured = ""
        vblock = (vendors_cfg or {}).get(v.vendor_id, {})
        if isinstance(vblock, dict):
            ccfg = (vblock.get("capabilities") or {}).get(CAP_IMAGE) or {}
            if isinstance(ccfg, dict):
                configured = ccfg.get("model") or ""
        out.append(
            {
                "vendor_id": v.vendor_id,
                "label": v.label,
                "default_model": configured or cap.default_model or "",
                "models": IMAGE_MODEL_SUGGESTIONS.get(v.vendor_id, []),
                "status": cap.status,
                "api_key_url": v.api_key_url or "",
            }
        )
    return out


def _resolve_image_creds(vendor: str, model: str) -> dict | None:
    """解析图像生成凭据，优先级：

    1) 供应商聚合 image 能力（``[vendors.<id>]`` 的 api_key/base_url/model）；
    2) legacy ``config.toml [app]`` 的 ``techvideo_image_*``；
    3) legacy OpenAI（``[app] openai_api_key/base_url/model_name``）。

    都缺失返回 ``None``。
    """
    vendors_cfg = getattr(app_config, "vendors", {}) or {}
    cfg = (app_config.app or {}) if hasattr(app_config, "app") else {}

    if vendor:
        ov = resolve_vendor_override(vendor, CAP_IMAGE, vendors_cfg)
        if ov and (ov.get("api_key") or ov.get("base_url")):
            return {
                "api_key": ov.get("api_key") or "",
                "base_url": ov.get("base_url") or "https://api.openai.com/v1",
                "model": model or ov.get("model") or "gpt-image-1",
            }
    # 2) techvideo_image_*
    key = (cfg.get("techvideo_image_api_key") or "").strip() if isinstance(cfg, dict) else ""
    if key:
        return {
            "api_key": key,
            "base_url": (cfg.get("techvideo_image_base_url") or "https://api.openai.com/v1"),
            "model": model or (cfg.get("techvideo_image_model") or "gpt-image-1"),
        }
    # 3) openai legacy（仅在未指定其它供应商、或指定 openai 时兜底）
    oa_key = (cfg.get("openai_api_key") or "").strip() if isinstance(cfg, dict) else ""
    if oa_key and (not vendor or vendor.lower() == "openai"):
        return {
            "api_key": oa_key,
            "base_url": (cfg.get("openai_base_url") or "https://api.openai.com/v1"),
            "model": model or (cfg.get("openai_model_name") or "gpt-image-1"),
        }
    return None


def _generate_image_via_vendor(vendor: str, model: str, prompt: str, size: str):
    """按供应商聚合解析凭据后调用 OpenAI 兼容图像生成。返回 ``(url, error)``。"""
    creds = _resolve_image_creds(vendor, model)
    if not creds:
        return None, (
            "未配置图像生成服务：请在「系统设置 → 供应商聚合」中配置支持图片模型的供应商"
            "（API Key / Base URL / 模型），或在 config.toml 的 [app] 设置 "
            "techvideo_image_api_key。"
        )
    return _call_openai_image(prompt, size, **creds)


def _http_get(url: str, *, headers: dict | None = None, timeout: int = 30, binary: bool = False):
    """带 TLS 校验开关的 GET（Pexels 图片/接口用）。

    默认带 User-Agent：Pexels 会拒绝 Python-urllib 的默认 UA（返回 403）。
    """
    ctx = None
    if not _get_tls_verify():
        ctx = ssl._create_unverified_context()
    hdrs = {"User-Agent": "Mozilla/5.0 (compatible; TechVideo/1.0)"}
    hdrs.update(headers or {})
    req = urllib.request.Request(url, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        if binary:
            return resp.read(), resp.headers.get("Content-Type", "")
        return resp.read().decode("utf-8", "ignore"), resp.headers.get("Content-Type", "")


def _search_pexels_photos(query: str, page: int) -> list[dict]:
    """搜索 Pexels 图片，返回随机 ``PEXELS_PICK_COUNT`` 张的精简信息。

    每张：``{id, thumb, full, photographer, url}``；``full`` 为下载用原图地址。
    """
    key = _pexels_get_api_key("pexels_api_keys")
    q = urllib.parse.quote_plus((query or "technology").strip() or "technology")
    per_page = 40
    url = f"https://api.pexels.com/v1/search?query={q}&per_page={per_page}&page={max(1, page)}"
    raw, _ = _http_get(url, headers={"Authorization": key}, timeout=30)
    data = json.loads(raw) if isinstance(raw, str) else json.loads(raw.decode("utf-8"))
    photos = data.get("photos") or []
    if not photos:
        return []
    import random

    sample = photos[:]
    random.shuffle(sample)
    out = []
    for p in sample[:PEXELS_PICK_COUNT]:
        src = p.get("src") or {}
        out.append(
            {
                "id": p.get("id"),
                "thumb": src.get("large") or src.get("medium") or src.get("small"),
                "full": src.get("large2x") or src.get("original") or src.get("large"),
                "photographer": p.get("photographer", ""),
                "url": p.get("url", ""),
            }
        )
    return out


def _download_pexels_image(image_url: str) -> tuple[str, str]:
    """把 Pexels 图片下载到 public/uploads，返回 ``(url, error)``。"""
    if not image_url or not str(image_url).startswith("http"):
        return "", "非法图片地址。"
    ext = ".jpg"
    try:
        content, ctype = _http_get(image_url, timeout=60, binary=True)
    except Exception as e:  # noqa: BLE001
        return "", f"图片下载失败：{e}"
    if not content:
        return "", "图片下载为空。"
    if "png" in (ctype or ""):
        ext = ".png"
    elif "webp" in (ctype or ""):
        ext = ".webp"
    uploads_dir = TECHVIDEO_DIR / "public" / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    fn = f"{uuid.uuid4().hex}{ext}"
    (uploads_dir / fn).write_bytes(content)
    return f"uploads/{fn}", ""


