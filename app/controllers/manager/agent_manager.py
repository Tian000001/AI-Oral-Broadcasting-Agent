"""口播智能体批量任务调度与监控（Phase 8）。

增强 ``controllers/manager/``：复用 MPT 现有的 ``TaskManager`` 并发控制
（`base_manager.py`）与 ``sm.state`` 的 Redis/Memory 持久化，提供「批量提交 →
优先级排序 → 实时监控（待处理/处理中/已完成/失败）→ 失败重试 / 人工复审」。

设计要点
--------
- 优先级队列：内存后端用 ``heapq``，Redis 后端用 ``ZSET``（score=priority*1e9+seq），
  保证高优先级任务先出队；同优先级按提交顺序（FIFO）。
- 任务记录统一写入 ``sm.state``，并打标 ``kind="agent"``，与 MPT 普通视频任务隔离、
  可追溯；状态使用 ``app.models.const`` 中扩展的 PENDING/PROCESSING/COMPLETE/
  FAILED/REVIEW/CANCELLED。
- 执行目标（真正的「口播生成」）通过 ``set_agent_handler`` 注入；默认 handler 为
  可离线运行的演示实现（支持合规拦截→人工复审、模拟失败→自动重试）。Phase 9 口播
  流水线就绪后，已在 ``app/asgi.py`` 启动时注册 ``_real_agent_handler``（调
  ``app.services.task.start(agent_mode="koubo")`` 端到端生成视频），调度/监控层无需改动。
"""

import heapq
import itertools
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

import redis
from loguru import logger

from app.config import config
from app.controllers.manager.base_manager import TaskManager, TaskQueueFullError
from app.models import const
from app.services import state as sm
from app.utils import utils


