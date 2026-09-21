"""系统级 REST：配置读写 + 通用文件上传（供静态前端设置页/人设上传使用）。

路由前缀由 :func:`app.controllers.v1.base.new_router` 统一设为 ``/api/v1``：

- ``GET  /api/v1/config``   读取当前运行期配置（按区段返回嵌套 JSON）
- ``POST /api/v1/config``   全量覆盖并持久化（复用 ``save_config`` 原子写）
- ``POST /api/v1/upload``   通用文件上传，返回服务器绝对路径（数字人源图/视频、
  声音克隆样本音频等），供前端在提交人设/生成时引用。

所有响应统一使用 :func:`app.utils.utils.get_response` 信封（``{status, data, message}``）。
"""
import mimetypes
import os
import pathlib
import uuid

from fastapi import Request, UploadFile
from fastapi.params import File
from fastapi.responses import FileResponse

import app as app_pkg
import app.config.config as cfg_module
from app.config.config import save_config
from app.controllers.v1.base import new_router
from app.models.exception import HttpException
from app.utils import file_security, utils

router = new_router()

# 配置文件中实际存在、且以 dict（或 _SynchronizedConfig）形式暴露的区段。
# 这些区段既能被 GET 序列化，也能被 POST 用 .update() 改写并经 save_config 落盘。
CONFIG_SECTIONS = [
    "app",
    "ui",
    "agent",
    "persona",
    "digital_human",
    "voice_clone",
    "compliance",
    "reference",
    "title_cover",
    "publishing",
    "azure",
    "siliconflow",
    "minimax_tts",
    "elevenlabs",
    "chatterbox",
    "proxy",
    "whisper",
    "vendors",
]

# 允许上传的扩展名：图片 + 视频 + 音频。
_ALLOWED_EXT = {
    "png", "jpg", "jpeg", "webp", "bmp", "gif",
    "mp4", "mov", "avi", "mkv", "flv",
    "mp3", "wav", "m4a", "aac", "ogg", "flac", "opus",
}


def _safe_name(filename: str, request_id: str) -> str:
    """只保留纯文件名，拒绝目录穿越与非法/不支持的扩展名。"""
    name = (filename or "").replace("\\", "/").split("/")[-1].strip()
    if not name or name in {".", ".."}:
        raise HttpException(
            task_id=request_id, status_code=400, message="invalid filename"
        )
    suffix = pathlib.Path(name).suffix.lower().lstrip(".")
    if suffix not in _ALLOWED_EXT:
        raise HttpException(
            task_id=request_id,
            status_code=400,
            message=f"unsupported file type: .{suffix}",
        )
    return name


@router.get(
    "/config",
    summary="读取当前运行期配置",
)
def get_config(request: Request):
    """按区段返回配置嵌套字典，供静态前端设置页渲染。"""
    out = {}
    for name in CONFIG_SECTIONS:
        obj = getattr(cfg_module, name, None)
        if isinstance(obj, dict):
            out[name] = dict(obj)
    return utils.get_response(200, out)


@router.post(
    "/config",
    summary="覆盖并持久化配置",
)
def update_config(request: Request, body: dict):
    """接收与 GET 同构的配置字典，逐区段 .update 后原子落盘。

    仅覆盖传入的区段与字段，未传区段保持不变；调用方应回传 GET 拿到的全量
    配置以避免误删其它区段。
    """
    if not isinstance(body, dict):
        raise HttpException(
            task_id="", status_code=400, message="body must be a config object"
        )

    for name, values in body.items():
        if name not in CONFIG_SECTIONS or not isinstance(values, dict):
            continue
        obj = getattr(cfg_module, name, None)
        if isinstance(obj, dict):
            try:
                obj.update(values)
            except Exception as e:  # 类型不匹配等，记录但不中断其它区段
                raise HttpException(
                    task_id="",
                    status_code=400,
                    message=f"config section '{name}' update failed: {e}",
                )

    try:
        save_config()
    except Exception as e:
        raise HttpException(
            task_id="", status_code=500, message=f"save config failed: {e}"
        )
    return utils.get_response(200, {"ok": True})


@router.get(
    "/version",
    summary="获取当前版本号",
)
def get_version(request: Request):
    """返回本项目当前版本号（来自 ``app.__version__``）。

    项目已脱离原 GitHub 仓库，不再做远程版本检查；此处仅返回本地版本号，
    供前端在侧边栏底部展示。
    """
    return utils.get_response(200, {"current_version": app_pkg.__version__})


@router.post(
    "/upload",
    summary="通用文件上传（数字人源图/视频、声音克隆样本音频等）",
)
def upload_file(
    request: Request,
    file: UploadFile = File(...),
    category: str = "misc",
):
    """保存上传文件到 storage/uploads/<category>/，返回绝对路径供流水线引用。"""
    request_id = ""
    try:
        request_id = __import__(
            "app.controllers.v1.base", fromlist=["base"]
        ).get_task_id(request)
    except Exception:
        request_id = ""

    safe = _safe_name(file.filename or "", request_id)
    sub = category if category in ("digital_human", "voice", "misc") else "misc"
    save_dir = utils.storage_dir(os.path.join("uploads", sub), create=True)
    # 前缀 UUID 避免同名覆盖，同时保证文件名安全。
    save_path = os.path.join(save_dir, f"{uuid.uuid4().hex}_{safe}")
    try:
        with open(save_path, "wb+") as buffer:
            file.file.seek(0)
            buffer.write(file.file.read())
    except OSError as e:
        raise HttpException(
            task_id=request_id, status_code=500, message=f"upload failed: {e}"
        )

    return utils.get_response(
        200,
        {
            "file": os.path.basename(save_path),
            "path": os.path.abspath(save_path),
            "category": sub,
        },
    )


@router.get(
    "/asset",
    summary="安全预览 storage/ 与 resource/ 下的图片/文件",
)
def serve_asset(request: Request, path: str = ""):
    """前端展示封面、上传资源等时使用。

    仅允许以 ``storage/`` 或 ``resource/`` 开头的路径，并经
    :func:`app.utils.file_security.resolve_path_within_directory` 收敛目录穿越，
    杜绝任意文件读取。
    """
    request_id = ""
    try:
        request_id = base.get_task_id(request)
    except Exception:
        pass

    if not path:
        raise HttpException(task_id=request_id, status_code=400, message="missing path")
    # 前端传入的路径带 storage/ 或 resource/ 前缀（相对项目根），这里剥离前缀后再
    # 相对各自根目录解析，避免拼接出 storage/storage 双重路径导致 404。
    if path.startswith("storage/"):
        base_dir = utils.storage_dir()
        rel = path[len("storage/"):]
    elif path.startswith("resource/"):
        base_dir = utils.resource_dir()
        rel = path[len("resource/"):]
    else:
        raise HttpException(task_id=request_id, status_code=400, message="path not allowed")

    try:
        resolved = file_security.resolve_path_within_directory(base_dir, rel)
    except ValueError as e:
        raise HttpException(task_id=request_id, status_code=404, message=str(e))
    if not os.path.isfile(resolved):
        raise HttpException(task_id=request_id, status_code=404, message="file not found")

    return FileResponse(
        resolved,
        media_type=mimetypes.guess_type(resolved)[0] or "application/octet-stream",
    )
