/**
 * src/lib/http.ts - Web Standard HTTP utilities for Cloudflare Workers.
 */

import { normalizeMessages } from './providers/router';
import type { StandardErrorResponse } from './providers/types';

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
 */
export function setCorsHeaders(headers: Headers): void {
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Requested-With, Accept, User-Agent, X-Api-Key'
    );
    headers.set('X-Powered-By', 'zerokey-edge');
}

/**
 * Creates standard JSON Response with CORS headers.
 */
export function jsonResponse(data: any, status: number = 200, extraHeaders?: HeadersInit): Response {
    const headers = new Headers(extraHeaders);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    setCorsHeaders(headers);
    return new Response(JSON.stringify(data), { status, headers });
}

/**
 * Creates standard OpenAI-compatible JSON error Response.
 */
export function jsonError(
    status: number,
    message: string,
    code: string = 'api_error',
    type: string = 'invalid_request_error'
): Response {
    return jsonResponse(
        {
            error: {
                message,
                type,
                param: null,
                code
            }
        },
        status
    );
}

/**
 * Handles CORS preflight OPTIONS requests.
 */
export function handleCorsPreflight(): Response {
    const headers = new Headers();
    setCorsHeaders(headers);
    return new Response(null, { status: 200, headers });
}

/**
 * Maps error messages/types to appropriate HTTP status codes.
 */
export function resolveHttpStatus(error: any): number {
    if (typeof error?.status === 'number' && error.status >= 400 && error.status <= 599) {
        return error.status;
    }

    const message = (error?.message || String(error || '')).toLowerCase();

    if (
        message.includes('challenge') ||
        message.includes('cloudflare') ||
        message.includes('captcha') ||
        message.includes('418') ||
        message.includes('err_challenge') ||
        message.includes('bot protection')
    ) {
        return 418;
    }

    if (message.includes('rate limit') || message.includes('too many requests') || message.includes('429')) {
        return 429;
    }

    if (
        message.includes('upstream') ||
        message.includes('timeout') ||
        message.includes('aborted') ||
        message.includes('overloaded') ||
        message.includes('network') ||
        message.includes('fetch failed') ||
        message.includes('body is empty') ||
        message.includes('empty body') ||
        message.includes('failed (') ||
        message.includes('unavailable')
    ) {
        return 502;
    }

    if (
        message.includes('unknown model') ||
        message.includes('missing required') ||
        message.includes('cannot be empty') ||
        message.includes('must be') ||
        message.includes('invalid')
    ) {
        return 400;
    }

    return 500;
}

/**
 * Validates incoming GET and POST requests for provider endpoints (/gemini, /deepai).
 * Edge-native: reads Web Standard Request.
 */
export async function parseAndValidateRequest(request: Request): Promise<ParseResult> {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
        return {
            error: {
                status: 405,
                error: `Method ${method} not allowed. Supported methods: GET, POST.`
            }
        };
    }

    const url = new URL(request.url, 'http://localhost');

    // Model catalog query on GET without prompt or with ?models=true
    if (method === 'GET' && (url.searchParams.get('models') === 'true' || !url.searchParams.has('prompt'))) {
        return { isModelQuery: true };
    }

    let raw: any;
    if (method === 'POST') {
        let text = '';
        try {
            text = await request.text();
        } catch {
            return { error: { status: 400, error: 'Invalid JSON payload in request body.' } };
        }

        if (!text || !text.trim()) {
            return { error: { status: 400, error: "Missing required 'prompt' or 'messages' in request." } };
        }

        try {
            raw = JSON.parse(text);
        } catch {
            return { error: { status: 400, error: 'Invalid JSON payload in request body.' } };
        }

        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { error: { status: 400, error: 'Request body must be a valid JSON object.' } };
        }
    } else {
        const queryPrompt = url.searchParams.get('prompt') ?? undefined;
        const queryModel = url.searchParams.get('model') ?? undefined;
        const queryHash = url.searchParams.get('customHash') ?? undefined;
        const streamParam = url.searchParams.get('stream');
        const streamVal = streamParam === 'true' ? true : streamParam === 'false' ? false : streamParam !== null ? streamParam : undefined;

        raw = {
            prompt: queryPrompt,
            model: queryModel,
            stream: streamVal,
            customHash: queryHash
        };
    }

    // Validate Prompt & Messages
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
            return { error: { status: 400, error: "Field 'messages' must be a non-empty array." } };
        }
    } else {
        return { error: { status: 400, error: "Missing required 'prompt' or 'messages' in request." } };
    }

    // Validate Stream
    if (raw.stream !== undefined && typeof raw.stream !== 'boolean') {
        return { error: { status: 400, error: "Field 'stream' must be a boolean (true or false)." } };
    }
    const stream = Boolean(raw.stream) || Boolean(request.headers.get('accept')?.includes('text/event-stream'));

    // Validate Model
    if (raw.model !== undefined) {
        if (typeof raw.model !== 'string') {
            return { error: { status: 400, error: "Field 'model' must be a string." } };
        }
        if (!raw.model.trim()) {
            return { error: { status: 400, error: "Field 'model' cannot be empty." } };
        }
    }

    // Validate CustomHash
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
