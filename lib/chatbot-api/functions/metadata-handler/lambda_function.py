import boto3
import json
import urllib.parse
import os
import unicodedata
from datetime import datetime
from botocore.exceptions import ClientError
from config import get_full_prompt, get_all_tags, CATEGORIES, CUSTOM_TAGS
from abe_utils import extract_json_object, get_logger


# S3 object metadata (the head-metadata map written via copy_object with
# MetadataDirective=REPLACE) is restricted to ASCII. Claude routinely emits
# typographic characters in summaries -- em-dashes, smart quotes, ellipses,
# non-breaking spaces -- which makes copy_object reject the whole request and
# leaves the file with empty head metadata. Map the common offenders to ASCII
# equivalents first, then strip anything still non-ASCII via NFKD
# normalization. This is loss-tolerant: the human-readable summary is
# preserved in metadata.txt where there is no such restriction.
_TYPOGRAPHIC_REPLACEMENTS = {
    "–": "-",   # en dash
    "—": "--",  # em dash
    "−": "-",   # minus sign
    "‘": "'",   # left single quote
    "’": "'",   # right single quote
    "‚": ",",   # single low-9 quote
    "“": '"',   # left double quote
    "”": '"',   # right double quote
    "„": '"',   # double low-9 quote
    "…": "...", # ellipsis
    " ": " ",   # non-breaking space
    " ": " ",   # narrow no-break space
    " ": " ",   # thin space
    "·": "*",   # middle dot
    "•": "*",   # bullet
    "™": "(TM)",
    "®": "(R)",
    "©": "(C)",
}


def to_ascii(value):
    """Return an ASCII-safe version of ``value`` suitable for S3 head metadata.

    Replaces common typographic characters with ASCII analogues, then
    NFKD-normalizes and drops anything still outside the ASCII range. Returns
    non-string values unchanged.
    """
    if not isinstance(value, str):
        return value
    text = value
    for src, dst in _TYPOGRAPHIC_REPLACEMENTS.items():
        if src in text:
            text = text.replace(src, dst)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return text



s3 = boto3.client('s3')
bedrock = boto3.client('bedrock-agent-runtime', region_name = 'us-east-1') #For using retrieve function
bedrock_invoke =boto3.client('bedrock-runtime', region_name = 'us-east-1') #For using invoke function
kb_id = os.environ['KB_ID']
logger = get_logger(__name__)


# Using Knowledge Base to fetch document contents
def retrieve_kb_docs(bucket, file_name, knowledge_base_id):
    """Fetch all KB chunks for a specific file, paginating through results.

    Using ``retrievalQuery`` alone (semantic search on the bare filename) is
    unreliable: for files with short, generic names (e.g. ``ENE53.pdf``,
    ``GRO39.pdf``, ``HLS06.pdf``) Bedrock returns the most semantically
    relevant chunks across the *entire* knowledge base, often dominated by
    long policy docs like ``Conducting Best Value Procurements``. The
    subsequent ``if file_name in uri`` post-filter then drops everything,
    leaving the document with no summary.

    Use the ``stringContains`` metadata filter on the source URI so the
    retrieval is scoped to chunks belonging to this file, and paginate via
    ``nextToken`` to ensure we collect every chunk -- not just the first 100.
    """
    try:
        key, _ = os.path.splitext(file_name)
        print(f"Search query KB : {key}")
        all_chunks = []
        file_uri = None
        next_token = None
        while True:
            request = {
                'knowledgeBaseId': knowledge_base_id,
                'retrievalQuery': {'text': key or file_name},
                'retrievalConfiguration': {
                    'vectorSearchConfiguration': {
                        'numberOfResults': 100,
                        'filter': {
                            'stringContains': {
                                'key': 'x-amz-bedrock-kb-source-uri',
                                'value': file_name,
                            },
                        },
                    },
                },
            }
            if next_token:
                request['nextToken'] = next_token
            response = bedrock.retrieve(**request)
            for result in response.get('retrievalResults', []):
                uri = result['location']['s3Location']['uri']
                # Defensive: stringContains is a substring match; require the
                # URI to actually end with this filename so a query for
                # "FAC114" doesn't accidentally pick up "FAC1141" etc.
                if uri.split('/')[-1] != file_name:
                    continue
                all_chunks.append(result['content']['text'])
                file_uri = uri
            next_token = response.get('nextToken')
            if not next_token:
                break

        if all_chunks:
            return {'content': all_chunks, 'uri': file_uri}

        print(f"No KB chunks found for {file_name}; document may not yet be ingested")
        return {
            'content': "No relevant document found in the knowledge base.",
            'uri': None,
        }
    except ClientError as e:
        print(f"Error fetching knowledge base docs: {e}")
        return {'content': [], 'uri': None}


