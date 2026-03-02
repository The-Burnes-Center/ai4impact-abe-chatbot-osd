from datetime import datetime
import json
import boto3
import os
import logging
import time

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

from langchain_aws import ChatBedrockConverse, BedrockEmbeddings
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper

GENERATE_RESPONSE_LAMBDA_NAME = os.environ['GENERATE_RESPONSE_LAMBDA_NAME']
BEDROCK_MODEL_ID = os.environ['BEDROCK_MODEL_ID']
TEST_CASES_BUCKET = os.environ['TEST_CASES_BUCKET']
EVAL_RESULTS_BUCKET = os.environ.get('EVAL_RESULTS_BUCKET', TEST_CASES_BUCKET)

s3_client = boto3.client('s3')
lambda_client = boto3.client('lambda')


def lambda_handler(event, context):
    try:
        chunk_key = event["chunk_key"]
        evaluation_id = event["evaluation_id"]
        logging.info(f"Processing chunk: {chunk_key} for evaluation: {evaluation_id}")
        test_cases = read_chunk_from_s3(s3_client, TEST_CASES_BUCKET, chunk_key)

        logging.info(f"Retrieved {len(test_cases)} test cases to evaluate")

        for idx, test_case in enumerate(test_cases):
            if 'question' not in test_case or 'expectedResponse' not in test_case:
                logging.error(f"Invalid test case at index {idx}: missing required fields")
                test_cases[idx] = {'question': f"Invalid test case {idx}", 'expectedResponse': ""}

        detailed_results = []
        total_similarity = 0
        total_relevance = 0
        total_correctness = 0
        total_context_precision = 0
        total_context_recall = 0
        total_response_relevancy = 0
        total_faithfulness = 0

        for idx, test_case in enumerate(test_cases):
            try:
                logging.info(f"Starting test case {idx+1}/{len(test_cases)}")

                if idx > 0:
                    time.sleep(0.5)

                result = process_test_case(idx, test_case)
                detailed_results.append(result)

                total_similarity += result['similarity']
                total_relevance += result['relevance']
                total_correctness += result['correctness']
                total_context_precision += result['context_precision']
                total_context_recall += result['context_recall']
                total_response_relevancy += result['response_relevancy']
                total_faithfulness += result['faithfulness']

                logging.info(f"Completed test case {idx+1}/{len(test_cases)} successfully")

            except Exception as e:
                logging.error(f"Error processing test case {idx+1}: {str(e)}")
                detailed_results.append({
                    'question': test_case.get('question', f"Question {idx+1}"),
                    'expectedResponse': test_case.get('expectedResponse', ''),
                    'actualResponse': 'Error during evaluation',
                    'similarity': 0.0,
                    'relevance': 0.0,
                    'correctness': 0.0,
                    'context_precision': 0.0,
                    'context_recall': 0.0,
                    'response_relevancy': 0.0,
                    'faithfulness': 0.0,
                    'error': str(e)
                })

        num_results = len(detailed_results)
        if num_results == 0:
            logging.warning(f"No test cases were successfully evaluated for chunk: {chunk_key}")
            partial_results = {
                "detailed_results": [],
                "total_similarity": 0,
                "total_relevance": 0,
                "total_correctness": 0,
                "num_test_cases": 0,
                "total_context_precision": 0,
                "total_context_recall": 0,
                "total_response_relevancy": 0,
                "total_faithfulness": 0
            }
        else:
            partial_results = {
                "detailed_results": detailed_results,
                "total_similarity": total_similarity,
                "total_relevance": total_relevance,
                "total_correctness": total_correctness,
                "num_test_cases": num_results,
                "total_context_precision": total_context_precision,
                "total_context_recall": total_context_recall,
                "total_response_relevancy": total_response_relevancy,
                "total_faithfulness": total_faithfulness
            }

        partial_result_key = f"evaluations/{evaluation_id}/partial_results/{os.path.basename(chunk_key)}"
        try:
            s3_client.put_object(
                Bucket=TEST_CASES_BUCKET,
                Key=partial_result_key,
                Body=json.dumps(partial_results)
            )
            logging.info(f"Successfully wrote partial results to S3: {TEST_CASES_BUCKET}/{partial_result_key}")
        except Exception as e:
            logging.error(f"Error writing partial results to S3: {str(e)}")

        return {
            "partial_result_key": partial_result_key,
            "evaluation_id": evaluation_id,
            "num_test_cases": num_results
        }

    except Exception as e:
        logging.error(f"Error in evaluation Lambda: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e),
                'evaluation_id': event.get("evaluation_id")
            }),
            'evaluation_id': event.get("evaluation_id")
        }


