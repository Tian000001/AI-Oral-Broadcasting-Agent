from fastapi import Request

from app.controllers.v1.base import new_router
from app.models.schema import (
    ComplianceCheckRequest,
    ComplianceCheckResponse,
    VideoScriptRequest,
    VideoScriptResponse,
    VideoSocialMetadataRequest,
    VideoSocialMetadataResponse,
    VideoTermsRequest,
    VideoTermsResponse,
    VideoTopicRequest,
    VideoTopicResponse,
)
from app.services import llm
from app.utils import utils

# authentication dependency
# router = new_router(dependencies=[Depends(base.verify_token)])
router = new_router()


@router.post(
    "/llm/scripts",
    response_model=VideoScriptResponse,
    summary="Create a script for the video",
)
def generate_video_script(request: Request, body: VideoScriptRequest):
    video_script = llm.generate_script(
        video_subject=body.video_subject,
        language=body.video_language,
        paragraph_number=body.paragraph_number,
        video_script_prompt=body.video_script_prompt,
        custom_system_prompt=body.custom_system_prompt,
    )
    response = {"video_script": video_script}
    return utils.get_response(200, response)


@router.post(
    "/llm/terms",
    response_model=VideoTermsResponse,
    summary="Generate video terms based on the video script",
)
def generate_video_terms(request: Request, body: VideoTermsRequest):
    video_terms = llm.generate_terms(
        video_subject=body.video_subject,
        video_script=body.video_script,
        amount=body.amount,
        match_script_order=body.match_materials_to_script,
    )
    response = {"video_terms": video_terms}
    return utils.get_response(200, response)


@router.post(
    "/llm/social-metadata",
    response_model=VideoSocialMetadataResponse,
    summary="Generate social publishing metadata",
)
def generate_video_social_metadata(
    request: Request, body: VideoSocialMetadataRequest
):
    metadata = llm.generate_social_metadata(
        video_subject=body.video_subject,
        video_script=body.video_script,
        language=body.language,
        platform=body.platform,
    )
    return utils.get_response(200, metadata)


@router.post(
    "/llm/topic",
    response_model=VideoTopicResponse,
    summary="Generate a short-video topic based on an optional persona",
)
def generate_video_topic(request: Request, body: VideoTopicRequest):
    topic = llm.generate_topic(
        persona_name=body.persona_name,
        persona_tone=body.persona_tone,
        video_language=body.video_language,
    )
    return utils.get_response(200, {"video_subject": topic})


@router.post(
    "/llm/compliance",
    response_model=ComplianceCheckResponse,
    summary="Check the spoken script for compliance issues",
)
def check_script_compliance(request: Request, body: ComplianceCheckRequest):
    result = llm.check_compliance(
        video_script=body.video_script,
        video_subject=body.video_subject,
        video_terms=body.video_terms or "",
        video_language=body.video_language,
    )
    return utils.get_response(200, result)
