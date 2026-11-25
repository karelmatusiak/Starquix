// src/ai/AIService.ts
import { streamText, stepCountIs, type ModelMessage, type ToolSet } from 'ai';
import { t } from '@/i18n';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { AIConfig } from './types';
import { DEFAULT_MODELS } from './types';
import { reasoningTapFetch, createReasoningSink, type ReasoningSink } from './reasoningTap';
import { isRetryableStatus } from './imageGen';
import { AIRequestError, classifyAIFailure } from './failure';

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  onComplete: (fullText: string) => void;
  onError: (error: Error) => void;
}

/** Real finish metadata from the stream — never fabricate "Done." without it. */
export interface AgentFinishMeta {
  finishReason: string;
  stepsUsed: number;
  stepCap: number;
}

/** Callbacks for tool-calling agent mode */
export interface AgentCallbacks {
  onText: (text: string) => void;
  onToolCall: (toolName: string, args: Record<string, unknown>) => void;
  onToolResult: (toolName: string, result: unknown) => void;
  /** meta is absent only for the dev mock runner. */
  onComplete: (fullText: string, meta?: AgentFinishMeta) => void;
  onError: (error: Error) => void;
  /** Reasoning-model thinking tokens, accumulated per block. One block per agent
   *  step; `blockId` is stable within a block so the UI keeps steps apart instead
   *  of overwriting one string. Lets the UI show live "thinking" instead of a
   *  static spinner while a model reasons for minutes. */
  onReasoning?: (text: string, blockId: string) => void;
  /** Streaming tool-call input (partial JSON) — for live canvas preview. Optional. */
  onToolInputStart?: (toolName: string) => void;
  onToolInputDelta?: (delta: string) => void;
  onToolInputEnd?: () => void;
  /** Provider returned a retryable status (429 or 5xx) — the SDK is backing off
   *  and retrying (or will fail if retries are exhausted). Carries the status. */
  onRateLimit?: (status: number) => void;
  /** Run was cancelled: the SDK emits a graceful {type:'abort'} part (never throws),
   *  or the abortSignal guard exits the loop. Fires exactly once. */
  onAbort?: () => void;
}

export const RATE_LIMIT_MESSAGE = 'Provider rate limit hit — wait a minute or switch model.';

/** True for a 429 from the SDK: APICallError.statusCode, RetryError.lastError/.errors, or message text. */
export function isRateLimitError(err: unknown): boolean {
  const e = err as { statusCode?: number; lastError?: unknown; errors?: unknown[]; message?: string } | null;
  if (e?.statusCode === 429) return true;
  if (e?.lastError && isRateLimitError(e.lastError)) return true;
  if (e?.errors?.some(inner => isRateLimitError(inner))) return true;
  return /\b429\b|rate.?limit/i.test(e?.message ?? '');
}

/** Map a run-fatal error to what the user sees; rate limits get the explicit remedy. */
function toAgentError(err: unknown): Error {
  return new AIRequestError(classifyAIFailure(err));
}

/**
 * The AI SDK retries 429/5xx internally with backoff and exposes no retry event —
 * a wrapping fetch is the sanctioned hook to observe each retried attempt so the
 * UI can show "provider busy — retrying" instead of a silent multi-minute stall.
 */
export function rateLimitAwareFetch(onRetryable: (status: number) => void): typeof globalThis.fetch {
  return async (input, init) => {
    const res = await globalThis.fetch(input, init);
    if (isRetryableStatus(res.status)) onRetryable(res.status);
    return res;
  };
}

/** A chat message. On the system message, `stableChars` counts how much of its start is the same on
 *  every request (saved prompt, confirm rule, style) — the part a provider's prompt cache can keep. */
export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  stableChars?: number;
}

/** Anthropic's cache breakpoint: the request up to and including the marked block is kept for
 *  5 minutes, and every read renews it. */
const CACHE_MARKER = { type: 'ephemeral' } as const;

/**
 * OpenRouter passes Anthropic's prompt cache through only where the request marks a breakpoint
 * (`cache_control` on a content part), and `@ai-sdk/openai` sends system content as one plain string
 * with nowhere to put it. So the marker goes on here: the system message becomes two text parts —
 * the stable prefix, marked, then the rest. Together they are the original string.
 * Shape per https://openrouter.ai/docs/guides/features/prompt-caching (2026-11-12).
 */
export function promptCacheFetch(inner: typeof globalThis.fetch, stablePrefix: string): typeof globalThis.fetch {
  return (input, init) => inner(input, withCacheMarker(init, stablePrefix));
}

