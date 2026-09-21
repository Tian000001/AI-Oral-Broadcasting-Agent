"""客户资产管理 REST（图片 / 声音 / 视频）。

路由前缀由 :func:`app.controllers.v1.base.new_router` 统一设为 ``/api/v1``：

- ``POST   /api/v1/agent/assets``          上传文件并登记（表单：file / category / name）
- ``GET    /api/v1/agent/assets``          列表（可按 category / type 过滤）
- ``GET    /api/v1/agent/assets/categories``  全部分类
- ``GET    /api/v1/agent/assets/{id}``     单条详情
- ``DELETE /api/v1/agent/assets/{id}``     删除（记录 + 物理文件）

所有响应统一使用 :func:`app.utils.utils.get_response` 信封（``{status, data, message}``）。
文件预览复用既有的 ``GET /api/v1/asset?path=...`` 端点。
"""
from fastapi import Request, UploadFile
from fastapi.params import File, Form, Query

from app.controllers.v1.base import new_router
from app.models.exception import HttpException
from app.services.agent import asset as asset_store
from app.utils import utils

router = new_router()


@router.post(
    "/agent/assets",
    summary="上传客户资产（图片/声音/视频）并分类登记",
)
async def create_asset(
    request: Request,
    file: UploadFile = File(...),
    category: str = Form(""),
    name: str = Form(""),
):
    """接收上传文件，按扩展名推断类型，落盘到 ``storage/assets/files/<type>/`` 并登记元数据。

    分类（category）为空时归入默认分类「未分类」；名称（name）为空时回退为文件名。
    """
    request_id = ""
    try:
        request_id = __import__(
            "app.controllers.v1.base", fromlist=["base"]
        ).get_task_id(request)
    except Exception:
        request_id = ""

    filename = file.filename or ""
    ext = (filename.rsplit(".", 1)[-1].lower() if "." in filename else "")
    if ext not in asset_store.ALLOWED_EXT:
        raise HttpException(
            task_id=request_id,
            status_code=400,
            message=f"不支持的文件类型：.{ext or '未知'}（仅支持图片/声音/视频）",
        )

    try:
        content = await file.read()
    except Exception as e:
        raise HttpException(task_id=request_id, status_code=500, message=f"读取上传失败：{e}")

    if not content:
        raise HttpException(task_id=request_id, status_code=400, message="空文件")

    file_meta = asset_store.save_upload(content, filename)
    record = asset_store.add(name=name.strip(), category=category.strip(), file_meta=file_meta)
    return utils.get_response(200, record)


@router.get(
    "/agent/assets",
    summary="资产列表（可按分类/类型过滤）",
)
def list_assets(
    request: Request,
    category: str = Query("", description="分类名，留空返回全部"),
    type: str = Query("", description="类型：image / audio / video / file"),
):
    records = asset_store.list_assets(
        category=category or None,
        asset_type=type or None,
    )
    return utils.get_response(200, records)


@router.get(
    "/agent/assets/categories",
    summary="资产全部分类",
)
def list_categories(request: Request):
    return utils.get_response(200, asset_store.categories())


@router.get(
    "/agent/assets/{asset_id}",
    summary="资产详情",
)
def get_asset(request: Request, asset_id: str):
    record = asset_store.get(asset_id)
    if not record:
        raise HttpException(task_id="", status_code=404, message="asset not found")
    return utils.get_response(200, record)


@router.delete(
    "/agent/assets/{asset_id}",
    summary="删除资产（记录 + 文件）",
)
def delete_asset(request: Request, asset_id: str):
    ok = asset_store.delete(asset_id)
    if not ok:
        raise HttpException(task_id="", status_code=404, message="asset not found")
    return utils.get_response(200, {"id": asset_id, "deleted": True})
