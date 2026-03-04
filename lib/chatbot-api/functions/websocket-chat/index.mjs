import { ApiGatewayManagementApiClient, PostToConnectionCommand, DeleteConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { BedrockAgentRuntimeClient, RetrieveCommand as KBRetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"
import ClaudeModel from "./models/chat-model.mjs";
import { PROMPT } from './prompt.mjs';
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";



/*global fetch*/

const ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT;
const wsConnectionClient = new ApiGatewayManagementApiClient({ endpoint: ENDPOINT });

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const lambdaClient = new LambdaClient({});

// Static tools that don't depend on Excel schemas
const STATIC_TOOLS = [
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
      "required": ["query"]
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
];

/**
 * Load index metadata from the Index Registry DynamoDB table.
 * Called once at cold-start; cached for the Lambda instance lifetime.
 */
async function loadIndexMetadata() {
  const registryTable = process.env.INDEX_REGISTRY_TABLE;
  if (!registryTable) {
    console.warn("INDEX_REGISTRY_TABLE not set; no index metadata will be loaded.");
    return [];
  }
  try {
    const resp = await ddbClient.send(new QueryCommand({
      TableName: registryTable,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: "TOOLS" } },
    }));
    const indexes = [];
    for (const item of resp.Items || []) {
      const indexName = item.index_name?.S || item.sk?.S;
      const displayName = item.display_name?.S || indexName;
      const columns = (item.columns?.L || []).map(c => c.S || "");
      const rowCount = parseInt(item.row_count?.N || "0", 10);
      if (!indexName) continue;
      const description = item.description?.S || "";
      indexes.push({ index_name: indexName, display_name: displayName, description, columns, row_count: rowCount });
    }
    console.log(`Loaded metadata for ${indexes.length} index(es) from registry.`);
    return indexes;
  } catch (error) {
    console.error("Failed to load index metadata from registry:", error);
    return [];
  }
}

/**
 * Build a single query_excel_index tool definition from registry metadata.
 */
function buildExcelIndexTool(indexes) {
  if (indexes.length === 0) return null;
  const indexDescriptions = indexes.map((idx, i) => {
    const desc = idx.description ? ` — ${idx.description}` : "";
    return `${i + 1}. ${idx.index_name} — ${idx.display_name} (${idx.row_count} rows).${desc} Columns: ${idx.columns.join(", ")}`;
  }).join("\n");
  const enumValues = indexes.map(idx => idx.index_name);
  return {
    name: "query_excel_index",
    description: `Query structured Excel-based data indexes. Available indexes:\n\n${indexDescriptions}\n\nUse free_text for broad search across all columns. Use filters for column-specific matching (keys are exact column names from above). Matching is punctuation-insensitive.\n\nResponse fields: total_matches (row count), returned (rows in response), rows (array of row objects). When count_unique is set, response also includes unique_count and unique_column. When group_by is set, response includes groups (object mapping each value to its count). IMPORTANT: total_matches counts rows, NOT distinct entities. NEVER count items yourself from returned rows — ALWAYS use count_unique or group_by to get accurate counts from the tool.`,
    input_schema: {
      type: "object",
      properties: {
        index_name: { type: "string", enum: enumValues, description: "Which index to query." },
        free_text: { type: "string", description: "Search across all columns (punctuation-insensitive partial match)." },
        filters: { type: "object", description: "Column-specific filters as {column_name: search_value}. Use exact column names from the index description." },
        count_only: { type: "boolean", description: "If true, return only total counts, no row data. Use for 'how many' questions." },
        count_unique: { type: "string", description: "Column name to count distinct values for. Returns unique_count. Use for 'how many unique X' questions." },
        group_by: { type: "string", description: "Column name to group and count by. Returns groups object {value: count}. Use for breakdowns like 'how many per severity/state/category'. Can combine with filters." },
        limit: { type: "integer", description: "Max rows to return (default 500).", default: 500 },
      },
      required: ["index_name"],
    },
  };
}

