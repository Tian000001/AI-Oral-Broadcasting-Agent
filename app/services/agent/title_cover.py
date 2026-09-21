"""口播智能体 · 标题 + 封面生成（Phase 5）。

把「一条口播稿」变成「可直接发布的标题、话题标签与封面图」：

    视频主题 / 文案 / 人设
            │
            ▼
      generate_title_and_tags  （LLM 生成吸睛标题 + 话题标签）
            │
            ▼
      generate_cover          （本地 PIL 渲染 / 云端图像模型）
            │
            ▼
      compose_video_with_cover （ffmpeg 把封面叠到成片开头）
            │
            ▼
      { title, tags, cover_path, (composed_video_path) }

设计要点：
- 标题/标签复用项目已有的 LLM 引擎（``app.services.llm``），不引入新依赖。
- 封面默认用 **本地 PIL 渲染器**（离线可用、零成本），并保留 **云端图像模型**
  （文生图/图生图）作为可插拔扩展点（``cover_engine = cloud`` 且已配置密钥时启用）。
- 任意一环缺依赖/缺模型/LLM 不可用都给出清晰、可操作的结果或错误，而非崩溃：
  - 标题生成失败 → 基于主题/首句启发式兜底；
  - 本地封面缺 PIL → 抛出明确错误，由调用方决定降级（如跳过封面合成）；
  - 云端封面未配置 → 明确提示改用本地引擎。
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import subprocess
import tempfile
import uuid
from typing import List, Optional

from app.config import config
from app.utils import utils

logger = logging.getLogger(__name__)

# PIL 在运行期才需要（仅本地封面渲染使用）。MPT 运行环境已自带 Pillow，
# 这里懒导入，确保模块在缺失 Pillow 时仍可导入、仅在真正渲染封面时报错。
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - 运行环境差异
    Image = None
    ImageDraw = None
    ImageFont = None


class TitleCoverError(RuntimeError):
    """标题/封面链路中的可预期错误（缺依赖 / 缺模型 / LLM 空结果等）。"""


# --------------------------------------------------------------------------- #
# 配置与路径
# --------------------------------------------------------------------------- #
def _cfg(key: str, default=None):
    """读取 ``[title_cover]`` 配置，带默认值兜底。"""
    return config.title_cover.get(key, default)


def _output_dir(task_id: Optional[str] = None) -> str:
    """解析封面/标题产物目录（相对路径以项目根为基准）。"""
    if task_id:
        path = utils.task_dir(task_id)
    else:
        base = _cfg("output_dir", "storage/title_cover")
        path = base if os.path.isabs(base) else os.path.join(utils.root_dir(), base)
    os.makedirs(path, exist_ok=True)
    return path


# --------------------------------------------------------------------------- #
# 标题 + 话题标签（LLM）
# --------------------------------------------------------------------------- #
def _build_title_prompt(
    video_subject: str,
    video_script: str,
    language: str,
    persona_name: str,
    tone: str,
    title_max: int,
    tag_count: int,
) -> str:
    subject = (video_subject or "").strip()
    script = (video_script or "").strip()
    script_excerpt = script[:1200]

    lang_label = {
        "zh": "中文",
        "en": "English",
        "ja": "日本語",
        "ko": "한국어",
    }.get((language or "zh").strip().lower(), language or "zh")

    persona_req = ""
    if persona_name or tone:
        persona_req = (
            f"\n- 人设：「{persona_name}」，口吻：{tone}。标题与标签要贴合该人设语气。"
            if (persona_name or tone)
            else ""
        )

    return f"""你是一位资深短视频运营，擅长把口播内容提炼成高点击率的标题与话题标签。

请基于下面的视频主题与文案，生成：
1. 一个吸睛、有情绪钩子的短视频标题（不超过 {title_max} 个字，不要使用markdown、不要加引号）；
2. {tag_count} 个相关的话题标签（每个以 # 开头、不含空格）。

要求：
- 标题要让人想点进来，可以用悬念、数字、反差或痛点，但必须贴合内容、不夸张误导；
- 话题标签要覆盖主题关键词与平台热词，便于推荐；
- 只返回一个 JSON 对象，不要任何额外说明或代码块标记。

输出格式示例：
{{"title":"...","tags":["#example","#视频"]}}

