"""Application configuration - root APIRouter.

Defines all FastAPI application endpoints.

Resources:
    1. https://fastapi.tiangolo.com/tutorial/bigger-applications

"""

from fastapi import APIRouter

from app.controllers.v1 import agent, asset, fonts, llm, stock, system, techvideo, video

root_api_router = APIRouter()
# v1
root_api_router.include_router(video.router)
root_api_router.include_router(llm.router)
root_api_router.include_router(agent.router)
root_api_router.include_router(asset.router)
root_api_router.include_router(system.router)
root_api_router.include_router(fonts.router)
root_api_router.include_router(techvideo.router)
root_api_router.include_router(stock.router)