/** Build the full tools array fresh from registry (called per-request). */
async function getAllTools() {
  const indexes = await loadIndexMetadata();
  const excelTool = buildExcelIndexTool(indexes);
  const tools = [...STATIC_TOOLS, ...(excelTool ? [excelTool] : [])];
  console.log(`Tools for request: ${tools.length} (${STATIC_TOOLS.length} static + ${excelTool ? 1 : 0} dynamic)`);
  return tools;
}

const fetchMetadata = async () => {
  const payload = JSON.stringify({});
  try {
    const command = new InvokeCommand({
      FunctionName: process.env.METADATA_RETRIEVAL_FUNCTION,
      Payload: Buffer.from(payload),
    });
    const response = await lambdaClient.send(command);

    // Parse the response payload
    const parsedPayload = JSON.parse(Buffer.from(response.Payload).toString());
    console.log("Parsed Result:", parsedPayload);
        // Extract metadata from the body field
    const metadata = JSON.parse(parsedPayload.body).metadata;
    console.log("Extracted Metadata:", metadata);

    return metadata;
  } catch (error) {
    console.error("Error fetching metadata:", error);
    return null;
  }
};

/** Invoke the generic Excel index query Lambda; returns string content for agent. */
async function invokeIndexQuery(payload) {
  const fnName = process.env.EXCEL_INDEX_QUERY_FUNCTION;
  if (!fnName) {
    return "Index query Lambda is not configured.";
  }
  try {
    const command = new InvokeCommand({
      FunctionName: fnName,
      Payload: Buffer.from(JSON.stringify(payload)),
      InvocationType: "RequestResponse",
    });
    const response = await lambdaClient.send(command);
    const raw = response.Payload ? Buffer.from(response.Payload).toString() : "{}";
    const parsed = JSON.parse(raw);
    const statusCode = parsed.statusCode ?? 500;
    const body = typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body ?? {});
    if (statusCode !== 200) {
      const err = JSON.parse(body);
      return err.error || "Index query failed.";
    }
    return body;
  } catch (error) {
    console.error("Index query error:", error);
    return "Could not query the index. Please try again or rephrase.";
  }
}

// Function to create dynamic prompt with metadata information and current date
const constructSysPrompt = async() => {
    const metadata = await fetchMetadata();
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'America/New_York'
    });

    let prompt = `${PROMPT}\n\n### Current Date\nToday is ${dateStr}. Use this to evaluate the recency and relevance of information in the retrieved documents.`;

    if(metadata){
        console.log("Metadata added successfully to prompt");
        prompt += `\n\n###Metadata information:\n${JSON.stringify(metadata,null,2)}`;
    } else {
        console.warn("Metadata information couldn't be added to prompt");
    }

    return prompt;
}

const SYS_PROMPT = await constructSysPrompt();

console.log(SYS_PROMPT);

