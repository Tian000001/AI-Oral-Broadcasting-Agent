"""数字人 / 声音克隆 Provider 的公共工具。

抽离所有 Provider 共用的异常、本地引擎解析、HTTP 下载、轮询与输出路径生成，
避免每个具体实现重复造轮子，也保证降级行为一致。

设计约定：
- 本地引擎（SadTalker / HeyGem / XTTS 等）依赖 PyTorch + GPU，无法塞进本项目便携发行版，
  因此统一通过 ``config.digital_human.local_python``（独立环境解释器）与
  ``local_script``（推理脚本）以 subprocess 方式调用，缺失时抛出清晰配置错误而非崩溃。
- 云端依赖 httpx（FastAPI 链路已自带），缺包时抛出 ProviderUnavailable。
"""
from __future__ import annotations

import os
import time
from datetime import datetime
from typing import Callable, Optional

from app.config import config
from app.config.config import root_dir


class ProviderError(Exception):
    """Provider 运行期错误（调用失败、超时、鉴权失败等）。"""


class ProviderConfigError(ProviderError):
    """配置缺失或无效（缺 api_key / 本地引擎路径等）。"""


class ProviderUnavailable(ProviderError):
    """运行环境不满足（缺依赖、引擎、网络）。"""


def agent_output_dir(sub: str = "agent") -> str:
    """返回口播智能体的临时产物目录（storage/temp/agent 或子目录）。"""
    path = os.path.join(root_dir, "storage", "temp", sub)
    os.makedirs(path, exist_ok=True)
    return path


def unique_output(name: str, ext: str, sub: str = "agent") -> str:
    """生成带时间戳的唯一输出文件路径，避免并发覆盖。"""
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    return os.path.join(agent_output_dir(sub), f"{name}_{ts}.{ext}")


def resolve_local_engine(provider_name: str, cfg: dict) -> tuple[str, str]:
    """解析本地引擎的 Python 解释器与推理脚本，缺失或无效则抛 ProviderConfigError。

    :param provider_name: 仅用于错误提示的 Provider 标识。
    :param cfg: 一般传 ``dict(config.digital_human)`` 或 ``dict(config.voice_clone)``。

    说明：``local_python`` / ``local_script`` 支持相对路径，会基于项目根目录
    （``root_dir``）解析，方便整套环境随项目目录一起拷贝到其它机器。
    """
    # 优先读取 per-provider 专属键（如 local_heygem_python / local_heygem_script），
    # 让同一类目下多个本地引擎（sadtalker / heygem）并存且互不覆盖；
    # 专属键缺失时回退到通用 local_python / local_script。
    local_python = (cfg.get(f"{provider_name}_python") or cfg.get("local_python") or "").strip()
    local_script = (cfg.get(f"{provider_name}_script") or cfg.get("local_script") or "").strip()
    if local_python and not os.path.isabs(local_python):
        local_python = os.path.join(root_dir, local_python)
    if local_script and not os.path.isabs(local_script):
        local_script = os.path.join(root_dir, local_script)
    if not local_python or not os.path.isfile(local_python):
        raise ProviderConfigError(
            f"[{provider_name}] 未配置有效的 local_python：请在 config.toml 的 "
            f"[digital_human] / [voice_clone] 段指向装有 PyTorch 的独立 Python 解释器。"
        )
    if not local_script or not os.path.isfile(local_script):
        raise ProviderConfigError(
            f"[{provider_name}] 未配置有效的 local_script：请指向引擎推理脚本。"
        )
    return local_python, local_script


def ensure_httpx():
    """返回 httpx 模块；不可用则抛 ProviderUnavailable。"""
    try:
        import httpx  # noqa: F401
    except ImportError as exc:  # pragma: no cover - 取决于运行环境
        raise ProviderUnavailable(
            "未安装 httpx，无法调用云端 Provider。请 pip install httpx。"
        ) from exc
    return __import__("httpx")


def is_url(value: str) -> bool:
    """判断给定字符串是否为 http(s) URL。"""
    return str(value or "").strip().lower().startswith(("http://", "https://"))


