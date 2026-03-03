import json
import os
import re
import uuid
import logging
import boto3
from datetime import datetime
from boto3.dynamodb.conditions import Key

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

TABLE_NAME = os.environ["TEST_LIBRARY_TABLE"]
MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-3-5-haiku-20241022-v1:0")

dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
table = dynamodb.Table(TABLE_NAME)
bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")

PARTITION_KEY = "MASTER"

SYSTEM_PROMPT = """You are helping build a Q&A test library for a government procurement chatbot called ABE.
Given a user question and chatbot response from a conversation that was marked as helpful, generate a clean question-answer pair.

Rules:
- The question should be standalone, clear, and rewritten for clarity if needed.
- The expected response should capture the key factual content from the chatbot response.
- Strip any conversational filler, greetings, or meta-commentary.
- Keep the expected response concise but complete.
- Output ONLY valid JSON with exactly two keys: "question" and "expectedResponse".
- Do not wrap the JSON in markdown code fences."""


def normalize_question(q: str) -> str:
    text = q.strip().lower()
    return re.sub(r'\s+', ' ', text)


def now_iso():
    return datetime.utcnow().isoformat() + "Z"


def find_by_normalized(normalized: str):
    resp = table.query(
        IndexName="NormalizedQuestionIndex",
        KeyConditionExpression=Key("questionNormalized").eq(normalized),
        Limit=1,
    )
    items = resp.get("Items", [])
    if items:
        qid = items[0]["QuestionId"]
        full = table.get_item(Key={"PartitionKey": PARTITION_KEY, "QuestionId": qid})
        return full.get("Item")
    return None


def upsert_item(question: str, expected_response: str, metadata: dict):
    normalized = normalize_question(question)
    existing = find_by_normalized(normalized)
    ts = now_iso()

    if existing:
        if existing.get("expectedResponse", "") == expected_response:
            logger.info("Unchanged duplicate: %s", existing["QuestionId"])
            return "unchanged", existing["QuestionId"]

        versions = existing.get("versions", [])
        versions.insert(0, {
            "expectedResponse": existing.get("expectedResponse", ""),
            "source": existing.get("source", ""),
            "updatedAt": existing.get("updatedAt", existing.get("createdAt", "")),
        })

        table.update_item(
            Key={"PartitionKey": PARTITION_KEY, "QuestionId": existing["QuestionId"]},
            UpdateExpression="SET expectedResponse = :er, #src = :src, updatedAt = :ua, versions = :v, submittedBy = :sb, submittedAt = :sa, feedbackSessionId = :fsi",
            ExpressionAttributeNames={"#src": "source"},
            ExpressionAttributeValues={
                ":er": expected_response,
                ":src": "feedback",
                ":ua": ts,
                ":v": versions,
                ":sb": metadata.get("submittedBy", {}),
                ":sa": metadata.get("submittedAt", ts),
                ":fsi": metadata.get("feedbackSessionId", ""),
            },
        )
        return "updated", existing["QuestionId"]
    else:
        qid = f"Q#{uuid.uuid4()}"
        table.put_item(Item={
            "PartitionKey": PARTITION_KEY,
            "QuestionId": qid,
            "question": question.strip(),
            "questionNormalized": normalized,
            "expectedResponse": expected_response,
            "source": "feedback",
            "createdAt": ts,
            "updatedAt": ts,
            "versions": [],
            "submittedBy": metadata.get("submittedBy", {}),
            "submittedAt": metadata.get("submittedAt", ts),
            "feedbackSessionId": metadata.get("feedbackSessionId", ""),
        })
        return "added", qid


def generate_qa_pair(prompt: str, completion: str) -> dict:
    user_message = (
        f"User Question:\n{prompt}\n\n"
        f"Chatbot Response:\n{completion}\n\n"
        "Generate the clean Q&A pair as JSON."
    )

    request_body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 2048,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_message}],
        "temperature": 0.2,
    })

    response = bedrock.invoke_model(
        modelId=MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=request_body,
    )

    result = json.loads(response["body"].read())
    text = result["content"][0]["text"].strip()

    json_match = re.search(r'\{[\s\S]*\}', text)
    if not json_match:
        raise ValueError(f"No JSON found in LLM response: {text[:200]}")

    qa = json.loads(json_match.group())
    if "question" not in qa or "expectedResponse" not in qa:
        raise ValueError(f"Missing keys in LLM response: {qa}")

    return qa


def lambda_handler(event, context):
    for record in event.get("Records", []):
        try:
            body = json.loads(record["body"])

            prompt = body.get("prompt", "")
            completion = body.get("completion", "")

            if not prompt or not completion:
                logger.warning("Skipping record with missing prompt/completion")
                continue

            qa = generate_qa_pair(prompt, completion)

            metadata = {
                "submittedBy": {
                    "userId": body.get("userId", ""),
                    "displayName": body.get("displayName", ""),
                },
                "submittedAt": body.get("submittedAt", now_iso()),
                "feedbackSessionId": body.get("sessionId", ""),
            }

            action, qid = upsert_item(qa["question"], qa["expectedResponse"], metadata)
            logger.info("Processed feedback -> %s: %s", action, qid)

        except Exception as e:
            logger.error("Failed to process SQS record: %s", str(e))
            raise
