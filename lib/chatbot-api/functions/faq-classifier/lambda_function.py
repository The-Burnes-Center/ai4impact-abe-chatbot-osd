import os
import json
import boto3
from datetime import datetime, timezone

ANALYTICS_TABLE = os.environ["ANALYTICS_TABLE_NAME"]
MODEL_ID = os.environ.get("FAST_MODEL_ID", "us.anthropic.claude-3-5-haiku-20241022-v1:0")

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(ANALYTICS_TABLE)
bedrock = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-east-1"))

CATEGORIES = [
    "General Procurement",
    "Contract Search",
    "Vendor Information",
    "Bidding & Solicitation",
    "Pricing & Cost",
    "Compliance & Regulations",
    "Forms & Documentation",
    "IT Procurement",
    "Greeting/Small Talk",
    "Other",
]

CLASSIFICATION_PROMPT = f"""Classify the following user question into exactly one category from this list:
{json.dumps(CATEGORIES)}

Return ONLY valid JSON with no explanation:
{{"topic": "<category>", "confidence": <0.0-1.0>}}"""


def classify_question(user_message: str) -> dict:
    body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 100,
        "messages": [
            {"role": "user", "content": f"{CLASSIFICATION_PROMPT}\n\nQuestion: {user_message}"}
        ],
    })

    response = bedrock.invoke_model(modelId=MODEL_ID, body=body, contentType="application/json")
    result = json.loads(response["body"].read())
    text = result["content"][0]["text"].strip()

    start = text.find("{")
    end = text.rfind("}") + 1
    if start == -1 or end == 0:
        return {"topic": "Other", "confidence": 0.0}

    return json.loads(text[start:end])


def lambda_handler(event, context):
    try:
        user_message = event.get("userMessage", "")
        user_id = event.get("userId", "")
        session_id = event.get("sessionId", "")
        timestamp = event.get("timestamp", datetime.now(timezone.utc).isoformat())

        if not user_message or len(user_message.strip()) < 3:
            return {"statusCode": 200, "body": "Skipped: message too short"}

        classification = classify_question(user_message)
        topic = classification.get("topic", "Other")
        confidence = classification.get("confidence", 0.0)

        if topic == "Greeting/Small Talk":
            return {"statusCode": 200, "body": f"Skipped: topic={topic}"}

        if confidence < 0.6 or topic not in CATEGORIES:
            topic = "Other"

        date_key = timestamp[:10]

        table.put_item(Item={
            "topic": topic,
            "timestamp": timestamp,
            "question": user_message[:500],
            "user_id": user_id,
            "session_id": session_id,
            "date_key": date_key,
            "confidence": str(confidence),
        })

        return {"statusCode": 200, "body": f"Classified as {topic} ({confidence})"}

    except Exception as e:
        print(f"FAQ classification error: {e}")
        return {"statusCode": 500, "body": str(e)}