def download_to(url: str, out_path: str, timeout: int = 600) -> str:
    """把 url 下载到 out_path，返回 out_path。"""
    httpx = ensure_httpx()
    try:
        with httpx.stream("GET", url, timeout=timeout, follow_redirects=True) as resp:
            resp.raise_for_status()
            with open(out_path, "wb") as fp:
                for chunk in resp.iter_bytes():
                    fp.write(chunk)
    except Exception as exc:  # 网络/HTTP 错误统一包装
        raise ProviderError(f"下载失败 ({url}): {exc}") from exc
    return out_path


def poll_until(
    get_status: Callable[[], object],
    is_done: Callable[[object], bool],
    interval: float = 5.0,
    timeout: float = 900.0,
) -> object:
    """按 interval 轮询 get_status()，直到 is_done(status) 为真或超时。

    :returns: 最后一次 get_status() 的结果。
    :raises ProviderError: 超过 timeout 仍未完成。
    """
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = get_status()
        if is_done(last):
            return last
        time.sleep(interval)
    raise ProviderError(f"轮询超时（{timeout:.0f}s），最后状态: {last}")


def read_api_credentials(segment: dict, *, key_env: str) -> str:
    """从配置段与环境变量解析 api_key，均缺失则抛 ProviderConfigError。"""
    key = (segment.get("api_key") or "").strip() or os.getenv(key_env, "").strip()
    if not key:
        raise ProviderConfigError(
            f"缺少 api_key：请在 config.toml 配置，或设置环境变量 {key_env}。"
        )
    return key


def base_url(segment: dict, default: str) -> str:
    """返回配置段中的 base_url，为空则回退默认值。"""
    return (segment.get("base_url") or "").strip() or default


def find_newest_file(root: str, ext: str) -> Optional[str]:
    """在 root（含子目录）下查找指定扩展名的最新文件，未找到返回 None。"""
    ext = ext if ext.startswith(".") else f".{ext}"
    newest: Optional[str] = None
    newest_mtime = -1.0
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if not name.lower().endswith(ext):
                continue
            full = os.path.join(dirpath, name)
            try:
                mtime = os.path.getmtime(full)
            except OSError:
                continue
            if mtime > newest_mtime:
                newest_mtime = mtime
                newest = full
    return newest


def _find_ffmpeg() -> str:
    """定位 ffmpeg 可执行文件：优先项目内置 imageio-ffmpeg，回退 PATH 里的 ffmpeg。"""
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            return exe
    except Exception:
        pass
    import shutil

    p = shutil.which("ffmpeg")
    return p or ""


def convert_audio(src: str, dst: str, *, timeout: int = 300) -> str:
    """用 ffmpeg 把 src 转码为 dst（按 dst 扩展名决定容器/编码），返回 dst。

    本地 TTS 引擎只产出 wav（soundfile/libsndfile 不支持写 mp3），而试听预览与
    视频合成普遍要求 ``.mp3``；此函数负责把引擎产物转码到调用方要求的扩展名，
    否则 subprocess 直接写 ``.mp3`` 会因 libsndfile 无 mp3 编码器而失败。
    """
    ff = _find_ffmpeg()
    if not ff:
        raise ProviderError(
            "未找到 ffmpeg，无法把本地引擎的 wav 输出转码为所需格式。"
            "请安装 ffmpeg 或确保 imageio-ffmpeg 可用。"
        )
    ext = os.path.splitext(dst)[1].lower()
    cmd = [ff, "-y", "-i", src]
    if ext == ".mp3":
        cmd += ["-codec:a", "libmp3lame", "-q:a", "2"]
    elif ext == ".m4a":
        cmd += ["-codec:a", "aac", "-b:a", "192k"]
    cmd.append(dst)
    import subprocess

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception as exc:
        raise ProviderError(f"ffmpeg 转码调用失败: {exc}") from exc
    if proc.returncode != 0 or not os.path.isfile(dst):
        raise ProviderError(
            f"ffmpeg 转码失败（退出码 {proc.returncode}）：{proc.stderr[-1500:] or proc.stdout[-1500:]}"
        )
    return dst
