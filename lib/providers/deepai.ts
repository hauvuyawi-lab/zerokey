import type {
    DeepAiModelInfo,
    DeepAiModelsResponse,
    FetchModelsOptions,
    AskDeepAiOptions,
    ProviderResult,
    ChatMessage
} from './types';

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEEPAI_CHAT_PAGE_URL = 'https://deepai.org/chat';
const DEEPAI_API_CHAT_URL = 'https://api.deepai.org/hacking_is_a_serious_crime';

/**
 * In-memory cache for dynamically scraped DeepAI models with a 5-minute TTL.
 */
interface ModelCacheEntry {
    models: DeepAiModelInfo[];
    defaultModel: string;
    timestamp: number;
}
let cachedModels: ModelCacheEntry | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Generates the client-side API key using DeepAI's algorithmic hash function and salt.
 */
export function generateIslandKey(userAgent: string = DEFAULT_USER_AGENT): string {
    const myrandomstr = Math.round(Math.random() * 100000000000) + '';
    const myhashfunction = (function () {
        const a: number[] = [];
        for (let b = 0; 64 > b;) {
            a[b] = 0 | (4294967296 * Math.sin(++b % Math.PI));
        }
        return function (input: string): string {
            let d: number, e: number, f: number;
            const g: number[] = [d = 1732584193, e = 4023233417, ~d, ~e];
            const h: number[] = [];
            const l: string = unescape(encodeURI(input)) + '\u0080';
            let k: any = l.length;
            let c: number = (--k / 4 + 2) | 15;
            for (h[--c] = 8 * k; ~k;) {
                h[k >> 2] |= l.charCodeAt(k) << (8 * k--);
            }
            for (let b = 0, l_idx = 0; b < c; b += 16) {
                for (
                    k = g as any;
                    64 > l_idx;
                    k = [
                        f = k[3],
                        d +
                            (((f =
                                k[0] +
                                [d & e | ~d & f, f & d | ~f & e, d ^ e ^ f, e ^ (d | ~f)][k = l_idx >> 4] +
                                a[l_idx] +
                                ~~h[b | [l_idx, 5 * l_idx + 1, 3 * l_idx + 5, 7 * l_idx][k] & 15]) <<
                                (k = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21][4 * k + (l_idx++ % 4)])) |
                                (f >>> -k)),
                        d,
                        e
                    ] as any
                ) {
                    d = k[1] | 0;
                    e = k[2];
                }
                for (l_idx = 4; l_idx;) {
                    g[--l_idx] += k[l_idx];
                }
            }
            let result = '';
            for (let l_idx = 0; 32 > l_idx;) {
                result += ((g[l_idx >> 3] >> (4 * (1 ^ l_idx++))) & 15).toString(16);
            }
            return result.split('').reverse().join('');
        };
    })();

    const salt = 'hackers_become_a_little_stinkier_every_time_they_hack';
    const hash = myhashfunction(
        userAgent +
            myhashfunction(
                userAgent +
                    myhashfunction(userAgent + myrandomstr + salt)
            )
    );
    return `tryit-${myrandomstr}-${hash}`;
}

/**
 * Dynamically fetches and parses all unlocked models live from DeepAI's chat web page.
 * Zero hardcoded model lists.
 */
