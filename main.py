import asyncio
import logging

import uvicorn
from loguru import logger

from app.config import config


class _IgnoreBenignUvicornNoise(logging.Filter):
    """屏蔽 uvicorn 对「非 HTTP 探测」打的良性 WARNING。

    浏览器 / 系统代理 / 杀软在拦截 localhost 时，常向纯 HTTP 端口发送
    HTTPS(TLS) 握手或 CONNECT 请求，uvicorn 解析不了会打
    ``Invalid HTTP request received.`` 警告。这类探测不影响服务，属噪声，
    仅精准过滤该特定消息，其它 uvicorn 报错与应用日志均不受影响。
    """

    _NOISE = "Invalid HTTP request received"

    def filter(self, record: logging.LogRecord) -> bool:
        return self._NOISE not in record.getMessage()


def _ignore_loop_connection_noise(loop, context):
    """事件循环级兜底：吞掉 Windows proactor 下「对端中断连接」产生的良性噪声。

    浏览器取消下载 / 刷新 / 关标签页时，服务端仍在流式回传大响应（视频成片等），
    底层 socket 被对端 RST，proactor 在 ``_call_connection_lost`` 里对已关闭的
    socket 调 ``shutdown`` 会抛 ``ConnectionResetError [WinError 10054]`` /
    ``ConnectionAbortedError`` / ``BrokenPipeError``。这类属于对端主动断连，
    不影响服务，不应刷屏；其它异常仍按默认方式上报，避免掩盖真实故障。
    """
    exc = context.get("exception")
    if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
        return
    msg = str(context.get("message", ""))
    if "10054" in msg or "call_connection_lost" in msg or "远程主机强迫关闭" in msg:
        return
    loop.default_exception_handler(context)


class _QuietLoopPolicy(asyncio.DefaultEventLoopPolicy):
    """给每个新建的事件循环装上「吞连接噪声」的异常处理器。

    保持平台默认事件循环（Windows 上为 proactor），仅额外接管异常处理。
    """

    def new_event_loop(self):
        loop = super().new_event_loop()
        loop.set_exception_handler(_ignore_loop_connection_noise)
        return loop


if __name__ == "__main__":
    logger.info(
        "start server, docs: http://127.0.0.1:" + str(config.listen_port) + "/docs"
    )
    # uvicorn 默认 LOGGING_CONFIG 的 disable_existing_loggers=False，
    # 这里提前挂到 uvicorn.error logger 上的过滤器会在 run 时保留。
    logging.getLogger("uvicorn.error").addFilter(_IgnoreBenignUvicornNoise())
    # 抑制 Windows asyncio proactor 对端断连噪声（WinError 10054 / 10053 等）。
    asyncio.set_event_loop_policy(_QuietLoopPolicy())
    uvicorn.run(
        app="app.asgi:app",
        host=config.listen_host,
        port=config.listen_port,
        reload=config.reload_debug,
        log_level="warning",
    )
