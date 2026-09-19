import type {
    GeminiResult,
    AskGeminiOptions,
    GeminiModelInfo,
    GeminiModelsResponse,
    FetchModelsOptions
} from './types';

// Re-export interface for convenience
export type {
    GeminiResult,
    AskGeminiOptions,
    GeminiModelInfo,
    GeminiModelsResponse,
    FetchModelsOptions
};

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_BL = 'boq_assistant-bard-web-server_20260916.10_p0';

/**
 * In-memory cache for dynamically fetched Gemini models with a 5-minute TTL.
 */
interface GeminiModelCacheEntry {
    models: GeminiModelInfo[];
    defaultModel: string;
    rawModelName: string;
    timestamp: number;
}

let cachedGeminiModels: GeminiModelCacheEntry | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Cleans Google internal UI tags and artifacts (Sections, Elicitations, code metadata)
 * while preserving clean Markdown and text content.
 */
export function cleanResponse(raw: string): string {
    if (!raw || typeof raw !== 'string') return '';

    return raw
        // Remove Google internal suggestion / elicitation blocks
        .replace(/<Elicitations[\s\S]*?<\/Elicitations>/gi, '')
        // Extract text content from <TextBox ... text="..." /> tags if present
        .replace(/<TextBox\b[^>]*?\btext="([^"]*)"[^>]*\/?>/gi, '$1\n')
        // Strip custom Google UI wrapper tags like <Section> and </Section>
        .replace(/<\/?(?:Section|TextBox|Elicitation)\b[^>]*>/gi, '')
        // Clean Google internal code-runner URL query parameters
        .replace(/\?(?:code_reference|code_stdout)&code_event_index=\d+/g, '')
        // Normalize multiple blank lines
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Fast stream-based fetch to extract Google's latest build label (bl / cfb2h).
 * Reads only the first few KB of HTML until "cfb2h" is matched, then cancels the stream.
 */
export async function fetchLatestBl(userAgent = DEFAULT_USER_AGENT): Promise<string> {
    try {
        const res = await fetch('https://gemini.google.com', {
            headers: {
                'User-Agent': userAgent
            }
        });
        if (!res.body) return DEFAULT_BL;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let text = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            text += decoder.decode(value, { stream: true });
            const match = text.match(/"cfb2h":"([^"]+)"/);
            if (match) {
                reader.cancel().catch(() => {});
                return match[1];
            }
        }
    } catch {}
    return DEFAULT_BL;
}

/**
 * Converts a raw Gemini model name (e.g. "3.5 Flash-Lite") into a clean model ID (e.g. "gemini-3.5-flash-lite").
 */
export function formatGeminiModelId(rawName: string): string {
    const clean = (rawName || '').trim();
    if (!clean) return 'gemini';
    const slug = clean.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
    return slug.startsWith('gemini') ? slug : `gemini-${slug}`;
}

/**
 * Builds standard model list for Google Gemini from raw model name.
 */
export function buildGeminiModelList(rawName: string): GeminiModelInfo[] {
    const cleanName = (rawName || '').trim() || '3.5 Flash-Lite';
    const formattedId = formatGeminiModelId(cleanName);
    const displayName = cleanName.toLowerCase().startsWith('gemini')
        ? cleanName
        : `Gemini ${cleanName}`.trim();

    const list: GeminiModelInfo[] = [
        {
            id: formattedId,
            name: displayName,
            provider: 'google',
            modelShortName: cleanName,
            modelName: displayName,
            entityHasAccess: true,
            label: null
        }
    ];

    return list;
}

/**
 * Updates the in-memory Gemini model cache with a newly observed model name.
 */
export function updateCachedGeminiModel(rawName: string): void {
    if (!rawName || typeof rawName !== 'string' || !rawName.trim()) return;
    const models = buildGeminiModelList(rawName.trim());
    cachedGeminiModels = {
        models,
        defaultModel: models[0].id,
        rawModelName: rawName.trim(),
        timestamp: Date.now()
    };
}

/**
 * Dynamically probes Google Gemini to extract the live active model name (e.g. "3.5 Flash-Lite").
 * Cancels the response stream immediately once the model name frame is parsed.
 */
