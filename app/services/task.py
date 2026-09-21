import math
import os
import re
import socket
import threading
import time
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from functools import partial
from os import path
from uuid import uuid4

from loguru import logger

from app.config import config
from app.models import const
from app.models.schema import VideoConcatMode, VideoParams
from app.services import bgm as bgm_service
from app.services import (
    elevenlabs_music,
    llm,
    material,
    sonilo,
    subtitle,
    task_artifacts,
    twelvelabs,
    video,
    voice,
)
from app.services import upload_post
from app.services import state as sm
from app.utils import file_security, utils


# 发布请求最长可等待数分钟，不能继续占用视频生成任务的并发名额。
# 固定大小的线程池将发布吞吐限制在可控范围内，同时让视频产物生成后
# 立即进入完成状态。
_cross_post_executor = ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="mpt-cross-post",
)
_cross_post_max_pending_tasks = max(
    1,
    int(config.app.get("upload_post_max_pending_tasks", 10)),
)
_cross_post_slots = threading.BoundedSemaphore(_cross_post_max_pending_tasks)
_cross_post_registry_lock = threading.RLock()
_cross_post_futures: dict[str, Future] = {}
_cross_post_process_owner = f"{socket.gethostname()}:{os.getpid()}:{uuid4().hex}"

# 视频生成任务在当前进程内的运行登记。生成线程是裸 threading.Thread，重启
# 后会丢失，但任务状态仍停留在 PROCESSING，成为删不掉的「僵尸任务」。登记
# 表让我们能区分「本进程正在跑」与「重启遗留的孤儿」，前者继续视为忙碌、
# 后者允许删除并在启动时收敛为失败。
_generation_registry_lock = threading.RLock()
_active_generations: dict[str, bool] = {}

# 用户主动取消（生成中停止）的请求登记。生成任务是协作式取消：置位标志后，
# 流水线在检查点轮询该标志，命中即抛出 _TaskCancelled 并收敛为「已取消」。
_cancellation_lock = threading.RLock()
_cancel_requests: dict[str, bool] = {}


class _TaskCancelled(Exception):
    """生成任务被用户取消时由检查点抛出，由 ``start()`` 捕获并收敛为终态。"""


def request_cancel(task_id: str) -> None:
    """记录用户对某任务的取消请求。"""
    with _cancellation_lock:
        _cancel_requests[task_id] = True


def is_cancelled(task_id: str | None) -> bool:
    """判断某任务是否已被请求取消。"""
    if not task_id:
        return False
    with _cancellation_lock:
        return _cancel_requests.get(task_id, False)


def _clear_cancel(task_id: str) -> None:
    """任务结束（成功/失败/取消）后清理取消标志，避免影响后续同名任务。"""
    with _cancellation_lock:
        _cancel_requests.pop(task_id, None)


def _check_cancel(task_id: str) -> None:
    """在检查点轮询取消标志；命中则抛出 ``_TaskCancelled``。"""
    if is_cancelled(task_id):
        raise _TaskCancelled(task_id)
_ACTIVE_CROSS_POST_STATES = {
    const.CROSS_POST_STATE_PENDING,
    const.CROSS_POST_STATE_PROCESSING,
}
_CROSS_POST_STATE_WRITE_ATTEMPTS = 3
_CROSS_POST_STATE_RETRY_DELAY_SECONDS = 0.1
_INTERRUPTED_CROSS_POST_ERROR = (
    "cross-posting was interrupted before the process completed"
)
# 视频配乐服务只需实现 ``is_enabled`` 和 ``generate_bgm``。供应商差异集中在
# 文件扩展名、领域异常和 WebUI 警告代码；任务编排、0 音量短路及失败降级
# 全部复用同一路径，避免后续新增供应商时维护多份相似流程。
_VIDEO_MUSIC_PROVIDERS = {
    "sonilo": {
        "service": sonilo,
        "error_type": sonilo.SoniloError,
        "suffix": ".m4a",
        "warning_code": "sonilo_bgm_failed",
        "display_name": "Sonilo",
    },
    "elevenlabs": {
        "service": elevenlabs_music,
        "error_type": elevenlabs_music.ElevenLabsMusicError,
        "suffix": ".mp3",
        "warning_code": "elevenlabs_bgm_failed",
        "display_name": "ElevenLabs",
    },
}


def _get_video_music_prompt(params: VideoParams) -> str:
    """
    读取当前视频配乐供应商实际使用的提示词。

    新任务统一使用供应商无关字段；旧 Sonilo CLI 参数和历史任务仍可能只有
    ``sonilo_bgm_prompt``，因此仅在 Sonilo 通用字段为空时读取旧字段。
    """
    prompt = str(params.video_music_prompt or "").strip()
    if params.bgm_type == "sonilo" and not prompt:
        prompt = str(params.sonilo_bgm_prompt or "").strip()
    return prompt


def _register_generation(task_id: str) -> None:
    """登记当前进程正在执行的视频生成任务。"""
    with _generation_registry_lock:
        _active_generations[task_id] = True


def _unregister_generation(task_id: str) -> None:
    """生成线程结束时移除登记，无论成功、失败还是被取消。"""
    with _generation_registry_lock:
        _active_generations.pop(task_id, None)


def _is_generation_active_in_process(task_id: str | None) -> bool:
    """判断当前进程是否仍持有未结束的视频生成任务。"""
    if not task_id:
        return False
    with _generation_registry_lock:
        return _active_generations.get(task_id, False)


def is_task_busy(task: dict | None) -> bool:
    """判断任务是否仍在生成或发布，供所有删除入口复用。"""
    if not task:
        return False

    state = task.get("state")
    try:
        state = int(state)
    except (TypeError, ValueError):
        pass

    # 视频生成和跨平台发布都可能继续读取任务目录。统一视为忙碌状态，
    # 可以避免 API 与 WebUI 分别维护规则后出现一个允许删除、另一个禁止
    # 删除的不一致行为。
    #
    # 但生成线程是裸 threading.Thread，进程重启后会丢失却仍显示 PROCESSING，
    # 造成「僵尸任务」永久无法删除。因此 PROCESSING 必须进一步确认本进程是否
    # 真的在跑：孤儿任务（重启遗留、不在登记表中）不再视为忙碌，允许删除。
    generation_active = state == const.TASK_STATE_PROCESSING and _is_generation_active_in_process(
        task.get("task_id")
    )
    return (
        generation_active
        or task.get("cross_post_state") in _ACTIVE_CROSS_POST_STATES
    )


def _register_cross_post_future(task_id: str, future: Future) -> None:
    """登记当前进程持有的发布 Future，供启动恢复和测试判断真实运行状态。"""
    with _cross_post_registry_lock:
        _cross_post_futures[task_id] = future


def _unregister_cross_post_future(task_id: str, future: Future | None = None) -> None:
    """仅移除匹配的 Future，避免旧回调误删同任务后续注册的新工作。"""
    with _cross_post_registry_lock:
        current = _cross_post_futures.get(task_id)
        if current is None or (future is not None and current is not future):
            return
        _cross_post_futures.pop(task_id, None)


def _is_cross_post_active_in_process(task_id: str) -> bool:
    """判断当前进程是否仍持有未结束的发布任务。"""
    with _cross_post_registry_lock:
        future = _cross_post_futures.get(task_id)
        return future is not None and not future.done()


def _is_windows_process_alive(process_id: int) -> bool:
    """通过只读 Win32 API 判断进程状态，避免用 os.kill 误终止进程。"""
    import ctypes

    process_query_limited_information = 0x1000
    still_active = 259
    error_access_denied = 5
    error_invalid_parameter = 87
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    # ctypes 默认把未声明的返回值当作 32 位 int。Windows 64 位进程句柄可能
    # 因此被截断，必须显式声明 Win32 函数签名后再调用。
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetExitCodeProcess.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_ulong),
    ]
    kernel32.GetExitCodeProcess.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    handle = kernel32.OpenProcess(
        process_query_limited_information,
        False,
        process_id,
    )
    if not handle:
        error_code = ctypes.get_last_error()
        if error_code == error_invalid_parameter:
            return False
        if error_code == error_access_denied:
            # 进程存在但当前用户无查询权限时，必须保守地视为存活，避免错误
            # 回收其它账户正在执行的发布任务。
            return True
        logger.warning(
            "failed to open cross-post owner process on Windows, "
            f"process_id: {process_id}, error_code: {error_code}"
        )
        return True

    try:
        exit_code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            error_code = ctypes.get_last_error()
            logger.warning(
                "failed to read cross-post owner process state on Windows, "
                f"process_id: {process_id}, error_code: {error_code}"
            )
            return True
        return exit_code.value == still_active
    finally:
        kernel32.CloseHandle(handle)


