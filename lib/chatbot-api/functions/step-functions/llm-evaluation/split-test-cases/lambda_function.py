import boto3
import csv
import io
import os
import uuid
import json
from datetime import datetime

TEST_CASE_BUCKET = os.environ['TEST_CASES_BUCKET']

def lambda_handler(event, context):
    s3_client = boto3.client('s3')
    test_cases_key = event.get('test_cases_key')
    if not test_cases_key:
        # Fallback to old parameter name for backward compatibility
        test_cases_key = event.get('testCasesKey')
        if not test_cases_key:
            raise ValueError("test_cases_key parameter is required in the event.")
    
    print("event: ", event)
    eval_name = event.get('evaluation_name')
    if not eval_name:
        # Fallback to old parameter name for backward compatibility
        eval_name = event.get('evalName')
    print("eval_name: ", eval_name)
    if not eval_name:
        eval_name = f"Evaluation on {str(datetime.now())}"

    # Use provided evaluation_id or generate a new one
    eval_id = event.get('evaluation_id', str(uuid.uuid4()))
    
    # Read test cases from S3 
    test_cases = read_test_cases_from_s3(s3_client, TEST_CASE_BUCKET, test_cases_key)
    
    # Split into chunks
    chunk_size = 15  # Adjust based on testing
    chunks = [test_cases[i:i + chunk_size] for i in range(0, len(test_cases), chunk_size)]
    chunk_infos = save_chunks_to_s3(s3_client, eval_id, chunks)
     
    return {
        'chunk_keys': chunk_infos,
        'evaluation_id': eval_id,
        'evaluation_name': eval_name,
        'test_cases_key': test_cases_key
    }

def read_test_cases_from_s3(s3_client, bucket_name, key):
    try:
        print(f"Reading test cases from S3 bucket: {bucket_name}, key: {key}")
        response = s3_client.get_object(Bucket=bucket_name, Key=key)
        content = response['Body'].read().decode('utf-8-sig')
        
        # Determine file type by extension
        file_extension = key.split('.')[-1].lower()
        print(f"Detected file extension: {file_extension}")
        
        if file_extension == 'json':
            # Process JSON file
            try:
                print("Processing JSON file")
                data = json.loads(content)
                # If it's an array, use it directly; otherwise look for a test_cases field
                if isinstance(data, list):
                    test_cases = data
                elif isinstance(data, dict) and 'test_cases' in data:
                    test_cases = data['test_cases']
                else:
                    raise ValueError("JSON file must contain an array of test cases or a test_cases field")
                    
                # Ensure each test case has the required fields
                for i, test_case in enumerate(test_cases):
                    if 'question' not in test_case or 'expectedResponse' not in test_case:
                        print(f"Missing required fields in test case {i}: {test_case}")
                        raise ValueError(f"Test case at index {i} must have 'question' and 'expectedResponse' fields")
                
                print(f"Successfully processed {len(test_cases)} test cases from JSON")
                return test_cases
            except json.JSONDecodeError as e:
                print(f"JSON decoding error: {str(e)}")
                raise ValueError(f"Invalid JSON file: {str(e)}")
        
        elif file_extension == 'csv':
            # Process CSV file
            try:
                print("Processing CSV file")
                test_cases = []
                csv_file = io.StringIO(content)
                reader = csv.DictReader(csv_file)
                
                # Check if the CSV has the necessary headers
                required_headers = ['question', 'expectedResponse']
                headers = reader.fieldnames
                
                if not headers:
                    print("CSV file has no headers")
                    raise ValueError("CSV file appears to be empty or has no headers")
                
                print(f"CSV headers: {headers}")
                missing_headers = [h for h in required_headers if h not in headers]
                if missing_headers:
                    print(f"Missing required headers: {missing_headers}")
                    
                    # If headers are missing but we have exactly 2 columns, assume they are question and expectedResponse
                    if len(headers) == 2:
                        print("Assuming first column is 'question' and second column is 'expectedResponse'")
                        # Reset the file position to start
                        csv_file.seek(0)
                        # Skip the header row
                        next(csv_file)
                        # Read as regular CSV
                        simple_reader = csv.reader(csv_file)
                        for row in simple_reader:
                            if len(row) >= 2:
                                test_cases.append({
                                    'question': row[0],
                                    'expectedResponse': row[1]
                                })
                    else:
                        raise ValueError(f"CSV file must have 'question' and 'expectedResponse' columns. Missing: {missing_headers}")
                else:
                    # Process with DictReader since headers match
                    for i, row in enumerate(reader):
                        # Check if row has required fields with non-empty values
                        if not row.get('question') or not row.get('expectedResponse'):
                            print(f"Row {i} missing values: {row}")
                            print(f"Skipping row {i} due to missing values")
                            continue
                        
                        test_cases.append({
                            'question': row['question'],
                            'expectedResponse': row['expectedResponse'],
                        })
                
                if not test_cases:
                    print("No valid test cases found in CSV")
                    raise ValueError("No valid test cases found in CSV file. Please check the format.")
                
                print(f"Successfully processed {len(test_cases)} test cases from CSV")
                return test_cases
            except Exception as e:
                print(f"Error processing CSV: {str(e)}")
                raise ValueError(f"Error processing CSV file: {str(e)}")
        
        else:
            print(f"Unsupported file extension: {file_extension}")
            raise ValueError(f"Unsupported file type: {file_extension}. Only JSON and CSV files are supported.")
    
    except Exception as e:
        print(f"Error reading test cases from S3: {str(e)}")
        raise

def save_chunks_to_s3(s3_client, evaluation_id, chunks):
    chunk_infos = []
    for idx, chunk in enumerate(chunks):
        chunk_key = f"evaluations/{evaluation_id}/chunks/chunk_{idx}.json"
        s3_client.put_object(
            Bucket=TEST_CASE_BUCKET,
            Key=chunk_key,
            Body=json.dumps(chunk)
        )
        chunk_infos.append({
            'chunk_key': chunk_key,
            'evaluation_id': evaluation_id
        })
    return chunk_infos
