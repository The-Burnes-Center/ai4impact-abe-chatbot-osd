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
        # Defensive: metadata.txt blobs written before the writers were fixed
        # carry a useless "metadata.txt": {} self-entry. Drop it so neither
        # the compact nor the full form exposes it during the transition.
        metadata.pop("metadata.txt", None)
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
    filename_contains = str(event.get('filename_contains') or '').strip().lower()
    try:
        now = time.time()
        if _metadata_cache is None or now - _metadata_cache_ts >= _METADATA_TTL:
            response = s3.get_object(Bucket=BUCKET, Key='metadata.txt')
            _metadata_cache = response['Body'].read().decode('utf-8')
            _metadata_cache_ts = now
        filtered_metadata = filter_metadata(_metadata_cache, category=filter_key)
        if filename_contains:
            # Case-insensitive substring match on filenames (e.g. a contract
            # identifier like "FAC115" selects that contract family). Applies
            # to both the compact and full forms, composes with the category
            # filter above, and runs after the metadata.txt self-entry pop.
            # No match -> empty dict (a valid response the model interprets).
            filtered_metadata = {
                k: v for k, v in filtered_metadata.items()
                if filename_contains in k.lower()
            }
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
