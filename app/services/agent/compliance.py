"""口播智能体 · 文案 / 标题违禁词合规检测（Phase 6）。

把「文案 + 标题」过一遍违禁词 / 敏感词库，命中即给出提示、改写建议，并标记是否阻断。

词库组织
--------
- 默认行业词库：``resource/forbidden_words/`` 下每个行业一个 ``.txt``（30+ 行业），
  文件名即行业名（如 ``finance.txt`` 金融、``medical.txt`` 医疗）。
- 用户自定义词：``storage/forbidden_words/custom.txt``（与默认词库同格式，行业标记为 ``custom``）。
- 历史兼容：config 里的 ``wordlist_path`` 指向的单文件（每行一个词，无元数据，行业标记为 ``legacy``）。

每行格式（行业词库 / 自定义词通用）
-------------------------------
    模式                    # 纯文本，按 default_level 定级（默认 warn）
    模式|block              # 指定级别：block（阻断）/ warn（仅提示建议改写）
    模式|warn|建议改写说明
    模式|block|建议改写|变体1,变体2   # 变体（同音 / 形近）一并匹配
    /正则表达式/|block|说明           # 以 / 包裹表示正则
    # 这是注释

匹配能力
--------
- 纯文本子串匹配（默认）。
- 正则匹配：用 ``/.../`` 包裹，可覆盖变体规避（如 ``/旺旺|王旺|汪汪/``）。
- 同音 / 形近变体：同一条目用 ``|`` 第四字段列出变体，全部参与匹配。

分级语义
--------
- ``block``：硬性违规，应阻断发布（如毒品、赌博、色情、政治敏感、根治/包治等绝对化医疗承诺）。
- ``warn``：高风险措辞，可能限流或触发审核，给出改写建议但不阻断（如「最」「第一」「美白」）。

``ComplianceResult.blocked`` = 存在 block 级命中 且 config 的 ``block_on_hit`` 为真。
调用方（流水线 / WebUI）据此决定是否拦截。关闭 ``block_on_hit`` 时即使命中 block 词也只上报不断开。

设计要点
--------
- 不引入新重依赖，仅标准库 + pydantic。
- 词库懒加载并缓存，修改自定义词后调用 :func:`reload_dictionaries` 热更新。
- 任意词库文件缺失 / 损坏都不影响其它词库与整体检测（单点故障隔离）。
"""
from __future__ import annotations

import logging
import os
import re
import threading
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional

from pydantic import BaseModel, Field

from app.config import config
from app.utils import utils

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# 数据模型
# --------------------------------------------------------------------------- #
class HitLevel(str, Enum):
    """命中级别：block 应阻断，warn 仅提示。"""

    BLOCK = "block"
    WARN = "warn"


@dataclass
class _Entry:
    """一条已编译的匹配规则。``literal`` 与 ``regex`` 二选一。"""

    display: str  # 原始触发词（用于上报展示）
    level: HitLevel
    industry: str
    suggestion: str = ""
    literal: Optional[str] = None
    regex: Optional[re.Pattern] = None


class ComplianceHit(BaseModel):
    """单条命中记录。"""

    word: str  # 触发词（原始 pattern，去 ``/`` 包裹）
    matched: str  # 文本中实际命中的子串
    industry: str  # 所属行业 / 词库
    level: HitLevel
    suggestion: str = ""  # 改写建议
    scope: str = "text"  # 命中字段：script / title / 自定义 key
    start: int = -1  # 命中起始字符索引（正则 / 变体可能 -1）
    end: int = -1


class ComplianceResult(BaseModel):
    """一次合规检测结果。"""

    passed: bool = True  # 是否通过（无 block 级命中即为 True）
    blocked: bool = False  # 是否因 block_on_hit 被阻断
    hits: List[ComplianceHit] = Field(default_factory=list)
    scanned_fields: List[str] = Field(default_factory=list)
    dictionary_count: int = 0  # 已加载规则条数


# --------------------------------------------------------------------------- #
# 配置与路径
# --------------------------------------------------------------------------- #
def _cfg(key: str, default):
    """读取 config.compliance 的安全取值（缺段也不报错）。"""
    return config.compliance.get(key, default)


def _resolve(rel_path: str) -> str:
    """相对路径以项目根为基准解析。"""
    if os.path.isabs(rel_path):
        return rel_path
    return os.path.join(utils.root_dir(), rel_path)


# --------------------------------------------------------------------------- #
# 词库加载
# --------------------------------------------------------------------------- #
_entries: List[_Entry] = []
_loaded: bool = False
_lock = threading.RLock()


