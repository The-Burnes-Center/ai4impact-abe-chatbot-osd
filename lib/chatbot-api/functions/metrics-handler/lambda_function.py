import os
import boto3
import json
from datetime import datetime, timedelta
from decimal import Decimal

# Initialize CloudWatch client
cloudwatch = boto3.client('cloudwatch', region_name='us-east-1')

# Metric namespaces
LOGINS_NAMESPACE = 'Chatbot/DailyLogins'
CHATBOT_USE_NAMESPACE = 'Chatbot/Usage'

def lambda_handler(event, context):
    """Handle metrics API requests"""
    route_key = event.get('routeKey', '')
    raw_path = event.get('rawPath', '')
    
    # Handle CORS preflight
    if 'OPTIONS' in route_key:
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
            },
            'body': json.dumps({})
        }
    
    # Route to appropriate handler
    if raw_path == '/daily-logins':
        if 'POST' in route_key:
            return handle_increment_login(event)
        elif 'GET' in route_key:
            return handle_get_daily_logins(event)
    elif raw_path == '/chatbot-use':
        if 'POST' in route_key:
            return handle_save_chatbot_use(event)
        elif 'GET' in route_key:
            return handle_get_chatbot_use(event)
    
    return {
        'statusCode': 404,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
        },
        'body': json.dumps({'error': 'Not found'})
    }


def handle_increment_login(event):
    """Increment daily login count by publishing a metric"""
    try:
        # Publish metric to CloudWatch (without Date dimension, we'll aggregate by timestamp)
        cloudwatch.put_metric_data(
            Namespace=LOGINS_NAMESPACE,
            MetricData=[
                {
                    'MetricName': 'DailyLogins',
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.now()
                }
            ]
        )
        
        today = datetime.now().date().isoformat()
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'message': 'Login count incremented', 'date': today})
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'error': str(e)})
        }


def handle_get_daily_logins(event):
    """Get daily login counts for a date range"""
    try:
        # Parse query parameters (HTTP API v2 format)
        query_params = event.get('queryStringParameters') or {}
        if query_params is None:
            query_params = {}
        start_date_str = query_params.get('startDate')
        end_date_str = query_params.get('endDate')
        
        # Default to last 30 days if not provided
        if not end_date_str:
            end_date = datetime.now()
        else:
            end_date = datetime.fromisoformat(end_date_str)
        
        if not start_date_str:
            start_date = end_date - timedelta(days=30)
        else:
            start_date = datetime.fromisoformat(start_date_str)
        
        # Query CloudWatch Metrics using get_metric_data for better aggregation
        # We'll query all metrics and aggregate by date
        response = cloudwatch.get_metric_statistics(
            Namespace=LOGINS_NAMESPACE,
            MetricName='DailyLogins',
            StartTime=start_date,
            EndTime=end_date,
            Period=86400,  # 1 day in seconds
            Statistics=['Sum']
        )
        
        # Process results into expected format
        logins = []
        if 'Datapoints' in response:
            # Group by date and sum values
            daily_counts = {}
            for datapoint in response['Datapoints']:
                # Convert UTC timestamp to date string
                timestamp = datapoint['Timestamp']
                if isinstance(timestamp, datetime):
                    date_str = timestamp.date().isoformat()
                else:
                    # Handle string timestamps
                    date_str = datetime.fromisoformat(str(timestamp).replace('Z', '+00:00')).date().isoformat()
                
                if date_str not in daily_counts:
                    daily_counts[date_str] = 0
                daily_counts[date_str] += int(datapoint['Sum'])
            
            # Convert to list format expected by frontend
            for date_str in sorted(daily_counts.keys()):
                logins.append({
                    'Timestamp': date_str,
                    'Count': str(daily_counts[date_str])
                })
        
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'logins': logins})
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'error': str(e)})
        }


def handle_save_chatbot_use(event):
    """Save chatbot interaction by publishing a metric"""
    try:
        body = json.loads(event.get('body', '{}'))
        interaction_data = body.get('interaction_data', {})
        
        # Publish metric to CloudWatch
        cloudwatch.put_metric_data(
            Namespace=CHATBOT_USE_NAMESPACE,
            MetricData=[
                {
                    'MetricName': 'ChatbotInteractions',
                    'Value': 1,
                    'Unit': 'Count',
                    'Timestamp': datetime.now()
                }
            ]
        )
        
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'message': 'Chatbot interaction saved'})
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'error': str(e)})
        }


def handle_get_chatbot_use(event):
    """Get chatbot usage data for a date range"""
    try:
        # Parse query parameters (HTTP API v2 format)
        query_params = event.get('queryStringParameters') or {}
        if query_params is None:
            query_params = {}
        start_time_str = query_params.get('startTime')
        end_time_str = query_params.get('endTime')
        next_page_token = query_params.get('nextPageToken')
        
        # Parse dates
        if start_time_str:
            start_time = datetime.fromisoformat(start_time_str.replace('Z', '+00:00'))
        else:
            start_time = datetime.now() - timedelta(days=30)
        
        if end_time_str:
            end_time = datetime.fromisoformat(end_time_str.replace('Z', '+00:00'))
        else:
            end_time = datetime.now()
        
        # Query CloudWatch Metrics
        response = cloudwatch.get_metric_statistics(
            Namespace=CHATBOT_USE_NAMESPACE,
            MetricName='ChatbotInteractions',
            StartTime=start_time,
            EndTime=end_time,
            Period=3600,  # 1 hour periods for more granular data
            Statistics=['Sum']
        )
        
        # Convert to format expected by frontend
        items = []
        if 'Datapoints' in response:
            for datapoint in response['Datapoints']:
                # Create an item for each interaction (if Sum > 0)
                count = int(datapoint['Sum'])
                for _ in range(count):
                    items.append({
                        'Timestamp': datapoint['Timestamp'].isoformat()
                    })
        
        # Sort by timestamp
        items.sort(key=lambda x: x['Timestamp'])
        
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({
                'Items': items,
                'Count': len(items)
            })
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'error': str(e)})
        }