const s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
/* Use the Bedrock Knowledge Base*/
async function retrieveKBDocs(query, knowledgeBase, knowledgeBaseID) {
  const input = { // RetrieveRequest
  knowledgeBaseId: knowledgeBaseID, // required
  retrievalQuery: { // KnowledgeBaseQuery
    text: query, // required
  }}


  try {
    const command = new KBRetrieveCommand(input);
    const response = await knowledgeBase.send(command);

    // filter the items based on confidence, we do not want LOW confidence results
    const confidenceFilteredResults = response.retrievalResults.filter(item =>
      item.score > 0.5
    )
    // console.log(confidenceFilteredResults)
    let fullContent = confidenceFilteredResults.map(item => item.content.text).join('\n');

    // Deduplicate by S3 key BEFORE generating pre-signed URLs
    // (pre-signed URLs are always unique, so dedup after generation never works)
    const seenKeys = new Set();
    const uniqueResults = confidenceFilteredResults.filter(item => {
      const s3Uri = item.location.s3Location.uri;
      if (seenKeys.has(s3Uri)) return false;
      seenKeys.add(s3Uri);
      return true;
    });

    const uniqueUris = await Promise.all(
      uniqueResults.map(async (item) => {
        const s3Uri = item.location.s3Location.uri;
        const bucketName = s3Uri.split("/")[2];
        const objectKey = s3Uri.split("/").slice(3).join("/");

        const ext = objectKey.split(".").pop()?.toLowerCase() || "";
        const contentTypeMap = {
          pdf: "application/pdf",
          html: "text/html",
          htm: "text/html",
          txt: "text/plain",
          csv: "text/csv",
          json: "application/json",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          doc: "application/msword",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xls: "application/vnd.ms-excel",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        };
        const contentType = contentTypeMap[ext] || "application/octet-stream";

        const signedUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: bucketName,
            Key: objectKey,
            ResponseContentDisposition: "inline",
            ResponseContentType: contentType,
          }),
          { expiresIn: 3600 }
        );

        return {
          title: objectKey + " (Bedrock Knowledge Base)",
          uri: signedUrl,
        };
      })
    );

    // console.log(fullContent);

    //Returning both full content and list of document URIs
    if (fullContent == '') {
      fullContent = `No knowledge available! This query is likely outside the scope of your knowledge.
      Please provide a general answer but do not attempt to provide specific details.`
      console.log("Warning: no relevant sources found")
    }

    return {
      content: fullContent,
      uris: uniqueUris
    };
  } catch (error) {
    console.error("Caught error: could not retrieve Knowledge Base documents:", error);
    // return no context
    return {
      content: `No knowledge available! There is something wrong with the search tool. Please tell the user to submit feedback.
      Please provide a general answer but do not attempt to provide specific details.`,
      uris: []
    };
  }
}

