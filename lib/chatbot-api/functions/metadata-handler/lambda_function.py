import boto3
import json
import urllib.parse
import os
from datetime import datetime
from botocore.exceptions import ClientError
from config import get_full_prompt, get_all_tags, CATEGORIES, CUSTOM_TAGS



s3 = boto3.client('s3')
bedrock = boto3.client('bedrock-agent-runtime', region_name = 'us-east-1') #For using retrieve function
bedrock_invoke =boto3.client('bedrock-runtime', region_name = 'us-east-1') #For using invoke function
kb_id = os.environ['KB_ID']


# Using Knowledge Base to fetch document contents
def retrieve_kb_docs(bucket, file_name, knowledge_base_id):
    try:
        key,_ = os.path.splitext(file_name)
        print(f"Search query KB : {key}")
        response = bedrock.retrieve(
            knowledgeBaseId=knowledge_base_id,
            retrievalQuery={
                'text': key
            },
            retrievalConfiguration={
                'vectorSearchConfiguration': {
                    'numberOfResults': 100  # We only want the most relevant document
                }
            }
        )

        full_content = []
        file_uri = []
        if response['retrievalResults']:
            print(f"Complete Response {response['retrievalResults']}")
            for result in response['retrievalResults']:
                uri = result['location']['s3Location']['uri']
                if file_name in uri:
                    full_content.append(result['content']['text'])
                    file_uri = uri

            if full_content:
                return {
                    'content': full_content,
                    'uri': file_uri
                }
            else:
                try:
                    print(f"Bucket : {bucket} and File : {file_name}")
                    s3_obj = s3.get_object(Bucket = bucket,Key= file_name)
                    full_content = s3_obj['Body'].read().decode('utf-8')
                    file_uri = f"s3://{bucket}/{file_name}"
                    print(f"Successfully retrieved file from S3: {file_uri}")
                    return {
                        'content': [full_content],
                        'uri': file_uri
                    }
                except Exception as e:
                    print(f"Error reading file content from S3: {e}")
                    return {
                        'content': full_content,
                        'uri': file_uri
                    }


        else:
            return {
                'content': "No relevant document found in the knowledge base.",
                'uri': None
            }
    except ClientError as e:
        print(f"Error fetching knowledge base docs: {e}")
        return {
            'content': [],
            'uri': None
        }


# Function to summarize and categorize using claude 3
def summarize_and_categorize(key,content):
    try:
        response = bedrock_invoke.invoke_model(
            modelId='anthropic.claude-3-sonnet-20240229-v1:0',
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 500,
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
        print(f"Raw llm output : {raw_response_body}")

        # Parse the raw response body
        try:
            result = json.loads(raw_response_body)
        except json.JSONDecodeError:
            print("Error: Response body is not valid JSON")
            return {
                "summary": "Error parsing response body",
                "tags": {"category": "unknown"}
            }

        # Validate 'content' field
        if 'content' not in result or not result['content']:
            print("Error: 'content' field is missing or empty")
            return {
                "summary": "Error generating summary",
                "tags": {"category": "unknown"}
            }

        # Extract and parse the text field
        text_content = result['content'][0].get('text', '')
        if not text_content:
            print("Error: 'text' field in 'content' is empty")
            return {
                "summary": "Error generating summary",
                "tags": {"category": "unknown"}
            }

        # Parse the nested JSON string in the 'text' field
        try:
            summary_and_tags = json.loads(text_content)
        except json.JSONDecodeError:
            print(f"Error parsing 'text' as JSON: {text_content}")
            return {
                "summary": "Error parsing nested JSON in 'text'",
                "tags": {"category": "unknown"}
            }

        summary_and_tags = json.loads(result['content'][0]['text'])
        creation_date = datetime.utcnow().strftime('%Y-%m-%d')

        # Validate the tags
        all_tags = get_all_tags()
        for tag, value in summary_and_tags['tags'].items():

            if tag == "creation_date":
                try:
                    datetime.strptime(value, "%Y-%m-%d")
                except ValueError:
                    print(f"Invalid creation_date format for {key}, resetting to blank.")
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
        print(f"Error generating summary and tags: {e}")
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
        # Check if the event is caused by the Lambda function itself
        if event['Records'][0]['eventSource'] == 'aws:s3' and \
           event['Records'][0]['eventName'].startswith('ObjectCreated:Copy'):
            print("Skipping event triggered by copy operation")


            return {
                'statusCode': 200,
                'body': json.dumps("Skipped event triggered by copy operation")
            }


    except:
        print("Issue checking for s3 action")


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
            if "Error generating summary" in summary_and_tags['summary']:
                return {
                    'statusCode': 500,
                    'body': json.dumps("Error generating summary and tags")
                }
            else:
                print(f"Summary and category : {summary_and_tags}")




            try:
                existing_metadata = get_metadata(bucket,key)
            except Exception as e:
                print(f"Error fetching metadata for {key}: {e}")
                return {
                    'statusCode': 500,
                    'body': json.dumps(f"Error fetching metadata for {key}: {e}")
                }

            # Generate new metadata fields

            new_metadata = {
                'summary': summary_and_tags['summary'],
                **{f"tag_{k}": v for k, v in summary_and_tags['tags'].items()}
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