视频主题：{subject}
{('视频文案：' + script_excerpt) if script_excerpt else ''}
语言：{lang_label}
{persona_req}"""


def _strip_code_fence(text: str) -> str:
    """去掉模型偶尔包裹的 ```json ... ``` 围栏。"""
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z0-9]*\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    return t.strip()


def _parse_title_json(response: str) -> dict:
    try:
        return json.loads(_strip_code_fence(response))
    except Exception:
        match = re.search(r"\{.*\}", response or "", re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except Exception:
                pass
    return {}


def _normalize_tags(raw, count: int) -> List[str]:
    """把 LLM 返回的标签统一整理成 ``#tag`` 列表（去重、去空格、限数量）。"""
    if isinstance(raw, str):
        candidates = re.split(r"[\s,]+", raw)
    elif isinstance(raw, (list, tuple)):
        candidates = [str(entry) for entry in raw]
    else:
        candidates = []

    seen = set()
    result: List[str] = []
    for item in candidates:
        tag = re.sub(r"[^\w]", "", item, flags=re.UNICODE)
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(f"#{tag}")
        if count and len(result) >= count:
            break
    return result


def _fallback_title_and_tags(
    video_subject: str, video_script: str, tag_count: int
) -> dict:
    """LLM 不可用时的启发式兜底，保证始终返回可用结构。"""
    subject = (video_subject or "").strip()
    script = (video_script or "").strip()

    title = subject
    if not title and script:
        # 没有主题时，用脚本第一句兜底。
        title = re.split(r"(?<=[.!?。！？])\s+", script)[0]

    fallback_tags = ["#shorts", "#viral", "#fyp", "#口播", "#干货", "#热门"]
    tags = _normalize_tags(fallback_tags, tag_count)
    # 若主题非空，附加一个主题标签，提升可检索性。
    if subject:
        topic_tag = "#" + re.sub(r"[^\w]", "", subject, flags=re.UNICODE)[:12]
        if topic_tag not in tags:
            tags = [topic_tag] + tags
    return {"title": (title or "未命名视频")[:60], "tags": tags[:tag_count]}


def generate_title_and_tags(
    *,
    video_subject: str = "",
    video_script: str = "",
    language: str = "zh",
    persona_name: str = "",
    tone: str = "",
    title_max: Optional[int] = None,
    tag_count: Optional[int] = None,
    app_config=None,
) -> dict:
    """用 LLM 生成吸睛标题 + 话题标签；失败自动降级为启发式结果。

    返回 ``{"title": str, "tags": List[str]}``。
    """
    title_max = int(title_max or _cfg("title_max", 30))
    tag_count = int(tag_count or _cfg("tag_count", 6))

    prompt = _build_title_prompt(
        video_subject=video_subject,
        video_script=video_script,
        language=language,
        persona_name=persona_name,
        tone=tone,
        title_max=title_max,
        tag_count=tag_count,
    )

    try:
        from app.services import llm

        if app_config is not None:
            response = llm._generate_response(prompt=prompt, app_config=app_config)
        else:
            response = llm._generate_response(prompt=prompt)
    except Exception as e:  # 上游 LLM 异常统一收敛
        logger.warning(f"title/tags LLM call failed, fallback used: {e}")
        return _fallback_title_and_tags(video_subject, video_script, tag_count)

    if not response or "Error: " in response:
        logger.warning("title/tags LLM returned empty/error, fallback used")
        return _fallback_title_and_tags(video_subject, video_script, tag_count)

    data = _parse_title_json(response)
    title = (data.get("title") or "").strip()
    tags = _normalize_tags(data.get("tags", []), tag_count)
    if not title:
        # 解析成功但标题为空，仍使用兜底标题，但保留可能可用的标签。
        fb = _fallback_title_and_tags(video_subject, video_script, tag_count)
        title = fb["title"]
        if not tags:
            tags = fb["tags"]
    return {"title": title[:title_max], "tags": tags}


