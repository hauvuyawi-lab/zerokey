/**
 * src/lib/providers/router.ts - Unified provider routing and catalog aggregation.
 * Routes between Google Gemini and DuckAI with dynamic discovery.
 */

import { askGemini, getGeminiModels } from './gemini';
import { askDuckAi, fetchDuckAiModels, resolveDuckAiModel } from './duckai';
import {
    extractContentText,
    type ChatMessage,
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

    if (messages.length === 1 && messages[0].content) {
        return extractContentText(messages[0].content);
    }

    const sys: string[] = [];
    const conversation: Array<{ role: string; content: string }> = [];

    for (const msg of messages) {
        const text = extractContentText(msg?.content);
        if (!text) continue;
        const role = (msg.role || '').toLowerCase();
        if (role === 'system' || role === 'developer') {
            sys.push(text);
        } else {
            conversation.push({ role, content: text });
        }
    }

    const parts: string[] = [];
    const sysPrefix = sys.join('\n\n');
    if (sysPrefix) {
        parts.push(`Instructions: ${sysPrefix}`);
    }

    for (let i = 0; i < conversation.length; i++) {
        const item = conversation[i];
        if (item.role === 'user') {
            // For multi-turn conversations (>1 turn), reinforce system instruction on active turn
            const isLastTurn = i === conversation.length - 1;
            if (isLastTurn && sysPrefix && conversation.length > 1) {
                parts.push(`User: ${item.content}\n\n[Instructions: ${sysPrefix}]`);
            } else {
                parts.push(`User: ${item.content}`);
            }
        } else if (item.role === 'assistant') {
            parts.push(`Assistant: ${item.content}`);
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
 * Direct routing between Google Gemini and DuckAI.
 * Defaults to Google Gemini when no model is specified or unrecognized.
 */
export async function resolveProvider(modelName?: string): Promise<{
    provider: 'gemini' | 'duckai';
    targetModel?: string;
}> {
    if (!modelName || !modelName.trim()) {
        return { provider: 'gemini', targetModel: 'gemini' };
    }

    const clean = modelName.trim();
    const lower = clean.toLowerCase();

    // 1. Google Gemini
    if (lower === 'gemini' || lower.startsWith('gemini-') || lower === 'google') {
        return { provider: 'gemini', targetModel: 'gemini' };
    }

    // Explicit duckai/ prefix
    if (lower.startsWith('duckai/')) {
        return { provider: 'duckai', targetModel: clean.slice(7) };
    }

    // 2. DuckAI (Dynamic check against live free accessible models)
    try {
        const duckData = await fetchDuckAiModels();
        const found = duckData.models.find(m => {
            const mId = m.id.toLowerCase();
            const mShort = mId.includes('/') ? mId.split('/').pop()! : mId;
            const mName = (m.name || '').toLowerCase();
            const mShortName = (m.modelShortName || '').toLowerCase();
            return (
                mId === lower ||
                mShort === lower ||
                mName === lower ||
                mShortName === lower ||
                mId.startsWith(lower) ||
                lower.startsWith(mShort) ||
                mShort.replace(/[-_]/g, '') === lower.replace(/[-_]/g, '')
            );
        });

        if (found) {
            return { provider: 'duckai', targetModel: found.id };
        }
    } catch {}

    // Fallback: Default to Gemini
    return { provider: 'gemini', targetModel: 'gemini' };
}

/**
 * Unified execution router: routes prompt/messages to Gemini or DuckAI.
 */
export async function unifiedExecute(params: {
    model?: string;
    prompt: string;
    messages?: ChatMessage[];
    onChunk?: ((token: string) => void) | null;
    env?: any;
}): Promise<ProviderResult> {
    const { model, prompt, messages, onChunk = null, env } = params;
    const { provider, targetModel } = await resolveProvider(model);

    if (provider === 'gemini') {
        return askGemini(prompt, { onChunk }, env);
    }

    const query = messages && messages.length > 0 ? messages : prompt;

    if (provider === 'duckai') {
        try {
            return await askDuckAi(query, { model: targetModel, onChunk }, env);
        } catch (err: any) {
            // Transparent failover: on DuckAI 418 (token expired) or 429 (rate limit), failover to Gemini
            const msg = String(err?.message || err);
            if (msg.includes('418') || msg.includes('429') || msg.includes('site pass missing')) {
                return await askGemini(prompt, { onChunk }, env);
            }
            throw err;
        }
    }

    return askGemini(prompt, { onChunk }, env);
}

/**
 * Aggregates available models across providers into standard OpenAI model schema.
 * Aggregates Google Gemini and DuckAI with zero duplicates.
 */
export async function getUnifiedOpenAIModels(): Promise<OpenAIModelListResponse> {
    const models: OpenAIModelItem[] = [];
    const seenIds = new Set<string>();

    const markSeen = (id: string) => {
        const lower = id.toLowerCase();
        seenIds.add(lower);
        if (lower.includes('/')) {
            seenIds.add(lower.split('/').pop()!);
        }
    };

    // 1. Google Gemini models
    try {
        const geminiModels = await getGeminiModels();
        for (const m of geminiModels) {
            if (!seenIds.has(m.id.toLowerCase())) {
                markSeen(m.id);
                models.push({
                    id: m.id,
                    object: 'model',
                    created: 1773800000,
                    owned_by: 'google'
                });
            }
        }
    } catch {
        models.push({
            id: 'gemini',
            object: 'model',
            created: 1773800000,
            owned_by: 'google'
        });
        markSeen('gemini');
    }

    // 2. DuckAI models
    try {
        const duckData = await fetchDuckAiModels({ timeoutMs: 4000 });
        for (const m of duckData.models) {
            const lower = m.id.toLowerCase();
            const stripped = lower.includes('/') ? lower.split('/').pop()! : lower;

            if (!seenIds.has(lower) && !seenIds.has(stripped)) {
                markSeen(m.id);
                models.push({
                    id: m.id,
                    object: 'model',
                    created: 1773800000,
                    owned_by: m.provider.toLowerCase()
                });
            }
        }
    } catch {}

    return {
        object: 'list',
        data: models
    };
}
