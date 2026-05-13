import boto3
import json
import time
import os

s3 = boto3.client('s3')
BUCKET = os.environ['BUCKET']

_METADATA_TTL = 300  # 5 minutes
_metadata_cache: str | None = None
_metadata_cache_ts: float = 0.0


def filter_metadata(metadata_content, category="memos"):
    """Optional category filter. Returns the parsed metadata dict (full form)
    or, when category is provided, only entries whose tag_category matches."""
    try:
        metadata = json.loads(metadata_content)
        if category:
            return {
                k: v for k, v in metadata.items()
                if v.get('tag_category') == category
            }
        return metadata
    except json.JSONDecodeError:
        print("Error: Invalid JSON format in metadata content")
        return {}
    except Exception as e:
        print(f"Error processing metadata: {str(e)}")
        return {}


def to_compact(metadata):
    """Reduce the full metadata map to {filename: tag_category}.

    The compact form is ~10x smaller (~16 KB vs ~180 KB for 200 documents) and
    is enough for the model to spot sibling documents by filename prefix and
    answer "what's in the KB" questions. Callers can request the full form
    (summaries + tags) by setting full=true on the invocation event.
    """
    if not isinstance(metadata, dict):
        return {}
    return {
        k: (v.get('tag_category') or 'unknown') if isinstance(v, dict) else 'unknown'
        for k, v in metadata.items()
    }


def lambda_handler(event, context):
    global _metadata_cache, _metadata_cache_ts
    filter_key = event.get('filter_key', None)
    full = bool(event.get('full', False))
    try:
        now = time.time()
        if _metadata_cache is None or now - _metadata_cache_ts >= _METADATA_TTL:
            response = s3.get_object(Bucket=BUCKET, Key='metadata.txt')
            _metadata_cache = response['Body'].read().decode('utf-8')
            _metadata_cache_ts = now
        filtered_metadata = filter_metadata(_metadata_cache, category=filter_key)
        payload = filtered_metadata if full else to_compact(filtered_metadata)
        return {
            'statusCode': 200,
            'body': json.dumps({'metadata': payload})
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