# --------------------------------------------------------------------------- #
# 封面图（本地 PIL 渲染 / 云端图像模型）
# --------------------------------------------------------------------------- #
def _hex_to_rgb(value: str):
    value = (value or "#000000").strip()
    if value.startswith("#"):
        value = value[1:]
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    value = (value + "000000")[:6]
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def _load_font(size: int, font_path: Optional[str] = None):
    candidates: List[str] = []
    if font_path:
        candidates.append(font_path)
    # 项目自带的 CJK 字体，保证中文封面标题可正常渲染。
    candidates += [
        utils.resource_dir("fonts/STHeitiMedium.ttc"),
        utils.resource_dir("fonts/MicrosoftYaHeiBold.ttc"),
        utils.resource_dir("fonts/MicrosoftYaHeiNormal.ttc"),
    ]
    for cand in candidates:
        if cand and os.path.isfile(cand):
            try:
                return ImageFont.truetype(cand, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _is_cjk(text: str) -> bool:
    return any(ord(ch) > 0x2E80 for ch in (text or ""))


def _wrap_text(draw, text: str, font, max_width: int) -> List[str]:
    """按宽度换行：CJK 按字符断行，拉丁文按单词断行。"""
    text = (text or "").strip()
    if not text:
        return []

    if _is_cjk(text):
        lines: List[str] = []
        line = ""
        for ch in text:
            if draw.textlength(line + ch, font=font) > max_width and line:
                lines.append(line)
                line = ch
            else:
                line += ch
        if line:
            lines.append(line)
        return lines

    words = text.split()
    lines = []
    line = ""
    for w in words:
        candidate = (line + " " + w).strip()
        if draw.textlength(candidate, font=font) > max_width and line:
            lines.append(line)
            line = w
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


def _gradient_background(width: int, height: int, top: str, bottom: str) -> Image.Image:
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)
    top_rgb = _hex_to_rgb(top)
    bottom_rgb = _hex_to_rgb(bottom)
    for y in range(height):
        ratio = y / max(1, height - 1)
        r = int(top_rgb[0] + (bottom_rgb[0] - top_rgb[0]) * ratio)
        g = int(top_rgb[1] + (bottom_rgb[1] - top_rgb[1]) * ratio)
        b = int(top_rgb[2] + (bottom_rgb[2] - top_rgb[2]) * ratio)
        draw.line([(0, y), (width, y)], fill=(r, g, b))
    return img


def _fit_cover_image(base_image: str, width: int, height: int) -> Optional[Image.Image]:
    """把用户提供的基础图缩放裁切为封面底图（图生图/图生视频的一帧）。"""
    try:
        with Image.open(base_image) as im:
            im = im.convert("RGB")
            im_ratio = im.width / im.height
            target_ratio = width / height
            if im_ratio > target_ratio:
                new_h = height
                new_w = int(height * im_ratio)
            else:
                new_w = width
                new_h = int(width / im_ratio)
            im = im.resize((new_w, new_h), Image.LANCZOS)
            left = (new_w - width) // 2
            top = (new_h - height) // 2
            return im.crop((left, top, left + width, top + height))
    except Exception as e:
        logger.warning(f"failed to use base image for cover: {e}")
        return None


def _render_local_cover(
    *,
    title: str,
    tags: List[str],
    video_subject: str,
    output_path: str,
    resolution: tuple,
    base_image: str = "",
) -> str:
    """用 PIL 本地渲染封面图（离线、零成本）。返回输出路径。"""
    if Image is None:
        raise TitleCoverError(
            "本地封面渲染需要 Pillow（PIL）。请先安装：pip install Pillow；"
            "或改用 cover_engine = cloud（需配置云端图像模型密钥）。"
        )

    width, height = resolution
    width = max(64, int(width))
    height = max(64, int(height))

    # 1) 背景：基础图（图生图）或渐变。
    if base_image and os.path.isfile(base_image):
        bg = _fit_cover_image(base_image, width, height)
    else:
        bg = None
    if bg is None:
        bg = _gradient_background(
            width, height, _cfg("background_top", "#0f172a"), _cfg("background_bottom", "#1e3a5f")
        )

    draw = ImageDraw.Draw(bg)

    # 2) 半透明暗色蒙版，保证文字可读性（无论是否使用基础图）。
    scrim = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    scrim_draw = ImageDraw.Draw(scrim)
    scrim_draw.rectangle([0, 0, width, height], fill=(0, 0, 0, 120))
    bg = bg.convert("RGBA")
    bg = Image.alpha_composite(bg, scrim).convert("RGB")
    draw = ImageDraw.Draw(bg)

    margin = int(width * 0.08)
    text_color = _cfg("text_color", "#FFFFFF")
    accent_color = _cfg("accent_color", "#00f5a0")

    # 3) 标题：大字号、自动换行、带阴影。
    title_size = max(28, int(width * 0.085))
    title_font = _load_font(title_size, _cfg("cover_font"))
    title_lines = _wrap_text(draw, title, title_font, width - 2 * margin)
    line_height = int(title_size * 1.25)
    y = int(height * 0.34)
    for line in title_lines[:4]:  # 最多 4 行，避免溢出
        # 阴影
        draw.text((margin + 2, y + 2), line, font=title_font, fill=(0, 0, 0))
        draw.text((margin, y), line, font=title_font, fill=_hex_to_rgb(text_color))
        y += line_height

    # 4) 主题副标题（可选，小字）。
    subject = (video_subject or "").strip()
    if subject and subject != title:
        sub_size = max(18, int(width * 0.04))
        sub_font = _load_font(sub_size, _cfg("cover_font"))
        sub_lines = _wrap_text(draw, subject, sub_font, width - 2 * margin)
        y += int(line_height * 0.3)
        for line in sub_lines[:2]:
            draw.text((margin + 1, y + 1), line, font=sub_font, fill=(0, 0, 0))
            draw.text((margin, y), line, font=sub_font, fill=(180, 180, 180))
            y += int(sub_size * 1.2)

    # 5) 话题标签（底部，强调色）。
    if tags:
        tag_text = "  ".join(tags[:8])
        tag_size = max(16, int(width * 0.038))
        tag_font = _load_font(tag_size, _cfg("cover_font"))
        tag_lines = _wrap_text(draw, tag_text, tag_font, width - 2 * margin)
        tag_y = height - margin - len(tag_lines) * int(tag_size * 1.3)
        for line in tag_lines:
            draw.text((margin, tag_y), line, font=tag_font, fill=_hex_to_rgb(accent_color))
            tag_y += int(tag_size * 1.3)

    bg.convert("RGB").save(output_path)
    return output_path


