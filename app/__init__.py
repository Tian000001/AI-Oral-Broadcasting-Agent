"""TTQ-Video 应用包元数据。"""

__version__ = "1.9.9"


def bump_version(version: str) -> str:
    """按十进制位（major.minor.patch）自增 1，遇 9 进位。

    例：
        "1.0.8" -> "1.0.9"
        "1.1.9" -> "1.2.0"
        "1.9.9" -> "2.0.0"
    任何一次项目修改后调用本函数得到下一版本号，再写回 ``__version__``。
    """
    parts = [int(x) for x in version.split(".")]
    while len(parts) < 3:
        parts.insert(0, 0)
    major, minor, patch = parts[-3], parts[-2], parts[-1]

    patch += 1
    if patch > 9:
        patch = 0
        minor += 1
    if minor > 9:
        minor = 0
        major += 1
    return f"{major}.{minor}.{patch}"