function withCacheMarker(init: RequestInit | undefined, stablePrefix: string): RequestInit | undefined {
  if (typeof init?.body !== 'string') return init;
  try {
    const body = JSON.parse(init.body);
    const system = body?.messages?.[0];
    if (system?.role !== 'system' || typeof system.content !== 'string' || !system.content.startsWith(stablePrefix)) return init;
    const rest = system.content.slice(stablePrefix.length);
    system.content = [
      { type: 'text', text: stablePrefix, cache_control: CACHE_MARKER },
      ...(rest ? [{ type: 'text', text: rest }] : []),
    ];
    return { ...init, body: JSON.stringify(body) };
  } catch {
    return init; // not JSON — leave it alone
  }
}

/**
 * Put the stable start of the system prompt in the provider's prompt cache: every tool step of a run
 * re-sends the whole prompt, and without the cache each one pays full input price for it.
 * Anthropic caches only where the request marks a breakpoint. The other providers cache a repeated
 * prefix by themselves or not at all, so their request stays exactly as it was. (Not handled: the
 * Alibaba-served Qwen models on OpenRouter, which also want an explicit marker.)
 * - anthropic: the SDK's cacheControl option, on a system block of its own.
 * - openrouter with an Anthropic model: `stablePrefix` asks promptCacheFetch to mark the request body.
 */
function withPromptCache(config: AIConfig, messages: AgentMessage[]): { messages: ModelMessage[]; stablePrefix?: string } {
  const plain: ModelMessage[] = messages.map(({ role, content }) => ({ role, content }));
  const [system] = messages;
  const stable = system?.role === 'system' ? system.content.slice(0, system.stableChars ?? 0) : '';
  if (!stable) return { messages: plain };

  if (config.provider === 'anthropic') {
    const changing = system.content.slice(stable.length);
    return {
      messages: [
        { role: 'system', content: stable, providerOptions: { anthropic: { cacheControl: CACHE_MARKER } } },
        ...(changing ? [{ role: 'system' as const, content: changing }] : []),
        ...plain.slice(1),
      ],
    };
  }
  const isClaudeOnOpenRouter = config.provider === 'openrouter' && /^~?anthropic\//i.test(config.model || DEFAULT_MODELS.openrouter);
  return { messages: plain, stablePrefix: isClaudeOnOpenRouter ? stable : undefined };
}

/** Frontier chat models drive the plan→build→verify→fix loop and earn the full
 *  step budget; weak/local/free-tier models keep the smaller cap. OpenRouter is
 *  a router — capability lives in the MODEL id, not the provider, so a frontier
 *  model routed through it must not inherit the weak cap (kimi-k3 image builds
 *  were hitting 15 and force-restarting). */
export function resolveStepCap(config: AIConfig): number {
  const FRONTIER = 40;
  const WEAK = 15;
  if (config.provider === 'anthropic' || config.provider === 'openai') return FRONTIER;
  if (config.provider === 'ollama') return WEAK;
  if (config.provider === 'openrouter') {
    const model = (config.model || '').toLowerCase();
    // Free-tier routes are rate-limited/small — keep the weak cap.
    return model.endsWith(':free') ? WEAK : FRONTIER;
  }
  return WEAK;
}

/**
 * Create a provider model instance from config.
 * Shared between generate() and generateWithTools().
 */
function createModelInstance(
  config: AIConfig,
  onRateLimit?: (status: number) => void,
  onReasoning?: ReasoningSink,
  /** From withPromptCache: mark this start of the system prompt in the request body. */
  stablePrefix?: string,
) {
  const model = config.model || DEFAULT_MODELS[config.provider];
  // No observer (generate/testConnection) = no wrapper; SDK uses native fetch.
  let fetch = onRateLimit ? rateLimitAwareFetch(onRateLimit) : undefined;
  // OpenRouter's reasoning tokens never reach the SDK's stream parts — tap the
  // SSE body ourselves so a long thinking phase has something to show.
  if (config.provider === 'openrouter' && onReasoning) {
    fetch = reasoningTapFetch(fetch ?? globalThis.fetch.bind(globalThis), onReasoning);
  }
  if (stablePrefix) {
    fetch = promptCacheFetch(fetch ?? globalThis.fetch.bind(globalThis), stablePrefix);
  }

  function createProvider() {
    switch (config.provider) {
      case 'anthropic':
        return createAnthropic({
          apiKey: config.apiKey,
          headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
          fetch,
        });
      case 'ollama':
        return createOpenAI({
          apiKey: 'ollama',
          baseURL: 'http://localhost:11434/v1',
          fetch,
        });
      case 'openrouter':
        return createOpenAI({
          apiKey: config.apiKey,
          baseURL: 'https://openrouter.ai/api/v1',
          headers: {
            'HTTP-Referer': globalThis.location?.origin || 'https://starquix.app',
            'X-Title': t('Starquix'),
          },
          fetch,
        });
      default:
        return createOpenAI({ apiKey: config.apiKey, fetch });
    }
  }

  const provider = createProvider();
  const useChatApi = config.provider === 'openrouter' || config.provider === 'ollama';
  return useChatApi ? provider.chat(model) : provider(model);
}

