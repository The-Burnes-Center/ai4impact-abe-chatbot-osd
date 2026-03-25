import json
import os

import boto3
from pydantic import BaseModel, Field, ValidationError

from abe_utils import extract_json_object, get_logger

MODEL_ID = os.environ.get("FAST_MODEL_ID", "us.anthropic.claude-3-5-haiku-20241022-v1:0")

bedrock = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-east-1"))
logger = get_logger(__name__)


class ConversationSummary(BaseModel):
    key_facts: list[str] = Field(description="Important facts established in the conversation")
    questions_answered: list[str] = Field(description="Questions the user asked and key points from answers")
    data_retrieved: list[str] = Field(description="Specific data or results from tool calls such as vendors, contracts, or counts")
    active_topic: str = Field(description="What the user was most recently focused on")


SUMMARY_SCHEMA = ConversationSummary.model_json_schema()

SYSTEM_PROMPT = (
    "You are a conversation summarizer for a procurement chatbot. "
    "Summarize the conversation into a structured JSON object that preserves all key facts, "
    "questions asked, answers given, data retrieved from tools, and the user's current focus. "
    "Be thorough but concise. Output ONLY valid JSON matching this schema:\n"
    f"{json.dumps(SUMMARY_SCHEMA, indent=2)}"
)


def summarize(conversation_text: str) -> dict:
    body = json.dumps(
        {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 2048,
            "messages": [
                {"role": "user", "content": f"Summarize this conversation:\n\n{conversation_text}"}
            ],
            "system": SYSTEM_PROMPT,
            "temperature": 0,
        }
    )

    response = bedrock.invoke_model(modelId=MODEL_ID, body=body, contentType="application/json")
    result = json.loads(response["body"].read())
    content = result.get("content") or []
    text = ""
    if content and isinstance(content[0], dict):
        text = (content[0].get("text") or "").strip()

    parsed = extract_json_object(text)
    summary = ConversationSummary.model_validate(parsed)
    return summary.model_dump()


def format_summary(data: dict) -> str:
    lines = []
    if data.get("active_topic"):
        lines.append(f"Current focus: {data['active_topic']}")
    if data.get("key_facts"):
        lines.append("Key facts:")
        for fact in data["key_facts"]:
            lines.append(f"  - {fact}")
    if data.get("questions_answered"):
        lines.append("Questions answered:")
        for qa in data["questions_answered"]:
            lines.append(f"  - {qa}")
    if data.get("data_retrieved"):
        lines.append("Data retrieved:")
        for d in data["data_retrieved"]:
            lines.append(f"  - {d}")
    return "\n".join(lines)


def lambda_handler(event, context):
    try:
        conversation_text = event.get("conversation_text", "")
        if not conversation_text:
            return {"statusCode": 400, "body": json.dumps({"error": "No conversation_text provided"})}

        summary_data = summarize(conversation_text)
        summary_text = format_summary(summary_data)

        return {
            "statusCode": 200,
            "body": json.dumps({
                "summary_data": summary_data,
                "summary_text": summary_text,
            }),
        }
    except ValidationError as err:
        logger.warning("Pydantic validation failed, falling back to raw summary: %s", err)
        try:
            fallback = _fallback_summarize(event.get("conversation_text", ""))
            return {
                "statusCode": 200,
                "body": json.dumps({
                    "summary_data": None,
                    "summary_text": fallback,
                }),
            }
        except Exception as fallback_err:
            logger.exception("Fallback summarization also failed")
            return {"statusCode": 500, "body": json.dumps({"error": str(fallback_err)})}
    except Exception as err:
        logger.exception("Context summarization error")
        return {"statusCode": 500, "body": json.dumps({"error": str(err)})}


def _fallback_summarize(conversation_text: str) -> str:
    body = json.dumps(
        {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 2048,
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Summarize this conversation concisely, preserving all key facts, "
                        "questions, answers, and data retrieved:\n\n" + conversation_text
                    ),
                }
            ],
            "temperature": 0,
        }
    )
    response = bedrock.invoke_model(modelId=MODEL_ID, body=body, contentType="application/json")
    result = json.loads(response["body"].read())
    content = result.get("content") or []
    if content and isinstance(content[0], dict):
        return (content[0].get("text") or "").strip()
    return ""