export async function fetchDeepAiModels(options?: FetchModelsOptions): Promise<DeepAiModelsResponse> {
    const timeoutMs = options?.timeoutMs ?? 7000;
    const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;

    if (cachedModels && Date.now() - cachedModels.timestamp < CACHE_TTL_MS) {
        return {
            source: 'scrape',
            count: cachedModels.models.length,
            models: cachedModels.models
        };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(DEEPAI_CHAT_PAGE_URL, {
            headers: {
                'user-agent': userAgent,
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            throw new Error(`Failed to fetch DeepAI page: HTTP ${res.status}`);
        }

        const html = await res.text();
        const modelRegex = /\{"value":"([^"]+)","label":"([^"]+)","locked":(true|false)/g;
        const found = new Map<string, DeepAiModelInfo>();

        let match: RegExpExecArray | null;
        while ((match = modelRegex.exec(html)) !== null) {
            const [, id, label, lockedStr] = match;
            const isLocked = lockedStr === 'true';
            if (!isLocked && !found.has(id)) {
                let provider = 'deepai';
                if (id.includes('gpt') || id.includes('o4')) provider = 'openai';
                else if (id.includes('deepseek')) provider = 'deepseek';
                else if (id.includes('llama')) provider = 'meta';
                else if (id.includes('gemini') || id.includes('gemma')) provider = 'google';
                else if (id.includes('qwen')) provider = 'qwen';
                else if (id.includes('glm')) provider = 'zhipu';
                else if (id.includes('tencent')) provider = 'tencent';

                found.set(id, {
                    id,
                    name: label,
                    provider,
                    locked: false
                });
            }
        }

        if (found.size === 0) {
            throw new Error('No unlocked models discovered in DeepAI web bundle');
        }

        const models = Array.from(found.values());
        const defaultModel = models[0]?.id || 'standard';
        cachedModels = { models, defaultModel, timestamp: Date.now() };

        return {
            source: 'scrape',
            count: models.length,
            models
        };
    } catch (err: any) {
        if (cachedModels) {
            return {
                source: 'scrape',
                count: cachedModels.models.length,
                models: cachedModels.models
            };
        }
        throw new Error(`Unable to discover models dynamically from DeepAI: ${err?.message || err}`);
    }
}

/**
 * Returns the default DeepAI model dynamically discovered from the live model catalog.
 */
export async function getDefaultDeepAiModel(): Promise<string> {
    if (cachedModels && cachedModels.defaultModel) {
        return cachedModels.defaultModel;
    }
    const catalog = await fetchDeepAiModels();
    return catalog.models[0]?.id || 'standard';
}

/**
 * Executes a chat query against DeepAI's web endpoint.
 * Completely keyless, stateless, and serverless-friendly with zero hardcoded model constraints.
 */
export async function askDeepAi(
    promptOrMessages: string | ChatMessage[],
    options?: AskDeepAiOptions
): Promise<ProviderResult> {
    const startTime = Date.now();
    const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;
    const model = options?.model?.trim() || (await getDefaultDeepAiModel());

    let chatHistory: ChatMessage[];
    if (typeof promptOrMessages === 'string') {
        if (!promptOrMessages.trim()) {
            throw new Error('Prompt or messages must be provided');
        }
        chatHistory = [{ role: 'user', content: promptOrMessages.trim() }];
    } else if (Array.isArray(promptOrMessages) && promptOrMessages.length > 0) {
        chatHistory = promptOrMessages.map(m => ({
            role: m.role === 'developer' ? 'system' : m.role,
            content: m.content
        }));
    } else {
        throw new Error('Prompt or messages must be provided');
    }

    const apiKey = generateIslandKey(userAgent);
    const sessionUuid = crypto.randomUUID();
    const sensitivityRequestId = crypto.randomUUID();

    const formData = new FormData();
    formData.append('chat_style', 'chat');
    formData.append('chatHistory', JSON.stringify(chatHistory));
    formData.append('model', model);
    formData.append('session_uuid', sessionUuid);
    formData.append('sensitivity_request_id', sensitivityRequestId);
    formData.append('tool_activity_support', '1');
    formData.append('thinking_image_tool_support', '1');
    formData.append('hacker_is_stinky', 'very_stinky');
    formData.append('enabled_tools', JSON.stringify(['image_generator', 'image_editor']));

    const res = await fetch(DEEPAI_API_CHAT_URL, {
        method: 'POST',
        headers: {
            'api-key': apiKey,
            'user-agent': userAgent,
            'origin': 'https://deepai.org',
            'referer': 'https://deepai.org/chat'
        },
        body: formData
    });

    if (!res.ok) {
        let errBody = '';
        try {
            errBody = await res.text();
            const json = JSON.parse(errBody);
            if (json.status === 'anonymous try it exceeded') {
                const err = new Error('DeepAI free usage quota exceeded for this IP. Please try again shortly.') as any;
                err.status = 429;
                throw err;
            }
            if (json.status) {
                errBody = json.status;
            }
        } catch (e: any) {
            if (e.status === 429) throw e;
        }

        const error = new Error(`DeepAI Error (${res.status}): ${errBody || res.statusText}`) as any;
        error.status = res.status;
        throw error;
    }

    let fullText = '';
    const onChunk = options?.onChunk;

    if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const textChunk = decoder.decode(value, { stream: true });
            fullText += textChunk;
            if (onChunk && textChunk) {
                onChunk(textChunk);
            }
        }
    } else {
        fullText = await res.text();
        if (onChunk && fullText) {
            onChunk(fullText);
        }
    }

    return {
        response: fullText.trim(),
        model,
        timeMs: Date.now() - startTime
    };
}
