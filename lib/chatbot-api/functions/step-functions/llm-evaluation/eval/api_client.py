import os
import json
import logging
import asyncio
import websockets
import uuid
from typing import Dict, List, Optional, Any

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class ChatbotAPIClient:
    """Client for interacting with the Chatbot WebSocket API"""
    
    def __init__(self, api_url: Optional[str] = None):
        """
        Initialize the API client
        
        Args:
            api_url: Optional WebSocket API URL. If not provided, uses the environment variable.
        """
        self.api_url = api_url or os.environ.get('CHATBOT_API_URL')
        if not self.api_url:
            raise ValueError("No API URL provided and CHATBOT_API_URL environment variable not set")
        
        # Log the original URL for debugging
        logger.info(f"Original API URL: {self.api_url}")
        
        # Ensure websocket URL starts with 'wss://'
        if not self.api_url.startswith('wss://'):
            # If it's a CloudFront URL, convert to websocket URL
            if self.api_url.startswith('https://'):
                self.api_url = 'wss://' + self.api_url.replace('https://', '')
            else:
                self.api_url = 'wss://' + self.api_url
        
        # Ensure URL ends with /prod (WebSocket stage)
        if not self.api_url.endswith('/prod'):
            self.api_url = self.api_url.rstrip('/') + '/prod'
            
        logger.info(f"Initialized ChatbotAPIClient with URL: {self.api_url}")

    async def get_chatbot_response(self, 
                                  question: str, 
                                  chat_history: List[Dict[str, str]] = None,
                                  user_id: str = None,
                                  session_id: str = None) -> Dict[str, Any]:
        """
        Get a response from the chatbot API
        
        Args:
            question: The user's question
            chat_history: Optional chat history
            user_id: Optional user ID (defaults to a UUID)
            session_id: Optional session ID (defaults to a UUID)
            
        Returns:
            Dictionary with response text, sources, and any error
        """
        if chat_history is None:
            chat_history = []
            
        # Generate UUIDs for user_id and session_id if not provided
        user_id = user_id or f"eval_user_{str(uuid.uuid4())}"
        session_id = session_id or f"eval_session_{str(uuid.uuid4())}"
        
        # Prepare response data
        response_text = ""
        sources = []
        error = None
        
        try:
            # Connect to WebSocket
            logger.info(f"Connecting to WebSocket at {self.api_url}")
            try:
                async with websockets.connect(self.api_url, ping_timeout=30, close_timeout=30) as websocket:
                    # Prepare the message payload
                    message = {
                        "action": "getChatbotResponse",
                        "data": {
                            "userMessage": question,
                            "chatHistory": chat_history,
                            "user_id": user_id,
                            "session_id": session_id
                        }
                    }
                    
                    # Send the message
                    await websocket.send(json.dumps(message))
                    logger.info(f"Sent message for question: {question[:50]}...")
                    
                    # Process the response
                    incoming_metadata = False
                    
                    # Set a timeout for the WebSocket response
                    timeout = 60  # seconds
                    
                    # Keep receiving messages until we get the end marker or an error
                    while True:
                        try:
                            # Wait for a response with timeout
                            data = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                            
                            # Check for error
                            if "<!ERROR!>:" in data:
                                error = data.replace("<!ERROR!>:", "").strip()
                                logger.error(f"Received error from WebSocket: {error}")
                                break
                            
                            # Check for end of message marker
                            if data == "!<|EOF_STREAM|>!":
                                incoming_metadata = True
                                continue
                            
                            if not incoming_metadata:
                                # Regular response text
                                response_text += data
                            else:
                                # Source metadata
                                try:
                                    sources = json.loads(data)
                                    # Normalize source titles if needed
                                    sources = [
                                        {
                                            "title": s.get("title") or s["uri"].split("/")[-1],
                                            "uri": s["uri"]
                                        }
                                        for s in sources
                                    ]
                                    # Once we've received the sources, we're done
                                    break
                                except json.JSONDecodeError:
                                    logger.warning(f"Failed to parse source data: {data}")
                        
                        except asyncio.TimeoutError:
                            logger.warning("WebSocket response timed out")
                            error = "Response timed out"
                            break
                    
                    logger.info(f"Completed response, text length: {len(response_text)}, sources: {len(sources)}")
            except websockets.exceptions.WebSocketException as wse:
                logger.error(f"WebSocket connection error: {str(wse)}")
                error = f"WebSocket connection error: {str(wse)}"
            
        except Exception as e:
            logger.error(f"Error getting chatbot response: {str(e)}")
            error = str(e)
        
        return {
            "response": response_text if response_text else "No response received. Please check the WebSocket API configuration.",
            "sources": sources,
            "error": error
        }

    def assemble_history(self, history: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        """
        Convert internal chat history format to the format expected by the API
        
        Args:
            history: List of message dictionaries
            
        Returns:
            List of dictionaries in the format expected by the API
        """
        formatted_history = []
        for message in history:
            if message.get("question") and message.get("answer"):
                formatted_history.append({
                    "user": message["question"],
                    "chatbot": message["answer"]
                })
        return formatted_history

async def get_app_response(question: str, app_modules_cache=None) -> Dict[str, Any]:
    """
    Get a response from the app's API for evaluation
    
    Args:
        question: The user question
        app_modules_cache: Not used, included for compatibility
        
    Returns:
        Dictionary with response and retrieved contexts
    """
    try:
        # Initialize the API client
        client = ChatbotAPIClient()
        
        # Get the response
        response_data = await client.get_chatbot_response(question)
        
        # Check for errors
        if response_data.get("error"):
            logger.error(f"Error from API: {response_data['error']}")
            return {
                "response": f"API Error: {response_data['error']}",
                "retrieved_contexts": [],
                "sources": []
            }
        
        # Extract source URIs as retrieved contexts
        # Normally we'd have the actual retrieved contexts, but the API doesn't return them directly
        # So we'll use the source URIs as a proxy
        retrieved_contexts = [source["uri"] for source in response_data.get("sources", [])]
        
        # Log success for debugging
        logger.info(f"Successfully retrieved response. Length: {len(response_data['response'])}, Sources: {len(retrieved_contexts)}")
        
        return {
            "response": response_data["response"],
            "retrieved_contexts": retrieved_contexts,
            "sources": response_data.get("sources", [])
        }
    
    except Exception as e:
        logger.error(f"Error getting app response: {str(e)}")
        # Make the error more clear in the response for debugging
        return {
            "response": f"Error: {str(e)}",
            "retrieved_contexts": [],
            "sources": []
        } 