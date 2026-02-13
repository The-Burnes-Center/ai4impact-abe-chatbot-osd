import { ApiGatewayManagementApiClient, PostToConnectionCommand, DeleteConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { BedrockAgentRuntimeClient, RetrieveCommand as KBRetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"
import ClaudeModel from "./models/claude3Sonnet.mjs";
import { PROMPT } from './prompt.mjs';
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";



/*global fetch*/

const ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT;
const wsConnectionClient = new ApiGatewayManagementApiClient({ endpoint: ENDPOINT });


const fetchMetadata = async () => {
  const lambdaClient = new LambdaClient({});
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

        const signedUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: bucketName,
            Key: objectKey,
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
    const chatHistory = data.chatHistory;    
    
    const knowledgeBase = new BedrockAgentRuntimeClient({ region: 'us-east-1' });

    if (!process.env.KB_ID) {
      throw new Error("Knowledge Base ID is not found.");
    }        

    // retrieve a model response based on the last 5 messages
    // messages come paired, so that's why the slice is only 2 (2 x 2 + the latest prompt = 5)
    let claude = new ClaudeModel();
    let lastFiveMessages = chatHistory.slice(-2);
    
    let stopLoop = false;        
    let modelResponse = ''
    
    let history = claude.assembleHistory(lastFiveMessages, userMessage)    
    let fullDocs = {"content" : "", "uris" : []}
    
    while (!stopLoop) {
      console.log("started new stream")
      history.forEach((historyItem) => {
        console.log(historyItem)
      })
      
      let stream;
      try {
        stream = await claude.getStreamedResponse(SYS_PROMPT, history);
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
              
              console.log("tool input")
              console.log(toolInput);
              let query;
              try {
                query = JSON.parse(toolInput);
              } catch (parseError) {
                console.error("Failed to parse tool input JSON:", toolInput, parseError);
                // Add a synthetic tool result so Claude doesn't get stuck
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
                // Knowledge Base retrieval
                console.log("using knowledge bases!")
                const docString = await retrieveKBDocs(query.query, knowledgeBase, process.env.KB_ID);
                fullDocs.content = fullDocs.content.concat(docString.content);
                fullDocs.uris = fullDocs.uris.concat(docString.uris);
                toolResultContent = docString.content;
              } else if (toolUse.name === "fetch_metadata") {
                // Metadata retrieval
                console.log("fetching metadata!")
                const metadata = await fetchMetadata();
                // tool_result content MUST be a string, never an object
                toolResultContent = metadata ? JSON.stringify(metadata) : "No metadata available.";
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
                // toolUse.input.query += parsedChunk;
              } else if (!assemblingInput) {
                // console.log('writing out to user')
                let responseParams = {
                  ConnectionId: id,
                  Data: parsedChunk.toString()
                }
                modelResponse = modelResponse.concat(parsedChunk)
                currentIterationText = currentIterationText.concat(parsedChunk)
                let command = new PostToConnectionCommand(responseParams);
                        
                try {
                  await wsConnectionClient.send(command);
                } catch (error) {
                  console.error("Error sending chunk:", error);
                }
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
          "Generate a concise title (5-8 words max) for this chat session. Output ONLY the title text, nothing else.",
          [],
          `User: ${userMessage}\nAssistant: ${modelResponse.substring(0, 500)}`
        );
        title = title.replaceAll(`"`, '').trim();
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