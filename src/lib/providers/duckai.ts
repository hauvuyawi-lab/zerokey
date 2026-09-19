/**
 * src/lib/providers/duckai.ts - DuckAI edge client for Cloudflare Workers.
 * Autonomous streaming completions, ephemeral RSA cryptography, and dynamic model discovery.
 */

import type {
    DuckAiModelInfo,
    DuckAiModelsResponse,
    FetchModelsOptions,
    AskDuckAiOptions,
    ProviderResult,
    ChatMessage
} from './types';
import { fetchWithProxy } from '../proxy';

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DUCK_BASE_URL = 'https://duck.ai';
const DUCK_MODELS_URL = `${DUCK_BASE_URL}/duckchat/v1/models`;
const DUCK_CHAT_URL = `${DUCK_BASE_URL}/duckchat/v1/chat`;
const DEFAULT_FE_VERSION = 'serp_20260918_112805_ET-0afc0e46b8e7cee7ca31121299a33611e47d4df0';

/**
 * In-memory cache for dynamically fetched DuckAI models with a 5-minute TTL.
 */
interface ModelCacheEntry {
    models: DuckAiModelInfo[];
    defaultModel: string;
    timestamp: number;
}
let cachedModels: ModelCacheEntry | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Dynamically queries DuckAI models and filters strictly for accessible free-tier models (entityHasAccess === true).
 * No hardcoded model lists.
 */