def _parse_line(line: str, industry: str, enable_regex: bool, enable_variants: bool) -> List[_Entry]:
    """解析单行，可能产出 1 条（含变体则多条）规则。"""
    parts = [p.strip() for p in line.split("|")]
    pattern = parts[0]
    if not pattern:
        return []

    # 第二字段：级别（缺省取 default_level）
    level = HitLevel(_cfg("default_level", "warn"))
    if len(parts) > 1 and parts[1]:
        lv = parts[1].lower()
        if lv in ("block", "warn"):
            level = HitLevel(lv)

    # 第三字段：改写建议
    suggestion = parts[2] if len(parts) > 2 else ""

    # 第四字段：同音 / 形近变体
    variants: List[str] = []
    if enable_variants and len(parts) > 3:
        variants = [v for v in parts[3].split(",") if v]

    entries = [_build_entry(pattern, level, industry, suggestion, enable_regex)]
    for v in variants:
        entries.append(_build_entry(v, level, industry, suggestion, enable_regex))
    return entries


def _build_entry(pattern: str, level: HitLevel, industry: str, suggestion: str, enable_regex: bool) -> _Entry:
    display = pattern
    if enable_regex and len(pattern) >= 2 and pattern.startswith("/") and pattern.endswith("/"):
        inner = pattern[1:-1]
        try:
            return _Entry(
                display=display,
                level=level,
                industry=industry,
                suggestion=suggestion,
                regex=re.compile(inner),
            )
        except re.error as exc:  # 正则非法则降级为字面量（去掉包裹斜杠）
            logger.warning(f"invalid regex '{pattern}' in [{industry}]: {exc}; treat as literal")
            pattern = inner

    return _Entry(
        display=display,
        level=level,
        industry=industry,
        suggestion=suggestion,
        literal=pattern,
    )


def _load_file(path: str, industry: str, enable_regex: bool, enable_variants: bool) -> List[_Entry]:
    out: List[_Entry] = []
    try:
        with open(path, mode="r", encoding="utf-8") as fp:
            for raw in fp:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                out.extend(_parse_line(line, industry, enable_regex, enable_variants))
    except OSError as exc:
        logger.warning(f"cannot read word list {path}: {exc}")
    return out


def load_dictionaries() -> int:
    """加载全部词库（行业词库 + 自定义词 + 兼容单文件）。返回规则条数。"""
    global _entries, _loaded

    industries_dir = _resolve(_cfg("dictionary_dir", "resource/forbidden_words"))
    custom_file = _resolve(_cfg("custom_words_file", "storage/forbidden_words/custom.txt"))
    legacy_file = _resolve(_cfg("wordlist_path", "resource/compliance/blocked_words.txt"))
    enable_regex = _cfg("enable_regex", True)
    enable_variants = _cfg("enable_variants", True)
    restrict = _cfg("industries", []) or []  # 非空时仅加载指定行业

    entries: List[_Entry] = []

    # 1) 分行业词库目录
    if os.path.isdir(industries_dir):
        for fname in sorted(os.listdir(industries_dir)):
            if not fname.endswith(".txt"):
                continue
            industry = os.path.splitext(fname)[0]
            if restrict and industry not in restrict:
                continue
            entries.extend(
                _load_file(os.path.join(industries_dir, fname), industry, enable_regex, enable_variants)
            )
    else:
        logger.warning(f"forbidden-words directory not found: {industries_dir}")

    # 2) 用户自定义词
    if os.path.isfile(custom_file):
        entries.extend(_load_file(custom_file, "custom", enable_regex, enable_variants))

    # 3) 历史兼容：单文件（每行一个词，默认 block 级）
    if os.path.isfile(legacy_file):
        try:
            with open(legacy_file, mode="r", encoding="utf-8") as fp:
                for raw in fp:
                    w = raw.strip()
                    if w and not w.startswith("#"):
                        entries.append(
                            _Entry(display=w, level=HitLevel.BLOCK, industry="legacy", literal=w)
                        )
        except OSError as exc:
            logger.warning(f"cannot read legacy wordlist {legacy_file}: {exc}")

    with _lock:
        _entries = entries
        _loaded = True

    logger.info(f"compliance dictionaries loaded: {len(entries)} entries")
    return len(entries)


def _ensure_loaded() -> None:
    global _loaded
    if not _loaded:
        with _lock:
            if not _loaded:
                load_dictionaries()


def reload_dictionaries() -> int:
    """强制热重载词库（自定义词变更后调用）。"""
    return load_dictionaries()


# --------------------------------------------------------------------------- #
# 扫描
# --------------------------------------------------------------------------- #
def _scan(text: str, scope: str) -> List[ComplianceHit]:
    hits: List[ComplianceHit] = []
    for e in _entries:
        if e.regex is not None:
            for m in e.regex.finditer(text):
                hits.append(
                    ComplianceHit(
                        word=e.display,
                        matched=m.group(0),
                        industry=e.industry,
                        level=e.level,
                        suggestion=e.suggestion,
                        scope=scope,
                        start=m.start(),
                        end=m.end(),
                    )
                )
        else:
            lit = e.literal
            if not lit:
                continue
            idx = text.find(lit)
            while idx != -1:
                hits.append(
                    ComplianceHit(
                        word=e.display,
                        matched=lit,
                        industry=e.industry,
                        level=e.level,
                        suggestion=e.suggestion,
                        scope=scope,
                        start=idx,
                        end=idx + len(lit),
                    )
                )
                idx = text.find(lit, idx + len(lit))
    return hits


