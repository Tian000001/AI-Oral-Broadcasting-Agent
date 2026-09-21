"""字幕字体枚举：列举 ``resource/fonts`` 目录下的可用字体文件，供前端字幕设置下拉框使用。

路由前缀由 :func:`app.controllers.v1.base.new_router` 统一设为 ``/api/v1``：

- ``GET  /api/v1/fonts``  返回 ``{default, fonts:[<filename>, ...]}``

前端下拉框的 option value 即字体文件名本身，后端 ``app.services.video`` 按文件名到
``utils.font_dir()`` 解析绝对路径，因此新增/移除字体文件无需改任何其它代码。
"""
import os

from app.controllers.v1.base import new_router
from app.utils import utils

router = new_router()

_FONT_EXTS = (".ttf", ".ttc", ".otf")
_DEFAULT_FONT = "STHeitiMedium.ttc"


@router.get(
    "/fonts",
    summary="列举可用字幕字体",
)
def list_fonts():
    """扫描 ``resource/fonts`` 目录，返回所有字体文件名（按名称排序）。

    ``default`` 为推荐默认字体（与 ``video.py`` 后端回退值一致），``fonts`` 为文件名列表。
    """
    d = utils.font_dir()
    fonts = sorted(
        f
        for f in os.listdir(d)
        if os.path.isfile(os.path.join(d, f)) and f.lower().endswith(_FONT_EXTS)
    )
    default = _DEFAULT_FONT if _DEFAULT_FONT in fonts else (fonts[0] if fonts else "")
    return utils.get_response(200, {"default": default, "fonts": fonts})
