"""Application implementation - ASGI."""

import os
import pathlib
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger

from app.config import config
from app.models.exception import HttpException
from app.router import root_api_router
from app.utils import utils


@asynccontextmanager
async def application_lifespan(_: FastAPI):
    """集中处理 API 进程启动恢复和关闭日志。"""
    logger.info("startup event")

    # 跨平台发布由当前进程线程池执行，不会在服务重启后恢复。启动时把 Redis
    # 中确认已失去执行进程的活动状态收敛为失败，避免任务永久无法删除。
    from app.services import task as task_service

    task_service.recover_interrupted_cross_posts()

    # 视频生成任务在进程重启后同样无法恢复，会把 PROCESSING 残留成删不掉的
    # 僵尸任务。启动时把本进程没有运行登记的生成任务收敛为失败，恢复可删除性。
    task_service.recover_interrupted_generations()

    # 口播智能体调度看板：接入真实端到端口播流水线（替代默认演示 handler）。
    # 真实 handler 仍受调度器的优先级队列 / 重试 / 复审 / 取消 逻辑托管。
    from app.controllers.manager.agent_manager import (
        _real_agent_handler,
        set_agent_handler,
    )

    set_agent_handler(_real_agent_handler)
    logger.info("agent scheduler: real koubo pipeline handler registered")
    try:
        yield
    finally:
        logger.info("shutdown event")


def exception_handler(request: Request, e: HttpException):
    return JSONResponse(
        status_code=e.status_code,
        content=utils.get_response(e.status_code, e.data, e.message),
    )


def validation_exception_handler(request: Request, e: RequestValidationError):
    # 把真实校验错误（缺失/非法的字段与原因）暴露给前端，而不是
    # 统一刷成 "field required" —— 否则用户看不到到底是哪个字段没填/填错。
    errs = e.errors()
    parts = []
    for er in errs:
        loc = ".".join(
            str(p) for p in er.get("loc", []) if p not in ("body", "query", "path", "form")
        )
        msg = er.get("msg", "")
        parts.append(f"{loc}: {msg}" if loc else msg)
    message = "; ".join(parts) if parts else "field required"
    return JSONResponse(
        status_code=400,
        content=utils.get_response(status=400, data=errs, message=message),
    )


def get_application() -> FastAPI:
    """Initialize FastAPI application.

    Returns:
       FastAPI: Application object instance.

    """
    instance = FastAPI(
        title=config.project_name,
        description=config.project_description,
        version=config.project_version,
        debug=False,
        lifespan=application_lifespan,
    )
    instance.include_router(root_api_router)
    instance.add_exception_handler(HttpException, exception_handler)
    instance.add_exception_handler(RequestValidationError, validation_exception_handler)
    return instance


app = get_application()

# Configures the CORS middleware for the FastAPI app
cors_allowed_origins_str = os.getenv("CORS_ALLOWED_ORIGINS", "")
origins = cors_allowed_origins_str.split(",") if cors_allowed_origins_str else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

task_dir = utils.task_dir()
app.mount(
    "/tasks", StaticFiles(directory=task_dir, html=True, follow_symlink=True), name=""
)

# 科技视频（Remotion）生成的音轨 / 素材，供前端预览与 Remotion 渲染访问。
media_dir = utils.storage_dir("techvideo_media", create=True)
app.mount(
    "/techvideo-media",
    StaticFiles(directory=media_dir, html=True, follow_symlink=True),
    name="",
)

# 科技视频「生成画廊」：已导出的成片 MP4，供前端 <video> 流式播放 / 下载。
gallery_dir = utils.storage_dir("techvideo", create=True)
app.mount(
    "/techvideo-videos",
    StaticFiles(directory=gallery_dir, html=True, follow_symlink=True),
    name="",
)

# 科技视频上传的图片素材：用户通过 /api/v1/techvideo/upload 上传的本地图片
# 落盘到 techvideo/public，此处挂出供浏览器预览；离线渲染时由 Remotion 的
# staticFile 从同一目录读取，预览与导出使用同一份文件。
_techvideo_root = pathlib.Path(__file__).resolve().parents[1] / "techvideo"
_techvideo_public = _techvideo_root / "public"
_techvideo_public.mkdir(parents=True, exist_ok=True)
app.mount(
    "/techvideo-public",
    StaticFiles(directory=str(_techvideo_public), html=True, follow_symlink=True),
    name="",
)

public_dir = utils.public_dir()
app.mount("/", StaticFiles(directory=public_dir, html=True), name="")
