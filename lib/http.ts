import type { VercelRequest, VercelResponse } from '@vercel/node';
import { normalizeMessages } from './providers/router';
import type { ProviderResult, StandardErrorResponse } from './providers/types';

export interface ValidatedChatRequest {
    prompt: string;
    model?: string;
    stream: boolean;
    customHash?: string;
}

export interface ParseResult {
    data?: ValidatedChatRequest;
    error?: StandardErrorResponse;
    isModelQuery?: boolean;
}

/**
 * Sets standard permissive CORS headers.
 * Automatically completes OPTIONS preflight requests with 200 OK.
 */
export function setCorsHeaders(res: VercelResponse, req: VercelRequest): boolean {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Requested-With, Accept, User-Agent, X-Api-Key'
    );
    res.setHeader('X-Powered-By', 'zerokey');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return true;
    }
    return false;
}

/**
 * Sends a standardized JSON error response across all HTTP status codes.
 */
export function sendError(res: VercelResponse, status: number, error: string): void {
    res.status(status).json({ status, error });
}

/**
 * Sends a standardized SSE error event chunk.
 */
export function sendStreamError(res: VercelResponse, status: number, error: string): void {
    res.write(`data: ${JSON.stringify({ status, error })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

/**
 * Maps error messages/types to appropriate HTTP status codes.
 */
export function resolveHttpStatus(error: any): number {
    if (typeof error?.status === 'number' && error.status >= 400 && error.status <= 599) {
        return error.status;
    }
    const msg = String(error?.message || error || '');
    if (
        msg.startsWith('Unknown model') ||
        msg.includes('Missing required') ||
        msg.includes('Invalid') ||
        msg.includes('cannot be empty') ||
        msg.includes('must be')
    ) {
        return 400;
    }
    if (msg.includes('418') || msg.includes('Bot Protection') || msg.includes('ERR_CHALLENGE')) {
        return 418;
    }
    if (msg.includes('429') || msg.includes('rate limit')) {
        return 429;
    }
    if (
        msg.includes('failed (') ||
        msg.includes('empty body') ||
        msg.includes('body is empty') ||
        msg.includes('unavailable') ||
        msg.includes('fetch failed')
    ) {
        return 502;
    }
    return 500;
}

/**
 * Validates incoming GET and POST requests for non-OpenAI endpoints (/gemini, /deepai).
 * Extracts parameters consistently, applies strict type and content checks, and returns parsed data.
 */
export function parseAndValidateRequest(req: VercelRequest): ParseResult {
    // 1. Method check
    if (req.method !== 'GET' && req.method !== 'POST') {
        return {
            error: {
                status: 405,
                error: `Method ${req.method} not allowed. Supported methods: GET, POST.`
            }
        };
    }

    // 2. Model catalog query on GET without prompt or with ?models=true
    if (req.method === 'GET' && (req.query.models === 'true' || !req.query.prompt)) {
        return { isModelQuery: true };
    }

    // 3. Normalize parameters from query (GET) or body (POST)
    let raw: any;
    if (req.method === 'POST') {
        try {
            raw = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        } catch {
            return { error: { status: 400, error: 'Invalid JSON payload in request body.' } };
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { error: { status: 400, error: 'Request body must be a valid JSON object.' } };
        }
    } else {
        const queryPrompt = Array.isArray(req.query.prompt) ? req.query.prompt[0] : req.query.prompt;
        const queryModel = Array.isArray(req.query.model) ? req.query.model[0] : req.query.model;
        const queryHash = Array.isArray(req.query.customHash) ? req.query.customHash[0] : req.query.customHash;
        const streamVal = req.query.stream === 'true' ? true : req.query.stream === 'false' ? false : req.query.stream;

        raw = {
            prompt: queryPrompt,
            model: queryModel,
            stream: streamVal,
            customHash: queryHash
        };
    }

    // 4. Validate Prompt & Messages
    let prompt = '';
    if (raw.prompt !== undefined) {
        if (typeof raw.prompt !== 'string') {
            return { error: { status: 400, error: "Field 'prompt' must be a string." } };
        }
        if (!raw.prompt.trim()) {
            return { error: { status: 400, error: "Field 'prompt' cannot be empty." } };
        }
        prompt = raw.prompt.trim();
    } else if (raw.messages !== undefined) {
        if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
            return { error: { status: 400, error: "Field 'messages' must be a non-empty array." } };
        }
        for (const [i, msg] of raw.messages.entries()) {
            if (!msg || typeof msg !== 'object' || typeof msg.content !== 'string') {
                return { error: { status: 400, error: `Message at index ${i} must be an object with string 'content'.` } };
            }
        }
        prompt = normalizeMessages(raw.messages);
        if (!prompt) {
            return { error: { status: 400, error: "Messages array contains no valid text content." } };
        }
    } else {
        return { error: { status: 400, error: "Missing required 'prompt' or 'messages' in request." } };
    }

    // 5. Validate Stream
    if (raw.stream !== undefined && typeof raw.stream !== 'boolean') {
        return { error: { status: 400, error: "Field 'stream' must be a boolean (true or false)." } };
    }
    const stream = Boolean(raw.stream) || Boolean(req.headers.accept?.includes('text/event-stream'));

    // 6. Validate Model
    if (raw.model !== undefined) {
        if (typeof raw.model !== 'string') {
            return { error: { status: 400, error: "Field 'model' must be a string." } };
        }
        if (!raw.model.trim()) {
            return { error: { status: 400, error: "Field 'model' cannot be empty." } };
        }
    }

    // 7. Validate CustomHash
    if (raw.customHash !== undefined) {
        if (typeof raw.customHash !== 'string') {
            return { error: { status: 400, error: "Field 'customHash' must be a string." } };
        }
        if (!raw.customHash.trim()) {
            return { error: { status: 400, error: "Field 'customHash' cannot be empty." } };
        }
    }

    return {
        data: {
            prompt,
            model: raw.model ? String(raw.model).trim() : undefined,
            stream,
            customHash: raw.customHash ? String(raw.customHash).trim() : undefined
        }
    };
}

/**
 * Unified request handler for provider endpoints (/gemini, /deepai).
 * DRY runner that handles CORS, validation, model listing, streaming SSE, and error dispatch.
 */
export async function handleProviderRequest(
    req: VercelRequest,
    res: VercelResponse,
    provider: 'gemini' | 'deepai',
    getModels: () => Promise<any> | any,
    ask: (params: {
        prompt: string;
        model?: string;
        customHash?: string;
        onChunk?: (token: string, model?: string) => void;
    }) => Promise<ProviderResult>
): Promise<void> {
    if (setCorsHeaders(res, req)) return;

    const validated = parseAndValidateRequest(req);
    if (validated.error) {
        sendError(res, validated.error.status, validated.error.error);
        return;
    }

    if (validated.isModelQuery) {
        const models = await getModels();
        res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
        res.status(200).json({ provider, models });
        return;
    }

    const { prompt, model, stream, customHash } = validated.data!;

    try {
        if (stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
                'Access-Control-Allow-Origin': '*'
            });

            await ask({
                prompt,
                model,
                customHash,
                onChunk: (token: string, chunkModel?: string) => {
                    res.write(`data: ${JSON.stringify({ chunk: token, model: chunkModel || model || provider })}\n\n`);
                    if (typeof (res as any).flush === 'function') {
                        (res as any).flush();
                    }
                }
            });

            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        const result = await ask({ prompt, model, customHash });
        res.status(200).json(result);
    } catch (error: any) {
        console.error(`${provider} API Error:`, error);
        const status = resolveHttpStatus(error);
        const message = error?.message || 'Internal Server Error';

        if (stream) {
            sendStreamError(res, status, message);
            return;
        }
        sendError(res, status, message);
    }
}
