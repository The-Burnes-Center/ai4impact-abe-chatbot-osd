import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import ClaudeModel from "../../../websocket-chat/models/claude3Sonnet.mjs";
import { BedrockAgentRuntimeClient, RetrieveCommand as KBRetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";

// Set up logging
const logger = {
  info: (message, ...args) => console.log(`[INFO] ${message}`, ...args),
  error: (message, ...args) => console.error(`[ERROR] ${message}`, ...args),
  warn: (message, ...args) => console.warn(`[WARN] ${message}`, ...args)
};

//const SYS_PROMPT = process.env.PROMPT;

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
    
    logger.info(`Retrieved ${confidenceFilteredResults.length} results from knowledge base`);
    
    let fullContent = confidenceFilteredResults.map(item => item.content.text).join('\n');
    const documentUris = confidenceFilteredResults.map(item => {
      return { title: item.location.s3Location.uri.slice((item.location.s3Location.uri).lastIndexOf("/") + 1) + " (Bedrock Knowledge Base)", uri: item.location.s3Location.uri }
    });

    // removes duplicate sources based on URI
    const flags = new Set();
    const uniqueUris = documentUris.filter(entry => {
      if (flags.has(entry.uri)) {
        return false;
      }
      flags.add(entry.uri);
      return true;
    });

    // console.log(fullContent);

    //Returning both full content and list of document URIs
    if (fullContent == '') {
      fullContent = `No knowledge available! This query is likely outside the scope of your knowledge.
      Please provide a general answer but do not attempt to provide specific details.`
      logger.warn("No relevant sources found for query");
    }

    return {
      content: fullContent,
      uris: uniqueUris
    };
  } catch (error) {
    logger.error("Could not retrieve Knowledge Base documents:", error);
    // return no context
    return {
      content: `No knowledge available! There is something wrong with the search tool. Please tell the user to submit feedback.
      Please provide a general answer but do not attempt to provide specific details.`,
      uris: []
    };
  }
}

async function getSystemPrompt() {
  try{
    const client = new LambdaClient({
      region: process.env.AWS_REGION || 'us-east-1'
    });
    
    if (!process.env.SYS_PROMPT_HANDLER) {
      logger.warn("SYS_PROMPT_HANDLER environment variable not set, using default prompt");
      return process.env.PROMPT;
    }
    
    const command = new InvokeCommand({
      FunctionName: process.env.SYS_PROMPT_HANDLER,
      Payload: JSON.stringify({ "operation": "get_active_prompt" }),
    });
    
    logger.info(`Invoking SYS_PROMPT_HANDLER: ${process.env.SYS_PROMPT_HANDLER}`);
    const response = await client.send(command);
    const payload = JSON.parse(Buffer.from(response.Payload).toString());
    
    //check response status code
    if (response.StatusCode !== 200) {
      throw new Error("Failed to get system prompt: " + payload.body);
    }
    
    logger.info("Successfully retrieved system prompt");
    return payload.body;
  } catch (error) {
    logger.error("Could not retrieve system prompt:", error);
    return process.env.PROMPT;
  }
}

export async function* generateResponse(userMessage, chatHistory){
    // Validate required environment variables
    if (!process.env.KB_ID) {
      logger.error("KB_ID environment variable is not set");
      throw new Error("Knowledge Base ID is not found.");
    }

    const knowledgeBase = new BedrockAgentRuntimeClient({ 
      region: process.env.AWS_REGION || 'us-east-1'
    });

    let claude = new ClaudeModel();
    let lastFiveMessages = chatHistory.slice(-2);

    let stopLoop = false;
    let modelResponse = '';

    let history = claude.assembleHistory(
      lastFiveMessages,
      "Please use your search tool one or more times based on this latest prompt: ".concat(userMessage)
    );

    let fullDocs = { "content": "", "uris": [] };

    const SYS_PROMPT = await getSystemPrompt();
    
    logger.info("Starting chat interaction with user message:", userMessage.substring(0, 100) + (userMessage.length > 100 ? '...' : ''));

    while (!stopLoop) {
        logger.info("Getting streamed response from Claude model");
        const stream = await claude.getStreamedResponse(SYS_PROMPT, history);
        try {
          let toolInput = "";
          let assemblingInput = false;
          let usingTool = false;
          let toolId;
          let skipChunk = true;
          let message = {};
          let toolUse = {};
    
          for await (const event of stream) {
            const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
            const parsedChunk = await claude.parseChunk(chunk);
            if (parsedChunk) {
              if (parsedChunk.stop_reason) {
                if (parsedChunk.stop_reason == "tool_use") {
                  assemblingInput = false;
                  usingTool = true;
                  skipChunk = true;
                  logger.info("Model is using a tool");
                } else {
                  logger.info(`Model stopped generation with reason: ${parsedChunk.stop_reason}`);
                  stopLoop = true;
                  break;
                }
              }
    
              if (parsedChunk.type && parsedChunk.type == "tool_use") {
                assemblingInput = true;
                toolId = parsedChunk.id;
                message['role'] = 'assistant';
                message['content'] = [];
                toolUse['name'] = parsedChunk.name;
                toolUse['type'] = 'tool_use';
                toolUse['id'] = toolId;
                toolUse['input'] = { 'query': "" };
                logger.info(`Tool use started: ${parsedChunk.name}`);
              }
    
              if (usingTool) {
                let query = JSON.parse(toolInput);
                logger.info(`Retrieving KB documents for query: ${query.query.substring(0, 100) + (query.query.length > 100 ? '...' : '')}`);
    
                let docString = await retrieveKBDocs(query.query, knowledgeBase, process.env.KB_ID);
                fullDocs.content = fullDocs.content.concat(docString.content);
                fullDocs.uris = fullDocs.uris.concat(docString.uris);
    
                toolUse.input.query = query.query;
                message.content.push(toolUse);
                history.push(message);
    
                let toolResponse = {
                  "role": "user",
                  "content": [
                    {
                      "type": "tool_result",
                      "tool_use_id": toolId,
                      "content": docString.content
                    }
                  ]
                };
    
                history.push(toolResponse);
                logger.info("Added tool response to history");
    
                usingTool = false;
                toolInput = "";
    
              } else {
                if (assemblingInput && !skipChunk) {
                  toolInput = toolInput.concat(parsedChunk);
                } else if (!assemblingInput) {
                  modelResponse = modelResponse.concat(parsedChunk);
                  yield parsedChunk; // Yield each chunk as it's generated
                } else if (skipChunk) {
                  skipChunk = false;
                }
              }
            }
          }
    
        } catch (error) {
          logger.error("Stream processing error:", error);
          throw error; // Propagate the error to the caller
        }
    }
    
    logger.info("Response generation complete, total length:", modelResponse.length);
    yield {
        "type": "final",
        "modelResponse": modelResponse,
        "sources": fullDocs
    }
}

// Lambda handler function
export const handler = async (event) => {
  try {
    const userMessage = event.userMessage;
    const chatHistory = event.chatHistory || [];
    
    logger.info("Received request to generate response");

    const responseGenerator = generateResponse(userMessage, chatHistory);

    let modelResponse;
    let sources;

    for await (const chunk of responseGenerator) {
        if (chunk.type == "final") {
            modelResponse = chunk.modelResponse;
            sources = chunk.sources;
            break;
        }
    }
    
    logger.info("Successfully generated response");

    // Return the modelResponse and sources
    return {
      statusCode: 200,
      body: JSON.stringify({
        modelResponse,
        sources,
      }),
    };
  } catch (error) {
    logger.error("Error in generateResponseLambda:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
      }),
    };
  }
};