# Function to summarize and categorize using claude 3
def summarize_and_categorize(key,content):
    try:
        response = bedrock_invoke.invoke_model(
            modelId=os.environ.get('FAST_MODEL_ID', 'us.anthropic.claude-3-5-haiku-20241022-v1:0'),
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                # 1500 covers a ~100-word summary + the tag JSON object with
                # comfortable headroom. The previous 500-token cap occasionally
                # truncated long documents mid-JSON, which surfaced as the
                # "Error parsing nested JSON in 'text'" summary marker.
                "max_tokens": 1500,
                "messages": [
                    {
                        "role": "user",
                        "content": get_full_prompt(key,content)
                    }
                ]
            })
        )

        #
        raw_response_body= response['body'].read().decode('utf-8') #Added decoding
        logger.info("Raw llm output received for metadata summarization")

        # Parse the raw response body
        try:
            result = json.loads(raw_response_body)
        except json.JSONDecodeError:
            logger.warning("Response body is not valid JSON")
            return {
                "summary": "Error parsing response body",
                "tags": {"category": "unknown"}
            }

        # Validate 'content' field
        if 'content' not in result or not result['content']:
            logger.warning("Response body missing content field")
            return {
                "summary": "Error generating summary",
                "tags": {"category": "unknown"}
            }

        # Extract and parse the text field
        text_content = result['content'][0].get('text', '')
        if not text_content:
            logger.warning("Response content missing text field")
            return {
                "summary": "Error generating summary",
                "tags": {"category": "unknown"}
            }

        try:
            summary_and_tags = extract_json_object(text_content)
        except Exception:
            logger.warning("Error parsing nested JSON in model text: %s", text_content[:500])
            return {
                "summary": "Error parsing nested JSON in 'text'",
                "tags": {"category": "unknown"}
            }
        creation_date = datetime.utcnow().strftime('%Y-%m-%d')

        # Validate the tags
        all_tags = get_all_tags()
        for tag, value in summary_and_tags['tags'].items():

            if tag == "creation_date":
                try:
                    datetime.strptime(value, "%Y-%m-%d")
                except ValueError:
                    logger.warning("Invalid creation_date format for %s, resetting to blank", key)
                    summary_and_tags['tags'][tag] = ""
                continue

            if not value or not value.strip():
                summary_and_tags['tags'][tag] = "unknown"
                continue

            if tag in all_tags:
                if all_tags[tag] and value not in all_tags[tag]:
                    summary_and_tags['tags'][tag] = 'unknown'
            else:
                summary_and_tags['tags'][tag] = 'unknown'

        if not summary_and_tags['tags'].get('creation_date') or not summary_and_tags['tags']['creation_date'].strip():
            summary_and_tags['tags']['creation_date'] = creation_date

        return summary_and_tags
    except Exception as e:
        logger.exception("Error generating summary and tags")
        return {"summary": "Error generating summary", "tags": {"category": "unknown"}}

# Getting metadata information from a file
def get_metadata(bucket,key):
    response = s3.head_object(Bucket=bucket, Key=key)
    existing_metadata = response.get('Metadata', {})
    return existing_metadata

#Getting metadata information of all files in a single document
def get_complete_metadata(bucket):
    all_metadata = {}
    try:
        paginator = s3.get_paginator('list_objects_v2')
        current_files = set()
        for page in paginator.paginate(Bucket =bucket):
            if 'Contents' in page:
                for obj in page['Contents']:
                    key = obj['Key']
                    current_files.add(key)
                    try:
                        all_metadata[key] = get_metadata(bucket,key)
                    except Exception as e:
                        print(f"Error in fetching complete metadata for {key}: {e}")

        # Upload to S3 with a specific key
        metadata_file = r"metadata.txt"

        # Removing deleted files
        updated_metadata = {
            key: value for key, value in all_metadata.items() if key in current_files
        }

        metadata_json = json.dumps(updated_metadata, indent=4)


        s3.put_object(
            Bucket=bucket,
            Key=metadata_file,
            Body=metadata_json,
            ContentType='text/plain'
        )
        print(f"Metadata successfully uploaded to {bucket}/{metadata_file}")
        return updated_metadata

    except Exception as e:
        print(f"Error occurred in fetching complete metadata : {e}")
        return None


