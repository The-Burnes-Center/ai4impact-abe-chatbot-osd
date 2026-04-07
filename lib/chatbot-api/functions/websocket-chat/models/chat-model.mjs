/**
 * @module chat-model
 *
 * Bedrock Claude model adapter for the ABE chatbot.
 *
 * Wraps the AWS Bedrock Runtime SDK to provide both streaming (tool-use
 * agentic loop) and non-streaming (title generation, metadata summaries)
 * invocations of Anthropic Claude models.
 *
 * Key design decisions:
 * - **Prompt caching**: The system prompt is sent as an array element with
 *   `cache_control: { type: "ephemeral" }`. Bedrock caches the ~4 K-token
 *   prompt for 5 minutes (TTL resets on each hit), cutting latency by up to
 *   85 % and input-token cost by up to 90 % on cache hits.
 * - **Guardrail integration**: When `GUARDRAIL_ID` is set, the Bedrock
 *   Guardrail identifier and version are attached as top-level command
 *   parameters (NOT inside the JSON body). This lets Bedrock evaluate the
 *   request/response against content-policy rules before returning.
 * - **Output token cap**: `DEFAULT_MAX_OUTPUT_TOKENS` is set to 16 384
 *   instead of the Bedrock maximum. Long vendor/contract lists can push
 *   Claude toward its output limit; capping at 16 K provides enough room
 *   for detailed answers while reducing the chance of mid-sentence
 *   truncation that occurs near the hard ceiling.
 * - **Temperature 0**: Deterministic output for procurement accuracy.
 */

import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  InvokeModelCommand
} from "@aws-sdk/client-bedrock-runtime";

/**
 * Maximum completion tokens for all chat invocations.
 *
 * Bedrock allows higher values, but 16 K is a practical sweet spot: large
 * enough for multi-page answers with vendor tables, small enough to avoid
 * the hard-truncation behavior that occurs near the model's absolute limit.
 * @type {number}
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/**
 * Primary chat-model adapter for Claude on Amazon Bedrock.
 *
 * Instantiated once per Lambda cold start and reused across invocations.
 * The model ID defaults to `PRIMARY_MODEL_ID` from the environment (set by
 * CDK) and falls back to Claude Sonnet 4.
 */
export default class ClaudeModel{
  /**
   * @param {string} [modelId] - Bedrock model identifier override.
   *   Falls back to `process.env.PRIMARY_MODEL_ID`, then to a hardcoded
   *   Claude Sonnet 4 ARN so the Lambda can start even when the env var
   *   is temporarily missing.
   */
  constructor(modelId) {
    this.client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
    this.modelId = modelId || process.env.PRIMARY_MODEL_ID || "us.anthropic.claude-sonnet-4-20250514-v1:0";
  }

  /**
   * Convert the persisted conversation history into the Bedrock Messages API
   * format and append the current user turn.
   *
   * Each prior exchange becomes a user/assistant message pair. Empty values
   * are replaced with placeholder strings so Bedrock never receives a blank
   * content block (which would trigger a validation error).
   *
   * @param {Array<{user: string, chatbot: string}>} hist - Previous turns
   *   stored in DynamoDB (oldest first).
   * @param {string} prompt - The current user message to append.
   * @returns {Array<{role: string, content: Array<{type: string, text: string}>}>}
   *   Alternating user/assistant messages ready for the Bedrock body.
   */
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
  /**
   * Normalize a single Bedrock streaming event into a simplified object.
   *
   * The Bedrock response stream emits multiple event types
   * (`content_block_start`, `content_block_delta`, `message_delta`).
   * This method maps each into one of five normalized shapes so the
   * caller (the agentic loop in `index.mjs`) can handle them uniformly:
   *
   * - `{ kind: 'text', text, index }` -- incremental text output
   * - `{ kind: 'tool_input', json, index }` -- partial JSON for a tool call
   * - `{ kind: 'citation', citation, index }` -- native Bedrock citation
   * - `{ type: 'tool_use', id, name, index }` -- tool-use block header
   * - `{ stop_reason, ... }` -- message-level delta (end-of-turn signals)
   *
   * Returns `null` for event types the caller does not need (e.g. `ping`).
   *
   * @param {object} chunk - Raw Bedrock streaming event.
   * @returns {object|null} Normalized event or null if not actionable.
   */
  parseChunk(chunk) {
    if (chunk.type === 'content_block_delta') {
      const idx = chunk.index;
      if (chunk.delta.type === 'text_delta') {
        return { kind: 'text', text: chunk.delta.text, index: idx };
      }
      if (chunk.delta.type === 'input_json_delta') {
        return { kind: 'tool_input', json: chunk.delta.partial_json, index: idx };
      }
      if (chunk.delta.type === 'citations_delta') {
        return { kind: 'citation', citation: chunk.delta.citation, index: idx };
      }
    } else if (chunk.type === 'content_block_start') {
      if (chunk.content_block.type === 'tool_use') {
        return { ...chunk.content_block, index: chunk.index };
      }
    } else if (chunk.type === 'message_delta') {
      return chunk.delta;
    }
    return null;
  }

  /**
   * Invoke the model with streaming enabled (used by the agentic tool-use loop).
   *
   * Returns the raw Bedrock response-stream async iterable. The caller
   * iterates over it, passing each decoded event through {@link parseChunk}.
   *
   * Prompt caching: The system prompt is wrapped in an array with
   * `cache_control: { type: "ephemeral" }`. Bedrock hashes the block and
   * stores it server-side for 5 minutes (TTL resets on every cache hit).
   * Subsequent requests that send the identical system block skip
   * re-tokenization, reducing first-token latency by up to 85 % and
   * input-token charges by up to 90 %.
   *
   * Guardrail: When `GUARDRAIL_ID` is present in the environment, the
   * guardrail identifier and version are set as top-level SDK command
   * parameters. Bedrock evaluates both the input messages and the
   * generated output against the guardrail's content-policy rules,
   * blocking or redacting disallowed content transparently.
   *
   * @param {string} system - Fully rendered system prompt text.
   * @param {Array} history - Message array (already in Bedrock format).
   * @param {Array} tools - Tool definitions for the agentic loop.
   * @returns {Promise<AsyncIterable>} Bedrock streaming response body.
   */
  async getStreamedResponse(system, history, tools) {

    const payload = {
      "anthropic_version": "bedrock-2023-05-31",
      // Prompt caching: wrapping the system prompt in an array element with
      // cache_control "ephemeral" tells Bedrock to cache the tokenized block
      // for 5 minutes (TTL resets on each hit). This avoids re-tokenizing
      // the ~4 K-token prompt on every request in the agentic loop.
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

  /**
   * Invoke the model synchronously (non-streaming).
   *
   * Used for lightweight tasks that do not need incremental delivery:
   * conversation-title generation, metadata summarization, and FAQ
   * auto-generation. Applies the same prompt-caching and guardrail
   * strategy as {@link getStreamedResponse}.
   *
   * @param {string} system - System prompt text.
   * @param {Array<{user: string, chatbot: string}>} history - Prior turns
   *   (will be converted via {@link assembleHistory}).
   * @param {string} message - Current user message.
   * @param {object} [options]
   * @param {number} [options.maxTokens=DEFAULT_MAX_OUTPUT_TOKENS] - Override
   *   the max completion tokens for this call.
   * @returns {Promise<string>} The model's text response, or a fallback
   *   error string if parsing fails.
   */
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
