"""客户资产库（图片 / 声音 / 视频）的分类上传与管理。

资产元数据以追加式 JSON 列表持久化在 ``storage/assets/assets.json``，
实际文件按类型落盘到 ``storage/assets/files/<type>/``。
前端通过既有的 ``GET /api/v1/asset?path=...`` 安全预览文件。

设计要点：
- 类型由扩展名推断（白名单），未命中归入 ``file``（普通文件，前端仅列名不预览）。
- 元数据与文件分离，删除时二者一并清理；并发写用模块级锁保护。
- 不依赖任何外部存储 / 数据库，开箱即用。
"""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import threading
import time
import uuid

from app.utils import utils

# 扩展名 -> 资产类型
_TYPE_BY_EXT = {
    "png": "image", "jpg": "image", "jpeg": "image", "gif": "image",
    "webp": "image", "bmp": "image", "svg": "image",
    "mp3": "audio", "wav": "audio", "m4a": "audio", "aac": "audio",
    "ogg": "audio", "flac": "audio",
    "mp4": "video", "mov": "video", "mkv": "video", "webm": "video",
    "avi": "video", "flv": "video", "m4v": "video",
}
ALLOWED_EXT = set(_TYPE_BY_EXT.keys())
DEFAULT_CATEGORY = "未分类"

_lock = threading.Lock()


def detect_type(filename: str) -> str:
    """由文件名扩展名推断资产类型（image / audio / video / file）。"""
    ext = pathlib.Path(filename or "").suffix.lower().lstrip(".")
    return _TYPE_BY_EXT.get(ext, "file")


def _safe_basename(filename: str) -> str:
    """只保留纯文件名并去掉空格/目录分隔，避免路径穿越与文件名歧义。"""
    name = (filename or "").replace("\\", "/").split("/")[-1].strip()
    name = os.path.basename(name)
    if not name or name in (".", ".."):
        name = "asset"
    # 替换为下划线，避免空白/特殊字符导致的前端或文件系统问题。
    name = "".join(c if c.isalnum() or c in "._-()" else "_" for c in name)
    return name or "asset"


def _meta_path() -> str:
    d = utils.storage_dir("assets", create=True)
    return os.path.join(d, "assets.json")


def _file_dir(asset_type: str) -> str:
    return utils.storage_dir(os.path.join("assets", "files", asset_type), create=True)


def _load() -> list:
    p = _meta_path()
    if not os.path.isfile(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save(records: list) -> None:
    p = _meta_path()
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


def save_upload(file_bytes: bytes, filename: str) -> dict:
    """落盘上传文件，返回 ``(type, rel_path, abs_path, size)``。

    ``rel_path`` 以 ``storage/`` 开头，可直接交给 ``/api/v1/asset`` 端点预览。
    """
    asset_type = detect_type(filename)
    safe = _safe_basename(filename)
    store_name = f"{uuid.uuid4().hex}_{safe}"
    abs_path = os.path.join(_file_dir(asset_type), store_name)
    with open(abs_path, "wb") as f:
        f.write(file_bytes)
    rel_path = f"storage/assets/files/{asset_type}/{store_name}"
    return {
        "type": asset_type,
        "path": rel_path,
        "abs_path": abs_path,
        "size": len(file_bytes),
    }


def add_from_path(src_path: str, name: str = "", category: str = "") -> dict:
    """把磁盘上已存在的文件（如后端离线渲染产出的成片）直接归档为客户资产。

    与 ``save_upload`` 的区别：源是本地路径而非上传字节流。文件会复制到
    ``storage/assets/files/<type>/`` 目录并登记元数据，与上传资产走同一套命名与
    预览逻辑，便于前端在资产管理里统一预览 / 删除。

    :param src_path: 源文件绝对路径（如 ``storage/techvideo/xxxx.mp4``）。
    :param name: 资产展示名，留空回退为文件名。
    :param category: 分类名，留空归入默认分类「未分类」。
    :raises FileNotFoundError: 源文件不存在时。
    """
    if not os.path.isfile(src_path):
        raise FileNotFoundError(f"源文件不存在：{src_path}")

    asset_type = detect_type(src_path)
    safe = _safe_basename(os.path.basename(src_path))
    store_name = f"{uuid.uuid4().hex}_{safe}"
    dst_dir = _file_dir(asset_type)
    dst_path = os.path.join(dst_dir, store_name)
    shutil.copyfile(src_path, dst_path)

    rel_path = f"storage/assets/files/{asset_type}/{store_name}"
    file_meta = {
        "type": asset_type,
        "path": rel_path,
        "abs_path": dst_path,
        "size": os.path.getsize(dst_path),
    }
    display_name = name.strip() or os.path.basename(src_path)
    return add(name=display_name, category=category.strip(), file_meta=file_meta)


def add(name: str, category: str, file_meta: dict) -> dict:
    """登记一条资产，返回完整记录（含生成的 id / created_at）。"""
    record = {
        "id": uuid.uuid4().hex,
        "name": name or file_meta.get("path", "").split("/")[-1],
        "category": (category or "").strip() or DEFAULT_CATEGORY,
        "type": file_meta["type"],
        "path": file_meta["path"],
        "file": file_meta["path"].split("/")[-1],
        "size": file_meta.get("size", 0),
        "created_at": int(time.time()),
    }
    with _lock:
        records = _load()
        records.append(record)
        _save(records)
    return record


def list_assets(category: str | None = None, asset_type: str | None = None) -> list:
    """按分类 / 类型过滤，返回按创建时间倒序的列表。"""
    with _lock:
        records = _load()
    if category:
        records = [r for r in records if r.get("category") == category]
    if asset_type:
        records = [r for r in records if r.get("type") == asset_type]
    records.sort(key=lambda r: r.get("created_at", 0), reverse=True)
    # 标记物理文件是否仍存在，便于前端对「孤儿记录」（文件被删但元数据残留）
    # 优雅降级，而不是发起注定 404 的预览请求并展示黑屏。
    for r in records:
        r["exists"] = bool(r.get("path")) and os.path.isfile(r.get("path"))
    return records


def get(asset_id: str) -> dict | None:
    with _lock:
        for r in _load():
            if r.get("id") == asset_id:
                return r
    return None


def categories() -> list:
    """返回去重且排序后的分类列表（含默认分类）。"""
    with _lock:
        cats = {r.get("category", DEFAULT_CATEGORY) for r in _load()}
    cats.add(DEFAULT_CATEGORY)
    return sorted(cats)


def delete(asset_id: str) -> bool:
    """删除一条资产记录及其物理文件，成功返回 True。"""
    with _lock:
        records = _load()
        target = next((r for r in records if r.get("id") == asset_id), None)
        if not target:
            return False
        records = [r for r in records if r.get("id") != asset_id]
        _save(records)
    # 文件删除放到锁外，避免长耗时阻塞其它请求。
    abs_path = target.get("path", "")
    if abs_path.startswith("storage/"):
        try:
            resolved = utils.storage_dir(abs_path[len("storage/"):])
            if os.path.isfile(resolved):
                os.remove(resolved)
        except Exception:
            pass
    return True
