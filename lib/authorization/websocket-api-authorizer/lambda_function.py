import json
from jose import jwt, jwk
from jose.utils import base64url_decode
import requests
import time
import os


def lambda_handler(event, context):
    try:
        query_params = event.get('queryStringParameters') or {}
        token = query_params.get('Authorization')
        if not token:
            raise Exception("Unauthorized")

        user_pool_id = os.environ.get('USER_POOL_ID')
        region = 'us-east-1'
        app_client_id = os.environ.get('APP_CLIENT_ID')
        keys_url = f'https://cognito-idp.{region}.amazonaws.com/{user_pool_id}/.well-known/jwks.json'

        response = requests.get(keys_url, timeout=5)
        response.raise_for_status()
        keys = response.json()['keys']
        key_dict = {key['kid']: json.dumps(key) for key in keys}

        headers = jwt.get_unverified_headers(token)
        kid = headers.get('kid')
        if not kid or kid not in key_dict:
            raise Exception("Unauthorized")

        key = json.loads(key_dict[kid])
        public_key = jwk.construct(key)

        message, encoded_signature = str(token).rsplit('.', 1)
        decoded_signature = base64url_decode(encoded_signature.encode('utf-8'))

        if not public_key.verify(message.encode("utf8"), decoded_signature):
            print('Signature verification failed')
            raise Exception("Unauthorized")

        claims = jwt.get_unverified_claims(token)

        if time.time() > claims['exp']:
            print('Token is expired')
            raise Exception("Unauthorized")

        if claims['aud'] != app_client_id:
            print('Token was not issued for this audience')
            raise Exception("Unauthorized")

        principalId = claims['sub']
        role = claims.get('custom:role', '')

        return {
            'principalId': principalId,
            'context': {'role': role},
            'policyDocument': {
                'Version': '2012-10-17',
                'Statement': [{
                    'Action': 'execute-api:Invoke',
                    'Effect': 'Allow',
                    'Resource': event['methodArn']
                }]
            }
        }
    except Exception as e:
        print(f'Authorization failed: {type(e).__name__}')
        raise Exception("Unauthorized")