/**
 * Multi-provider AI service using Vercel AI SDK.
 * Runs client-side with user-provided API keys.
 */
export async function generate(
  config: AIConfig,
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal,
): Promise<void> {
  const model = config.model || DEFAULT_MODELS[config.provider];

  try {
    const modelInstance = createModelInstance(config);

    const result = streamText({
      model: modelInstance,
      messages,
      abortSignal,
      maxOutputTokens: config.provider === 'ollama' ? 4096 : 16384,
    });

    let fullText = '';
    for await (const chunk of result.textStream) {
      if (abortSignal?.aborted) return;
      fullText += chunk;
      callbacks.onChunk(fullText);
    }

    // Await response to surface API errors (auth, billing, etc.)
    // that don't propagate through textStream
    await result.response;

    callbacks.onComplete(fullText);
  } catch (sdkError) {
    // If the SDK error is an API-level error (auth, billing, rate limit),
    // report it directly instead of falling back to raw fetch
    const errMsg = sdkError instanceof Error ? sdkError.message : String(sdkError);
    const isApiError = /credit|balance|api.key|unauthorized|forbidden|rate.limit|quota|billing|authentication/i.test(errMsg);

    if (isApiError) {
      callbacks.onError(sdkError instanceof Error ? sdkError : new Error(errMsg));
      return;
    }

    // Fall back to raw fetch only for browser/streaming compatibility issues
    try {
      await generateWithFetch(config, model, messages, callbacks, abortSignal);
    } catch (fetchError) {
      callbacks.onError(
        fetchError instanceof Error ? fetchError : new Error(String(fetchError)),
      );
    }
  }
}

/**
 * Fallback: raw fetch with SSE parsing for environments where
 * the AI SDK's streaming doesn't work (e.g., some browser contexts).
 */
async function generateWithFetch(
  config: AIConfig,
  model: string,
  messages: { role: string; content: string }[],
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal,
): Promise<void> {
  const isAnthropic = config.provider === 'anthropic';

  const API_URLS: Record<string, string> = {
    anthropic: 'https://api.anthropic.com/v1/messages',
    ollama: 'http://localhost:11434/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions',
  };
  const url = API_URLS[config.provider] || API_URLS.openai;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  let body: string;

  if (isAnthropic) {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';

    // Separate system message from user/assistant messages
    const systemMsg = messages.find((m) => m.role === 'system');
    const chatMessages = messages.filter((m) => m.role !== 'system');

    body = JSON.stringify({
      model,
      max_tokens: 16384,
      stream: true,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: chatMessages.map((m) => ({ role: m.role, content: m.content })),
    });
  } else {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
    if (config.provider === 'openrouter') {
      headers['HTTP-Referer'] = globalThis.location?.origin || 'https://starquix.app';
      headers['X-Title'] = t('Starquix');
    }
    body = JSON.stringify({
      model,
      stream: true,
      max_tokens: config.provider === 'ollama' ? 4096 : 16384,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: abortSignal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (abortSignal?.aborted) return;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const text = isAnthropic
          ? parsed.delta?.text || ''
          : parsed.choices?.[0]?.delta?.content || '';

        if (text) {
          fullText += text;
          callbacks.onChunk(fullText);
        }
      } catch {
        // Skip unparseable chunks
      }
    }
  }

  callbacks.onComplete(fullText);
}

/**
 * Test connection to the AI provider.
 * Sends a minimal request to verify the API key works.
 */
export async function testConnection(config: AIConfig): Promise<boolean> {
  try {
    const modelInstance = createModelInstance(config);

    const result = streamText({
      model: modelInstance,
      messages: [{ role: 'user', content: 'Say "ok"' }],
      maxOutputTokens: 5,
    });

    // Consume the stream to check for errors
    for await (const _ of result.textStream) {
      // Just need one chunk to confirm it works
      return true;
    }
    return true;
  } catch (err) {
    console.warn('[AI] testConnection failed:', err);
    return false;
  }
}

/**
 * Agent mode: stream text with tool calling.
 * The AI can call tools autonomously and chain multiple tool calls.
 * Uses Vercel AI SDK's maxSteps for multi-step tool use.
 */