def _generate_cover_cloud(
    *,
    title: str,
    tags: List[str],
    video_subject: str,
    output_path: str,
) -> str:
    """云端图像模型封面（文生图）。仅当已配置密钥时可用，否则明确报错。"""
    api_key = _cfg("cloud_api_key", "")
    model = _cfg("cloud_model", "")
    if not api_key or not model:
        raise TitleCoverError(
            "云端封面引擎未配置（title_cover.cloud_api_key / cloud_model）。"
            "请在 config.toml 配置 OpenAI 兼容图像模型，或改用 cover_engine = local。"
        )

    prompt = (
        f"短视频封面图，竖版 9:16。主题：{video_subject or title}。"
        "风格：高清、吸睛、构图干净、适合短视频平台信息流；"
        f"画面中不要出现难以辨认的小字。标题文案：{title}。"
    )
    try:
        from openai import OpenAI

        client = OpenAI(api_key=api_key, base_url=_cfg("cloud_base_url", "") or None)
        resp = client.images.generate(model=model, prompt=prompt, size="1024x1024", n=1)
        item = (resp.data or [{}])[0]
        b64 = getattr(item, "b64_json", None) or ""
        url = getattr(item, "url", None) or ""
        if b64:
            with open(output_path, "wb") as fp:
                fp.write(base64.b64decode(b64))
            return output_path
        if url:
            import urllib.request

            with urllib.request.urlopen(url, timeout=90) as r:
                with open(output_path, "wb") as fp:
                    fp.write(r.read())
            return output_path
    except Exception as e:
        raise TitleCoverError(f"云端封面生成失败：{e}") from e

    raise TitleCoverError("云端封面接口未返回可用图片。")


def generate_cover(
    *,
    title: str,
    tags: Optional[List[str]] = None,
    video_subject: str = "",
    base_image: str = "",
    output_path: str,
    resolution: tuple = (1080, 1920),
    engine: Optional[str] = None,
) -> str:
    """生成封面图。

    - ``engine="local"``（默认）：本地 PIL 渲染，离线可用；
    - ``engine="cloud"``：调用 OpenAI 兼容图像模型（文生图）。

    返回封面图路径。
    """
    tags = tags or []
    engine = (engine or _cfg("cover_engine", "local")).strip().lower()

    if engine == "cloud":
        return _generate_cover_cloud(
            title=title, tags=tags, video_subject=video_subject, output_path=output_path
        )

    return _render_local_cover(
        title=title,
        tags=tags,
        video_subject=video_subject,
        output_path=output_path,
        resolution=resolution,
        base_image=base_image,
    )


# --------------------------------------------------------------------------- #
# 把封面合成到成片（ffmpeg）
# --------------------------------------------------------------------------- #
def _probe_resolution(video_path: str) -> Optional[tuple]:
    """用 ffprobe 读取视频分辨率，失败返回 None。"""
    ffprobe = shutil_which("ffprobe")
    if not ffprobe:
        return None
    try:
        out = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0",
                video_path,
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        parts = (out.stdout or "").strip().split(",")
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            return int(parts[0]), int(parts[1])
    except Exception:
        pass
    return None