const getUserResponse = async (id, requestJSON) => {
  try {
    const data = requestJSON.data;    

    let userMessage = data.userMessage;
    const userId = data.user_id;
    const sessionId = data.session_id;
    const displayName = data.display_name || "";
    const agency = data.agency || "";
    const chatHistory = data.chatHistory;    
    
    const knowledgeBase = new BedrockAgentRuntimeClient({ region: 'us-east-1' });

    if (!process.env.KB_ID) {
      throw new Error("Knowledge Base ID is not found.");
    }        

    // Keep last 4 exchange pairs (8 messages + current prompt = 9 messages in context).
    // More history prevents context loss that causes the model to forget its own earlier answers.
    let claude = new ClaudeModel();
    let lastFiveMessages = chatHistory.slice(-4);
    
    let stopLoop = false;        
    let modelResponse = ''
    // Tracks whether the model has used at least one tool in this request.
    // Pre-tool text (e.g. follow-up questions before a search) is buffered
    // and NOT streamed to the user. Only text generated AFTER tool use
    // (the actual answer) is streamed token-by-token.
    let hasUsedTool = false;
    
    let history = claude.assembleHistory(lastFiveMessages, userMessage)    
    let fullDocs = {"content" : "", "uris" : []}
    const currentTools = await getAllTools();
    
    while (!stopLoop) {
      console.log("started new stream")
      history.forEach((historyItem) => {
        console.log(historyItem)
      })
      
      let stream;
      try {
        stream = await claude.getStreamedResponse(SYS_PROMPT, history, currentTools);
      } catch (modelError) {
        console.error("Model invocation failed:", modelError);
        let responseParams = {
          ConnectionId: id,
          Data: "<!ERROR!>: I'm sorry, something went wrong processing your request. Please try again or rephrase your question."
        }
        let command = new PostToConnectionCommand(responseParams);
        await wsConnectionClient.send(command);
        break; // Exit the while loop -- don't retry with same corrupted history
      }
      
      try {
        // store the full model response for saving to sessions later
        
        let toolInput = "";
        let assemblingInput = false
        let usingTool = false;
        let toolId;
        let skipChunk = true;
        // this is for when the assistant uses a tool
        let message = {};
        // this goes in that message
        let toolUse = {}
        // Track text streamed in THIS iteration (before tool use)
        // so we can include it in the assistant message and prevent Claude from repeating itself
        let currentIterationText = "";
        
        // iterate through each chunk from the model stream
        for await (const event of stream) {
          const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
          const parsedChunk = await claude.parseChunk(chunk);
          if (parsedChunk) {                      
            
            // this means that we got tool use input or stopped generating text
            if (parsedChunk.stop_reason) {
              if (parsedChunk.stop_reason == "tool_use") {
                assemblingInput = false;
                usingTool = true;
                skipChunk = true;
              } else {
                // end_turn: if no tools were used, flush buffered text to user now
                if (!hasUsedTool && currentIterationText.length > 0) {
                  try {
                    await wsConnectionClient.send(new PostToConnectionCommand({
                      ConnectionId: id, Data: currentIterationText
                    }));
                  } catch (err) {
                    console.error("Error flushing buffered text:", err);
                  }
                  modelResponse = currentIterationText;
                }
                stopLoop = true;
                break;
              }
            }
            
            // this means that we are collecting tool use input
            if (parsedChunk.type) {
             if (parsedChunk.type == "tool_use") {
               assemblingInput = true;
               toolId = parsedChunk.id
               message['role'] = 'assistant'
               message['content'] = []
               // Include any text Claude streamed before this tool_use block
               // so it appears in history and Claude won't repeat itself on the next iteration
               if (currentIterationText.length > 0) {
                 message['content'].push({
                   type: 'text',
                   text: currentIterationText
                 });
               }
               toolUse['name'] = parsedChunk.name;
               toolUse['type'] = 'tool_use'
               toolUse['id'] = toolId;
               toolUse['input'] = {'query' : ""}
             } 
            }
            
            if (usingTool) {
              hasUsedTool = true;
              console.log("tool input")
              console.log(toolInput);
              let query;
              try {
                query = JSON.parse(toolInput);
              } catch (parseError) {
                console.error("Failed to parse tool input JSON:", toolInput, parseError);
                message.content.push(toolUse);
                history.push(message);
                history.push({
                  "role": "user",
                  "content": [{
                    "type": "tool_result",
                    "tool_use_id": toolId,
                    "content": "Error: could not process the tool input. Please respond to the user without using tools."
                  }]
                });
                usingTool = false;
                toolInput = "";
                message = {};
                toolUse = {};
                continue;
              }
              
              let toolResultContent = "";
              
              if (toolUse.name === "query_db") {
                console.log("using knowledge bases!")
                try {
                  await wsConnectionClient.send(new PostToConnectionCommand({
                    ConnectionId: id, Data: "!<|STATUS|>!Looking through procurement documents..."
                  }));
                } catch (_) {}
                const docString = await retrieveKBDocs(query.query, knowledgeBase, process.env.KB_ID);
                fullDocs.content = fullDocs.content.concat(docString.content);
                fullDocs.uris = fullDocs.uris.concat(docString.uris);
                toolResultContent = docString.content;
              } else if (toolUse.name === "fetch_metadata") {
                console.log("fetching metadata!")
                try {
                  await wsConnectionClient.send(new PostToConnectionCommand({
                    ConnectionId: id, Data: "!<|STATUS|>!Researching contract details..."
                  }));
                } catch (_) {}
                const metadata = await fetchMetadata();
                toolResultContent = metadata ? JSON.stringify(metadata) : "No metadata available.";
              } else if (toolUse.name === "query_excel_index") {
                const indexName = query.index_name;
                console.log(`querying excel index: ${indexName}`);
                try {
                  await wsConnectionClient.send(new PostToConnectionCommand({
                    ConnectionId: id, Data: "!<|STATUS|>!Searching index data..."
                  }));
                } catch (_) {}
                toolResultContent = await invokeIndexQuery({
                  action: "query",
                  index_name: indexName,
                  free_text: query.free_text || null,
                  filters: query.filters || null,
                  count_only: query.count_only === true,
                  limit: typeof query.limit === "number" ? query.limit : 500,
                });
              } else {
                console.warn("Unknown tool:", toolUse.name);
                toolResultContent = "Unknown tool requested.";
              }
              
              // add the model's query to the tool use message
              toolUse.input = query;
              // add the tool use message to chat history
              message.content.push(toolUse);
              history.push(message);
              
              // add the tool response to chat history
              // content MUST be a string (Bedrock rejects objects)
              let toolResponse = {
                  "role": "user",
                  "content": [
                      {
                          "type": "tool_result",
                          "tool_use_id": toolId,
                          "content": String(toolResultContent)
                      }
                  ]
              };
              
              history.push(toolResponse);
              
              try {
                await wsConnectionClient.send(new PostToConnectionCommand({
                  ConnectionId: id, Data: "!<|STATUS|>!Reading through the results..."
                }));
              } catch (_) {}
              
              usingTool = false;
              toolInput = "";
              message = {};
              toolUse = {};
              
              console.log("correctly used tool: " + toolUse.name)
              
            } else {             
            
              if  (assemblingInput && !skipChunk) {
                // Guard against null/undefined from parseChunk to prevent string corruption
                if (parsedChunk !== null && parsedChunk !== undefined) {
                  toolInput = toolInput.concat(parsedChunk);
                }
              } else if (!assemblingInput) {
                currentIterationText = currentIterationText.concat(parsedChunk)

                if (hasUsedTool) {
                  // Post-tool: stream the actual answer token-by-token
                  modelResponse = modelResponse.concat(parsedChunk)
                  try {
                    await wsConnectionClient.send(new PostToConnectionCommand({
                      ConnectionId: id, Data: parsedChunk.toString()
                    }));
                  } catch (error) {
                    console.error("Error sending chunk:", error);
                  }
                }
                // Pre-tool text is only buffered in currentIterationText
                // for inclusion in history (so the model won't repeat it)
              } else if (skipChunk) {
                skipChunk = false;
              }
            }
            
            
            
          }
        }        
        
      } catch (error) {
        console.error("Stream processing error:", error);
        let responseParams = {
          ConnectionId: id,
          Data: "<!ERROR!>: I'm sorry, something went wrong processing your request. Please try again or rephrase your question."
        }
        let command = new PostToConnectionCommand(responseParams);
        await wsConnectionClient.send(command);
      }
  
    }

    let command;
    let links = JSON.stringify(fullDocs.uris)
    // send end of stream message
    try {
      let eofParams = {
        ConnectionId: id,
        Data: "!<|EOF_STREAM|>!"
      }
      command = new PostToConnectionCommand(eofParams);
      await wsConnectionClient.send(command);

      // send sources
      let responseParams = {
        ConnectionId: id,
        Data: links
      }
      command = new PostToConnectionCommand(responseParams);
      await wsConnectionClient.send(command);
    } catch (e) {
      console.error("Error sending EOF_STREAM and sources:", e);
    }

    // Async FAQ classification (fire-and-forget)
    if (process.env.FAQ_CLASSIFIER_FUNCTION) {
      try {
        const classifierClient = new LambdaClient({});
        await classifierClient.send(new InvokeCommand({
          FunctionName: process.env.FAQ_CLASSIFIER_FUNCTION,
          InvocationType: 'Event',
          Payload: JSON.stringify({
            userMessage,
            userId,
            sessionId,
            displayName,
            agency,
            timestamp: new Date().toISOString(),
          }),
        }));
      } catch (classifyErr) {
        console.error("FAQ classification fire-and-forget failed:", classifyErr);
      }
    }

    const sessionRequest = {
      body: JSON.stringify({
        "operation": "get_session",
        "user_id": userId,
        "session_id": sessionId
      })
    }
    const client = new LambdaClient({});
    const lambdaCommand = new InvokeCommand({
      FunctionName: process.env.SESSION_HANDLER,
      Payload: JSON.stringify(sessionRequest),
    });

    const { Payload, LogResult } = await client.send(lambdaCommand);
    const result = Buffer.from(Payload).toString();

    // Check if the request was successful
    if (!result) {
      throw new Error(`Error retriving session data!`);
    }

    // Parse the JSON
    let output = {};
    try {
      const response = JSON.parse(result);
      output = JSON.parse(response.body);
      console.log('Parsed JSON:', output);
    } catch (error) {
      console.error('Failed to parse JSON:', error);
      let responseParams = {
        ConnectionId: id,
        Data: '<!ERROR!>: Unable to load past messages, please retry your query'
      }
      command = new PostToConnectionCommand(responseParams);
      await wsConnectionClient.send(command);
      return; // Optional: Stop further execution in case of JSON parsing errors
    }

    // Continue processing the data
    const retrievedHistory = output.chat_history;
    let operation = '';
    let title = ''; // Ensure 'title' is initialized if used later in your code

    // Further logic goes here

    let newChatEntry = { "user": userMessage, "chatbot": modelResponse, "metadata": links };
    if (retrievedHistory === undefined) {
      operation = 'add_session';
      try {
        let titleModel = new ClaudeModel(process.env.FAST_MODEL_ID);
        title = await titleModel.getResponse(
          "Generate a short title (3-8 words) summarizing the USER's question topic. Rules: output ONLY the title, no quotes, no explanation, no apologies. Focus on what the user is asking about, not the assistant's response. Examples: 'HVAC Trade Vendor Contracts', 'W.B. Mason Contract Lookup', 'Laptop Procurement Process'.",
          [],
          `User: ${userMessage}`,
          { maxTokens: 15 }
        );
        title = title.replaceAll(`"`, '').trim();
        if (title.length > 80) {
          title = userMessage.substring(0, 75).trim();
        }
      } catch (titleError) {
        console.error("Title generation failed:", titleError);
        title = userMessage.substring(0, 50);
      }
    } else {
      operation = 'update_session';
    }

    const sessionSaveRequest = {
      body: JSON.stringify({
        "operation": operation,
        "user_id": userId,
        "session_id": sessionId,
        "new_chat_entry": newChatEntry,
        "title": title
      })
    }

    const lambdaSaveCommand = new InvokeCommand({
      FunctionName: process.env.SESSION_HANDLER,
      Payload: JSON.stringify(sessionSaveRequest),
    });

    // const { SessionSavePayload, SessionSaveLogResult } = 
    await client.send(lambdaSaveCommand);

    const input = {
      ConnectionId: id,
    };
    await wsConnectionClient.send(new DeleteConnectionCommand(input));

  } catch (error) {
    console.error("Error:", error);
    let responseParams = {
      ConnectionId: id,
      Data: "<!ERROR!>: I'm sorry, something went wrong. Please try again or rephrase your question."
    }
    let command = new PostToConnectionCommand(responseParams);
    await wsConnectionClient.send(command);
  }
}

export const handler = async (event) => {
  if (event.requestContext) {    
    const connectionId = event.requestContext.connectionId;
    const routeKey = event.requestContext.routeKey;
    let body = {};
    try {
      if (event.body) {
        body = JSON.parse(event.body);
      }
    } catch (err) {
      console.error("Failed to parse JSON:", err)
    }
    console.log(routeKey);

    switch (routeKey) {
      case '$connect':
        console.log('CONNECT')
        return { statusCode: 200 };
      case '$disconnect':
        console.log('DISCONNECT')
        return { statusCode: 200 };
      case '$default':
        console.log('DEFAULT')
        return { 'action': 'Default Response Triggered' }
      case "getChatbotResponse":
        console.log('GET CHATBOT RESPONSE')
        await getUserResponse(connectionId, body)
        return { statusCode: 200 };      
      default:
        return {
          statusCode: 404,  // 'Not Found' status code
          body: JSON.stringify({
            error: "The requested route is not recognized."
          })
        };
    }
  }
  return {
    statusCode: 200,
  };
};