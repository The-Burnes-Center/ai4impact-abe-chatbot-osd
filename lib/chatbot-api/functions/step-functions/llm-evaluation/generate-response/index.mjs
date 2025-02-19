import { BedrockAgentRuntimeClient, RetrieveCommand as KBRetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import ClaudeModel from "./models/claude3Sonnet.mjs";
// import ClaudeModel from "../websocket-chat/models/claude3Sonnet.mjs";

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
    // console.log(confidenceFilteredResults)
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
      console.log("Warning: no relevant sources found")
    }

    return {
      content: fullContent,
      uris: uniqueUris
    };
  } catch (error) {
    console.error("Caught error: could not retreive Knowledge Base documents:", error);
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
    const client = new LambdaClient({});
    const command = new InvokeCommand({
      FunctionName: process.env.SYS_PROMPT_HANDLER,
      Payload: JSON.stringify({ "operation": "get_active_prompt" }),
    });
    const response = await client.send(command);
    const payload = JSON.parse(Buffer.from(response.Payload).toString());
    //check response status code
    if (response.StatusCode !== 200) {
      throw new Error("Failed to get system prompt: " + payload.body);
    }
    return payload.body;
  } catch (error) {
    console.error("Caught error: could not retreive system prompt:", error);
    return process.env.PROMPT;
  }
}

export async function* generateResponse(userMessage, chatHistory){
    const knowledgeBase = new BedrockAgentRuntimeClient({ region: 'us-east-1' });

    if (!process.env.KB_ID) {
    throw new Error("Knowledge Base ID is not found.");
    }

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

    while (!stopLoop) {
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
                } else {
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
              }
    
              if (usingTool) {
                let query = JSON.parse(toolInput);
    
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
          console.error("Stream processing error:", error);
          throw error; // Propagate the error to the caller
        }
    }
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

    // Return the modelResponse and sources
    return {
      statusCode: 200,
      body: JSON.stringify({
        modelResponse,
        sources,
      }),
    };
  } catch (error) {
    console.error("Error in generateResponseLambda:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
      }),
    };
  }
};

