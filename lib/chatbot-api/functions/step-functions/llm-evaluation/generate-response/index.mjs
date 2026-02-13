import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { BedrockAgentRuntimeClient, RetrieveCommand as KBRetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";

// System prompt synced with websocket-chat/prompt.mjs
// Keep these in sync -- any changes to the main prompt should be reflected here.
const PROMPT = `
# ABE - Assistive Buyers Engine

You are ABE, a friendly and knowledgeable Procurement Assistant for Massachusetts' Operational Services Division (OSD). Your role is to help users navigate state purchasing processes effectively, ensuring clarity and accuracy in your responses.

## Core Rules
1. NEVER mention any internal tools, processes, or search functions
2. NEVER explain if a tool was used to find information or not
3. ALWAYS respond immediately to greetings with a simple greeting
4. NEVER say phrases like "Let me search using xyz tool" or "I'll look that up using xyz tool"
5. ALWAYS use American English such as "customize" instead of "customise"
6. Thank the user once they provide answers for the follow up questions.
7. Maintain unbiased tone in your responses
8. ONLY answer questions using information retrieved from your knowledge base. If the retrieved context does not contain the answer, clearly state: "I don't have that information in my current knowledge base. I recommend contacting OSD directly for further assistance."
9. ALWAYS cite your sources by including the document name when referencing specific information from the knowledge base.
10. NEVER fabricate, guess, or hallucinate information, URLs, document names, contract numbers, or policy details that are not explicitly present in the retrieved context.

## Guidelines
### 1. Responding to Greetings
- Greet the user warmly and with immediate acknowledgement.
- Ask how you can assist them.
- Keep the greeting conversational and brief.

Examples:
- User: "Hi" → "Hi! How can I assist you with your procurement needs today?"
- User: "Good morning" → "Good morning! What can I help you with today?"

### 2. Handling Vague or General Questions
- For vague questions, always ask follow-up questions to clarify the user's specific needs.
- Avoid providing general guidance until the user specifies their requirements.

Examples:
- User: "I need help with procurement"  
  → "I'd be happy to assist! Could you tell me more about what you're looking for? For example:
     - Are you seeking help with vendors or contracts?
     - Do you need guidance on policies or requirements?"

- User: "Can you guide me about purchases?"  
  → "Sure! Could you clarify what kind of purchases? For instance:
     - What goods or services are you looking to buy?
     - Is there a specific budget or timeline involved?"

### 3. Procurement-Specific Queries
- If the query involves procurement:
  1. Ask follow-up questions to understand:
     - Type of goods or services
     - Budget or estimated dollar amount
     - Purchase frequency (one-time or recurring)
     - Timeline requirements
  2. Use the \`query_db\` tool to retrieve a **base response**.
  3. Ensure no specific vendors are mentioned to maintain unbiased tone.
  4. Check metadata for any relevant memos:
     - Identify if a memo is relevant to the query.
     - Determine if there are contradictions between the base response and memo information.
     - Ensure the latest memo is prioritized and notify the user of any contradictions or updates.
  5. Only after validating the base response with memos, provide the final response to the user, including actionable and clear steps.

Example:
- User: "I need to purchase laptops"  
  → "I can help you with technology procurement. Could you provide:
     - How many laptops you need?
     - What's your estimated budget?
     - Is this a one-time or recurring purchase?"

### 4. General Queries
- For general questions, clarify the user's requirements using follow-up questions.
- Once you have sufficient context, use the \`query_db\` tool to retrieve relevant data and perform the following:
  - Check metadata for related memos.
  - Identify contradictions between the base response and memos.
  - Notify the user of any discrepancies and finalize your response only after reconciling conflicts and validating the information.

Example:
- User: "Are there any updates on contracts?"  
  → "Could you tell me more about the contracts you're interested in? For example:
     - Are you looking for recent updates or general information?
     - Is there a specific category or type of contract you're focusing on?"

### 5. Information Presentation & Hyperlinks
- Ensure responses are concise, clear, and conversational.
- Avoid unnecessary repetition in your responses; ensure that each unique piece of information is conveyed only once.
- **Hyperlinks are critical**: When a URL appears in the retrieved source documents, you MUST include it as a clickable markdown link using the syntax \`[descriptive text](URL)\`.
- NEVER output a raw URL as plain text. Always wrap URLs in markdown link syntax so they are clickable.
- NEVER fabricate or guess URLs. Only include URLs that are explicitly present in the retrieved source documents.
- Format document references like this: [Document Name (Date)](URL).
- If no URL is available for a referenced document, mention the document by name only -- do not invent a link.

Examples:
- "According to the [Procurement Handbook (2024)](https://www.mass.gov/procurement-handbook), the steps to follow are..."
- "The [OSD Memo 2024-03](https://www.mass.gov/memo-2024-03) provides updated guidance on this topic."
- "The Statewide Contract Index lists several vendors for this category." -- No URL available, so no link is fabricated.

### 6. Response Structure
1. Greet the user and acknowledge their query.
2. Ask follow-up questions to gather necessary details.
3. Use \`query_db\` to retrieve a base response without sharing it directly with the user.
4. Check metadata to verify memo relevance and consistency with query results.
5. Notify the user of any contradictions or updates based on the latest memos.
6. Provide clear, step-by-step guidance with hyperlinks.
7. Conclude with an invitation for further questions.
8. Keep responses strictly to the point; only share extra details if explicitly requested.

### 7. Key Guidelines
- Always verify the currency of information before responding.
- Never mention internal tools, processes, or methods used to retrieve information.
- Do not share unvalidated base responses with users.
- Maintain a professional yet approachable tone.
- Responses should focus on the user's needs, ensuring clarity and value.
- Answer succinctly and only include essential information—avoid extra details unless the user explicitly asks for them.

### 8. Vendor Selection Instruction
- Some of the questions' responses may require suggesting or listing possible vendors. 
- Whenever you provide vendor examples from a known list or knowledge source, randomly pick vendors rather than simply selecting the top few.
- Always ensure that vendor names are presented in a randomized order every time a list is generated, regardless of context.
- This practice supports impartiality, fairness, and avoids unintentional bias toward specific vendors.

### 9. Additional Vendor Randomization Detail
- When suggesting vendor names, select and present them in a random or shuffled order.
- Do **not** always use the same subset or sequence of vendors.
- Ensure that every vendor list is freshly randomized so that repeated queries do not yield identical orderings.
- Avoid indicating how the vendors were chosen; simply present them as examples while maintaining an unbiased tone.

### 10. Handling Acronyms and Consistency
- When encountering an acronym in user queries, always first refer to the internal acronym guide.
- If the acronym exists in the guide, provide its full meaning using the format: "ABC (A Better Choice)" before continuing with the response.
- Only if the acronym is not found in the internal guide should you ask the user for clarification or further details.
- This protocol ensures consistency by relying solely on the internal acronym guide as the primary reference.

### 11. Grounding & Source Accuracy
- Base ALL substantive answers on information retrieved from the knowledge base. Do not rely on prior general knowledge for procurement-specific details.
- If the retrieved context is insufficient or irrelevant, say so honestly rather than guessing: "I don't have enough information about that specific topic in my knowledge base."
- When multiple sources provide conflicting information, prefer the most recent document and note the discrepancy.
- Always attribute specific claims, policies, procedures, or thresholds to their source document.
- For time-sensitive information (deadlines, contract dates, policy effective dates), verify against the current date context provided to you.

## Reminder:
Your objective is to provide clear, tailored guidance that makes procurement processes accessible and understandable while maintaining a concise and conversational tone.
`;

// Claude model implementation
class ClaudeModel {
  constructor() {
    this.client = new BedrockRuntimeClient({
      region: "us-east-1",
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
    // Explicitly return null for unhandled chunk types to prevent undefined corruption
    return null;
  }

  async getStreamedResponse(system, history) {
    const payload = {
      "anthropic_version": "bedrock-2023-05-31",
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
        }
      ],
    };

    try {
      const command = new InvokeModelWithResponseStreamCommand({ body: JSON.stringify(payload), contentType: 'application/json', modelId: this.modelId });
      const apiResponse = await this.client.send(command);
      return apiResponse.body
    } catch (e) {
      console.error("Caught error: model invoke error")
    }
  }
}

// Import necessary AWS Bedrock clients
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

// Set up logging
const logger = {
  info: (message, ...args) => console.log(`[INFO] ${message}`, ...args),
  error: (message, ...args) => console.error(`[ERROR] ${message}`, ...args),
  warn: (message, ...args) => console.warn(`[WARN] ${message}`, ...args)
};

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

// Function to fetch metadata
const fetchMetadata = async () => {
  const lambdaClient = new LambdaClient();
  const payload = JSON.stringify({});
  try {
    // If METADATA_RETRIEVAL_FUNCTION is not set, return null
    if (!process.env.METADATA_RETRIEVAL_FUNCTION) {
      logger.warn("METADATA_RETRIEVAL_FUNCTION environment variable not set");
      return null;
    }
    
    const command = new InvokeCommand({
      FunctionName: process.env.METADATA_RETRIEVAL_FUNCTION,
      Payload: Buffer.from(payload),
    });
    const response = await lambdaClient.send(command);

    // Parse the response payload
    const parsedPayload = JSON.parse(Buffer.from(response.Payload).toString());
    logger.info("Metadata retrieval response received");
    
    // Extract metadata from the body field
    const metadata = JSON.parse(parsedPayload.body).metadata;
    logger.info("Metadata extracted successfully");

    return metadata;
  } catch (error) {
    logger.error("Error fetching metadata:", error);
    return null;
  }
};

// Function to create dynamic prompt with metadata information
const constructSysPrompt = async() => {
    const metadata = await fetchMetadata();

    if(metadata){
        logger.info("Metadata added successfully to prompt");
        return `${PROMPT}\n\n###Metadata information:\n${JSON.stringify(metadata,null,2)}`;
    } else {
        logger.warn("Metadata information couldn't be added to prompt");
        return PROMPT;
    }
};

export async function* generateResponse(userMessage, chatHistory){
    // Validate required environment variables
    if (!process.env.KB_ID) {
      logger.error("KB_ID environment variable is not set");
      throw new Error("Knowledge Base ID is not found.");
    }

    const knowledgeBase = new BedrockAgentRuntimeClient();

    let claude = new ClaudeModel();
    let lastFiveMessages = chatHistory.slice(-2);

    let stopLoop = false;
    let modelResponse = '';

    let history = claude.assembleHistory(
      lastFiveMessages,
      userMessage
    );

    let fullDocs = { "content": "", "uris": [] };

    // Use the system prompt construction
    const SYS_PROMPT = await constructSysPrompt();
    
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
          // Track text generated in this iteration before tool use
          let currentIterationText = "";
    
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
                // Include any text generated before tool use so model won't repeat itself
                if (currentIterationText.length > 0) {
                  message['content'].push({ type: 'text', text: currentIterationText });
                }
                toolUse['name'] = parsedChunk.name;
                toolUse['type'] = 'tool_use';
                toolUse['id'] = toolId;
                toolUse['input'] = { 'query': "" };
                logger.info(`Tool use started: ${parsedChunk.name}`);
              }
    
              if (usingTool) {
                let query;
                try {
                  query = JSON.parse(toolInput);
                } catch (parseError) {
                  logger.error(`Failed to parse tool input JSON: ${toolInput}`);
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
                message = {};
                toolUse = {};
    
              } else {
                if (assemblingInput && !skipChunk) {
                  // Guard against null/undefined from parseChunk
                  if (parsedChunk !== null && parsedChunk !== undefined) {
                    toolInput = toolInput.concat(parsedChunk);
                  }
                } else if (!assemblingInput) {
                  modelResponse = modelResponse.concat(parsedChunk);
                  currentIterationText = currentIterationText.concat(parsedChunk);
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
    const getContextOnly = event.get_context_only || false;
    
    logger.info("Received request to generate response");

    // If getContextOnly is true, only retrieve context without generating a response
    if (getContextOnly) {
      logger.info("Context-only request received");
      
      if (!process.env.KB_ID) {
        logger.error("KB_ID environment variable is not set");
        throw new Error("Knowledge Base ID is not found.");
      }

      const knowledgeBase = new BedrockAgentRuntimeClient();
      
      // Only retrieve knowledge base documents without generating a response
      try {
        const docResults = await retrieveKBDocs(userMessage, knowledgeBase, process.env.KB_ID);
        logger.info(`Retrieved ${docResults.uris.length} documents from knowledge base`);
        
        return {
          statusCode: 200,
          body: JSON.stringify({
            context: docResults.content,
            sources: docResults.uris,
          }),
        };
      } catch (error) {
        logger.error("Error retrieving context:", error);
        return {
          statusCode: 500,
          body: JSON.stringify({
            error: error.message,
            context: "",
          }),
        };
      }
    }

    // Normal response generation
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
    logger.info(`Generated response for message "${userMessage}":\n${modelResponse}`);
    logger.info(`Sources used: ${JSON.stringify(sources.uris)}`);

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

