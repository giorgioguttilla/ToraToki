import {
  type InferenceChatRequest,
  type InferenceChatResult,
  type InferenceChatMessage,
  type InferenceStreamEvent,
  type InferenceUsage,
} from '../shared/language-api';
import {
  DEFAULT_LM_STUDIO_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  type PersistedInferenceProviderConfig,
  type PersistedLmStudioProviderConfig,
  type PersistedOpenAiProviderConfig,
} from './config';

interface OpenAiCompatibleStreamChunk {
  error?: {
    message?: string;
    type?: string;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | Array<{ text?: string }>;
    };
  }>;
}

const normalizeBaseUrl = (value: string, fallback: string) =>
  (value.trim() || fallback).replace(/\/+$/, '');

const toUsage = (
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined,
): InferenceUsage | null => {
  if (!usage) {
    return null;
  }

  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
};

const toChatMessages = (request: InferenceChatRequest): InferenceChatMessage[] => {
  const systemMessage = request.systemPrompt?.trim()
    ? [{ role: 'system' as const, content: request.systemPrompt.trim() }]
    : [];

  return [
    ...systemMessage,
    ...(request.contextMessages ?? []),
    ...request.messages,
  ];
};

const extractDeltaText = (content: unknown) => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (
        typeof part === 'object' &&
        part !== null &&
        'text' in part &&
        typeof part.text === 'string'
      ) {
        return part.text;
      }

      return '';
    })
    .join('');
};

const formatErrorResponse = async (response: Response) => {
  const bodyText = await response.text();

  if (!bodyText) {
    return `The provider returned ${response.status} ${response.statusText}.`;
  }

  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string };
      message?: string;
    };

    return (
      parsed.error?.message ??
      parsed.message ??
      `The provider returned ${response.status} ${response.statusText}.`
    );
  } catch {
    return bodyText;
  }
};

const readServerSentEvents = async function* (response: Response) {
  if (!response.body) {
    throw new Error('The provider did not return a streaming response body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const extractEvents = () => {
    const events: string[] = [];

    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let separatorIndex = buffer.indexOf('\n\n');

    while (separatorIndex !== -1) {
      events.push(buffer.slice(0, separatorIndex));
      buffer = buffer.slice(separatorIndex + 2);
      separatorIndex = buffer.indexOf('\n\n');
    }

    return events;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      for (const rawEvent of extractEvents()) {
        const payload = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');

        if (!payload) {
          continue;
        }

        if (payload === '[DONE]') {
          return;
        }

        yield JSON.parse(payload) as OpenAiCompatibleStreamChunk;
      }
    }

    buffer += decoder.decode();

    for (const rawEvent of extractEvents()) {
      const payload = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');

      if (!payload || payload === '[DONE]') {
        continue;
      }

      yield JSON.parse(payload) as OpenAiCompatibleStreamChunk;
    }
  } finally {
    reader.releaseLock();
  }
};

export interface InferenceProvider {
  readonly id: string;
  readonly kind: PersistedInferenceProviderConfig['kind'];
  readonly name: string;
  readonly model: string;
  streamChatResponse(
    request: InferenceChatRequest,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<InferenceStreamEvent, void, void>;
  createChatResponse(
    request: InferenceChatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<InferenceChatResult>;
}

abstract class OpenAiCompatibleProviderBase implements InferenceProvider {
  readonly id: string;
  readonly kind: PersistedInferenceProviderConfig['kind'];
  readonly name: string;
  readonly model: string;
  protected readonly baseUrl: string;

  protected constructor(config: PersistedInferenceProviderConfig, fallbackBaseUrl: string) {
    this.id = config.id;
    this.kind = config.kind;
    this.name = config.name;
    this.model = config.model;
    this.baseUrl = normalizeBaseUrl(config.baseUrl, fallbackBaseUrl);
  }

  protected abstract getHeaders(): Record<string, string>;

  async *streamChatResponse(
    request: InferenceChatRequest,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<InferenceStreamEvent, void, void> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getHeaders(),
      },
      body: JSON.stringify({
        model: this.model,
        messages: toChatMessages(request),
        temperature: request.temperature ?? undefined,
        max_tokens: request.maxOutputTokens ?? undefined,
        stream: true,
        stream_options: {
          include_usage: true,
        },
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      throw new Error(await formatErrorResponse(response));
    }

    let text = '';
    let finishReason: string | null = null;
    let usage: InferenceUsage | null = null;

    yield {
      type: 'response.started',
      providerId: this.id,
      providerKind: this.kind,
      model: this.model,
    };

    for await (const chunk of readServerSentEvents(response)) {
      if (chunk.error?.message) {
        throw new Error(chunk.error.message);
      }

      const choice = chunk.choices?.[0];
      const delta = extractDeltaText(choice?.delta?.content);

      if (delta) {
        text += delta;
        yield {
          type: 'response.delta',
          providerId: this.id,
          providerKind: this.kind,
          model: this.model,
          delta,
        };
      }

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }

      usage = toUsage(chunk.usage) ?? usage;
    }

    yield {
      type: 'response.completed',
      providerId: this.id,
      providerKind: this.kind,
      model: this.model,
      text,
      finishReason,
      usage,
    };
  }

  async createChatResponse(
    request: InferenceChatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<InferenceChatResult> {
    let finalEvent: InferenceStreamEvent | null = null;

    for await (const event of this.streamChatResponse(request, options)) {
      if (event.type === 'response.completed') {
        finalEvent = event;
      }
    }

    if (!finalEvent || finalEvent.type !== 'response.completed') {
      throw new Error('The provider stream ended before a completion event was received.');
    }

    return {
      providerId: finalEvent.providerId,
      providerKind: finalEvent.providerKind,
      model: finalEvent.model,
      text: finalEvent.text,
      finishReason: finalEvent.finishReason,
      usage: finalEvent.usage,
    };
  }
}

export class OpenAiInferenceProvider extends OpenAiCompatibleProviderBase {
  private readonly apiKey: string;
  private readonly organizationId: string | null;
  private readonly projectId: string | null;

  constructor(config: PersistedOpenAiProviderConfig) {
    super(config, DEFAULT_OPENAI_BASE_URL);
    this.apiKey = config.apiKey;
    this.organizationId = config.organizationId;
    this.projectId = config.projectId;
  }

  protected getHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...(this.organizationId
        ? { 'OpenAI-Organization': this.organizationId }
        : {}),
      ...(this.projectId ? { 'OpenAI-Project': this.projectId } : {}),
    };
  }
}

export class LmStudioInferenceProvider extends OpenAiCompatibleProviderBase {
  private readonly apiKey: string | null;

  constructor(config: PersistedLmStudioProviderConfig) {
    super(config, DEFAULT_LM_STUDIO_BASE_URL);
    this.apiKey = config.apiKey;
  }

  protected getHeaders() {
    return this.apiKey
      ? {
          Authorization: `Bearer ${this.apiKey}`,
        }
      : {};
  }
}

export const createInferenceProvider = (
  config: PersistedInferenceProviderConfig,
): InferenceProvider => {
  if (config.kind === 'openai') {
    return new OpenAiInferenceProvider(config);
  }

  return new LmStudioInferenceProvider(config);
};