class NeedsManualReview(Exception):
    """执行 handler 抛出此异常，表示任务需要人工复审（如合规拦截）。"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 执行 handler：真正的「口播生成」逻辑。Phase 9 注册真实流水线。
# ---------------------------------------------------------------------------
_DEFAULT_MAX_RETRIES = 2
_DEFAULT_MAX_CONCURRENT = 3
_DEFAULT_MAX_QUEUED = 200


def _demo_handler(spec: Dict[str, Any]) -> Dict[str, Any]:
    """默认演示 handler：可离线运行，便于看板立即可玩、可测试。

    - 若 spec 带 ``script`` 且合规模块可用，先做违禁词检测；命中 block 级则抛
      ``NeedsManualReview``，演示「合规拦截 → 人工复审」闭环。
    - ``simulate_review`` 直接触发人工复审；``simulate_fail`` 触发失败→自动重试。
    - 正常情况返回合成结果摘要。
    """
    if spec.get("script"):
        try:
            from app.services.agent import compliance

            result = compliance.check(
                script=spec.get("script"), title=spec.get("title")
            )
            if getattr(result, "blocked", False):
                raise NeedsManualReview(
                    f"合规拦截：{getattr(result, 'summary', '命中违禁词')}"
                )
        except NeedsManualReview:
            raise
        except Exception as e:  # 合规模块异常不应阻断正常调度
            logger.warning(f"compliance check skipped in demo handler: {e}")

    if spec.get("simulate_review"):
        raise NeedsManualReview(spec.get("review_reason", "演示：需要人工复审"))

    if spec.get("simulate_fail"):
        raise RuntimeError(spec.get("fail_reason", "演示：模拟执行失败"))

    duration = float(spec.get("duration", 0) or 0)
    if duration > 0:
        time.sleep(min(duration, 2))  # 演示用，限制上限避免阻塞

    return {
        "ok": True,
        "topic": spec.get("topic"),
        "channel": spec.get("channel"),
        "persona_id": spec.get("persona_id"),
        "message": "演示任务已完成（未接入真实口播流水线）",
    }


_HANDLER: Callable[[Dict[str, Any]], Dict[str, Any]] = _demo_handler


def set_agent_handler(func: Callable[[Dict[str, Any]], Dict[str, Any]]) -> None:
    """注入真实执行 handler（Phase 9 口播流水线就绪后调用）。"""
    global _HANDLER
    _HANDLER = func


# 本地素材扩展名白名单（视频 + 常见图片，供无脸混剪兜底使用）
_LOCAL_MATERIAL_EXTS = (
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v",
    ".png", ".jpg", ".jpeg", ".bmp", ".webp",
)


def _collect_local_materials() -> List[Dict[str, Any]]:
    """扫描 storage/local_videos 目录，返回 MaterialInfo 清单（url=文件名）。

    仅用于看板批量提交未显式指定素材时的兜底：让「只给主题」的任务也能用本地
    素材出片。素材路径安全性由 ``video.preprocess_video`` 在 local_videos 目录内解析保证。
    """
    try:
        lv = utils.storage_dir("local_videos")
        mats = []
        for fn in sorted(os.listdir(lv)):
            if fn.lower().endswith(_LOCAL_MATERIAL_EXTS):
                mats.append({"provider": "local", "url": fn})
        return mats
    except Exception as e:
        logger.warning(f"collect local materials failed: {e}")
        return []


def _real_agent_handler(spec: Dict[str, Any]) -> Dict[str, Any]:
    """真实口播 handler：用 Phase 9 端到端流水线生成视频（口播模式）。

    行为要点
    --------
    - 由提交 spec 构造 ``VideoParams(agent_mode="koubo")`` 触发端到端流水线
      （脚本→配音→视频合成；数字人未配置时流水线自动回退「无脸混剪」，保证出片）。
    - 用**独立** ``video_task_id`` 运行 ``start()``，避免与调度器自有任务状态机相互覆盖；
      成片路径随 handler 返回值写入口播任务 ``result``，供看板展示与下载。
    - 未产出成片（流水线内部失败）时抛 ``RuntimeError``，交由调度器的重试/失败态处理。
    """
    import uuid

    from app.models.schema import VideoParams
    from app.services.task import start

    topic = (spec.get("topic") or "").strip()
    if not topic:
        raise RuntimeError("任务缺少 topic（创作主题）")

    # 仅透传 VideoParams 支持的字段，避免构造报错
    extra = spec.get("params") or {}
    allowed = set(VideoParams.model_fields.keys())
    vp_kwargs = {k: v for k, v in (extra or {}).items() if k in allowed}

    # 本地素材源：批量提交通常只给主题、不指定素材清单。自动收集 local_videos
    # 目录下的视频/图片作为素材，使看板任务也能直接出片，对齐正常「本地」生成路径。
    if (vp_kwargs.get("video_source") or "").lower() == "local" and not vp_kwargs.get("video_materials"):
        mats = _collect_local_materials()
        if mats:
            vp_kwargs["video_materials"] = mats

    # 看板批量提交通常不带音色；缺省时回落到项目默认音色（config.app.voice_name），
    # 与正常视频生成页行为一致，避免空 voice 触发 TTS 失败。
    vp_kwargs.setdefault(
        "voice_name",
        (config.app.get("voice_name") or "") or "zh-CN-XiaoxiaoNeural-Female",
    )

    vp = VideoParams(
        video_subject=topic,
        agent_mode="koubo",
        persona_id=spec.get("persona_id"),
        video_script=spec.get("script") or "",
        **vp_kwargs,
    )

    video_task_id = uuid.uuid4().hex
    result = start(video_task_id, vp, stop_at="video") or {}
    videos = result.get("videos") or []
    combined = result.get("combined_videos") or []

    if not videos:
        # 流水线内部已将 video_task_id 标记为失败；抛出以触发调度器重试/失败态
        raise RuntimeError(result.get("error") or "视频生成失败，未产出成片")

    return {
        "ok": True,
        "topic": topic,
        "channel": spec.get("channel"),
        "persona_id": spec.get("persona_id"),
        "video_task_id": video_task_id,
        "videos": videos,
        "combined_videos": combined,
        "message": "口播任务已完成，视频已生成",
    }


# ---------------------------------------------------------------------------
# 调度器
# ---------------------------------------------------------------------------
class AgentTaskManager(TaskManager):
    """带优先级的口播批量任务调度器，复用 TaskManager 的并发名额控制。

    子类只需实现 ``create_queue`` / ``enqueue`` / ``dequeue`` / ``is_queue_empty`` /
    ``queue_size`` 以适配不同后端的优先级队列；通用逻辑（提交、状态机、重试、复审、
    看板统计）在此实现。
    """

    def __init__(
        self,
        max_concurrent_tasks: int = _DEFAULT_MAX_CONCURRENT,
        max_queued_tasks: int = _DEFAULT_MAX_QUEUED,
        max_retries: int = _DEFAULT_MAX_RETRIES,
    ):
        self.max_retries = max_retries
        self._seq = itertools.count()
        super().__init__(max_concurrent_tasks, max_queued_tasks=max_queued_tasks)

    # -- 重写 add_task：支持 priority 并构造带优先级的队列项 --
    def add_task(self, func: Callable, *args: Any, priority: int = 0, **kwargs: Any):
        task = {"func": func, "args": args, "kwargs": kwargs, "priority": priority}
        with self.lock:
            if self.current_tasks < self.max_concurrent_tasks:
                logger.info(
                    f"agent add task (run now), current_tasks={self.current_tasks}, "
                    f"priority={priority}"
                )
                self.current_tasks += 1
                try:
                    self.execute_task(func, *args, **kwargs)
                except Exception:
                    self.current_tasks -= 1
                    raise
            else:
                if self.queue_size() >= self.max_queued_tasks:
                    logger.warning(
                        f"agent reject task: queue full ({self.queue_size()}/"
                        f"{self.max_queued_tasks})"
                    )
                    raise TaskQueueFullError(
                        "agent task queue is full, please try again later"
                    )
                logger.info(
                    f"agent enqueue task, priority={priority}, "
                    f"queue_size={self.queue_size()}"
                )
                self.enqueue(task)

    # -- 子类必须实现的队列原语（优先级感知） --
    def enqueue(self, task: Dict):  # pragma: no cover - overridden
        raise NotImplementedError()

    def dequeue(self):  # pragma: no cover - overridden
        raise NotImplementedError()

    # -- 队列中移除指定任务（取消用） --
    def remove_from_queue(self, task_id: str) -> bool:
        return False

    # -- 业务方法 --
    def submit(
        self,
        spec: Dict[str, Any],
        priority: int = 0,
        batch_id: Optional[str] = None,
    ) -> str:
        """提交单个创作任务，返回 task_id。"""
        import uuid

        task_id = spec.get("task_id") or uuid.uuid4().hex
        spec["task_id"] = task_id
        spec["priority"] = priority
        if batch_id:
            spec["batch_id"] = batch_id

        now = _now_iso()
        sm.state.update_task(
            task_id,
            state=const.TASK_STATE_PENDING,
            kind="agent",
            spec=spec,
            priority=priority,
            attempt=0,
            progress=0,
            created_at=now,
            updated_at=now,
            started_at="",
            finished_at="",
            error="",
            review_reason="",
            review_decision="",
        )
        self.add_task(self._execute, task_id=task_id, priority=priority)
        return task_id

    def submit_batch(
        self,
        specs: List[Dict[str, Any]],
        batch_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """批量提交。返回 {batch_id, task_ids, count}。"""
        import uuid

        batch_id = uuid.uuid4().hex
        if batch_name:
            # 批次名仅作展示，挂在首个任务的 batch_name 字段上便于追溯
            pass
        task_ids: List[str] = []
        for spec in specs:
            task_id = self.submit(spec, priority=int(spec.get("priority", 0)), batch_id=batch_id)
            task_ids.append(task_id)
            if batch_name:
                sm.state.patch_task(task_id, batch_name=batch_name)
        return {"batch_id": batch_id, "task_ids": task_ids, "count": len(task_ids)}

    # -- 工作线程入口 --
    def _execute(self, task_id: str) -> None:
        task = sm.state.get_task(task_id)
        if task is None:
            return
        # 已被取消：直接放弃执行
        if task.get("state") == const.TASK_STATE_CANCELLED:
            return

        spec = task.get("spec") or {}
        now = _now_iso()
        sm.state.patch_task(
            task_id,
            state=const.TASK_STATE_PROCESSING,
            progress=5,
            started_at=now,
            updated_at=now,
            error="",
            review_reason="",
        )
        try:
            result = _HANDLER(spec)
            sm.state.patch_task(
                task_id,
                state=const.TASK_STATE_COMPLETE,
                progress=100,
                result=result,
                finished_at=_now_iso(),
                updated_at=_now_iso(),
                error="",
            )
        except NeedsManualReview as e:
            attempt = int(task.get("attempt", 0)) + 1
            sm.state.patch_task(
                task_id,
                state=const.TASK_STATE_REVIEW,
                review_reason=str(e),
                finished_at=_now_iso(),
                updated_at=_now_iso(),
                attempt=attempt,
            )
        except Exception as e:  # 失败：自动重试，耗尽后标记 FAILED
            attempt = int(task.get("attempt", 0)) + 1
            logger.warning(f"agent task {task_id} failed (attempt {attempt}): {e}")
            if attempt <= self.max_retries:
                sm.state.patch_task(
                    task_id,
                    state=const.TASK_STATE_PENDING,
                    attempt=attempt,
                    last_error=str(e),
                    progress=0,
                    updated_at=_now_iso(),
                )
                # 重试时优先级 +1，让其相对新提交任务靠前，加速恢复
                self.add_task(
                    self._execute, task_id=task_id, priority=int(spec.get("priority", 0)) + 1
                )
            else:
                sm.state.patch_task(
                    task_id,
                    state=const.TASK_STATE_FAILED,
                    error=str(e),
                    last_error=str(e),
                    finished_at=_now_iso(),
                    updated_at=_now_iso(),
                    attempt=attempt,
                )

    def retry(self, task_id: str, boost_priority: int = 1) -> bool:
        """手动重试：把任务重新置为待处理并重入队（重置尝试次数）。"""
        task = sm.state.get_task(task_id)
        if task is None:
            return False
        if task.get("state") not in (
            const.TASK_STATE_FAILED,
            const.TASK_STATE_REVIEW,
            const.TASK_STATE_CANCELLED,
        ):
            return False
        spec = task.get("spec") or {}
        priority = int(task.get("priority", 0)) + boost_priority
        spec["priority"] = priority
        now = _now_iso()
        sm.state.patch_task(
            task_id,
            state=const.TASK_STATE_PENDING,
            priority=priority,
            spec=spec,
            attempt=0,
            progress=0,
            error="",
            last_error="",
            review_reason="",
            review_decision="",
            started_at="",
            finished_at="",
            updated_at=now,
        )
        self.add_task(self._execute, task_id=task_id, priority=priority)
        return True

    def resolve_review(self, task_id: str, approve: bool, note: Optional[str] = None) -> bool:
        """人工复审决议：通过→完成；驳回→失败/取消。"""
        task = sm.state.get_task(task_id)
        if task is None:
            return False
        if task.get("state") != const.TASK_STATE_REVIEW:
            return False
        decision = "approved" if approve else "rejected"
        now = _now_iso()
        if approve:
            sm.state.patch_task(
                task_id,
                state=const.TASK_STATE_COMPLETE,
                progress=100,
                review_decision=decision,
                review_note=note or "",
                finished_at=now,
                updated_at=now,
            )
        else:
            sm.state.patch_task(
                task_id,
                state=const.TASK_STATE_CANCELLED,
                review_decision=decision,
                review_note=note or "",
                finished_at=now,
                updated_at=now,
            )
        return True

    def cancel(self, task_id: str) -> bool:
        """取消任务：待处理→从队列移除并标记取消；处理中→标记取消（运行中的线程见标记放弃）。"""
        task = sm.state.get_task(task_id)
        if task is None:
            return False
        state = task.get("state")
        if state in (const.TASK_STATE_COMPLETE, const.TASK_STATE_CANCELLED):
            return False
        if state == const.TASK_STATE_PENDING:
            self.remove_from_queue(task_id)
        sm.state.patch_task(
            task_id,
            state=const.TASK_STATE_CANCELLED,
            finished_at=_now_iso(),
            updated_at=_now_iso(),
            error="用户取消",
        )
        return True

    def delete(self, task_id: str) -> bool:
        task = sm.state.get_task(task_id)
        if task is None:
            return False
        if task.get("state") == const.TASK_STATE_PROCESSING:
            # 运行中不强行删除，避免状态错乱；仅标记取消
            return False
        if task.get("state") == const.TASK_STATE_PENDING:
            self.remove_from_queue(task_id)
        sm.state.delete_task(task_id)
        return True

    def list_tasks(
        self,
        status_filter: Optional[int] = None,
        page: int = 1,
        page_size: int = 50,
        sort_by_priority: bool = True,
    ) -> Dict[str, Any]:
        """列出口播任务（过滤/排序/分页）。"""
        all_tasks, _ = sm.state.get_all_tasks(1, 10000)
        agent_tasks = [t for t in all_tasks if t.get("kind") == "agent"]
        if status_filter is not None:
            agent_tasks = [t for t in agent_tasks if t.get("state") == status_filter]

        if sort_by_priority:
            agent_tasks.sort(
                key=lambda t: (
                    -int(t.get("priority", 0)),
                    t.get("created_at") or "",
                )
            )
        else:
            agent_tasks.sort(key=lambda t: t.get("created_at") or "")

        total = len(agent_tasks)
        start = (page - 1) * page_size
        end = start + page_size
        page_items = agent_tasks[start:end]
        return {
            "tasks": page_items,
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    def dashboard_stats(self) -> Dict[str, int]:
        """看板聚合统计。"""
        all_tasks, _ = sm.state.get_all_tasks(1, 10000)
        stats = {
            "total": 0,
            "pending": 0,
            "processing": 0,
            "complete": 0,
            "failed": 0,
            "review": 0,
            "cancelled": 0,
        }
        for t in all_tasks:
            if t.get("kind") != "agent":
                continue
            stats["total"] += 1
            s = t.get("state")
            if s == const.TASK_STATE_PENDING:
                stats["pending"] += 1
            elif s == const.TASK_STATE_PROCESSING:
                stats["processing"] += 1
            elif s == const.TASK_STATE_COMPLETE:
                stats["complete"] += 1
            elif s == const.TASK_STATE_FAILED:
                stats["failed"] += 1
            elif s == const.TASK_STATE_REVIEW:
                stats["review"] += 1
            elif s == const.TASK_STATE_CANCELLED:
                stats["cancelled"] += 1
        return stats


class AgentMemoryManager(AgentTaskManager):
    """内存优先级队列（默认、无 Redis 时）。"""

    def create_queue(self):
        return []

    def enqueue(self, task: Dict):
        priority = int(task.get("priority", 0))
        task_id = task.get("kwargs", {}).get("task_id")
        heapq.heappush(self.queue, (-priority, next(self._seq), task_id))

    def dequeue(self):
        if not self.queue:
            return None
        _, _, task_id = heapq.heappop(self.queue)
        return {"func": self._execute, "args": (task_id,), "kwargs": {}}

    def is_queue_empty(self):
        return len(self.queue) == 0

    def queue_size(self):
        return len(self.queue)

    def remove_from_queue(self, task_id: str) -> bool:
        before = len(self.queue)
        self.queue = [e for e in self.queue if e[2] != task_id]
        heapq.heapify(self.queue)
        return len(self.queue) != before


class AgentRedisManager(AgentTaskManager):
    """Redis 优先级队列（启用 Redis 时，跨进程共享）。"""

    def __init__(
        self,
        max_concurrent_tasks: int,
        redis_url: str,
        max_queued_tasks: int = _DEFAULT_MAX_QUEUED,
        max_retries: int = _DEFAULT_MAX_RETRIES,
    ):
        self.redis_client = redis.Redis.from_url(redis_url)
        super().__init__(max_concurrent_tasks, max_queued_tasks=max_queued_tasks, max_retries=max_retries)

    def create_queue(self):
        return "agent_task_queue"

    def enqueue(self, task: Dict):
        priority = int(task.get("priority", 0))
        task_id = task.get("kwargs", {}).get("task_id")
        score = priority * 1_000_000_000 + next(self._seq)
        self.redis_client.zadd(self.queue, {task_id: score})

    def dequeue(self):
        result = self.redis_client.zpopmax(self.queue, 1)
        if not result:
            return None
        task_id = result[0][0]
        if isinstance(task_id, bytes):
            task_id = task_id.decode("utf-8")
        return {"func": self._execute, "args": (task_id,), "kwargs": {}}

    def is_queue_empty(self):
        return self.redis_client.zcard(self.queue) == 0

    def queue_size(self):
        return self.redis_client.zcard(self.queue)

    def remove_from_queue(self, task_id: str) -> bool:
        removed = self.redis_client.zrem(self.queue, task_id)
        return bool(removed)


# ---------------------------------------------------------------------------
# 单例工厂
# ---------------------------------------------------------------------------
_manager: Optional[AgentTaskManager] = None
_manager_lock = threading.Lock()


def get_agent_manager() -> AgentTaskManager:
    """返回进程内单例调度器；按配置选择 Redis / 内存后端。"""
    global _manager
    if _manager is not None:
        return _manager
    with _manager_lock:
        if _manager is not None:
            return _manager

        enable_redis = config.app.get("enable_redis", False)
        max_concurrent = int(config.app.get("agent_max_concurrent_tasks", _DEFAULT_MAX_CONCURRENT))
        max_queued = int(config.app.get("agent_max_queued_tasks", _DEFAULT_MAX_QUEUED))
        max_retries = int(config.app.get("agent_max_retries", _DEFAULT_MAX_RETRIES))

        if enable_redis:
            redis_password = config.app.get("redis_password", None)
            redis_host = config.app.get("redis_host", "localhost")
            redis_port = config.app.get("redis_port", 6379)
            redis_db = config.app.get("redis_db", 0)
            redis_url = f"redis://:{redis_password}@{redis_host}:{redis_port}/{redis_db}"
            _manager = AgentRedisManager(
                max_concurrent_tasks=max_concurrent,
                redis_url=redis_url,
                max_queued_tasks=max_queued,
                max_retries=max_retries,
            )
            logger.info("agent scheduler: using Redis backend")
        else:
            _manager = AgentMemoryManager(
                max_concurrent_tasks=max_concurrent,
                max_queued_tasks=max_queued,
                max_retries=max_retries,
            )
            logger.info("agent scheduler: using in-memory backend")
        return _manager


def reset_agent_manager() -> None:
    """测试/重置用：清空单例。"""
    global _manager
    with _manager_lock:
        _manager = None