export async function scrapeGeminiModelName(options?: FetchModelsOptions): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? 5000;
    const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const bl = await fetchLatestBl(userAgent);
        const turnHash = Array.from({ length: 32 }, () =>
            Math.floor(Math.random() * 16).toString(16)
        ).join('');
        const clientUuid = typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : 'B9ECC548-B2B3-4CFA-9DE5-047C1E48217A';

        const inner = [
            ['ping', 0, null, null, null, null, 0],
            ['en-US'],
            null, null, turnHash,
            null, [1], 1, null, null, 1, 0, null, null, null, null, null,
            [[1]], 0, null, null, null, null, null, null, null, null, 1,
            null, null, [4], null, null, null, null, null, null, null, null,
            null, null, [2], null, null, null, null, null, null, null, null,
            null, null, null, 0, null, null, null, null, null,
            clientUuid,
            null, [], null, null, null, null, null, null, 2, null, null,
            null, null, null, null, null, null, null, null, 6, null, null,
            null, null, null, null, null, null, null, null, null, 0, null,
            null, null, null, 0, null, 1
        ];

        const reqId = Math.floor(Math.random() * 900000) + 100000;
        const body = new URLSearchParams({
            'f.req': JSON.stringify([null, JSON.stringify(inner)])
        }).toString();

        const url = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(bl)}&f.sid=0&hl=en-US&_reqid=${reqId}&rt=c`;

        const res = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'Accept': 'application/json; charset=utf-8',
                'x-same-domain': '1',
                'User-Agent': userAgent
            },
            body
        });

        if (!res.ok || !res.body) {
            throw new Error(`Google Gemini probe returned HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.includes('wrb.fr')) continue;

                try {
                    const parsed = JSON.parse(trimmed.replace(/^\)\]\}'\s*/, ''));
                    for (const item of parsed) {
                        if (item[0] === 'wrb.fr' && item[2]) {
                            const data = JSON.parse(item[2]);
                            if (Array.isArray(data)) {
                                if (typeof data[42] === 'string' && data[42].trim()) {
                                    reader.cancel().catch(() => {});
                                    controller.abort();
                                    return data[42].trim();
                                }
                                for (const val of data) {
                                    if (typeof val === 'string' && val.length > 0 && val.length < 50 && (val.includes('Flash') || val.includes('Pro') || val.includes('Lite') || val.includes('Gemini') || val.includes('Ultra'))) {
                                        reader.cancel().catch(() => {});
                                        controller.abort();
                                        return val.trim();
                                    }
                                }
                            }
                        }
                    }
                } catch {}
            }
        }
    } finally {
        clearTimeout(timeoutId);
    }

    return '3.5 Flash-Lite';
}

/**
 * Dynamically fetches and scrapes Google Gemini models with a 5-minute TTL cache.
 * Matches DuckAI's fetchDuckAiModels interface and behavior.
 */
export async function fetchGeminiModels(options?: FetchModelsOptions): Promise<GeminiModelsResponse> {
    const now = Date.now();
    if (cachedGeminiModels && now - cachedGeminiModels.timestamp < CACHE_TTL_MS) {
        return {
            source: 'cache',
            count: cachedGeminiModels.models.length,
            models: cachedGeminiModels.models
        };
    }

    try {
        const rawModelName = await scrapeGeminiModelName(options);
        updateCachedGeminiModel(rawModelName);
        return {
            source: 'api',
            count: cachedGeminiModels!.models.length,
            models: cachedGeminiModels!.models
        };
    } catch {
        if (cachedGeminiModels) {
            return {
                source: 'cache',
                count: cachedGeminiModels.models.length,
                models: cachedGeminiModels.models
            };
        }
        const fallbackList = buildGeminiModelList('3.5 Flash-Lite');
        return {
            source: 'fallback',
            count: fallbackList.length,
            models: fallbackList
        };
    }
}

/**
 * Returns available models for Google Gemini provider.
 */
export async function getGeminiModels(options?: FetchModelsOptions): Promise<GeminiModelInfo[]> {
    const res = await fetchGeminiModels(options);
    return res.models;
}

/**
 * Returns the default Gemini model dynamically without hardcoding.
 */
export async function getDefaultGeminiModel(): Promise<string> {
    if (cachedGeminiModels && cachedGeminiModels.defaultModel) {
        return cachedGeminiModels.defaultModel;
    }
    const catalog = await fetchGeminiModels();
    return catalog.models[0]?.id || formatGeminiModelId('3.5 Flash-Lite');
}

/**
 * Resolves a requested model name against the live scraped Gemini catalog.
 */
