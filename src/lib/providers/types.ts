export interface ProviderResult {
    response: string;
    model: string;
    timeMs: number;
}

export interface StandardErrorResponse {
    status: number;
    error: string;
}

export type GeminiResult = ProviderResult;

export interface ProviderModelInfo {
    id: string;
    name: string;
    provider: string;
    entityHasAccess?: boolean;
}

export interface ProviderStreamOptions {
    onChunk?: ((chunk: string) => void) | null;
    model?: string;
    stream?: boolean;
}

export interface AskGeminiOptions {
    onChunk?: ((token: string, model?: string) => void) | null;
    raw?: boolean;
}

export interface FetchModelsOptions {
    timeoutMs?: number;
    userAgent?: string;
}

// --- Gemini Provider Types ---

export interface GeminiModelInfo {
    id: string;
    name: string;
    provider: 'google';
    modelShortName?: string;
    modelName?: string;
    entityHasAccess: boolean;
    label?: string | null;
}

export interface GeminiModelsResponse {
    source: 'api' | 'cache' | 'fallback';
    count: number;
    models: GeminiModelInfo[];
}

// --- DuckAI Provider Types ---

export interface DuckAiModelInfo {
    id: string;
    name: string;
    provider: string;
    modelShortName?: string;
    modelName?: string;
    modelVariant?: string;
    entityHasAccess: boolean;
    label?: string | null;
}

export interface DuckAiModelsResponse {
    source: 'api';
    count: number;
    models: DuckAiModelInfo[];
}

export type DuckAiModelId = string;

export interface AskDuckAiOptions {
    model?: DuckAiModelId;
    onChunk?: ((token: string) => void) | null;
    userAgent?: string;
    vqd?: string;
}

// --- OpenAI API Specification Types ---

export type MessageContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: string } }
    | { type: 'input_audio'; input_audio: { data: string; format: string } }
    | { type: string; [key: string]: any };

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'developer';
    content: string | MessageContentPart[] | any;
}

/**
 * Safely extracts plain text from OpenAI standard message content.
 * Supports string content, multimodal content part arrays (text, image_url, input_audio, file),
 * and nested objects without crashing.
 */
export function extractContentText(content: unknown): string {
    if (!content) return '';
    if (typeof content === 'string') return content.trim();

    if (Array.isArray(content)) {
        const textParts: string[] = [];
        let hasImage = false;
        let hasAudio = false;
        let hasFile = false;

        for (const part of content) {
            if (!part) continue;
            if (typeof part === 'string') {
                if (part.trim()) textParts.push(part.trim());
                continue;
            }
            if (typeof part === 'object') {
                const p = part as Record<string, any>;
                if (p.type === 'text' && typeof p.text === 'string') {
                    if (p.text.trim()) textParts.push(p.text.trim());
                } else if (typeof p.text === 'string' && p.text.trim()) {
                    textParts.push(p.text.trim());
                } else if (p.type === 'image_url' || p.image_url) {
                    hasImage = true;
                } else if (p.type === 'input_audio' || p.input_audio) {
                    hasAudio = true;
                } else if (p.type === 'file' || p.file) {
                    hasFile = true;
                }
            }
        }

        const annotations: string[] = [];
        if (hasImage) annotations.push('[Attached Image]');
        if (hasAudio) annotations.push('[Attached Audio]');
        if (hasFile) annotations.push('[Attached File]');

        if (annotations.length > 0) {
            textParts.push(annotations.join(' '));
        }

        return textParts.join('\n').trim();
    }

    if (typeof content === 'object') {
        const obj = content as Record<string, any>;
        if (typeof obj.text === 'string') return obj.text.trim();
        return '';
    }

    return String(content).trim();
}

export interface ChatCompletionRequest {
    model?: string;
    messages: ChatMessage[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    stream_options?: {
        include_usage?: boolean;
    };
    [key: string]: any;
}

export interface ChatCompletionChoice {
    index: number;
    message: {
        role: 'assistant';
        content: string;
        refusal: string | null;
    };
    logprobs: null;
    finish_reason: 'stop' | 'length' | null;
}

export interface ChatCompletionResponse {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    system_fingerprint: string | null;
    choices: ChatCompletionChoice[];
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export interface ChatCompletionChunkDelta {
    role?: 'assistant';
    content?: string;
    refusal?: string | null;
}

export interface ChatCompletionChunkChoice {
    index: number;
    delta: ChatCompletionChunkDelta;
    logprobs: null;
    finish_reason: 'stop' | 'length' | null;
}

export interface ChatCompletionChunk {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    system_fingerprint: string | null;
    choices: ChatCompletionChunkChoice[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    } | null;
}

export interface OpenAIModelItem {
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
}

export interface OpenAIModelListResponse {
    object: 'list';
    data: OpenAIModelItem[];
}
