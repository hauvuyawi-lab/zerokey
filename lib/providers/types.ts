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

export interface DeepAiModelInfo {
    id: string;
    name: string;
    provider: string;
    locked?: boolean;
    description?: string;
}

export interface FetchModelsOptions {
    timeoutMs?: number;
    userAgent?: string;
}

export interface DeepAiModelsResponse {
    source: 'scrape';
    count: number;
    models: DeepAiModelInfo[];
}

export type DeepAiModelId = string;

export interface AskDeepAiOptions {
    model?: DeepAiModelId;
    onChunk?: ((token: string) => void) | null;
    userAgent?: string;
}

// --- OpenAI API Specification Types ---

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'developer';
    content: string;
}

export interface ChatCompletionRequest {
    model?: string;
    messages: ChatMessage[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
}

export interface ChatCompletionChoice {
    index: number;
    message: {
        role: 'assistant';
        content: string;
    };
    finish_reason: 'stop' | 'length' | null;
}

export interface ChatCompletionResponse {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
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
}

export interface ChatCompletionChunkChoice {
    index: number;
    delta: ChatCompletionChunkDelta;
    finish_reason: 'stop' | null;
}

export interface ChatCompletionChunk {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: ChatCompletionChunkChoice[];
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