export async function generateWithTools(
  config: AIConfig,
  messages: AgentMessage[],
  tools: ToolSet,
  callbacks: AgentCallbacks,
  abortSignal?: AbortSignal,
): Promise<void> {
  try {
    const reasoningSink = createReasoningSink(callbacks.onReasoning);
    const cached = withPromptCache(config, messages);
    const modelInstance = createModelInstance(config, callbacks.onRateLimit, reasoningSink.fromTap, cached.stablePrefix);

    const stepCap = resolveStepCap(config);

    const result = streamText({
      model: modelInstance,
      messages: cached.messages,
      tools,
      toolChoice: 'auto',
      stopWhen: stepCountIs(stepCap),
      abortSignal,
      maxOutputTokens: config.provider === 'ollama' ? 4096 : 16384,
    });

    let fullText = '';
    // Reasoning accumulates per block, not per run. Blocks are sequential in a
    // stream, so tracking the current id is enough — no map of live blocks.
    let reasoningId = '';
    let reasoningText = '';

    for await (const part of result.fullStream) {
      // Both abort exit routes settle the run via onAbort; each returns
      // immediately, so it can only fire once.
      if (abortSignal?.aborted) { callbacks.onAbort?.(); return; }

      // Diagnostic logging — errors must be visible in DevTools console
      if (part.type === 'tool-call') {
        console.log(`[AI] tool-call: ${part.toolName}`, part.input);
      } else if (part.type === 'tool-result') {
        const out = part.output as Record<string, unknown> | undefined;
        if (out?.success === false || out?.error) {
          console.error(`[AI] tool FAILED: ${part.toolName}`, out?.message || out?.error, out);
        } else {
          console.log(`[AI] tool-result: ${part.toolName}`, out);
        }
      } else if (part.type === 'error') {
        console.error('[AI] stream error:', part.error);
      } else if (part.type === 'finish-step') {
        // A prompt cache that stops being hit raises no error — the bill is just higher. This line is
        // where it shows: every step after a run's first should read the stable prompt back.
        const cache = part.usage?.inputTokenDetails;
        console.log(`[AI] step input: ${part.usage?.inputTokens ?? '?'} tokens (cache read ${cache?.cacheReadTokens ?? 0}, cache write ${cache?.cacheWriteTokens ?? '?'})`);
      }

      switch (part.type) {
        case 'text-delta':
          fullText += part.text;
          callbacks.onText(fullText);
          break;
        case 'reasoning-delta': {
          // Reasoning models (kimi-k3 etc.) stream thinking tokens the UI used
          // to drop into `default` — leaving a static "Thinking…" for minutes.
          // A new id means a new step, so the accumulator restarts with it.
          const p = part as { id?: string; text?: string };
          const id = p.id ?? 'reasoning';
          if (id !== reasoningId) { reasoningId = id; reasoningText = ''; }
          reasoningText += p.text ?? '';
          reasoningSink.fromSdk(reasoningText, id);
          break;
        }
        case 'tool-call':
          callbacks.onToolCall(part.toolName, part.input as Record<string, unknown>);
          break;
        case 'tool-result':
          callbacks.onToolResult(part.toolName, part.output);
          break;
        case 'tool-input-start':
          callbacks.onToolInputStart?.((part as { toolName: string }).toolName);
          break;
        case 'tool-input-delta': {
          // TextStreamPart carries `delta`; older/UI-message unions used
          // `inputTextDelta`. Reading only the latter emitted '' for every
          // delta and silently killed the canvas stream preview.
          const p = part as { delta?: string; inputTextDelta?: string };
          callbacks.onToolInputDelta?.(p.delta ?? p.inputTextDelta ?? '');
          break;
        }
        case 'tool-input-end':
          callbacks.onToolInputEnd?.();
          break;
        case 'tool-error': {
          const p = part as { toolName: string; error: unknown };
          // Route through onToolResult so the fifo shifts and the row settles red —
          // dropping this part left the row spinning, then falsely green (task-126).
          callbacks.onToolResult(p.toolName, { success: false, error: String(p.error) });
          break;
        }
        case 'abort':
          // AI SDK v6 never throws on cancel — it enqueues this part and closes
          // the stream. Returning without a callback left cancelled messages
          // stuck status:'streaming' with rows spinning forever (task-126).
          callbacks.onAbort?.();
          return;
        case 'error':
          callbacks.onError(toAgentError(part.error));
          return;
        default:
          break;
      }
    }

    // Await response to surface API errors
    await result.response;
    const finishReason = await result.finishReason;
    const steps = await result.steps;
    callbacks.onComplete(fullText, { finishReason, stepsUsed: steps.length, stepCap });
  } catch (error) {
    if (abortSignal?.aborted || (error as { name?: string } | null)?.name === 'AbortError') {
      callbacks.onAbort?.();
      return;
    }
    console.error('[AI] request failed:', error);
    callbacks.onError(toAgentError(error));
  }
}
