"""素材查找 REST（Pexels 图片 / 视频搜索 + 下载到资产管理）。

路由前缀由 :func:`app.controllers.v1.base.new_router` 统一设为 ``/api/v1``：

- ``POST /api/v1/stock/terms``     文案 → LLM 提取英文搜索关键词
- ``POST /api/v1/stock/search``    关键词 → Pexels 图片/视频搜索（分页）
- ``POST /api/v1/stock/download``  下载选中的图片/视频并登记为资产（分类「素材查找」）

所有响应统一使用 :func:`app.utils.utils.get_response` 信封（``{status, data, message}``）。
复用 ``app.services.material`` 的 API Key 轮换 / 代理 / TLS 校验配置。
"""
import hashlib
from urllib.parse import urlencode

import requests
from fastapi import Request
from loguru import logger
from pydantic import BaseModel

from app.config import config
from app.controllers.v1.base import new_router
from app.services.agent import asset as asset_store
from app.services.llm import generate_terms
from app.services.material import _get_tls_verify, get_api_key
from app.utils import utils

router = new_router()

# Pexels 拒绝 Python-urllib / requests 的默认 UA（返回 403），统一伪装浏览器 UA。
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
)
_UA_HEADERS = {"User-Agent": _UA}

# 每页返回条数上限（Pexels per_page 最大 80）。
MAX_PER_PAGE = 40
# 下载登记到资产管理时使用的默认分类。
DEFAULT_CATEGORY = "素材查找"


class TermsRequest(BaseModel):
    text: str = ""
    amount: int = 6


class SearchRequest(BaseModel):
    query: str = ""
    kind: str = "photo"        # photo | video
    page: int = 1
    per_page: int = 24
    orientation: str = ""      # 空 | landscape | portrait | square


class DownloadRequest(BaseModel):
    url: str = ""
    kind: str = "photo"        # photo | video
    name: str = ""


def _pexels_key() -> str:
    """取 Pexels API Key；未配置时抛 ValueError（由端点转成友好提示）。"""
    return get_api_key("pexels_api_keys")


def _pexels_get(url: str, key: str) -> dict:
    """带鉴权/代理/TLS 开关的 Pexels GET，返回解析后的 JSON。"""
    r = requests.get(
        url,
        headers={**_UA_HEADERS, "Authorization": key},
        proxies=config.proxy,
        verify=_get_tls_verify(),
        timeout=(30, 60),
    )
    r.raise_for_status()
    return r.json()


@router.post("/stock/terms", summary="文案提取英文搜索关键词（LLM）")
async def stock_terms(request: Request, body: TermsRequest):
    """把整段口播文案交给 LLM 提取 Pexels 友好的英文搜索关键词。

    入参 ``text`` 支持中文长文案；``amount`` 控制关键词数量（默认 6，上限 12）。
    返回 ``{terms: [...]}``；LLM 不可用时 ``ok:False`` 并带回原因。
    """
    text = (body.text or "").strip()
    if not text:
        return utils.get_response(200, {"ok": False, "message": "请先输入文案。"})
    amount = max(1, min(int(body.amount or 6), 12))
    try:
        terms = generate_terms(video_subject="", video_script=text, amount=amount)
    except Exception as e:  # noqa: BLE001
        logger.error(f"stock terms generation failed: {e}")
        return utils.get_response(
            200, {"ok": False, "message": f"关键词提取失败：{e}"}
        )
    terms = [t for t in (terms or []) if t and str(t).strip()]
    if not terms:
        return utils.get_response(
            200, {"ok": False, "message": "未能提取到关键词，请检查大模型配置。"}
        )
    return utils.get_response(200, {"ok": True, "terms": terms})