def lambda_handler(event, context):
    try:
        # Get the bucket name and file key from the event, handling URL-encoded characters
        event_name = event['Records'][0]['eventName']
        bucket = event['Records'][0]['s3']['bucket']['name']
        raw_key = event['Records'][0]['s3']['object']['key']
        key = urllib.parse.unquote_plus(raw_key)
        # Skipping operation if the uploaded file is metadata.
        if key == "metadata.txt":
            print("Skipping processing for metadata.txt to prevent recursion.")
            return {
                'statusCode': 200,
                'body': json.dumps("Skipped processing for metadata.txt")
            }

        # Recursion guard for our own self-copy (line 315 below copies the object
        # to itself with MetadataDirective=REPLACE to attach the summary, which
        # fires another ObjectCreated:Copy event). We skip only when the file
        # already carries a `summary` in its S3 head metadata. Sync-pushed copies
        # from the staging bucket have no such marker, so they fall through and
        # get processed normally.
        if event_name.startswith('ObjectCreated:Copy'):
            try:
                head = s3.head_object(Bucket=bucket, Key=key)
                existing = head.get('Metadata', {}) or {}
                if existing.get('summary'):
                    print(f"Skipping self-copy recursion for {key} (summary already set)")
                    return {
                        'statusCode': 200,
                        'body': json.dumps("Skipped self-copy recursion")
                    }
            except Exception as e:
                print(f"Could not inspect head metadata for {key}, proceeding: {e}")

        print(f"Processing file: Bucket - {bucket}, File - {key}")
        if event_name.startswith('ObjectRemoved'):
            print(f"Object removed: {key}")
            # Update metadata.txt to remove metadata for the deleted file
            all_metadata = get_complete_metadata(bucket)
            if all_metadata is not None:
                return {
                    'statusCode': 200,
                    'body': json.dumps(all_metadata)
                }
            else:
                return {
                    'statusCode': 500,
                    'body': json.dumps("Failed to retrieve metadata")
                }

        elif event_name.startswith('ObjectCreated'):
            # Retrieve the document content from the knowledge base
            print(f"file : {key}, kb_id : {kb_id}")
            document_content = retrieve_kb_docs(bucket, key, kb_id)
            if not document_content['content']:
                return {
                    'statusCode': 404,
                    'body': json.dumps("No relevant content found")
                }
            else:
                print(f"Content : {document_content}")

            summary_and_tags = summarize_and_categorize(key,document_content)
            # Any of the sentinel error summaries returned by
            # summarize_and_categorize means we did NOT get a usable response
            # from the model. Don't persist the sentinel to S3 head metadata
            # (and therefore to metadata.txt) -- bail out with a 500 so the
            # next sync sweep retries the file.
            summary_text = summary_and_tags.get('summary', '') or ''
            if summary_text.lower().startswith('error '):
                return {
                    'statusCode': 500,
                    'body': json.dumps(f"Summarization failed for {key}: {summary_text}")
                }
            print(f"Summary and category : {summary_and_tags}")




            try:
                existing_metadata = get_metadata(bucket,key)
            except Exception as e:
                print(f"Error fetching metadata for {key}: {e}")
                return {
                    'statusCode': 500,
                    'body': json.dumps(f"Error fetching metadata for {key}: {e}")
                }

            # Generate new metadata fields. ASCII-sanitize every value before
            # it lands in S3 head metadata -- typographic characters in the
            # model's output (em-dashes, smart quotes, ellipses) would
            # otherwise cause copy_object to reject the entire request and
            # leave the file with empty metadata.
            new_metadata = {
                'summary': to_ascii(summary_and_tags['summary']),
                **{f"tag_{k}": to_ascii(v) for k, v in summary_and_tags['tags'].items()}
            }

            # Merge new metadata with any existing metadata
            updated_metadata = {**existing_metadata, **new_metadata}
            updated_metadata = {k.replace(" ", "_"): v for k, v in updated_metadata.items()} # Replace spaces in keys
            print(f"Updated Metadata : {updated_metadata}")

            # Copy the object to itself to update metadata
            try:
                s3.copy_object(
                    Bucket=bucket,
                    CopySource={'Bucket': bucket, 'Key': key},
                    Key=key,
                    Metadata=updated_metadata,
                    MetadataDirective='REPLACE'
                )
                print(f"Metadata successfully updated for {key}: {updated_metadata}")
            except Exception as e:
                print("Error in copying file copy")
                print(f"Error updating metadata for {key}: {e}")
                return {
                    'statusCode': 500,
                    'body': json.dumps(f"Error updating metadata for {key}: {e}")
                }

            all_metadata = get_complete_metadata(bucket)
            if all_metadata is not None:
                print(f"All Metadata : {all_metadata}")
                return {
                    'statusCode': 200,
                    'body': json.dumps(all_metadata)
                }
            else:
                return {
                    'statusCode': 500,
                    'body': json.dumps("Failed to retrieve metadata")
                }

        else:
            print(f"Unhandled event type: {event_name}")
            return {
                'statusCode': 400,
                'body': json.dumps("Unhandled event type")
            }
    except Exception as e:
        print(f"Unexpected error processing file: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps(f"Unexpected error processing file: {e}")
        }