export async function resolveGeminiModel(requestedModel?: string): Promise<string> {
    if (!requestedModel || !requestedModel.trim()) {
        return getDefaultGeminiModel();
    }

    const clean = requestedModel.trim().replace(/^gemini\//i, '');
    const lower = clean.toLowerCase();

    if (lower === 'gemini' || lower === 'google') {
        return getDefaultGeminiModel();
    }

    try {
        const catalog = await fetchGeminiModels();
        const found = catalog.models.find(m => {
            const mId = m.id.toLowerCase();
            const mName = (m.name || '').toLowerCase();
            const mShort = (m.modelShortName || '').toLowerCase();
            return lower === mId || lower === mName || lower === mShort || mId.endsWith(lower) || lower.endsWith(mId);
        });
        if (found) return found.id;
    } catch {}

    return clean;
}

/**
 * Executes a one-shot Gemini request.
 * Completely stateless: zero global memory or cached variables (safe for serverless/edge).
 * Emits real-time tokens via `onChunk` callback if provided.
 */
export async function askGemini(
    prompt: string,
    options: AskGeminiOptions = {},
    env?: any
): Promise<GeminiResult> {
    const { onChunk = null, raw = false } = options;
    const startTime = Date.now();

    // 32-character random hex string representing the client interaction turn ID
    const turnHash = Array.from({ length: 32 }, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join('');

    // Randomized client interaction UUID
    const clientUuid = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'B9ECC548-B2B3-4CFA-9DE5-047C1E48217A';

    // Google Protobuf (JSPB) request array structure:
    // [0] = Prompt array | [1] = Locale | [2] = Turn history (null for one-shot)
    // [3] = BotGuard (null for guest) | [4] = Turn hash | [47] = Client UUID
    const inner = [
        [prompt, 0, null, null, null, null, 0],
        ['en-US'],
        null, null, turnHash,
        null, [1], 1, null, null, 1, 0, null, null, null, null, null,
        [[1]], 0, null, null, null, null, null, null, null, null, 1,
        null, null, [4], null, null, null, null, null, null, null, null,
        null, null, [2], null, null, null, null, null, null, null, null,
        null, null, null, 0, null, null, null, null, null,
        clientUuid,
        null, [], null, null, null, null, null, null, 2, null, null,
        null, null, null, null, null, null, null, null, 6, null, null,
        null, null, null, null, null, null, null, null, null, 0, null,
        null, null, null, 0, null, 1
    ];

    const reqId = Math.floor(Math.random() * 900000) + 100000;
    const body = new URLSearchParams({
        'f.req': JSON.stringify([null, JSON.stringify(inner)])
    }).toString();

    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Accept': 'application/json; charset=utf-8',
        'x-same-domain': '1',
        'User-Agent': DEFAULT_USER_AGENT
    };

    let bl = DEFAULT_BL;
    let url = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(bl)}&f.sid=0&hl=en-US&_reqid=${reqId}&rt=c`;

    let controller = new AbortController();
    let res = await fetch(url, { method: 'POST', signal: controller.signal, headers, body });

    // If default bl is rejected (Google updated build), auto-fetch latest bl and retry
    if (!res.ok) {
        bl = await fetchLatestBl();
        url = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(bl)}&f.sid=0&hl=en-US&_reqid=${reqId}&rt=c`;
        controller = new AbortController();
        res = await fetch(url, { method: 'POST', signal: controller.signal, headers, body });
        if (!res.ok) {
            throw new Error(`Gemini request failed (${res.status})`);
        }
    }

    if (!res.body) {
        throw new Error('Gemini response body is empty');
    }

    // Read response chunks in real-time
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let model = '';
    let emittedLength = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let isComplete = false;

        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Retain incomplete trailing line in buffer

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || /^\d+$/.test(trimmed)) continue;

            try {
                // Strip anti-XSSI prefix ")]}'" before JSON parse
                const parsed = JSON.parse(trimmed.replace(/^\)\]\}'\s*/, ''));
                for (const item of parsed) {
                    // "wrb.fr" is Google's Web RPC Batch Frame Response envelope
                    if (item[0] === 'wrb.fr' && item[2]) {
                        const data = JSON.parse(item[2]);

                        // Extract model name dynamically from Google's response
                        if (!model && Array.isArray(data)) {
                            if (typeof data[42] === 'string' && data[42]) {
                                model = data[42];
                            } else {
                                for (const val of data) {
                                    if (typeof val === 'string' && val.length > 0 && val.length < 50 && (val.includes('Flash') || val.includes('Pro') || val.includes('Lite') || val.includes('Gemini') || val.includes('Ultra'))) {
                                        model = val;
                                        break;
                                    }
                                }
                            }
                        }

                        // data[4][0][1][0] contains the candidate reply text
                        if (data[4]?.[0]?.[1]?.[0]) {
                            answer = data[4][0][1][0];

                            // Real-time streaming callback: emit token delta as it arrives
                            if (typeof onChunk === 'function' && answer.length > emittedLength) {
                                const delta = answer.slice(emittedLength);
                                emittedLength = answer.length;
                                onChunk(delta, model || cachedGeminiModels?.rawModelName || 'gemini');
                            }
                        }

                        // data[4][0][8] is status: [1] = in-progress, [2] = generation complete.
                        // Key "26" in data[2] is the end-of-turn context token.
                        if (data[4]?.[0]?.[8]?.[0] === 2 || data[2]?.['26']) {
                            isComplete = true;
                            break;
                        }
                    }
                }
            } catch {}
            if (isComplete) break;
        }

        // Abort early once text is complete to avoid waiting 2-3s for trailing metadata
        if (isComplete) {
            reader.cancel().catch(() => {});
            controller.abort();
            break;
        }
    }

    if (model) {
        updateCachedGeminiModel(model);
    }

    const defaultModel = cachedGeminiModels?.defaultModel || formatGeminiModelId('3.5 Flash-Lite');

    return {
        response: raw ? answer : cleanResponse(answer),
        model: model ? formatGeminiModelId(model) : defaultModel,
        timeMs: Date.now() - startTime
    };
}
