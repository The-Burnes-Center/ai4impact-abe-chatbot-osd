import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  InvokeModelCommand
} from "@aws-sdk/client-bedrock-runtime";

export default class ClaudeModel{
  constructor() {
    this.client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
    this.modelId = process.env.PRIMARY_MODEL_ID || "us.anthropic.claude-sonnet-4-20250514-v1:0";
  }

  assembleHistory(hist, prompt) {
    var history = []
    hist.forEach((element) => {
      history.push({"role": "user", "content": [{"type": "text", "text": element.user}]});
      history.push({"role": "assistant", "content": [{"type": "text", "text": element.chatbot}]});
    });
    history.push({"role": "user", "content": [{"type": "text", "text": prompt}]});
    return history;
  }
  parseChunk(chunk) {
    if (chunk.type == 'content_block_delta') {
      if (chunk.delta.type == 'text_delta') {
        return chunk.delta.text
      }
      if (chunk.delta.type == "input_json_delta") {
        return chunk.delta.partial_json
      }
    } else if (chunk.type == "content_block_start") {
      if (chunk.content_block.type == "tool_use"){
        return chunk.content_block
      }
    } else if (chunk.type == "message_delta") {
      if (chunk.delta.stop_reason == "tool_use") {
        return chunk.delta
      } 
      else {
        return chunk.delta
      }
    }
    // Explicitly return null for unhandled chunk types (e.g., content_block_stop,
    // message_start, ping) to prevent undefined from corrupting string concatenation
    return null;
  }

  async getStreamedResponse(system, history) {
    
    const payload = {
      "anthropic_version": "bedrock-2023-05-31",
      "system": system,
      "max_tokens": 2048,
      "messages": history,
      "temperature": 0.01,
      "tools": [
        {
                "name": "query_db",
                "description": "Query a vector database for any information in your knowledge base. Try to use specific key words when possible.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The query you want to make to the vector database."
                        }
                    },
                    "required": [
                        "query"
                    ]
                }
              
          },
           {
        "name": "fetch_metadata",
        "description": "Retrieve metadata information from metadata.txt in the same knowledge bucket.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filter_key": {
                    "type": "string",
                    "description": "Filter metadata by a specific key."
                }
            },
            "required": ["filter_key"]
        }
    }
      ],
    };

    const command = new InvokeModelWithResponseStreamCommand({ body: JSON.stringify(payload), contentType: 'application/json', modelId: this.modelId });
    const apiResponse = await this.client.send(command);
    return apiResponse.body
    
  }
  
  async getResponse(system, history, message) {
    const hist = this.assembleHistory(history,message);
    const payload = {
      "anthropic_version": "bedrock-2023-05-31",
      "system": system,
      "max_tokens": 2048,
      "messages" : hist,
      "temperature" : 0,
    };

    // Guardrails must be top-level InvokeModelCommand parameters, NOT inside the body
    const commandParams = {
      contentType: "application/json",
      body: JSON.stringify(payload),
      modelId: this.modelId,
    };

    // Only add guardrails if the environment variable is configured
    const guardrailId = process.env.GUARDRAIL_ID;
    if (guardrailId) {
      commandParams.guardrailIdentifier = guardrailId;
      commandParams.guardrailVersion = process.env.GUARDRAIL_VERSION || "1";
    }

    const command = new InvokeModelCommand(commandParams);
    const apiResponse = await this.client.send(command);

    try {
      const parsed = JSON.parse(new TextDecoder().decode(apiResponse.body));
      return parsed.content[0].text;
    } catch (e) {
      console.error("Failed to parse Bedrock response:", e);
      return "I'm sorry, I encountered an issue processing your request. Please try again.";
    }
  }
}