export async function fetchDuckAiModels(options?: FetchModelsOptions): Promise<DuckAiModelsResponse> {
    const now = Date.now();
    if (cachedModels && now - cachedModels.timestamp < CACHE_TTL_MS) {
        return {
            source: 'api',
            count: cachedModels.models.length,
            models: cachedModels.models
        };
    }

    const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;
    const timeoutMs = options?.timeoutMs ?? 5000;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(DUCK_MODELS_URL, {
            headers: {
                'User-Agent': userAgent,
                'Accept': 'application/json',
                'Origin': DUCK_BASE_URL,
                'Referer': `${DUCK_BASE_URL}/`
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            throw new Error(`DuckAI returned HTTP ${res.status}`);
        }

        const data: any = await res.json();
        const rawModels: any[] = Array.isArray(data?.models) ? data.models : [];

        // Strictly filter for accessible free-tier models only
        const freeModels: DuckAiModelInfo[] = rawModels
            .filter((m: any) => m && m.id && m.entityHasAccess === true)
            .map((m: any) => ({
                id: String(m.id),
                name: String(m.name || m.id),
                provider: String(m.provider || 'duckai'),
                modelShortName: m.modelShortName ? String(m.modelShortName) : undefined,
                modelName: m.modelName ? String(m.modelName) : undefined,
                modelVariant: m.modelVariant ? String(m.modelVariant) : undefined,
                entityHasAccess: true,
                label: m.label ?? null
            }));

        if (freeModels.length === 0) {
            throw new Error('No accessible free-tier models found in DuckAI catalog');
        }

        const defaultModel = freeModels.find(m => m.label === 'EVERYDAY_USE')?.id || freeModels[0].id;

        cachedModels = {
            models: freeModels,
            defaultModel,
            timestamp: now
        };

        return {
            source: 'api',
            count: freeModels.length,
            models: freeModels
        };
    } catch (err: any) {
        if (cachedModels) {
            return {
                source: 'api',
                count: cachedModels.models.length,
                models: cachedModels.models
            };
        }
        throw new Error(`Failed to dynamically fetch DuckAI free models: ${err?.message || err}`);
    }
}

/**
 * Returns the default DuckAI free model dynamically without hardcoding.
 */
export async function getDefaultDuckAiModel(): Promise<string> {
    if (cachedModels && cachedModels.defaultModel) {
        return cachedModels.defaultModel;
    }
    const catalog = await fetchDuckAiModels();
    const everyday = catalog.models.find(m => m.label === 'EVERYDAY_USE');
    return everyday?.id || catalog.models[0]?.id || '';
}

/**
 * Resolves a model name or alias against the live dynamic free-tier catalog.
 * No hardcoded model names or static mappings.
 */
export async function resolveDuckAiModel(requestedModel?: string): Promise<string> {
    if (!requestedModel || !requestedModel.trim()) {
        return getDefaultDuckAiModel();
    }

    const clean = requestedModel.trim().replace(/^duckai\//i, '');
    const lower = clean.toLowerCase();

    try {
        const catalog = await fetchDuckAiModels();

        // 1. Direct match on id, name, modelShortName, or modelName
        const direct = catalog.models.find(m => {
            const mId = m.id.toLowerCase();
            const mName = (m.name || '').toLowerCase();
            const mShort = (m.modelShortName || '').toLowerCase();
            const mModelName = (m.modelName || '').toLowerCase();
            return lower === mId || lower === mName || lower === mShort || lower === mModelName;
        });
        if (direct) return direct.id;

        // 2. Match without vendor prefix (e.g. gpt-oss-120b matches tinfoil/gpt-oss-120b)
        const strippedMatch = catalog.models.find(m => {
            const stripped = m.id.toLowerCase().includes('/')
                ? m.id.toLowerCase().split('/').pop()!
                : m.id.toLowerCase();
            return lower === stripped;
        });
        if (strippedMatch) return strippedMatch.id;

        // 3. Partial or prefix match against live free models (e.g. 'claude-haiku' matches 'claude-haiku-4-5')
        const partial = catalog.models.find(m => {
            const mId = m.id.toLowerCase();
            const stripped = mId.includes('/') ? mId.split('/').pop()! : mId;
            return mId.startsWith(lower) || lower.startsWith(stripped) || stripped.startsWith(lower);
        });
        if (partial) return partial.id;
    } catch {}

    return clean;
}

/**
 * Folds multi-turn OpenAI messages into DuckAI conversation format.
 */
function foldMessages(messages: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
    const sys: string[] = [];
    const rest: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const m of messages) {
        if (!m || typeof m !== 'object') continue;
        const role = m.role.toLowerCase();
        if (role === 'system' || role === 'developer') {
            if (m.content) sys.push(String(m.content));
        } else {
            rest.push({
                role: role === 'assistant' ? 'assistant' : 'user',
                content: String(m.content || '')
            });
        }
    }

    if (sys.length === 0) return rest;
    const prefix = sys.join('\n\n');
    if (rest.length === 0) return [{ role: 'user', content: prefix }];

    const firstUserIdx = rest.findIndex(m => m.role === 'user');
    if (firstUserIdx >= 0) {
        rest[firstUserIdx] = {
            role: 'user',
            content: `${prefix}\n\n${rest[firstUserIdx].content}`
        };
    } else {
        rest.unshift({ role: 'user', content: prefix });
    }

    // In multi-turn conversations with >1 user turn, reinforce system instructions on the active turn
    let lastUserIdx = -1;
    for (let i = rest.length - 1; i >= 0; i--) {
        if (rest[i].role === 'user') {
            lastUserIdx = i;
            break;
        }
    }
    if (lastUserIdx > firstUserIdx && lastUserIdx >= 0) {
        rest[lastUserIdx] = {
            role: 'user',
            content: `[System Instructions: ${prefix}]\n\n${rest[lastUserIdx].content}`
        };
    }

    return rest;
}

/**
 * Generates an ephemeral RSA-OAEP-256 keypair envelope for DuckAI durableStream.
 */
async function generateEnvelope() {
    const keyPair = await crypto.subtle.generateKey(
        {
            name: 'RSA-OAEP',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256'
        },
        true,
        ['encrypt', 'decrypt']
    );
    const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

    return {
        messageId: crypto.randomUUID().replaceAll('-', ''),
        conversationId: crypto.randomUUID().replaceAll('-', ''),
        publicKey: {
            alg: 'RSA-OAEP-256',
            e: jwk.e || 'AQAB',
            ext: true,
            key_ops: ['encrypt'],
            kty: 'RSA',
            n: jwk.n || '',
            use: 'enc'
        }
    };
}

/**
 * Executes a chat query against DuckAI's web endpoint.
 * Dynamically resolves VQD token from options, Cloudflare KV, or environment variables.
 */
export async function askDuckAi(
    promptOrMessages: string | ChatMessage[],
    options?: AskDuckAiOptions,
    env?: any
): Promise<ProviderResult> {
    const startTime = Date.now();
    const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;
    const targetModel = await resolveDuckAiModel(options?.model);

    let messages: ChatMessage[];
    if (typeof promptOrMessages === 'string') {
        if (!promptOrMessages.trim()) {
            throw new Error('Prompt or messages must be provided');
        }
        messages = [{ role: 'user', content: promptOrMessages.trim() }];
    } else if (Array.isArray(promptOrMessages) && promptOrMessages.length > 0) {
        messages = promptOrMessages;
    } else {
        throw new Error('Prompt or messages must be provided');
    }

    // Resolve VQD token from options -> Cloudflare KV -> env variables
    let vqdToken = options?.vqd;
    if (!vqdToken && env?.ZEROKEY_KV) {
        try {
            vqdToken = await env.ZEROKEY_KV.get('DUCKAI_VQD');
        } catch {}
    }
    if (!vqdToken) {
        vqdToken = env?.DUCKAI_VQD || (typeof process !== 'undefined' ? process.env?.DUCKAI_VQD : undefined);
    }

    if (!vqdToken || !vqdToken.trim()) {
        throw new Error(
            'DuckAI site pass missing. Please run "bun run harvest" or post a fresh token to /duckai/token'
        );
    }

    const folded = foldMessages(messages);
    const envelope = await generateEnvelope();

    const body = {
        model: targetModel,
        messages: folded,
        canUseTools: false,
        reasoningEffort: 'none',
        metadata: {},
        durableStream: envelope
    };

    const res = await fetchWithProxy(
        DUCK_CHAT_URL,
        {
            method: 'POST',
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/event-stream',
                'Content-Type': 'application/json',
                'Origin': DUCK_BASE_URL,
                'Referer': `${DUCK_BASE_URL}/`,
                'x-fe-version': DEFAULT_FE_VERSION,
                'x-fe-signals': btoa('{}'),
                'X-Vqd-Hash-1': vqdToken.trim(),
                'x-ddg-journey-id': envelope.conversationId
            },
            body: JSON.stringify(body)
        },
        env
    );

    if (res.status === 418) {
        throw new Error(
            'DuckAI challenge token expired (HTTP 418). Run "bun run harvest" to update token.'
        );
    }

    if (res.status === 429) {
        throw new Error(
            'DuckAI rate limit reached (HTTP 429). Please wait a moment.'
        );
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`DuckAI request failed with HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    if (!res.body) {
        throw new Error('DuckAI response body is null');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullResponse = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr || dataStr === '[DONE]' || dataStr === '[PING]') continue;

            try {
                const parsed = JSON.parse(dataStr);
                if (parsed.role === 'assistant' && typeof parsed.message === 'string') {
                    fullResponse += parsed.message;
                    if (options?.onChunk) {
                        options.onChunk(parsed.message);
                    }
                }
            } catch {}
        }
    }

    const timeMs = Date.now() - startTime;
    return {
        response: fullResponse.trim(),
        model: targetModel,
        timeMs
    };
}