def compose_video_with_cover(
    video_path: str,
    cover_path: str,
    output_path: Optional[str] = None,
    cover_duration: Optional[float] = None,
    fps: int = 30,
) -> str:
    """用 ffmpeg 把封面图作为片头，拼接到成片开头。

    单条命令通过 concat 滤镜完成，封面按 ``cover_duration`` 秒展示后接正片，
    原音频原样保留。``cover_duration <= 0`` 时直接返回原视频（空操作）。
    """
    if not (video_path and os.path.isfile(video_path)):
        raise TitleCoverError(f"待合成视频不存在：{video_path}")
    if not (cover_path and os.path.isfile(cover_path)):
        raise TitleCoverError(f"封面图不存在：{cover_path}")

    if cover_duration is None:
        cover_duration = float(_cfg("cover_duration", 3.0))
    if cover_duration <= 0:
        return video_path

    ffmpeg = utils.get_ffmpeg_binary()
    if not ffmpeg:
        raise TitleCoverError("未找到 ffmpeg，无法合成封面。请检查 ffmpeg 安装。")

    if output_path is None:
        base, ext = os.path.splitext(video_path)
        output_path = f"{base}.cover{ext}"

    dur = max(0.5, float(cover_duration))
    filter_complex = (
        f"[1:v]trim=duration={dur:.3f},setpts=PTS-STARTPTS,fps={fps},setsar=1[cover];"
        f"[0:v]setpts=PTS-STARTPTS,setsar=1[mainv];"
        f"[cover][mainv]concat=n=2:v=1:a=0[outv]"
    )
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        video_path,
        "-loop",
        "1",
        "-i",
        cover_path,
        "-filter_complex",
        filter_complex,
        "-map",
        "[outv]",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        output_path,
    ]
    try:
        subprocess.run(
            cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except subprocess.CalledProcessError as e:
        raise TitleCoverError(f"ffmpeg 合成封面失败：{e}") from e

    if not os.path.isfile(output_path):
        raise TitleCoverError("ffmpeg 合成封面后未生成文件。")
    return output_path


def shutil_which(name: str) -> str:
    """轻量 which，避免重复导入 shutil（与 ffmpeg 解析保持一致）。"""
    import shutil

    return shutil.which(name) or ""


# --------------------------------------------------------------------------- #
# 编排
# --------------------------------------------------------------------------- #
def process_title_cover(
    *,
    video_subject: str = "",
    video_script: str = "",
    language: str = "",
    persona_id: Optional[str] = None,
    base_image: str = "",
    video_path: str = "",
    engine: Optional[str] = None,
    compose: bool = False,
    task_id: Optional[str] = None,
) -> dict:
    """标题 + 封面生成编排入口。

    返回 ``{title, tags, cover_path, (composed_video_path)}``。
    ``video_path`` + ``compose=True`` 时还会把封面合成到成片开头。
    """
    from app.services.agent import persona as persona_store

    language = (language or _cfg("language", "zh")).strip()
    persona_name = ""
    tone = ""
    if persona_id:
        persona = persona_store.get_persona(persona_id)
        if persona is None:
            raise TitleCoverError(f"人设不存在：{persona_id}")
        persona_name = persona.name or ""
        tone = persona.tone or ""
        video_subject = video_subject or (persona.style_preset or "")

    title_tags = generate_title_and_tags(
        video_subject=video_subject,
        video_script=video_script,
        language=language,
        persona_name=persona_name,
        tone=tone,
    )
    title = title_tags["title"]
    tags = title_tags["tags"]

    resolution = (1080, 1920)
    if video_path and os.path.isfile(video_path):
        probed = _probe_resolution(video_path)
        if probed:
            resolution = probed

    out_dir = _output_dir(task_id)
    cover_path = os.path.join(out_dir, f"cover_{uuid.uuid4().hex}.png")
    generate_cover(
        title=title,
        tags=tags,
        video_subject=video_subject,
        base_image=base_image,
        output_path=cover_path,
        resolution=resolution,
        engine=engine,
    )

    result = {
        "title": title,
        "tags": tags,
        "cover_path": cover_path,
    }

    if compose and video_path and os.path.isfile(video_path):
        composed = compose_video_with_cover(video_path, cover_path)
        result["composed_video_path"] = composed

    return result


if __name__ == "__main__":
    # 本地调试：生成一次标题/封面（需要可用的 LLM 配置与 Pillow）。
    import sys

    subject = sys.argv[1] if len(sys.argv) > 1 else "如何高效学习 Python"
    script = sys.argv[2] if len(sys.argv) > 2 else ""
    out = process_title_cover(
        video_subject=subject,
        video_script=script,
        language="zh",
        engine="local",
        compose=False,
    )
    print("title:", out["title"])
    print("tags:", out["tags"])
    print("cover:", out["cover_path"])