@router.post("/stock/search", summary="Pexels 图片/视频搜索")
async def stock_search(request: Request, body: SearchRequest):
    """按关键词搜索 Pexels 图片或视频，返回归一化结果与分页信息。

    入参：
    - ``query``：搜索词（建议英文；中文结果可能偏少）。
    - ``kind``：``photo``（默认）或 ``video``。
    - ``page`` / ``per_page``：分页（per_page 上限 40）。
    - ``orientation``：空（不限）/ landscape / portrait / square。

    返回 ``{kind, query, page, per_page, total, items}``；
    图片项 ``{type,id,thumb,full,width,height,author,page_url}``；
    视频项 ``{type,id,thumb,preview,width,height,duration,author,page_url,files}``。
    """
    query = (body.query or "").strip()
    if not query:
        return utils.get_response(200, {"ok": False, "message": "请输入搜索关键词。"})
    kind = "video" if (body.kind or "").lower() == "video" else "photo"
    page = max(1, int(body.page or 1))
    per_page = max(1, min(int(body.per_page or 24), MAX_PER_PAGE))
    orientation = (body.orientation or "").strip().lower()
    if orientation not in ("landscape", "portrait", "square"):
        orientation = ""

    try:
        key = _pexels_key()
    except ValueError as e:
        return utils.get_response(200, {"ok": False, "message": str(e)})

    params = {"query": query, "per_page": per_page, "page": page}
    if orientation:
        params["orientation"] = orientation

    try:
        if kind == "photo":
            data = _pexels_get(
                f"https://api.pexels.com/v1/search?{urlencode(params)}", key
            )
            photos = data.get("photos") or []
            items = [
                {
                    "type": "photo",
                    "id": p.get("id"),
                    "thumb": (p.get("src") or {}).get("large")
                    or (p.get("src") or {}).get("medium"),
                    "full": (p.get("src") or {}).get("large2x")
                    or (p.get("src") or {}).get("original")
                    or (p.get("src") or {}).get("large"),
                    "width": p.get("width"),
                    "height": p.get("height"),
                    "author": p.get("photographer", ""),
                    "page_url": p.get("url", ""),
                }
                for p in photos
            ]
        else:
            data = _pexels_get(
                f"https://api.pexels.com/v1/videos/search?{urlencode(params)}", key
            )
            videos = data.get("videos") or []
            items = []
            for v in videos:
                files = [
                    {
                        "link": f.get("link", ""),
                        "quality": f.get("quality", ""),
                        "width": f.get("width"),
                        "height": f.get("height"),
                        "file_type": f.get("file_type", ""),
                    }
                    for f in (v.get("video_files") or [])
                    if (f.get("file_type") or "").startswith("video/")
                ]
                # 预览用：优先 ≤1920 宽的 HD mp4，其次任意 mp4
                preview = ""
                for f in files:
                    w = int(f.get("width") or 0)
                    if f.get("quality") == "hd" and 0 < w <= 1920:
                        preview = f["link"]
                        break
                if not preview and files:
                    preview = files[0]["link"]
                pictures = v.get("video_pictures") or []
                user = v.get("user") or {}
                items.append(
                    {
                        "type": "video",
                        "id": v.get("id"),
                        "thumb": (pictures[0].get("picture") if pictures else "")
                        or "",
                        "preview": preview,
                        "width": v.get("width"),
                        "height": v.get("height"),
                        "duration": v.get("duration"),
                        "author": user.get("name", ""),
                        "page_url": v.get("url", ""),
                        "files": files,
                    }
                )
    except requests.HTTPError as e:
        code = e.response.status_code if e.response is not None else 0
        if code == 401 or code == 403:
            msg = "Pexels 拒绝访问：请检查 pexels_api_keys 是否有效。"
        elif code == 429:
            msg = "Pexels 请求频率超限，请稍后再试。"
        else:
            msg = f"Pexels 搜索失败（HTTP {code}）。"
        logger.error(f"pexels stock search failed: {e}")
        return utils.get_response(200, {"ok": False, "message": msg})
    except Exception as e:  # noqa: BLE001
        logger.error(f"pexels stock search failed: {e}")
        return utils.get_response(200, {"ok": False, "message": f"Pexels 搜索失败：{e}"})

    return utils.get_response(
        200,
        {
            "ok": True,
            "kind": kind,
            "query": query,
            "page": page,
            "per_page": per_page,
            "total": data.get("total_results"),
            "items": items,
        },
    )


@router.post("/stock/download", summary="下载 Pexels 图片/视频并登记到资产管理")
async def stock_download(request: Request, body: DownloadRequest):
    """把选中的 Pexels 素材下载到本地 ``storage/assets/files/`` 并登记资产记录。

    入参 ``url`` 为素材直链（图片原图 / 视频 mp4 文件链接）；``kind`` 决定扩展名
    兜底（photo→.jpg，video→.mp4，实际按 Content-Type 校正）；``name`` 为资产名称，
    留空用文件名。登记分类固定为「素材查找」，可在资产管理页再归类。
    """
    url = (body.url or "").strip()
    if not url.startswith(("http://", "https://")):
        return utils.get_response(200, {"ok": False, "message": "非法素材地址。"})
    kind = "video" if (body.kind or "").lower() == "video" else "photo"

    try:
        r = requests.get(
            url,
            headers=_UA_HEADERS,
            proxies=config.proxy,
            verify=_get_tls_verify(),
            timeout=(30, 180),
        )
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        logger.error(f"pexels stock download failed: {url} -> {e}")
        return utils.get_response(200, {"ok": False, "message": f"素材下载失败：{e}"})

    content = r.content or b""
    if not content:
        return utils.get_response(200, {"ok": False, "message": "素材下载为空。"})

    ctype = (r.headers.get("Content-Type") or "").lower()
    ext = ".mp4" if kind == "video" else ".jpg"
    if "png" in ctype:
        ext = ".png"
    elif "webp" in ctype:
        ext = ".webp"
    elif "mp4" in ctype or "video/" in ctype:
        ext = ".mp4"
    elif "jpeg" in ctype or "jpg" in ctype:
        ext = ".jpg"

    digest = hashlib.md5(url.encode("utf-8")).hexdigest()[:12]
    filename = f"pexels-{digest}{ext}"
    try:
        file_meta = asset_store.save_upload(content, filename)
        record = asset_store.add(
            name=(body.name or "").strip(),
            category=DEFAULT_CATEGORY,
            file_meta=file_meta,
        )
    except Exception as e:  # noqa: BLE001
        logger.error(f"stock asset save failed: {e}")
        return utils.get_response(200, {"ok": False, "message": f"资产保存失败：{e}"})
    return utils.get_response(200, {"ok": True, "asset": record})