def _build_result(hits: List[ComplianceHit], scopes: List[str]) -> ComplianceResult:
    # 去重：同一 (匹配串, 位置, 行业, 字段) 只计一次
    seen = set()
    uniq: List[ComplianceHit] = []
    for h in hits:
        key = (h.matched, h.start, h.industry, h.scope)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(h)

    block_hits = [h for h in uniq if h.level == HitLevel.BLOCK]
    passed = len(block_hits) == 0
    block_on_hit = _cfg("block_on_hit", True)
    blocked = (not passed) and block_on_hit
    return ComplianceResult(
        passed=passed,
        blocked=blocked,
        hits=uniq,
        scanned_fields=scopes,
        dictionary_count=len(_entries),
    )


# --------------------------------------------------------------------------- #
# 公开 API
# --------------------------------------------------------------------------- #
def check_text(text: str, *, scope: str = "text", enabled: Optional[bool] = None) -> ComplianceResult:
    """检测单段文本。``enabled`` 缺省读 config。"""
    _ensure_loaded()
    if enabled is None:
        enabled = _cfg("enabled", True)
    if not enabled or not text:
        return ComplianceResult(passed=True, dictionary_count=len(_entries))
    return _build_result(_scan(text, scope), [scope])


def check(
    script: str = "",
    title: str = "",
    extra: Optional[Dict[str, str]] = None,
    enabled: Optional[bool] = None,
) -> ComplianceResult:
    """检测多段文本（文案 + 标题 + 任意附加字段）。返回合并结果。"""
    _ensure_loaded()
    if enabled is None:
        enabled = _cfg("enabled", True)

    fields: Dict[str, str] = {}
    if script:
        fields["script"] = script
    if title:
        fields["title"] = title
    if extra:
        for k, v in extra.items():
            if v:
                fields[k] = v

    if not enabled or not fields:
        return ComplianceResult(passed=True, dictionary_count=len(_entries))

    all_hits: List[ComplianceHit] = []
    for scope, text in fields.items():
        all_hits.extend(_scan(text, scope))
    return _build_result(all_hits, list(fields.keys()))


def is_compliant(text: str, *, scope: str = "text") -> bool:
    """便捷判断：是否存在 block 级命中。"""
    return check_text(text, scope=scope).passed


def mask_hits(text: str, result: ComplianceResult, mask_char: str = "*") -> str:
    """把 block 级命中替换成掩码，便于快速生成『安全版』草稿。warn 级保留。"""
    spans = [
        (h.start, h.end)
        for h in result.hits
        if h.start >= 0 and h.end >= 0 and h.level == HitLevel.BLOCK
    ]
    if not spans:
        return text
    spans.sort(reverse=True)  # 从后往前替换，避免索引偏移
    out = text
    for s, e in spans:
        out = out[:s] + mask_char * (e - s) + out[e:]
    return out


def industries() -> List[str]:
    """已加载词库的行业列表（去重，保序）。"""
    _ensure_loaded()
    seen: List[str] = []
    for e in _entries:
        if e.industry not in seen:
            seen.append(e.industry)
    return seen


def stats() -> Dict[str, int]:
    """每个行业的规则条数（用于 WebUI 展示词库规模）。"""
    _ensure_loaded()
    counts: Dict[str, int] = {}
    for e in _entries:
        counts[e.industry] = counts.get(e.industry, 0) + 1
    return dict(sorted(counts.items()))


# --------------------------------------------------------------------------- #
# 自定义词管理
# --------------------------------------------------------------------------- #
def _custom_path() -> str:
    return _resolve(_cfg("custom_words_file", "storage/forbidden_words/custom.txt"))


def list_custom_words() -> List[str]:
    """列出自定义词原始行（不含注释 / 空行）。"""
    path = _custom_path()
    if not os.path.isfile(path):
        return []
    out: List[str] = []
    with open(path, mode="r", encoding="utf-8") as fp:
        for line in fp:
            s = line.strip()
            if s and not s.startswith("#"):
                out.append(s)
    return out


def add_custom_words(entries: List[str]) -> int:
    """追加自定义词（每行一条，可与词库同格式）。返回实际新增条数。"""
    path = _custom_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    added = 0
    with open(path, mode="a", encoding="utf-8") as fp:
        for e in entries:
            e = (e or "").strip()
            if e:
                fp.write(e + "\n")
                added += 1
    if added:
        reload_dictionaries()
    return added


def remove_custom_word(target: str) -> bool:
    """按「整行」或「触发词（第一字段）」删除自定义词。返回是否删除成功。"""
    path = _custom_path()
    if not os.path.isfile(path):
        return False
    target = target.strip()
    kept: List[str] = []
    removed = False
    with open(path, mode="r", encoding="utf-8") as fp:
        for line in fp:
            head = line.strip().split("|")[0].strip()
            if line.strip() == target or head == target:
                removed = True
                continue
            kept.append(line)
    if removed:
        with open(path, mode="w", encoding="utf-8") as fp:
            fp.writelines(kept)
        reload_dictionaries()
    return removed
