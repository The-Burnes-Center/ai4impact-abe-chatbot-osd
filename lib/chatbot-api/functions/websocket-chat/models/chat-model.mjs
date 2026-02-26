import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  InvokeModelCommand
} from "@aws-sdk/client-bedrock-runtime";

/** Primary chat model adapter. Model ID from PRIMARY_MODEL_ID (e.g. Claude Sonnet 4/4.5). */
export default class ClaudeModel{
  constructor(modelId) {
    this.client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
    this.modelId = modelId || process.env.PRIMARY_MODEL_ID || "us.anthropic.claude-sonnet-4-20250514-v1:0";
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
      // System prompt as array with cache_control to enable Bedrock prompt caching.
      // The ~4K token system prompt is cached between requests, reducing latency
      // by up to 85% and input token costs by up to 90% on cache hits.
      // Cache TTL is 5 minutes (resets on each hit) for Claude Sonnet 4.
      "system": [{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }],
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
    },
        {
        "name": "query_contract_index",
        "description": "Search the Statewide Contract Index (SWC Index). Each row contains 32 columns: Contract_ID, Blanket_Number, Statewide_Contract_Description, Master_Blanket_Contract_EndDate, CUG_Keywords, Agency, Purchaser_Category_Manager, Purchaser_Email, Purchaser_Phone, Purchaser_Contact, Vendor_Number, Vendor_Name, Vendor_Contact_Name, Vendor_Email_Address, Vendor_Phone_Number, Vendor_Fax_Number, Vendor_Address_Line_1, Vendor_Address_Line_2, Vendor_City, Vendor_State, Vendor_Zip, Punchout_Enabled, Solicitation_Enabled, Group_Blanket_Release_Type, RPA_Release_Allowed, Vendor_Certificates (e.g. 'MBE, SDO, WBE'), CategoryManager_1_Contact, CategoryManager_1_Email, CategoryManager_1_Phone, CategoryManager_2_Contact, CategoryManager_2_Email, CategoryManager_2_Phone. Returns matching rows (with all columns) or counts. Matching is punctuation-insensitive. Results include total_matches and unique_vendors counts.",
        "input_schema": {
            "type": "object",
            "properties": {
                "free_text": { "type": "string", "description": "Broad search across description, CUG keywords, vendor name, agency, contract ID, blanket number, purchaser, punchout, and vendor certificates." },
                "vendor_name": { "type": "string", "description": "Filter by vendor name (punctuation-insensitive partial match)." },
                "agency": { "type": "string", "description": "Filter by agency (partial match)." },
                "contract_id": { "type": "string", "description": "Filter by contract ID, e.g. 'ITS75' (partial match)." },
                "blanket_number": { "type": "string", "description": "Filter by blanket number (partial match)." },
                "punchout_enabled": { "type": "boolean", "description": "Filter to contracts with punchout enabled (true) or not (false)." },
                "certification": { "type": "string", "description": "Filter by vendor certification type found in Vendor_Certificates column (e.g. 'SDO', 'MBE', 'WBE', 'SBPP'). Server-side filter — use with count_only for accurate certification counts." },
                "count_only": { "type": "boolean", "description": "If true, return only total_matches (row count) and unique_vendors (deduplicated vendor count), no row data. Use for 'how many' questions." },
                "date_to": { "type": "string", "description": "Filter contracts ending on or before this date (YYYY-MM-DD)." },
                "limit": { "type": "integer", "description": "Max unique vendor rows to return (default 500). Only lower this if you want a brief sample.", "default": 500 }
            },
            "required": []
        }
    },
        {
        "name": "query_trade_index",
        "description": "Search the Trade Contract Index for trade-specific contract data: trades vendors (HVAC, plumbing, electrical, painting, etc.) and their details. Returns matching rows or a count. Matching is punctuation-insensitive.",
        "input_schema": {
            "type": "object",
            "properties": {
                "free_text": { "type": "string", "description": "Search across all columns in the trade index (punctuation-insensitive partial match)." },
                "vendor_name": { "type": "string", "description": "Filter by vendor name (punctuation-insensitive partial match)." },
                "contract_id": { "type": "string", "description": "Filter by contract ID or number (partial match)." },
                "count_only": { "type": "boolean", "description": "If true, return only the total count of matching rows. Use for 'how many' questions." },
                "limit": { "type": "integer", "description": "Max rows to return (default 500).", "default": 500 }
            },
            "required": []
        }
    }
      ],
    };

    const command = new InvokeModelWithResponseStreamCommand({ body: JSON.stringify(payload), contentType: 'application/json', modelId: this.modelId });
    const apiResponse = await this.client.send(command);
    return apiResponse.body

  }

  async getResponse(system, history, message, { maxTokens = 2048 } = {}) {
    const hist = this.assembleHistory(history,message);
    const payload = {
      "anthropic_version": "bedrock-2023-05-31",
      "system": [{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }],
      "max_tokens": maxTokens,
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