def _is_cross_post_owner_alive(owner: str | None) -> bool:
    """判断持久化发布任务的本机进程是否仍存在。"""
    if not owner:
        return False

    try:
        hostname, process_id_text, _ = owner.split(":", 2)
        process_id = int(process_id_text)
    except (TypeError, ValueError):
        logger.warning(f"invalid cross-post owner metadata: {owner}")
        return False

    # 无法可靠探测其它主机上的进程。共享 Redis 的多主机部署中必须保守地
    # 视为仍在运行，避免当前节点误删另一节点正在读取的视频文件。
    if hostname != socket.gethostname():
        return True

    # 当前进程内是否仍有真实发布工作，已经由 Future 注册表准确判断。运行到
    # 这里说明注册表中没有对应 Future，即使 owner 与当前进程完全一致，也应
    # 视为已中断；这可以覆盖终态写入持续失败、Future 已结束的场景。
    if process_id == os.getpid():
        return False

    # Windows 的 os.kill(pid, 0) 与 POSIX 语义不同，可能直接终止目标进程。
    # 使用只申请查询权限的 Win32 API，不向目标进程发送任何信号。
    if os.name == "nt":
        return _is_windows_process_alive(process_id)

    try:
        os.kill(process_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError as exc:
        logger.warning(
            f"failed to inspect cross-post owner process, owner: {owner}, error: {exc}"
        )
        return True
    return True


def _mark_task_failed(task_id: str, stage: str, error: str) -> dict:
    """记录结构化失败信息，并保留任务失败前已经到达的进度。"""
    existing_task = None
    try:
        existing_task = sm.state.get_task(task_id)
    except Exception as exc:
        logger.warning(f"failed to read task state before failure update: {exc}")

    # 具体服务函数通常比编排层拥有更准确的错误原因。后续的空结果检查
    # 不能再用通用文案覆盖它，否则 API 调用方仍然只能看到模糊信息。
    if (
        existing_task
        and existing_task.get("state") == const.TASK_STATE_FAILED
        and existing_task.get("error")
    ):
        return existing_task

    message = str(error or "unknown task error").strip()
    progress = int((existing_task or {}).get("progress", 0) or 0)
    logger.error(
        f"task failed, task_id: {task_id}, stage: {stage}, error: {message}"
    )
    failure = {
        "task_id": task_id,
        "state": const.TASK_STATE_FAILED,
        "progress": progress,
        "failed_stage": stage,
        "error": message,
    }
    sm.state.update_task(
        task_id,
        state=failure["state"],
        progress=failure["progress"],
        failed_stage=failure["failed_stage"],
        error=failure["error"],
    )
    return failure


def _mark_task_cancelled(task_id: str, stage: str) -> dict:
    """把任务收敛为「已取消」，并保留取消前已经到达的进度。"""
    existing_task = None
    try:
        existing_task = sm.state.get_task(task_id)
    except Exception as exc:
        logger.warning(f"failed to read task state before cancel update: {exc}")

    # 已经是终态（完成/失败/取消）时不要覆盖其原有结论。
    if existing_task and int(existing_task.get("state", 0) or 0) in (
        const.TASK_STATE_COMPLETE,
        const.TASK_STATE_FAILED,
        const.TASK_STATE_CANCELLED,
        const.TASK_STATE_REVIEW,
    ):
        _clear_cancel(task_id)
        return existing_task

    progress = int((existing_task or {}).get("progress", 0) or 0)
    logger.info(
        f"task cancelled, task_id: {task_id}, stage: {stage}, progress: {progress}"
    )
    sm.state.update_task(
        task_id,
        state=const.TASK_STATE_CANCELLED,
        progress=progress,
        cancelled_stage=stage,
        error="任务已被用户取消",
    )
    _clear_cancel(task_id)
    return {
        "task_id": task_id,
        "state": const.TASK_STATE_CANCELLED,
        "progress": progress,
        "cancelled_stage": stage,
    }


def generate_script(task_id, params):
    logger.info("\n\n## generating video script")
    video_script = params.video_script.strip()
    if not video_script:
        video_script = llm.generate_script(
            video_subject=params.video_subject,
            language=params.video_language,
            paragraph_number=params.paragraph_number,
            video_script_prompt=params.video_script_prompt,
            custom_system_prompt=params.custom_system_prompt,
        )
    else:
        logger.debug(f"video script: \n{video_script}")

    if not video_script:
        _mark_task_failed(task_id, "script", "failed to generate video script")
        return None

    return video_script


def generate_terms(task_id, params, video_script):
    logger.info("\n\n## generating video terms")
    video_terms = params.video_terms
    if not video_terms:
        # 开启素材按文案顺序匹配后，关键词本身也必须按脚本叙事顺序生成；
        # 否则后续即使顺序下载和顺序拼接，也只能复用一组全局主题词，
        # 无法改善“后面内容的画面提前出现”的问题。
        video_terms = llm.generate_terms(
            video_subject=params.video_subject,
            video_script=video_script,
            amount=8 if params.match_materials_to_script else 5,
            match_script_order=params.match_materials_to_script,
        )
    else:
        if isinstance(video_terms, str):
            video_terms = [term.strip() for term in re.split(r"[,，]", video_terms)]
        elif isinstance(video_terms, list):
            video_terms = [term.strip() for term in video_terms]
        else:
            raise ValueError("video_terms must be a string or a list of strings.")

        logger.debug(f"video terms: {utils.to_json(video_terms)}")

    if not video_terms:
        _mark_task_failed(
            task_id,
            "terms",
            "failed to generate video search terms",
        )
        return None

    # 可选的 TwelveLabs Marengo 语义重排：未启用时返回原顺序，无任何副作用。
    # 顺序匹配模式下关键词顺序本身就是脚本叙事顺序，必须保持原样，故跳过。
    if not params.match_materials_to_script:
        video_terms = twelvelabs.rerank_terms_by_subject(
            video_subject=params.video_subject,
            search_terms=video_terms,
        )

    return video_terms


def save_script_data(task_id, video_script, video_terms, params):
    script_data = {
        "script": video_script,
        "search_terms": video_terms,
        "params": params,
    }
    task_artifacts.write_script_data(task_id, script_data)


def resolve_custom_audio_file(task_id: str, custom_audio_file: str | None) -> str:
    requested_file = (custom_audio_file or "").strip()
    if not requested_file:
        return ""

    task_dir = utils.task_dir(task_id)
    try:
        return file_security.resolve_path_within_directory(
            task_dir,
            requested_file,
        )
    except ValueError as exc:
        task_dir_error = exc

    server_audio_file = path.realpath(
        requested_file
        if path.isabs(requested_file)
        else path.join(utils.root_dir(), requested_file)
    )
    if not path.isabs(requested_file):
        project_root = path.realpath(utils.root_dir())
        try:
            if path.commonpath([project_root, server_audio_file]) != project_root:
                raise ValueError(
                    "relative custom audio paths must stay within the project directory"
                )
        except ValueError as exc:
            raise ValueError(
                "custom audio file must be task-local or an existing server-side file"
            ) from exc

    if not path.isfile(server_audio_file):
        raise ValueError(
            "custom audio file does not exist or is not a file"
        ) from task_dir_error

    return server_audio_file


def _resolve_reusable_voice_preview(
    task_id: str,
    params,
    video_script: str,
    voice_preview: dict | None,
) -> tuple[str, float, object] | None:
    """
    校验并解析 WebUI 提交的完整试听缓存。

    该载荷不是公开 API 参数，只能来自当前进程的 WebUI。即便如此，后台任务
    仍重新核对文案和全部配音参数，并限制音频位于当前任务目录；任何不一致都
    回退普通 TTS，不让过期试听污染正式成片。
    """
    if not voice_preview:
        return None

    expected_values = {
        "script": str(video_script or "").strip(),
        "voice_name": params.voice_name,
        "voice_rate": float(params.voice_rate),
        "voice_volume": float(params.voice_volume),
    }
    if not math.isclose(float(params.voice_volume), 1.0) or any(
        voice_preview.get(key) != value for key, value in expected_values.items()
    ):
        logger.info(
            f"skip stale voice preview cache, task_id: {task_id}, "
            "reason: voice parameters changed"
        )
        return None

    preview_file = path.realpath(str(voice_preview.get("audio_file") or ""))
    task_root = path.realpath(utils.task_dir(task_id))
    try:
        preview_is_task_local = path.commonpath([task_root, preview_file]) == task_root
    except ValueError:
        preview_is_task_local = False

    duration = voice_preview.get("duration")
    sub_maker = voice_preview.get("sub_maker")
    if (
        not preview_is_task_local
        or not path.isfile(preview_file)
        or not isinstance(duration, (int, float))
        or not math.isfinite(duration)
        or duration <= 0
        or sub_maker is None
    ):
        logger.warning(
            f"skip invalid voice preview cache, task_id: {task_id}, "
            f"audio_file: {preview_file or '<empty>'}"
        )
        return None

    logger.info(
        f"using full voice preview audio, task_id: {task_id}, duration: {duration:.2f}s"
    )
    return preview_file, math.ceil(duration), sub_maker


def generate_audio(task_id, params, video_script, voice_preview=None):
    """
    Generate audio for the video script.
    If a custom audio file is provided, it will be used directly.
    There will be no subtitle maker object returned in this case.
    Otherwise, TTS will be used to generate the audio.
    Returns:
        - audio_file: path to the generated or provided audio file
        - audio_duration: duration of the audio in seconds
        - sub_maker: subtitle maker object if TTS is used, None otherwise
    """
    logger.info("\n\n## generating audio")
    # /audio 和 /subtitle 请求模型不包含 custom_audio_file，
    # 这里统一做兼容读取，避免直调接口时抛属性错误。
    requested_custom_audio_file = getattr(params, "custom_audio_file", None)
    try:
        custom_audio_file = resolve_custom_audio_file(
            task_id, requested_custom_audio_file
        )
    except ValueError as exc:
        _mark_task_failed(
            task_id,
            "audio",
            f"invalid custom audio file: {exc}",
        )
        return None, None, None

    if not custom_audio_file:
        reusable_preview = _resolve_reusable_voice_preview(
            task_id,
            params,
            video_script,
            voice_preview,
        )
        if reusable_preview:
            return reusable_preview

        logger.info("no custom audio file provided, using TTS to generate audio.")
        audio_file = path.join(utils.task_dir(task_id), "audio.mp3")
        sub_maker = voice.tts(
            text=video_script,
            voice_name=voice.parse_voice_name(params.voice_name),
            voice_rate=params.voice_rate,
            voice_file=audio_file,
        )
        if sub_maker is None:
            _mark_task_failed(
                task_id,
                "audio",
                "failed to synthesize audio; verify the selected voice and TTS connectivity",
            )
            return None, None, None
        audio_duration = math.ceil(voice.get_audio_duration(sub_maker))
        if audio_duration == 0:
            _mark_task_failed(task_id, "audio", "generated audio duration is zero")
            return None, None, None
        return audio_file, audio_duration, sub_maker
    else:
        logger.info(f"using custom audio file: {custom_audio_file}")
        audio_duration = voice.get_audio_duration(custom_audio_file)
        if audio_duration == 0:
            _mark_task_failed(
                task_id,
                "audio",
                "custom audio duration is zero",
            )
            return None, None, None
        return custom_audio_file, audio_duration, None

def generate_subtitle(
    task_id,
    params,
    video_script,
    sub_maker,
    audio_file,
    audio_duration_seconds: float = 0.0,
):
    '''
    Generate subtitle for the video script.
    If subtitle generation is disabled or no subtitle maker is provided, it will return an empty string.
    Otherwise, it will generate the subtitle using the specified provider.
    Returns:
        - subtitle_path: path to the generated subtitle file
    '''
    logger.info("\n\n## generating subtitle")
    if not params.subtitle_enabled:
        return ""

    subtitle_path = path.join(utils.task_dir(task_id), "subtitle.srt")
    subtitle_provider = config.app.get("subtitle_provider", "edge").strip().lower()
    logger.info(f"\n\n## generating subtitle, provider: {subtitle_provider}")

    if not subtitle_provider:
        logger.info("subtitle provider is empty, skip subtitle generation")
        return ""

    if sub_maker is None and subtitle_provider != "whisper":
        # 自定义音频不会经过 TTS，因此没有 Edge/Azure 等 TTS 返回的
        # sub_maker 时间轴。只有 Whisper 可以直接从音频文件转写字幕；
        # 其他字幕提供方继续保持原有行为，避免生成错误的空时间轴。
        logger.warning(
            "subtitle maker is missing, skip subtitle generation for provider: "
            f"{subtitle_provider}"
        )
        return ""

    if subtitle_provider == "edge":
        voice.create_subtitle(
            text=video_script,
            sub_maker=sub_maker,
            subtitle_file=subtitle_path,
            audio_duration_seconds=audio_duration_seconds,
        )
        if not os.path.exists(subtitle_path):
            # Edge 字幕偶尔会因为时间轴与文案无法匹配而没有产出文件。这里不能
            # 自动切换到 Whisper，否则首次失败会在用户不知情的情况下下载数 GB
            # 的模型。只有显式配置 Whisper 时才允许加载模型，Edge 失败则保留
            # 无字幕视频并记录原因，避免意外的网络和磁盘开销。
            logger.warning(
                "edge subtitle generation did not produce a subtitle file; "
                "skip subtitles without falling back to whisper"
            )
            return ""

    if subtitle_provider == "whisper":
        subtitle.create(audio_file=audio_file, subtitle_file=subtitle_path)
        logger.info("\n\n## correcting subtitle")
        subtitle.correct(subtitle_file=subtitle_path, video_script=video_script)

    # 校验字幕文件可解析。这里必须用 video._parse_srt（基于时间轴行的鲁棒
    # 解析器），不能用 subtitle.file_to_subtitles —— 后者对格式挑剔（要求
    # 严格逗号时间戳、块间空行），一旦解析失败就返回空，会让本已正确生成的
    # subtitle.srt 被当成无效而返回空路径，最终 video.generate_video 收到空
    # subtitle_path 直接跳过字幕合成，表现为「无字幕」。只要文件存在且能解析
    # 出至少一条，就信任它并返回路径。
    if not os.path.exists(subtitle_path):
        logger.warning(f"subtitle file was not created: {subtitle_path}")
        return ""

    parsed = video._parse_srt(subtitle_path)
    if not parsed:
        logger.warning(
            f"subtitle file parsed to 0 items, but keep path anyway: {subtitle_path}"
        )
        # 不再因解析器挑剔而丢弃字幕文件。video.generate_video 内部会再次用
        # _parse_srt 解析；若真为 0 条它会跳过合成并记 warning。保留路径可让
        # 调试时仍能看到磁盘上的 srt 文件。
    else:
        logger.info(f"subtitle ok: {len(parsed)} items, {subtitle_path}")

    return subtitle_path


def get_video_materials(task_id, params, video_terms, audio_duration):
    if params.video_source == "local":
        logger.info("\n\n## preprocess local materials")
        materials = video.preprocess_video(
            materials=params.video_materials, clip_duration=params.video_clip_duration
        )
        if not materials:
            _mark_task_failed(
                task_id,
                "materials",
                "no valid local video materials were found",
            )
            return None
        return [material_info.url for material_info in materials]
    else:
        logger.info(f"\n\n## downloading videos from {params.video_source}")
        # 顺序匹配模式只在用户显式开启时生效。这里强制素材下载按关键词顺序
        # 轮询，避免某个早期关键词下载太多素材，把后续脚本主题挤出最终时间线。
        downloaded_videos = material.download_videos(
            task_id=task_id,
            search_terms=video_terms,
            source=params.video_source,
            video_aspect=params.video_aspect,
            video_concat_mode=(
                VideoConcatMode.sequential
                if params.match_materials_to_script
                else params.video_concat_mode
            ),
            audio_duration=audio_duration * params.video_count,
            max_clip_duration=params.video_clip_duration,
            match_script_order=params.match_materials_to_script,
        )
        if not downloaded_videos:
            _mark_task_failed(
                task_id,
                "materials",
                f"failed to download video materials from {params.video_source}",
            )
            return None
        return downloaded_videos


def generate_final_videos(
    task_id, params, downloaded_videos, audio_file, subtitle_path, audio_duration
):
    final_video_paths = []
    combined_video_paths = []
    warnings = []
    video_music_provider = _VIDEO_MUSIC_PROVIDERS.get(params.bgm_type)
    video_music_requested = (
        video_music_provider is not None
        and bgm_service.should_use_bgm(params.bgm_type, params.bgm_volume)
    )
    # 多视频生成默认会打散素材以增加差异；但“按文案顺序匹配素材”追求的是
    # 时间线稳定性和可解释性，所以开启后所有输出都使用顺序拼接。
    if params.match_materials_to_script:
        video_concat_mode = VideoConcatMode.sequential
    elif params.video_count == 1:
        video_concat_mode = params.video_concat_mode
    else:
        video_concat_mode = VideoConcatMode.random
    video_transition_mode = params.video_transition_mode

    _progress = 50
    for i in range(params.video_count):
        index = i + 1
        combined_video_path = path.join(
            utils.task_dir(task_id), f"combined-{index}.mp4"
        )
        logger.info(f"\n\n## combining video: {index} => {combined_video_path}")
        _fv_t0 = time.time()
        video.combine_videos(
            combined_video_path=combined_video_path,
            video_paths=downloaded_videos,
            audio_file=audio_file,
            video_aspect=params.video_aspect,
            video_concat_mode=video_concat_mode,
            video_transition_mode=video_transition_mode,
            max_clip_duration=params.video_clip_duration,
            threads=params.n_threads,
            clip_speed=params.video_clip_speed,
        )
        logger.info(
            f"[{task_id}] index {index} combine (ffmpeg concat) took "
            f"{time.time() - _fv_t0:.2f}s"
        )

        _progress += 50 / params.video_count / 2
        sm.state.update_task(task_id, progress=_progress)

        final_video_path = path.join(utils.task_dir(task_id), f"final-{index}.mp4")

        # 视频配乐模式先明确禁用默认 BGM 解析，避免旧任务残留的 bgm_file 被
        # 误用。只有音量大于 0 才生成代理并调用付费 API；0 音量统一跳过。
        bgm_file_override = "" if video_music_provider else None
        if video_music_requested:
            service = video_music_provider["service"]
            display_name = video_music_provider["display_name"]
            warning_code = video_music_provider["warning_code"]
            generated_bgm_path = path.join(
                utils.task_dir(task_id),
                (f"{params.bgm_type}-bgm-{index}{video_music_provider['suffix']}"),
            )
            try:
                service.generate_bgm(
                    video_path=combined_video_path,
                    output_path=generated_bgm_path,
                    video_duration=audio_duration,
                    prompt=_get_video_music_prompt(params),
                )
                bgm_file_override = generated_bgm_path
            except video_music_provider["error_type"] as exc:
                # 视频、旁白和字幕都已生成时，第三方配乐临时失败不应浪费整条
                # 任务。当前视频明确禁用 BGM，并把降级结果返回 WebUI 提醒用户。
                logger.warning(
                    f"{display_name} BGM generation failed: task_id={task_id}, "
                    f"video_index={index}, error={exc}"
                )
                bgm_file_override = ""
                warnings.append({"code": warning_code, "video_index": index})

        logger.info(f"\n\n## generating video: {index} => {final_video_path}")
        _fv_t1 = time.time()
        bgm_mix_succeeded = video.generate_video(
            video_path=combined_video_path,
            audio_path=audio_file,
            subtitle_path=subtitle_path,
            output_file=final_video_path,
            params=params,
            bgm_file_override=bgm_file_override,
        )
        logger.info(
            f"[{task_id}] index {index} moviepy render took "
            f"{time.time() - _fv_t1:.2f}s"
        )
        if (
            video_music_provider is not None
            and bgm_file_override
            and not bgm_mix_succeeded
        ):
            # 第三方已成功返回并通过 FFmpeg 校验，但 MoviePy 最终混音仍可能
            # 因运行环境失败。视频服务会保留无 BGM 成片；API 生成失败时
            # override 为空，因此不会重复追加警告。
            warnings.append(
                {
                    "code": video_music_provider["warning_code"],
                    "video_index": index,
                }
            )

        _progress += 50 / params.video_count / 2
        sm.state.update_task(task_id, progress=_progress)

        final_video_paths.append(final_video_path)
        combined_video_paths.append(combined_video_path)

    return final_video_paths, combined_video_paths, warnings


def _patch_cross_post_state(task_id: str, **kwargs) -> bool | None:
    """安全更新发布字段；短暂状态后端故障时有限重试。"""
    for attempt in range(1, _CROSS_POST_STATE_WRITE_ATTEMPTS + 1):
        try:
            return sm.state.patch_task(task_id, **kwargs)
        except Exception as exc:
            # Redis 短暂断连不应让任务永久停留在 pending/processing。发布状态
            # 写入频率很低，这里使用固定次数和短等待即可覆盖瞬时故障，同时
            # 避免后台线程无限阻塞。最后一次失败保留完整堆栈便于定位。
            if attempt >= _CROSS_POST_STATE_WRITE_ATTEMPTS:
                logger.exception(
                    f"failed to update cross-post state after retries, "
                    f"task_id: {task_id}, fields: {', '.join(kwargs)}, "
                    f"attempts: {attempt}, error: {exc}"
                )
                return None

            logger.warning(
                f"retry cross-post state update, task_id: {task_id}, "
                f"fields: {', '.join(kwargs)}, attempt: {attempt}, error: {exc}"
            )
            time.sleep(_CROSS_POST_STATE_RETRY_DELAY_SECONDS)

    return None


def _record_cross_post_failure(
    task_id: str,
    error: Exception,
    results: list[dict] | None = None,
) -> None:
    """尽最大努力保存发布失败；状态后端不可用时由日志保留诊断信息。"""
    updated = _patch_cross_post_state(
        task_id,
        cross_post_state=const.CROSS_POST_STATE_FAILED,
        cross_post_results=results or None,
        cross_post_error=str(error),
        cross_post_owner=None,
    )
    if updated is False:
        logger.warning(f"discard cross-post failure for missing task: {task_id}")


def _ensure_cross_post_terminal_state(task_id: str) -> None:
    """Future 结束后把仍处于活动态的任务收敛为失败。"""
    try:
        task = sm.state.get_task(task_id)
    except Exception as exc:
        # 此处已经是 Future 的最终回调，没有后续同步调用方可以处理异常。
        # 状态后端恢复后，下一次进程启动仍会通过恢复逻辑处理遗留状态。
        logger.exception(
            f"failed to verify final cross-post state, task_id: {task_id}, error: {exc}"
        )
        return

    if not task or task.get("cross_post_state") not in _ACTIVE_CROSS_POST_STATES:
        return

    logger.warning(
        f"cross-post worker ended without terminal state, task_id: {task_id}, "
        f"state: {task.get('cross_post_state')}"
    )
    _record_cross_post_failure(
        task_id,
        RuntimeError("cross-post worker ended without persisting a terminal state"),
        task.get("cross_post_results"),
    )


def recover_interrupted_cross_posts(page_size: int = 100) -> int | None:
    """
    将进程重启后无法恢复的发布任务标记为失败。

    跨平台发布使用当前进程内的线程池，不是持久化任务队列。进程启动时，
    Redis 中残留的 pending/processing 不会自动继续执行；如果继续把它们视为
    运行中，用户将永久无法删除任务。这里分页扫描状态，只处理当前进程没有
    对应 Future 的活动记录，并保留已经生成的视频结果。
    """
    recovered = 0
    page = 1

    while True:
        try:
            tasks, total = sm.state.get_all_tasks(page, page_size)
        except Exception as exc:
            logger.exception(f"failed to recover interrupted cross-post tasks: {exc}")
            return None

        for task in tasks:
            task_id = str(task.get("task_id") or "")
            if (
                not task_id
                or task.get("cross_post_state") not in _ACTIVE_CROSS_POST_STATES
                or _is_cross_post_active_in_process(task_id)
                or _is_cross_post_owner_alive(task.get("cross_post_owner"))
            ):
                continue

            updated = _patch_cross_post_state(
                task_id,
                cross_post_state=const.CROSS_POST_STATE_FAILED,
                cross_post_error=_INTERRUPTED_CROSS_POST_ERROR,
                cross_post_owner=None,
            )
            if updated is True:
                recovered += 1

        if page * page_size >= total or not tasks:
            break
        page += 1

    if recovered:
        logger.warning(f"recovered interrupted cross-post tasks: {recovered}")
    return recovered


_INTERRUPTED_GENERATION_ERROR = "任务在服务器重启/进程中途中止，请重新生成"


def recover_interrupted_generations(page_size: int = 100) -> int | None:
    """
    将进程重启后无法恢复的视频生成任务标记为失败。

    视频生成在线程池里执行，不是持久化任务队列。进程启动时，状态残留的
    PROCESSING 任务不会自动继续；若仍视为运行中，用户将永久无法删除。这里
    分页扫描，只处理本进程没有对应运行登记的活动任务，并保留已到达的进度。
    """
    recovered = 0
    page = 1

    while True:
        try:
            tasks, total = sm.state.get_all_tasks(page, page_size)
        except Exception as exc:
            logger.exception(f"failed to recover interrupted generation tasks: {exc}")
            return None

        for task in tasks:
            task_id = str(task.get("task_id") or "")
            if not task_id:
                continue

            state = task.get("state")
            try:
                state = int(state)
            except (TypeError, ValueError):
                continue

            # 只有真正的生成中状态需要处理；已终态（完成/失败/取消/复审）不动。
            if state != const.TASK_STATE_PROCESSING:
                continue

            # 本进程仍在跑的（刚提交的、未受重启影响）保持忙碌，不回收。
            if _is_generation_active_in_process(task_id):
                continue

            updated = _mark_task_failed(
                task_id,
                "generation",
                _INTERRUPTED_GENERATION_ERROR,
            )
            if updated:
                recovered += 1

        if page * page_size >= total or not tasks:
            break
        page += 1

    if recovered:
        logger.warning(f"recovered interrupted generation tasks: {recovered}")
    return recovered


def _run_cross_post(
    task_id: str,
    video_paths: tuple[str, ...],
    video_subject: str,
    video_script: str,
    video_language: str,
    platforms: tuple[str, ...],
    youtube_privacy_status: str,
) -> None:
    """后台执行跨平台发布，并只补充发布相关的任务字段。"""
    results = []
    try:
        state_updated = _patch_cross_post_state(
            task_id,
            cross_post_state=const.CROSS_POST_STATE_PROCESSING,
            cross_post_error=None,
            cross_post_owner=_cross_post_process_owner,
        )
        if state_updated is not True:
            # False 表示任务已删除，None 表示状态后端暂时不可用。两种情况都
            # 不应继续调用第三方接口，否则用户无法查询或控制这次发布。
            if state_updated is False:
                logger.warning(f"skip cross-post for missing task: {task_id}")
            else:
                _record_cross_post_failure(
                    task_id,
                    RuntimeError("failed to persist cross-post processing state"),
                )
            return

        logger.info(
            f"cross-post started, task_id: {task_id}, platforms: {', '.join(platforms)}"
        )
        youtube_extra = None
        if any(platform.startswith("youtube") for platform in platforms):
            metadata = llm.generate_social_metadata(
                video_subject=video_subject,
                video_script=video_script,
                language=video_language or "",
                platform="youtube_shorts",
            )
            youtube_extra = {
                "youtube_title": metadata.get("title", video_subject),
                "youtube_description": metadata.get("caption", ""),
                "tags": metadata.get("hashtags", []),
                "privacyStatus": youtube_privacy_status,
                "containsSyntheticMedia": True,
            }

        for video_path in video_paths:
            result = upload_post.cross_post_video(
                video_path=video_path,
                title=video_subject or "Check out this video! #shorts #viral",
                platforms=list(platforms),
                youtube_extra=youtube_extra,
            )
            if not isinstance(result, dict):
                result = {
                    "success": False,
                    "error": "Upload-Post returned an invalid response",
                }
            results.append(result)

        failures = [result for result in results if not result.get("success")]
        if failures:
            error_messages = [
                str(
                    result.get("error")
                    or result.get("message")
                    or "unknown upload error"
                )
                for result in failures
            ]
            cross_post_state = const.CROSS_POST_STATE_FAILED
            cross_post_error = "; ".join(error_messages)
            logger.warning(
                f"cross-post completed with failures, task_id: {task_id}, "
                f"failed: {len(failures)}, total: {len(results)}"
            )
        else:
            cross_post_state = const.CROSS_POST_STATE_COMPLETE
            cross_post_error = None
            logger.success(
                f"cross-post completed, task_id: {task_id}, videos: {len(results)}"
            )

        state_updated = _patch_cross_post_state(
            task_id,
            cross_post_state=cross_post_state,
            cross_post_results=results,
            cross_post_error=cross_post_error,
            cross_post_owner=None,
        )
        if state_updated is False:
            logger.warning(f"discard cross-post result for missing task: {task_id}")
        elif state_updated is None:
            # 上传已经结束但结果没有持久化时，不能继续保留 processing。
            # 失败状态写入会再次经过有限重试，至少让调用方得到明确终态。
            _record_cross_post_failure(
                task_id,
                RuntimeError("failed to persist final cross-post result"),
                results,
            )
    except Exception as exc:
        # 发布失败只影响发布状态，不能反向覆盖已经完成的视频任务。
        # 异常原文写入任务状态，API 调用方无需访问服务端日志也能定位问题。
        logger.exception(f"cross-post failed, task_id: {task_id}, error: {exc}")
        _record_cross_post_failure(task_id, exc, results)


def _run_cross_post_with_slot(*args) -> None:
    """执行发布任务，并确保成功、失败或异常时都会归还队列容量。"""
    try:
        _run_cross_post(*args)
    except Exception as exc:
        # _run_cross_post 已处理预期异常；这里是最后一道保护，避免未来新增
        # 逻辑抛出的异常只保存在无人读取的 Future 中。
        task_id = str(args[0]) if args else "unknown"
        logger.exception(
            f"cross-post worker crashed, task_id: {task_id}, error: {exc}"
        )
        if args:
            _record_cross_post_failure(task_id, exc)
    finally:
        _cross_post_slots.release()


def _finalize_cross_post_future(task_id: str, future: Future) -> None:
    """清理 Future 注册，并确保取消、异常和状态写入失败都能收敛。"""
    _unregister_cross_post_future(task_id, future)

    try:
        error = future.exception()
    except CancelledError:
        logger.warning(f"cross-post future was cancelled, task_id: {task_id}")
        # Future 在开始执行前被取消时，worker 的 finally 不会运行，因此需要
        # 在回调中归还队列容量，并把持久化状态改为失败。
        _cross_post_slots.release()
        _record_cross_post_failure(
            task_id,
            RuntimeError("cross-post job was cancelled before execution"),
        )
        return
    except Exception as exc:
        logger.exception(
            f"failed to inspect cross-post future, task_id: {task_id}, error: {exc}"
        )
        _ensure_cross_post_terminal_state(task_id)
        return

    if error is not None:
        logger.error(
            f"cross-post future failed, task_id: {task_id}, "
            f"error: {type(error).__name__}: {error}"
        )

    _ensure_cross_post_terminal_state(task_id)


def _schedule_cross_post(
    task_id: str,
    video_paths: list[str],
    params: VideoParams,
    video_script: str,
    platforms: list[str],
    youtube_privacy_status: str,
) -> str | None:
    """提交后台发布任务；成功返回 None，调度失败返回可查询的错误原因。"""
    if not _cross_post_slots.acquire(blocking=False):
        error = "cross-post queue is full; publishing was skipped"
        logger.warning(
            f"skip cross-post because queue is full, task_id: {task_id}, "
            f"capacity: {_cross_post_max_pending_tasks}"
        )
        _patch_cross_post_state(
            task_id,
            cross_post_state=const.CROSS_POST_STATE_FAILED,
            cross_post_error=error,
            cross_post_owner=None,
        )
        return error

    try:
        future = _cross_post_executor.submit(
            _run_cross_post_with_slot,
            task_id,
            tuple(video_paths),
            params.video_subject or "",
            video_script,
            params.video_language or "",
            tuple(platforms),
            youtube_privacy_status,
        )
        _register_cross_post_future(task_id, future)
        future.add_done_callback(partial(_finalize_cross_post_future, task_id))
    except RuntimeError as exc:
        _unregister_cross_post_future(task_id)
        _cross_post_slots.release()
        logger.exception(
            f"failed to schedule cross-post, task_id: {task_id}, error: {exc}"
        )
        _patch_cross_post_state(
            task_id,
            cross_post_state=const.CROSS_POST_STATE_FAILED,
            cross_post_error=f"failed to schedule cross-post: {exc}",
            cross_post_owner=None,
        )
        return f"failed to schedule cross-post: {exc}"

    return None


def _run_pipeline(
    task_id,
    params: VideoParams,
    stop_at: str = "video",
    voice_preview: dict | None = None,
):
    logger.info(f"start task: {task_id}, stop_at: {stop_at}")
    sm.state.update_task(task_id, state=const.TASK_STATE_PROCESSING, progress=5)

    # 分段计时：每个阶段结束后打印自上一阶段的耗时，便于定位生成瓶颈。
    _stage_t = [time.time()]
    def _stage(name):
        now = time.time()
        logger.info(
            f"[{task_id}] stage '{name}' took {now - _stage_t[0]:.2f}s "
            f"(total {now - pipeline_t0:.2f}s)"
        )
        _stage_t[0] = now
    pipeline_t0 = time.time()

    # 只有完整成片流程需要视频配乐供应商。尽早阻止缺少 Key 的完整任务，避免
    # 先消耗 LLM、TTS 和素材服务额度；中间产物接口仍可独立使用。
    video_music_provider = _VIDEO_MUSIC_PROVIDERS.get(params.bgm_type)
    video_music_enabled = (
        stop_at == "video"
        and video_music_provider is not None
        and bgm_service.should_use_bgm(params.bgm_type, params.bgm_volume)
    )
    if video_music_enabled:
        service = video_music_provider["service"]
        display_name = video_music_provider["display_name"]
        if not service.is_enabled():
            return _mark_task_failed(
                task_id,
                "preflight",
                f"{display_name} background music requires an API key",
            )

        # WebUI 会限制输入长度，但 API、CLI 和历史任务可以绕过前端控件。
        # 在生成脚本、配音和素材之前按供应商上限再次校验，避免完整视频合成后
        # 才由第三方请求拒绝。服务层仍保留同一校验，作为直接调用时的最后防线。
        music_prompt = _get_video_music_prompt(params)
        max_prompt_length = int(getattr(service, "MAX_PROMPT_LENGTH", 0) or 0)
        if max_prompt_length and len(music_prompt) > max_prompt_length:
            return _mark_task_failed(
                task_id,
                "preflight",
                (f"{display_name} music prompt exceeds {max_prompt_length} characters"),
            )

        # 供应商可以选择提供不计费的账号前置检查。检查函数只应抛出确定性
        # 错误；网络波动或权限范围无法确认时由服务层记录警告并继续实际生成。
        validate_access = getattr(service, "validate_generation_access", None)
        if callable(validate_access):
            try:
                validate_access()
            except video_music_provider["error_type"] as exc:
                return _mark_task_failed(task_id, "preflight", str(exc))

    # 1. Generate script
    video_script = generate_script(task_id, params)
    if not video_script or "Error: " in video_script:
        error = (
            video_script.removeprefix("Error: ").strip()
            if isinstance(video_script, str) and "Error: " in video_script
            else "failed to generate video script"
        )
        return _mark_task_failed(task_id, "script", error)

    _stage("script")
    sm.state.update_task(task_id, state=const.TASK_STATE_PROCESSING, progress=10)

    if stop_at == "script":
        sm.state.update_task(
            task_id, state=const.TASK_STATE_COMPLETE, progress=100, script=video_script
        )
        return {"script": video_script}

    # 2. Generate terms
    _check_cancel(task_id)
    video_terms = ""
    if params.video_source != "local":
        video_terms = generate_terms(task_id, params, video_script)
        if not video_terms:
            return _mark_task_failed(
                task_id,
                "terms",
                "failed to generate video search terms",
            )

    save_script_data(task_id, video_script, video_terms, params)

    if stop_at == "terms":
        sm.state.update_task(
            task_id, state=const.TASK_STATE_COMPLETE, progress=100, terms=video_terms
        )
        return {"script": video_script, "terms": video_terms}

    _stage("terms")
    sm.state.update_task(task_id, state=const.TASK_STATE_PROCESSING, progress=20)

    # 3. Generate audio
    _check_cancel(task_id)
    audio_file, audio_duration, sub_maker = generate_audio(
        task_id,
        params,
        video_script,
        voice_preview=voice_preview,
    )
    if not audio_file:
        return _mark_task_failed(
            task_id,
            "audio",
            "failed to prepare narration audio",
        )

    _stage("audio")
    sm.state.update_task(task_id, state=const.TASK_STATE_PROCESSING, progress=30)

    if stop_at == "audio":
        sm.state.update_task(
            task_id,
            state=const.TASK_STATE_COMPLETE,
            progress=100,
            audio_file=audio_file,
        )
        return {"audio_file": audio_file, "audio_duration": audio_duration}

    # 4. Generate subtitle
    _check_cancel(task_id)
    subtitle_path = generate_subtitle(
        task_id,
        params,
        video_script,
        sub_maker,
        audio_file,
        audio_duration_seconds=audio_duration,
    )

    if stop_at == "subtitle":
        sm.state.update_task(
            task_id,
            state=const.TASK_STATE_COMPLETE,
            progress=100,
            subtitle_path=subtitle_path,
        )
        return {"subtitle_path": subtitle_path}

    _stage("subtitle")
    sm.state.update_task(task_id, state=const.TASK_STATE_PROCESSING, progress=40)

    # 5. Get video materials
    _check_cancel(task_id)
    downloaded_videos = get_video_materials(
        task_id, params, video_terms, audio_duration
    )
    if not downloaded_videos:
        return _mark_task_failed(
            task_id,
            "materials",
            "failed to prepare video materials",
        )

    if stop_at == "materials":
        sm.state.update_task(
            task_id,
            state=const.TASK_STATE_COMPLETE,
            progress=100,
            materials=downloaded_videos,
        )
        return {"materials": downloaded_videos}

    _stage("materials")
    sm.state.update_task(task_id, state=const.TASK_STATE_PROCESSING, progress=50)

    # 仅完整视频生成流程才需要处理视频拼接模式；
    # 这样可以避免 /subtitle 和 /audio 这类请求访问不存在的字段。
    if type(params.video_concat_mode) is str:
        params.video_concat_mode = VideoConcatMode(params.video_concat_mode)

    # 6. Generate final videos
    _check_cancel(task_id)
    final_video_paths, combined_video_paths, generation_warnings = generate_final_videos(
        task_id,
        params,
        downloaded_videos,
        audio_file,
        subtitle_path,
        audio_duration,
    )

    if not final_video_paths:
        return _mark_task_failed(
            task_id,
            "video",
            "failed to generate final video",
        )

    _stage("final_videos")

    logger.success(
        f"task {task_id} finished, generated {len(final_video_paths)} videos."
    )

    # 6.5 标题 + 封面（口播智能体 Phase 5）。
    # 默认关闭（config.title_cover.enabled = false），开启后才生成标题/话题标签/封面，
    # 并可选地（compose_cover = true）把封面作为片头拼接到每条成片。
    # 整段非致命；抽成 _run_title_cover_step 复用给口播模式流水线（Phase 9）。
    title_cover_info = None
    if config.title_cover.get("enabled", False):
        title_cover_ctx = {
            "final_video_paths": list(final_video_paths),
            "video_script": video_script,
        }
        _run_title_cover_step(task_id, params, title_cover_ctx)
        if title_cover_ctx.get("final_video_paths") is not None:
            final_video_paths = title_cover_ctx["final_video_paths"]
        title_cover_info = {
            "title": title_cover_ctx.get("title"),
            "tags": title_cover_ctx.get("tags"),
            "cover_path": title_cover_ctx.get("cover_path"),
        }

    _stage("complete")

    # 7. 先完成视频生成任务，再按需提交跨平台发布。第三方上传可能耗时
    # 数分钟，不应阻塞视频结果返回，也不能反向影响已经生成的成片。
    cross_post_enabled = (
        upload_post.upload_post_service.is_configured()
        and upload_post.upload_post_service.auto_upload
    )
    platforms = (
        list(upload_post.upload_post_service.platforms)
        if cross_post_enabled
        else []
    )
    should_cross_post = cross_post_enabled and bool(platforms)
    if cross_post_enabled and not platforms:
        logger.warning(
            f"skip cross-post because no platforms are configured, task_id: {task_id}"
        )
    cross_post_state = const.CROSS_POST_STATE_PENDING if should_cross_post else None

    kwargs = {
        "videos": final_video_paths,
        "combined_videos": combined_video_paths,
        "script": video_script,
        "terms": video_terms,
        "audio_file": audio_file,
        "audio_duration": audio_duration,
        "subtitle_path": subtitle_path,
        "materials": downloaded_videos,
        "cross_post_state": cross_post_state,
        "cross_post_results": None,
        "cross_post_error": None,
        "cross_post_owner": _cross_post_process_owner if should_cross_post else None,
        "warnings": generation_warnings or None,
    }
    if title_cover_info:
        # 把标题/标签/封面回写到任务状态，供 WebUI/API 展示与后续发布复用。
        kwargs["title"] = title_cover_info.get("title")
        kwargs["tags"] = title_cover_info.get("tags")
        kwargs["cover_path"] = title_cover_info.get("cover_path")
        kwargs["composed_cover"] = (
            config.title_cover.get("compose_cover", True)
            if title_cover_info.get("cover_path")
            else False
        )

    sm.state.update_task(
        task_id, state=const.TASK_STATE_COMPLETE, progress=100, **kwargs
    )

    if should_cross_post:
        scheduling_error = _schedule_cross_post(
            task_id=task_id,
            video_paths=final_video_paths,
            params=params,
            video_script=video_script,
            platforms=platforms,
            youtube_privacy_status=(
                upload_post.upload_post_service.youtube_privacy_status
            ),
        )
        # 队列满或线程池关闭属于同步可知的调度失败。任务状态已经由调度函数
        # 更新，这里同步修正返回快照，避免调用方收到与后续查询不一致的 pending。
        if scheduling_error:
            kwargs["cross_post_state"] = const.CROSS_POST_STATE_FAILED
            kwargs["cross_post_error"] = scheduling_error
            kwargs["cross_post_owner"] = None

    return kwargs


def _run_title_cover_step(task_id, params, ctx):
    """生成标题/标签/封面（Phase 5），并可把封面拼入成片。

    入参 ``ctx`` 需含 ``final_video_paths``（列表）与 ``video_script``（字符串）；
    函数会就地更新 ``ctx`` 的 ``final_video_paths`` / ``title`` / ``tags`` /
    ``cover_path``。返回是否实际启用（``config.title_cover.enabled``）。整段非致命：
    任何失败只记录警告，不影响调用方后续流程。混剪模式与口播模式共用此函数。
    """
    if not config.title_cover.get("enabled", False):
        return False
    try:
        from app.services.agent import title_cover as tc

        tc_result = tc.process_title_cover(
            video_subject=params.video_subject or "",
            video_script=ctx.get("video_script") or "",
            language=params.video_language or "",
            persona_id=getattr(params, "persona_id", None),
            base_image="",
            video_path="",
            engine=None,
            compose=False,
            task_id=task_id,
        )
        cover_path = tc_result.get("cover_path")
        final = ctx.get("final_video_paths") or []
        if cover_path and config.title_cover.get("compose_cover", True) and final:
            composed = []
            for fv in final:
                try:
                    composed.append(tc.compose_video_with_cover(fv, cover_path))
                except Exception as exc:
                    logger.warning(f"title-cover compose skipped for {fv}: {exc}")
                    composed.append(fv)
            if composed:
                ctx["final_video_paths"] = composed
        ctx["title"] = tc_result.get("title")
        ctx["tags"] = tc_result.get("tags")
        ctx["cover_path"] = cover_path
        return True
    except Exception as exc:
        logger.warning(
            f"title-cover generation skipped (non-fatal), task_id={task_id}: {exc}"
        )
        return False


# --------------------------------------------------------------------------- #
# 口播模式流水线（Phase 9）
#
# 在「原混剪模式」之外新增「口播模式」：把 Phase 1–8 串成端到端闭环，二者共存、
# 可通过 config.agent.default_mode 或每条任务的 agent_mode 字段切换。
#
# 设计原则（契合旗博士「流程可控」）：
# - 每个阶段都是独立的「检查点（checkpoint）」，按固定顺序串联；
# - 每个检查点可单独跳过（按配置/可用性自动判定）或单独调试（stop_at 提前返回）；
# - 关键检查点（脚本/音频/成片）失败会判任务失败；非关键检查点（对标/数字人/
#   合规/标题封面/发布）失败只记警告并继续，绝不阻断整条流水线；
# - 数字人未配置/不可用时自动回退到「无脸混剪」兜底，保证端到端一定出片。
# --------------------------------------------------------------------------- #
_KOUBO_MODES = {
    "koubo", "agent", "talking_head", "koubo_agent",
    "digital_human", "koubo_digital_human", "口播",
}
# stop_at 别名 → 检查点名称（用于分步调试）
_AGENT_STOP_ALIASES = {
    "script": "script",
    "audio": "audio",
    "reference": "reference",
    "digital_human": "digital_human",
    "video": "video_assembly",
    "compliance": "compliance",
    "title_cover": "title_cover",
    "title": "title_cover",
    "cover": "title_cover",
    "publish": "publish",
}


def _resolve_agent_mode(params) -> str:
    """解析任务应使用的流水线模式（口播 / 混剪）。"""
    mode = (
        getattr(params, "agent_mode", None)
        or config.agent.get("default_mode", "material_montage")
        or "material_montage"
    )
    return str(mode).strip().lower()


def _is_agent_mode(params) -> bool:
    """是否为「口播模式」任务。"""
    return _resolve_agent_mode(params) in _KOUBO_MODES


class _Checkpoint:
    """口播模式的一个阶段检查点。

    - ``run``：实际执行函数 ``(task_id, params, ctx) -> dict``，返回结果并入 ctx。
    - ``critical``：为 True 时该检查点失败会判任务失败；否则只记警告继续。
    - ``skip_when``：返回 True 时跳过该检查点（不执行、不计入失败）。
    """

    __slots__ = ("name", "run", "critical", "skip_when")

    def __init__(self, name, run, *, critical=False, skip_when=None):
        self.name = name
        self.run = run
        self.critical = critical
        self.skip_when = skip_when

    def should_skip(self, ctx) -> bool:
        return bool(self.skip_when(ctx)) if self.skip_when else False


def _agent_reference_enabled(ctx) -> bool:
    params = ctx["params"]
    source = (getattr(params, "reference_source", None) or "").strip()
    transcript = (getattr(params, "transcript_text", None) or "").strip()
    return bool(source or transcript) and bool(config.reference.get("enabled", True))


def _agent_dh_enabled(ctx) -> bool:
    dh = ctx.get("digital_human_cfg")
    if not dh:
        return False
    return bool(dh.provider) and dh.provider not in ("auto", "")


def _agent_publish_enabled(_ctx) -> bool:
    return bool(
        upload_post.upload_post_service.is_configured()
        and upload_post.upload_post_service.auto_upload
    )


# ---- 各检查点实现 ---------------------------------------------------------- #
def _agent_step_persona(task_id, params, ctx):
    from app.services.agent import persona as persona_store

    persona_id = getattr(params, "persona_id", None)
    if not persona_id:
        return {}
    persona = persona_store.get_persona(persona_id)
    if persona is None:
        raise RuntimeError(f"人设不存在：{persona_id}")
    # 把人设口吻注入脚本生成的系统提示，使文案贴合人设。
    tone = persona.tone or ""
    if tone:
        base = (params.custom_system_prompt or "").strip()
        params.custom_system_prompt = (
            (base + "\n") if base else ""
        ) + f"口播人设口吻：{tone}"
    return {
        "persona": persona,
        "persona_name": persona.name or "",
        "tone": tone,
        "digital_human_cfg": persona.digital_human,
        "voice_cfg": persona.voice,
    }


def _agent_step_script(task_id, params, ctx):
    video_script = generate_script(task_id, params)
    if not video_script or "Error: " in video_script:
        error = (
            video_script.removeprefix("Error: ").strip()
            if isinstance(video_script, str) and "Error: " in video_script
            else "failed to generate video script"
        )
        raise RuntimeError(error)
    return {"video_script": video_script}


def _agent_step_reference(task_id, params, ctx):
    from app.services.agent import reference as reference_service

    # 用户已提供 / 编辑过口播文案（如经「AI生成」对标仿写预览并调整）：
    # 尊重该文案，跳过重复的语义级仿写，保证「预览即最终」。
    existing_script = (getattr(params, "video_script", None) or "").strip()
    if existing_script:
        return {}

    transcript = (getattr(params, "transcript_text", None) or "").strip()
    source = (getattr(params, "reference_source", None) or "").strip()
    if not transcript and not source:
        return {}

    # 明确粘贴的已转写文案优先：直接作为 transcript，跳过下载/转写，只做语义级仿写。
    # 否则按 reference_source 解析：链接/本地媒体走 source（下载→抽音频→转写），
    # 纯文本（非路径/URL）兜底为已转写文案。
    if transcript:
        ref_kwargs = {
            "source": None,
            "transcript_text": transcript,
            "persona_id": getattr(params, "persona_id", None),
            "language": params.video_language or None,
        }
    else:
        is_text = (
            not source.startswith(("http://", "https://", "file://"))
            and not os.path.isfile(source)
            and not source.lower().endswith(
                (".mp4", ".mov", ".mkv", ".webm", ".avi", ".flv", ".m4v", ".mp3", ".wav")
            )
        )
        ref_kwargs = {
            "source": None if is_text else source,
            "transcript_text": source if is_text else None,
            "persona_id": getattr(params, "persona_id", None),
            "language": params.video_language or None,
        }
    try:
        result = reference_service.process_reference(**ref_kwargs)
    except Exception as exc:
        logger.warning(f"reference processing failed (non-fatal): {exc}")
        return {}
    rewritten = (result.get("rewritten_script") or "").strip()
    if rewritten:
        return {"video_script": rewritten, "reference_result": result}
    return {"reference_result": result}


def _agent_step_audio(task_id, params, ctx):
    from app.services import voice as voice_service

    video_script = ctx["video_script"]
    voice_cfg = ctx.get("voice_cfg")
    audio_file = None
    sub_maker = None
    # 可选：先用克隆音色合成（若人设配置了可用克隆）。
    if voice_cfg and voice_cfg.provider not in ("", "none"):
        try:
            from app.services.agent.providers import (
                get_provider,
                VoiceCloneProvider,
            )

            provider_cls = get_provider(voice_cfg.provider)
            if (
                provider_cls
                and issubclass(provider_cls, VoiceCloneProvider)
                and voice_cfg.voice_id
            ):
                provider = provider_cls.from_config(voice_cfg)
                out = provider.synthesize(
                    text=video_script, voice_id=voice_cfg.voice_id
                )
                if out and os.path.isfile(out):
                    audio_file = out
        except Exception as exc:
            logger.warning(f"voice clone unavailable/failed, fallback to TTS: {exc}")
    # 兜底/默认：标准 TTS（MPT 既有能力，必然可用）。
    if not audio_file:
        af, dur, smk = generate_audio(
            task_id, params, video_script, voice_preview=ctx.get("voice_preview")
        )
        if not af:
            raise RuntimeError("failed to prepare narration audio")
        audio_file, audio_duration, sub_maker = af, dur, smk
    else:
        audio_duration = math.ceil(voice_service.get_audio_duration(audio_file))
        if audio_duration == 0:
            raise RuntimeError("generated audio duration is zero")
    return {
        "audio_file": audio_file,
        "audio_duration": audio_duration,
        "sub_maker": sub_maker,
    }


def _agent_step_subtitle(task_id, params, ctx):
    """口播模式复用经典混剪的字幕生成，确保成片带字幕。

    经典混剪流水线在标准流程（task.py ``generate_subtitle``）里会先生成字幕
    再烧录到成片；但口播智能体流水线此前漏掉了这一步——``_agent_step_audio``
    产出的 ``sub_maker`` 没有经过字幕生成，``ctx['subtitle_path']`` 始终为空，
    导致 ``_agent_step_video_assembly`` 以空字幕烧录，成片无字幕。

    这里在 audio 之后补上字幕检查点：只要启用了字幕且存在旁白音频/文案，
    就调用同一份 ``generate_subtitle``（内部自带逐词时间轴与均匀兜底），
    结果写入 ``ctx['subtitle_path']`` 供视频合成阶段烧录。
    """
    video_script = ctx.get("video_script") or ""
    audio_file = ctx.get("audio_file")
    if not audio_file or not video_script:
        return {}
    subtitle_path = generate_subtitle(
        task_id,
        params,
        video_script,
        ctx.get("sub_maker"),
        audio_file,
        audio_duration_seconds=ctx.get("audio_duration") or 0,
    )
    return {"subtitle_path": subtitle_path or ""}


def _agent_step_digital_human(task_id, params, ctx):
    dh_cfg = ctx.get("digital_human_cfg")
    audio_file = ctx.get("audio_file")
    if not dh_cfg or not audio_file:
        return {}
    provider_name = dh_cfg.provider
    if provider_name in ("", "auto"):
        # 未显式选择具体 Provider：不启用数字人，交由下方混剪兜底出片。
        return {}
    try:
        from app.services.agent.providers import (
            get_provider,
            DigitalHumanProvider,
        )

        provider_cls = get_provider(provider_name)
        if not provider_cls or not issubclass(provider_cls, DigitalHumanProvider):
            return {}
        provider = provider_cls.from_config(dh_cfg)
        out = provider.generate(
            audio_path=audio_file,
            image_path=dh_cfg.source_image,
            video_path=dh_cfg.source_video,
        )
        if out and os.path.isfile(out):
            return {"dh_video_path": out}
        logger.warning("digital human generate returned no file")
        return {}
    except Exception as exc:
        # 数字人属可选增强：任何失败都回退到混剪，不阻断流水线。
        logger.warning(f"digital human skipped (non-fatal): {exc}")
        return {}


def _agent_step_video_assembly(task_id, params, ctx):
    # 与经典混剪流水线一致：把拼接模式字符串归一为枚举，避免后续
    # combine_videos 对字符串取 .value 时报 ``'str' object has no attribute 'value'``。
    if type(params.video_concat_mode) is str:
        params.video_concat_mode = VideoConcatMode(params.video_concat_mode)

    # 若数字人已产出视频，直接作为成片（口播头）。
    dh_video = ctx.get("dh_video_path")
    if dh_video and os.path.isfile(dh_video):
        return {"final_video_paths": [dh_video], "combined_videos": [dh_video]}
    # 否则回退「无脸混剪」：复用 MPT 素材下载 + 合成，保证端到端一定出片。
    video_script = ctx["video_script"]
    video_terms = ctx.get("video_terms")
    if not video_terms and params.video_source != "local":
        video_terms = generate_terms(task_id, params, video_script)
        ctx["video_terms"] = video_terms
    downloaded = get_video_materials(
        task_id, params, video_terms or "", ctx.get("audio_duration") or 0
    )
    if not downloaded:
        raise RuntimeError("failed to prepare video materials")
    final_paths, combined_paths, warnings = generate_final_videos(
        task_id,
        params,
        downloaded,
        ctx["audio_file"],
        ctx.get("subtitle_path") or "",
        ctx.get("audio_duration") or 0,
    )
    if not final_paths:
        raise RuntimeError("failed to generate final video")
    return {
        "final_video_paths": final_paths,
        "combined_videos": combined_paths,
        "warnings": warnings,
        "materials": downloaded,
    }


def _agent_step_compliance(task_id, params, ctx):
    if not config.compliance.get("enabled", False):
        return {}
    from app.services.agent import compliance as compliance_service

    try:
        result = compliance_service.check(
            script=ctx.get("video_script") or "",
            title=ctx.get("title") or "",
            extra={},
        )
    except Exception as exc:
        logger.warning(f"compliance check failed (non-fatal): {exc}")
        return {}
    hits = getattr(result, "hits", []) or []
    passed = getattr(result, "passed", True)
    block_hits = sum(
        1 for h in hits if str(getattr(h, "level", "")).lower() == "block"
    )
    warn_hits = sum(
        1 for h in hits if str(getattr(h, "level", "")).lower() == "warn"
    )
    if block_hits and config.compliance.get("block_on_hit", True):
        logger.warning(
            f"compliance blocked hits: {block_hits} (non-fatal, content already generated)"
        )
        ctx.setdefault("warnings", []).append(
            {"stage": "compliance", "error": f"{block_hits} 违禁词命中(阻断级)"}
        )
    return {
        "compliance": {
            "passed": bool(passed),
            "block_hits": block_hits,
            "warn_hits": warn_hits,
        }
    }


def _agent_step_title_cover(task_id, params, ctx):
    _run_title_cover_step(task_id, params, ctx)
    return {}


def _agent_step_publish(task_id, params, ctx):
    final = ctx.get("final_video_paths") or []
    if not final:
        return {}
    cross_post_enabled = _agent_publish_enabled(ctx)
    platforms = (
        list(upload_post.upload_post_service.platforms)
        if cross_post_enabled
        else []
    )
    if not (cross_post_enabled and platforms):
        return {}
    scheduling_error = _schedule_cross_post(
        task_id=task_id,
        video_paths=final,
        params=params,
        video_script=ctx.get("video_script") or "",
        platforms=platforms,
        youtube_privacy_status=upload_post.upload_post_service.youtube_privacy_status,
    )
    if scheduling_error:
        ctx["cross_post_state"] = const.CROSS_POST_STATE_FAILED
        ctx["cross_post_error"] = scheduling_error
    else:
        ctx["cross_post_state"] = const.CROSS_POST_STATE_PENDING
    return {}


# ---- 检查点执行器 ---------------------------------------------------------- #
def _run_checkpoints(task_id, params, checkpoints, ctx):
    """按顺序执行检查点。返回 None 表示正常走完；返回 dict 表示因 stop_at 提前结束。"""
    total = len(checkpoints)
    stop_at = (ctx.get("stop_at") or "").strip().lower()
    stop_name = _AGENT_STOP_ALIASES.get(stop_at)
    for idx, cp in enumerate(checkpoints, start=1):
        # 协作式取消：任一检查点开始前轮询取消标志，命中即由 start() 收敛为已取消。
        _check_cancel(task_id)
        if cp.should_skip(ctx):
            logger.info(f"[agent] skip checkpoint: {cp.name}")
            ctx.setdefault("skipped", []).append(cp.name)
            continue
        sm.state.update_task(
            task_id,
            progress=max(5, min(95, 8 + int(87 * (idx - 1) / total))),
            current_stage=cp.name,
        )
        try:
            result = cp.run(task_id, params, ctx) or {}
        except Exception as exc:
            if cp.critical:
                return _mark_task_failed(task_id, cp.name, str(exc))
            logger.warning(
                f"[agent] checkpoint {cp.name} failed (non-fatal): {exc}"
            )
            ctx.setdefault("warnings", []).append(
                {"stage": cp.name, "error": str(exc)}
            )
            continue
        ctx.update(result)
        sm.state.update_task(
            task_id,
            progress=max(5, min(95, 8 + int(87 * idx / total))),
            current_stage=cp.name,
        )
        if stop_name == cp.name:
            logger.info(
                f"[agent] reached stop_at={stop_at} at checkpoint {cp.name}"
            )
            return _finalize_agent_partial(task_id, ctx, stop_at)
    return None


def _finalize_agent_partial(task_id, ctx, stop_at):
    """调试/分步：把当前已产出结果作为完成态返回，不进入发布。"""
    final_video_paths = ctx.get("final_video_paths") or []
    kwargs = {
        "videos": final_video_paths,
        "script": ctx.get("video_script") or "",
        "terms": ctx.get("video_terms") or "",
        "audio_file": ctx.get("audio_file"),
        "audio_duration": ctx.get("audio_duration"),
        "subtitle_path": ctx.get("subtitle_path") or "",
        "title": ctx.get("title"),
        "tags": ctx.get("tags"),
        "cover_path": ctx.get("cover_path"),
        "compliance": ctx.get("compliance"),
        "skipped_stages": ctx.get("skipped") or None,
        "agent_mode": "koubo",
        "stop_at": stop_at,
    }
    sm.state.update_task(
        task_id, state=const.TASK_STATE_COMPLETE, progress=100, **kwargs
    )
    return kwargs


def _run_agent_pipeline(task_id, params, stop_at="video", voice_preview=None):
    """口播模式主流程：把 Phase 1–8 串成端到端闭环。

    与原混剪模式共存：仅当任务被判定为「口播模式」时由 ``start()`` 调用。
    各阶段为可跳过/可单独调试的检查点，详见本文件顶部说明。
    """
    logger.info(f"start agent(koubo) task: {task_id}, stop_at: {stop_at}")
    sm.state.update_task(task_id, state=const.TASK_STATE_PROCESSING, progress=5)

    ctx = {
        "task_id": task_id,
        "params": params,
        "stop_at": stop_at,
        "voice_preview": voice_preview,
        "skipped": [],
        "warnings": [],
    }

    checkpoints = [
        _Checkpoint(
            "persona",
            _agent_step_persona,
            skip_when=lambda c: not (getattr(c["params"], "persona_id", None)),
        ),
        _Checkpoint("script", _agent_step_script, critical=True),
        _Checkpoint(
            "reference",
            _agent_step_reference,
            skip_when=_agent_reference_enabled,
        ),
        _Checkpoint("audio", _agent_step_audio, critical=True),
        _Checkpoint(
            "subtitle",
            _agent_step_subtitle,
            skip_when=lambda c: not getattr(c["params"], "subtitle_enabled", True),
        ),
        _Checkpoint(
            "digital_human",
            _agent_step_digital_human,
            skip_when=lambda c: not _agent_dh_enabled(c),
        ),
        _Checkpoint("video_assembly", _agent_step_video_assembly, critical=True),
        _Checkpoint(
            "compliance",
            _agent_step_compliance,
            skip_when=lambda c: not config.compliance.get("enabled", False),
        ),
        _Checkpoint(
            "title_cover",
            _agent_step_title_cover,
            skip_when=lambda c: not config.title_cover.get("enabled", False),
        ),
        _Checkpoint("publish", _agent_step_publish, skip_when=_agent_publish_enabled),
    ]

    early = _run_checkpoints(task_id, params, checkpoints, ctx)
    if isinstance(early, dict):
        return early

    final_video_paths = ctx.get("final_video_paths") or []
    if not final_video_paths:
        return _mark_task_failed(task_id, "video", "no final video produced")

    kwargs = {
        "videos": final_video_paths,
        "combined_videos": ctx.get("combined_videos") or [],
        "script": ctx.get("video_script") or "",
        "terms": ctx.get("video_terms") or "",
        "audio_file": ctx.get("audio_file"),
        "audio_duration": ctx.get("audio_duration"),
        "subtitle_path": ctx.get("subtitle_path") or "",
        "materials": ctx.get("materials") or [],
        "title": ctx.get("title"),
        "tags": ctx.get("tags"),
        "cover_path": ctx.get("cover_path"),
        "compliance": ctx.get("compliance"),
        "cross_post_state": ctx.get("cross_post_state"),
        "cross_post_results": None,
        "cross_post_error": ctx.get("cross_post_error"),
        "cross_post_owner": (
            _cross_post_process_owner
            if ctx.get("cross_post_state") == const.CROSS_POST_STATE_PENDING
            else None
        ),
        "warnings": ctx.get("warnings") or None,
        "agent_mode": "koubo",
        "skipped_stages": ctx.get("skipped") or None,
    }
    sm.state.update_task(
        task_id, state=const.TASK_STATE_COMPLETE, progress=100, **kwargs
    )
    return kwargs


def start(
    task_id,
    params: VideoParams,
    stop_at: str = "video",
    voice_preview: dict | None = None,
):
    """执行任务流水线，并确保未预期异常也会转换成可查询的失败状态。

    口播模式（Phase 9）：当任务被判定为「口播模式」时走 ``_run_agent_pipeline``，
    否则走原有混剪 ``_run_pipeline``；二者共存、可切换。
    """
    _register_generation(task_id)
    try:
        try:
            # 排队中（尚未真正开始）就被取消的任务，启动即收敛为已取消。
            if is_cancelled(task_id):
                return _mark_task_cancelled(task_id, "pipeline")
            if _is_agent_mode(params):
                return _run_agent_pipeline(
                    task_id, params, stop_at=stop_at, voice_preview=voice_preview
                )
            return _run_pipeline(
                task_id, params, stop_at=stop_at, voice_preview=voice_preview
            )
        except _TaskCancelled:
            logger.info(f"task cancelled by user, task_id: {task_id}")
            return _mark_task_cancelled(task_id, "pipeline")
        except Exception as exc:
            logger.exception(
                f"unexpected task pipeline failure, task_id: {task_id}, error: {exc}"
            )
            return _mark_task_failed(
                task_id,
                "pipeline",
                f"{type(exc).__name__}: {exc}",
            )
    finally:
        _unregister_generation(task_id)
        _clear_cancel(task_id)


if __name__ == "__main__":
    task_id = "task_id"
    params = VideoParams(
        video_subject="金钱的作用",
        voice_name="zh-CN-XiaoyiNeural-Female",
        voice_rate=1.0,
    )
    start(task_id, params, stop_at="video")
