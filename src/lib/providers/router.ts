import { askGemini } from './gemini';
import { askDeepAi, fetchDeepAiModels } from './deepai';
import type {
    ChatMessage,
    ProviderResult,
    OpenAIModelListResponse,
    OpenAIModelItem
} from './types';

/**
 * Normalizes OpenAI messages array into a single one-shot prompt.
 */
export function normalizeMessages(messages: ChatMessage[]): string {
    if (!Array.isArray(messages) || messages.length === 0) {
        return '';
    }

    // If single user message, return directly
    if (messages.length === 1 && messages[0].content) {
        return messages[0].content.trim();
    }

    const parts: string[] = [];
    for (const msg of messages) {
        if (!msg.content) continue;
        const role = msg.role.toLowerCase();
        if (role === 'system' || role === 'developer') {
            parts.push(`Instructions: ${msg.content.trim()}`);
        } else if (role === 'user') {
            parts.push(`User: ${msg.content.trim()}`);
        } else if (role === 'assistant') {
            parts.push(`Assistant: ${msg.content.trim()}`);
        }
    }

    return parts.join('\n\n');
}

/**
 * Extracts a prompt string from either a simple prompt field or messages array.
 */
export function extractPrompt(request: { prompt?: string; messages?: ChatMessage[] }): string {
    if (typeof request.prompt === 'string' && request.prompt.trim()) {
        return request.prompt.trim();
    }
    if (Array.isArray(request.messages) && request.messages.length > 0) {
        return normalizeMessages(request.messages);
    }
    return '';
}

/**
 * Determines which provider handles the requested model.
 */
export function resolveProvider(modelName?: string): { provider: 'gemini' | 'deepai'; targetModel?: string } {
    if (!modelName) {
        return { provider: 'deepai' };
    }

    const lower = modelName.trim().toLowerCase();

    if (lower === 'gemini' || lower.startsWith('gemini-') || lower === 'google') {
        return { provider: 'gemini', targetModel: 'gemini' };
    }

    if (lower.startsWith('deepai/')) {
        return { provider: 'deepai', targetModel: modelName.slice(7) };
    }

    return { provider: 'deepai', targetModel: modelName.trim() };
}

/**
 * Unified execution router: routes prompt/messages to either Gemini or DeepAI.
 */
export async function unifiedExecute(params: {
    model?: string;
    prompt: string;
    messages?: ChatMessage[];
    onChunk?: ((token: string) => void) | null;
}): Promise<ProviderResult> {
    const { model, prompt, messages, onChunk = null } = params;
    const { provider, targetModel } = resolveProvider(model);

    if (provider === 'gemini') {
        return askGemini(prompt, { onChunk });
    }

    const query = messages && messages.length > 0 ? messages : prompt;
    return askDeepAi(query, { model: targetModel, onChunk });
}

/**
 * Aggregates all available models across providers into standard OpenAI model schema.
 */
export async function getUnifiedOpenAIModels(): Promise<OpenAIModelListResponse> {
    const models: OpenAIModelItem[] = [
        {
            id: 'gemini',
            object: 'model',
            created: 1773800000,
            owned_by: 'google'
        }
    ];

    try {
        const deepData = await fetchDeepAiModels({ timeoutMs: 5000 });
        for (const m of deepData.models) {
            models.push({
                id: m.id,
                object: 'model',
                created: 1773800000,
                owned_by: m.provider.toLowerCase()
            });
        }
    } catch {
        // Return Gemini at minimum if DeepAI fetch fails
    }

    return {
        object: 'list',
        data: models
    };
}