def process_test_case(idx, test_case):
    question = test_case['question']
    expected_response = test_case['expectedResponse']

    logging.info(f"Processing test case {idx+1}: {question[:50]}...")

    actual_response = invoke_generate_response_lambda(lambda_client, question)
    if not actual_response:
        logging.warning(f"Empty response received for question: {question[:50]}...")
        actual_response = "No response generated."

    retrieved_context = invoke_generate_response_lambda(lambda_client, question, get_context_only=True)

    logging.info(f"Evaluating response for test case {idx+1}")

    max_retries = 3
    retry_delay = 2
    result = None

    for retry in range(max_retries):
        try:
            result = evaluate_with_ragas(question, expected_response, actual_response, retrieved_context)
            break
        except Exception as e:
            if retry < max_retries - 1:
                logging.warning(f"Retry {retry+1}/{max_retries} for RAGAS evaluation: {str(e)}")
                time.sleep(retry_delay)
            else:
                raise

    logging.info(f"RAGAS evaluation complete with scores: similarity={result['scores']['similarity']:.2f}, "
                 f"relevance={result['scores']['relevance']:.2f}, correctness={result['scores']['correctness']:.2f}")

    return {
        'question': question,
        'expectedResponse': expected_response,
        'actualResponse': actual_response,
        'similarity': result['scores']['similarity'],
        'relevance': result['scores']['relevance'],
        'correctness': result['scores']['correctness'],
        'context_precision': result['scores']['context_precision'],
        'context_recall': result['scores']['context_recall'],
        'response_relevancy': result['scores']['response_relevancy'],
        'faithfulness': result['scores']['faithfulness'],
        'retrieved_context': retrieved_context
    }


def invoke_generate_response_lambda(lambda_client, question, get_context_only=False):
    try:
        logging.info(f"Invoking generate-response Lambda for question: {question[:50]}...")

        payload = {'userMessage': question, 'chatHistory': []}
        if get_context_only:
            payload['get_context_only'] = True

        response = lambda_client.invoke(
            FunctionName=GENERATE_RESPONSE_LAMBDA_NAME,
            InvocationType='RequestResponse',
            Payload=json.dumps(payload),
        )

        logging.info("Response received from Lambda")
        payload_bytes = response['Payload'].read().decode('utf-8')
        result = json.loads(payload_bytes)

        if result.get('statusCode', 200) != 200:
            logging.error(f"Error response from Lambda: {result}")
            return ""

        body = json.loads(result.get('body', '{}'))

        if get_context_only:
            context = body.get('context', '')
            logging.info(f"Received context of length: {len(context)} characters")
            return context
        else:
            response_text = body.get('modelResponse', '')
            logging.info(f"Received response of length: {len(response_text)} characters")
            return response_text
    except Exception as e:
        logging.error(f"Error invoking generateResponseLambda: {str(e)}")
        return ""


def evaluate_with_ragas(question, expected_response, actual_response, retrieved_context):
    from ragas import evaluate
    from ragas.metrics import (
        answer_correctness,
        answer_similarity,
        answer_relevancy,
        context_precision,
        context_recall,
        faithfulness,
    )
    from ragas import SingleTurnSample, EvaluationDataset

    metrics = [answer_correctness, answer_similarity, answer_relevancy, context_precision, context_recall, faithfulness]

    if not actual_response:
        actual_response = "No response"
    if not expected_response:
        expected_response = "No expected response provided"
    if not retrieved_context:
        retrieved_context = "No context retrieved"

    logging.info(f"RAGAS inputs - Question: {question[:50]}...")
    logging.info(f"RAGAS inputs - Answer length: {len(actual_response)}")
    logging.info(f"RAGAS inputs - Reference length: {len(expected_response)}")
    logging.info(f"RAGAS inputs - Context length: {len(retrieved_context)}")

    sample = SingleTurnSample(
        user_input=question,
        response=actual_response,
        reference=expected_response,
        retrieved_contexts=[retrieved_context],
    )
    dataset = EvaluationDataset(samples=[sample])

    evaluator_llm = LangchainLLMWrapper(ChatBedrockConverse(
        region_name="us-east-1",
        model=BEDROCK_MODEL_ID,
        temperature=0.0,
    ))
    evaluator_embeddings = LangchainEmbeddingsWrapper(BedrockEmbeddings(
        region_name="us-east-1",
        model_id='amazon.titan-embed-text-v2:0',
    ))

    logging.info("Starting RAGAS evaluation")
    result = evaluate(dataset=dataset, metrics=metrics, llm=evaluator_llm, embeddings=evaluator_embeddings)
    scores = result.to_pandas().iloc[0]

    import pandas as pd
    if scores.isnull().values.any():
        nan_metrics = [col for col in scores.index if pd.isna(scores[col])]
        error_msg = f"RAGAS evaluation returned NaN scores for: {', '.join(nan_metrics)}"
        logging.error(error_msg)
        raise ValueError(error_msg)

    logging.info("RAGAS evaluation completed successfully")
    return {
        "status": "success",
        "scores": {
            "similarity": float(scores.get('semantic_similarity', 0)),
            "relevance": float(scores.get('answer_relevancy', 0)),
            "correctness": float(scores.get('answer_correctness', 0)),
            "context_precision": float(scores.get('context_precision', 0)),
            "context_recall": float(scores.get('context_recall', 0)),
            "response_relevancy": float(scores.get('answer_relevancy', 0)),
            "faithfulness": float(scores.get('faithfulness', 0)),
        }
    }


def read_chunk_from_s3(s3_client, bucket_name, key):
    try:
        logging.info(f"Reading file from S3: {bucket_name}/{key}")
        response = s3_client.get_object(Bucket=bucket_name, Key=key)
        content = response['Body'].read().decode('utf-8')
        data = json.loads(content)
        logging.info(f"Successfully read file from S3, size: {len(content)} bytes")
        return data
    except Exception as e:
        logging.error(f"Error reading file from S3: {str(e)}")
        raise
