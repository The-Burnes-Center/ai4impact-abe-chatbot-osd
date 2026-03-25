import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  InvokeModelCommand
} from "@aws-sdk/client-bedrock-runtime";

/** Max completion tokens for streamed chat (Bedrock allows higher; 16k reduces cut-off on long lists). */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

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
      const userText = element.user || "[empty]";
      const botText = element.chatbot || "[No response generated]";
      history.push({"role": "user", "content": [{"type": "text", "text": userText}]});
      history.push({"role": "assistant", "content": [{"type": "text", "text": botText}]});
    });
    history.push({"role": "user", "content": [{"type": "text", "text": prompt || "[empty]"}]});
    return history;
  }
  parseChunk(chunk) {
    if (chunk.type === 'content_block_delta') {
      if (chunk.delta.type === 'text_delta') {
        return { kind: 'text', text: chunk.delta.text };
      }
      if (chunk.delta.type === 'input_json_delta') {
        return { kind: 'tool_input', json: chunk.delta.partial_json };
      }
      if (chunk.delta.type === 'citations_delta') {
        return { kind: 'citation', citation: chunk.delta.citation };
      }
    } else if (chunk.type === 'content_block_start') {
      if (chunk.content_block.type === 'tool_use') {
        return chunk.content_block;
      }
    } else if (chunk.type === 'message_delta') {
      return chunk.delta;
    }
    return null;
  }

  async getStreamedResponse(system, history, tools) {

    const payload = {
      "anthropic_version": "bedrock-2023-05-31",
      // System prompt as array with cache_control to enable Bedrock prompt caching.
      // The ~4K token system prompt is cached between requests, reducing latency
      // by up to 85% and input token costs by up to 90% on cache hits.
      // Cache TTL is 5 minutes (resets on each hit) for Claude Sonnet 4.
      "system": [{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }],
      "max_tokens": DEFAULT_MAX_OUTPUT_TOKENS,
      "messages": history,
      "temperature": 0,
      "tools": tools,
    };

    const commandParams = {
      body: JSON.stringify(payload),
      contentType: 'application/json',
      modelId: this.modelId,
    };

    const guardrailId = process.env.GUARDRAIL_ID;
    if (guardrailId) {
      commandParams.guardrailIdentifier = guardrailId;
      commandParams.guardrailVersion = process.env.GUARDRAIL_VERSION || "1";
    }

    const command = new InvokeModelWithResponseStreamCommand(commandParams);
    const apiResponse = await this.client.send(command);
    return apiResponse.body

  }

  async getResponse(system, history, message, { maxTokens = DEFAULT_MAX_OUTPUT_TOKENS } = {}) {
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
