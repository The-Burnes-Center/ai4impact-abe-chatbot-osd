import json
import os
import re
import uuid
import logging
import boto3
from datetime import datetime
from boto3.dynamodb.conditions import Key

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TABLE_NAME = os.environ["TEST_LIBRARY_TABLE"]
MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-sonnet-4-20250514-v1:0")

dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
table = dynamodb.Table(TABLE_NAME)
bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")

PARTITION_KEY = "MASTER"

SYSTEM_PROMPT = """You are building a Q&A test library for ABE, a U.S. federal government \
procurement chatbot operated by the Office of the Secretary of Defense (OSD). ABE helps \
government buyers navigate acquisition regulations, find contracts (GSA Schedule, BPAs, GWACs), \
identify vendors, and understand compliance requirements.

You will be given a user's question and the chatbot's answer from a conversation that the \
user marked as helpful. Your ONLY job is to rewrite the user's question into a clean, \
standalone question. Do NOT touch the answer — it will be kept exactly as-is.

The user's original question may be:
- Poorly worded, vague, or overly casual ("i want carpet")
- A follow-up that makes no sense without prior context ("what about pricing for that?")
- A single word or fragment ("vendors?")

Rewrite it into a clear, self-contained question that would naturally lead to the given \
answer. Use the answer's content to understand what the user was really asking about. \
The rewritten question should make sense to someone with no prior conversation context.

Rules:
- Output ONLY valid JSON with exactly one key: "question".
- Do not wrap the JSON in markdown code fences or add any text outside the JSON object.
- Do not include or modify the answer in your output.

Example input:
User Question: i want carpet
Chatbot Response: Based on the available contracts, you can purchase carpet through \
MRO001 (Maintenance, Repair, and Operations). There are 10 vendors available.

Example output:
{"question": "How can I purchase carpet through government contracts?"}

Example input:
User Question: what about the health stuff
Chatbot Response: When purchasing carpet for a fire department, look for products that \
meet these health and safety standards: UL GREENGUARD Gold certification, free of PFAS \
and vinyl, no added antimicrobials, Cradle to Cradle Certified.

Example output:
{"question": "What environmental and health standards should I look for when purchasing \
carpet for a fire department?"}"""


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


def rewrite_question(prompt: str, completion: str) -> str:
    """Use the LLM to rewrite the user's question as a clear standalone question.
    The completion (chatbot answer) is passed as context so the LLM understands
    what the user was really asking about, but is NOT included in the output."""
    user_message = (
        f"User Question:\n{prompt}\n\n"
        f"Chatbot Response:\n{completion}\n\n"
        "Rewrite the user's question as clean standalone JSON."
    )

    request_body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 512,
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

    parsed = json.loads(json_match.group())
    if "question" not in parsed:
        raise ValueError(f"Missing 'question' key in LLM response: {parsed}")

    return parsed["question"]


def lambda_handler(event, context):
    for record in event.get("Records", []):
        try:
            body = json.loads(record["body"])

            prompt = body.get("prompt", "")
            completion = body.get("completion", "")

            if not prompt or not completion:
                logger.warning("Skipping record with missing prompt/completion")
                continue

            logger.info("Input prompt: %s", prompt[:500])
            logger.info("Input completion length: %d chars", len(completion))

            rewritten_q = rewrite_question(prompt, completion)

            logger.info("Original Q: %s", prompt[:300])
            logger.info("Rewritten Q: %s", rewritten_q[:300])

            metadata = {
                "submittedBy": {
                    "userId": body.get("userId", ""),
                    "displayName": body.get("displayName", ""),
                },
                "submittedAt": body.get("submittedAt", now_iso()),
                "feedbackSessionId": body.get("sessionId", ""),
            }

            action, qid = upsert_item(rewritten_q, completion, metadata)
            logger.info("Processed feedback -> %s: %s", action, qid)

        except Exception as e:
            logger.error("Failed to process SQS record: %s", str(e))
            raise
