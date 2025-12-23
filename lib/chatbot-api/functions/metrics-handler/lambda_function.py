import os
import boto3
from botocore.exceptions import ClientError
import json
from datetime import datetime, timedelta
from collections import defaultdict

DDB_TABLE_NAME = os.environ["DDB_TABLE_NAME"]
dynamodb = boto3.resource("dynamodb", region_name='us-east-1')
table = dynamodb.Table(DDB_TABLE_NAME)

def get_unique_users_count():
    """Get total count of unique users from sessions table"""
    try:
        unique_users = set()
        last_evaluated_key = None
        
        while True:
            if last_evaluated_key:
                response = table.scan(
                    ProjectionExpression='user_id',
                    ExclusiveStartKey=last_evaluated_key
                )
            else:
                response = table.scan(
                    ProjectionExpression='user_id'
                )
            
            items = response.get("Items", [])
            for item in items:
                unique_users.add(item['user_id'])
            
            last_evaluated_key = response.get("LastEvaluatedKey")
            if not last_evaluated_key:
                break
        
        return len(unique_users)
    except Exception as e:
        print(f"Error getting unique users count: {e}")
        return 0

def get_traffic_metrics():
    """Get traffic metrics including total sessions, messages, and daily breakdown"""
    try:
        total_sessions = 0
        total_messages = 0
        daily_stats = defaultdict(lambda: {"sessions": 0, "messages": 0})
        unique_users_daily = defaultdict(set)
        
        last_evaluated_key = None
        
        while True:
            if last_evaluated_key:
                response = table.scan(
                    ExclusiveStartKey=last_evaluated_key
                )
            else:
                response = table.scan()
            
            items = response.get("Items", [])
            for item in items:
                total_sessions += 1
                
                # Count messages in chat_history
                chat_history = item.get('chat_history', [])
                message_count = len(chat_history)
                total_messages += message_count
                
                # Extract date from timestamp
                timestamp = item.get('time_stamp', '')
                if timestamp:
                    try:
                        # Parse timestamp and extract date
                        # Handle different timestamp formats
                        if 'T' in timestamp:
                            dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00').split('.')[0])
                        else:
                            dt = datetime.strptime(timestamp.split('.')[0], '%Y-%m-%d %H:%M:%S')
                        date_key = dt.strftime('%Y-%m-%d')
                        daily_stats[date_key]["sessions"] += 1
                        daily_stats[date_key]["messages"] += message_count
                        unique_users_daily[date_key].add(item.get('user_id'))
                    except Exception as parse_error:
                        print(f"Error parsing timestamp {timestamp}: {parse_error}")
                        pass
            
            last_evaluated_key = response.get("LastEvaluatedKey")
            if not last_evaluated_key:
                break
        
        # Convert daily stats to list format
        daily_breakdown = []
        for date, stats in sorted(daily_stats.items()):
            daily_breakdown.append({
                "date": date,
                "sessions": stats["sessions"],
                "messages": stats["messages"],
                "unique_users": len(unique_users_daily[date])
            })
        
        return {
            "total_sessions": total_sessions,
            "total_messages": total_messages,
            "daily_breakdown": daily_breakdown
        }
    except Exception as e:
        print(f"Error getting traffic metrics: {e}")
        return {
            "total_sessions": 0,
            "total_messages": 0,
            "daily_breakdown": []
        }

def lambda_handler(event, context):
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,OPTIONS'
    }
    
    # Check for admin authorization
    admin = False
    try:
        claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
        if claims:
            roles = json.loads(claims.get('custom:role', '[]'))
            if any('Admin' in role for role in roles):
                admin = True
    except Exception as e:
        print(f"Error checking admin status: {e}")
    
    # Handle OPTIONS request
    http_method = event.get('routeKey', '')
    if 'OPTIONS' in http_method:
        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps({})
        }
    
    # Only allow GET requests from admins
    if 'GET' not in http_method:
        return {
            'statusCode': 405,
            'headers': headers,
            'body': json.dumps('Method Not Allowed')
        }
    
    if not admin:
        return {
            'statusCode': 403,
            'headers': headers,
            'body': json.dumps('Forbidden: Admin access required')
        }
    
    try:
        # Get metrics
        unique_users = get_unique_users_count()
        traffic_metrics = get_traffic_metrics()
        
        response_data = {
            "unique_users": unique_users,
            "total_sessions": traffic_metrics["total_sessions"],
            "total_messages": traffic_metrics["total_messages"],
            "daily_breakdown": traffic_metrics["daily_breakdown"]
        }
        
        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps(response_data)
        }
    except Exception as e:
        print(f"Error in lambda_handler: {e}")
        import traceback
        traceback.print_exc()
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({
                'error': str(e),
                'message': 'Failed to retrieve metrics'
            })
        }

