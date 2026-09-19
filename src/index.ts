/**
 * src/index.ts - Zerokey Cloudflare Worker Entry Point.
 * High-performance, edge-native, multi-model AI gateway with Web Standards.
 * Providers: Google Gemini -> DuckAI.
 */

import {
    jsonResponse,
    jsonError,
    handleCorsPreflight,
    resolveHttpStatus,
    parseAndValidateRequest
} from './lib/http';
import { createSseStream } from './lib/sse';
import {
    unifiedExecute,
    normalizeMessages,
    resolveProvider,
    getUnifiedOpenAIModels
} from './lib/providers/router';
import { askGemini, getGeminiModels } from './lib/providers/gemini';
import { askDuckAi, fetchDuckAiModels } from './lib/providers/duckai';
import { isTruncated, deduplicateSeam, buildContinuationMessages } from './lib/continuation';
import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatCompletionChunk
} from './lib/providers/types';

export interface Env {
    ENVIRONMENT?: string;
    ADMIN_KEY?: string;
    DUCKAI_VQD?: string;
    ZEROKEY_KV?: KVNamespace;
    [key: string]: any;
}

export default {
    async fetch(request: Request, env?: Env, ctx?: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const method = request.method.toUpperCase();

        // 1. CORS Preflight
        if (method === 'OPTIONS') {
            return handleCorsPreflight();
        }

        try {
            // 2. Health & Root Info
            if (path === '/') {
                return jsonResponse({
                    name: 'zerokey',
                    version: '1.0.0',
                    runtime: 'cloudflare-workers',
                    description: 'Anonymous Serverless Multi-Model AI Gateway',
                    endpoints: {
                        models: '/v1/models',
                        completions: '/v1/chat/completions',
                        gemini: '/gemini',
                        duckai: '/duckai'
                    }
                });
            }

            // 3. /v1/models
            if (path === '/v1/models') {
                if (method !== 'GET') {
                    return jsonError(405, `Method ${method} not allowed. Use GET.`, 'method_not_allowed');
                }
                const models = await getUnifiedOpenAIModels();
                return jsonResponse(models, 200, {
                    'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400'
                });
            }

            // 4. /v1/chat/completions
            if (path === '/v1/chat/completions') {
                if (method !== 'POST') {
                    return jsonError(405, `Method ${method} not allowed. Use POST.`, 'method_not_allowed');
                }
                return handleChatCompletions(request, url, env);
            }

            // 5. /duckai/token (Autonomous VQD token ingestion & status check)
            if (path === '/duckai/token') {
                return handleDuckAiTokenEndpoint(request, env);
            }

            // 6. /gemini
            if (path === '/gemini') {
                return handleGeminiEndpoint(request);
            }

            // 7. /duckai
            if (path === '/duckai') {
                return handleDuckAiEndpoint(request, env);
            }

            return jsonError(404, `Route ${path} not found.`, 'not_found');
        } catch (err: any) {
            console.error('[WORKER ERROR]', err);
            const status = resolveHttpStatus(err);
            return jsonError(status, err?.message || 'Internal Server Error', 'server_error');
        }
    }
};

/**
 * Handles OpenAI-compatible /v1/chat/completions requests.
 */
async function handleChatCompletions(request: Request, url: URL, env?: Env): Promise<Response> {
    let body: ChatCompletionRequest;
    try {
        body = await request.json();
    } catch {
        return jsonError(400, 'Invalid JSON payload in request body.', 'invalid_json');
    }

    const { model, messages, stream = false } = body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return jsonError(400, 'Missing or invalid "messages" array in request body.', 'missing_messages');
    }

    const prompt = normalizeMessages(messages);
    if (!prompt) {
        return jsonError(400, 'No message content provided in "messages" array.', 'empty_prompt');
    }

    // Auto-continuation: OFF by default. Opt-in strictly via query parameter (?ac=1 or ?auto_continue=true).
    const acParam = url.searchParams.get('ac') || url.searchParams.get('auto_continue');
    const autoContinue = acParam === '1' || acParam === 'true';

    const { targetModel } = await resolveProvider(model);
    const activeModel = targetModel || model || 'unified-model';
    const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    // --- Streaming Mode ---
    if (stream) {
        const sse = createSseStream();

        (async () => {
            try {
                let accumulatedText = '';
                let chunkSeq = 0;

                const emitDelta = async (text: string) => {
                    const chunk: ChatCompletionChunk = {
                        id,
                        object: 'chat.completion.chunk',
                        created,
                        model: activeModel,
                        choices: [
                            {
                                index: 0,
                                delta: chunkSeq === 0 ? { role: 'assistant', content: text } : { content: text },
                                finish_reason: null
                            }
                        ]
                    };
                    chunkSeq++;
                    await sse.writeChunk(chunk);
                };

                const initialResult = await unifiedExecute({
                    model,
                    prompt,
                    messages,
                    onChunk: (token: string) => {
                        accumulatedText += token;
                        emitDelta(token);
                    },
                    env
                });

                if (!accumulatedText && initialResult.response) {
                    accumulatedText = initialResult.response;
                    await emitDelta(accumulatedText);
                }

                // If auto-continuation is opted-in (?ac=1), detect cutoff and continue
                if (autoContinue && isTruncated(accumulatedText)) {
                    let loopCount = 0;
                    const maxLoops = 2;

                    while (loopCount < maxLoops && isTruncated(accumulatedText)) {
                        loopCount++;
                        const continuationMessages = buildContinuationMessages(messages, accumulatedText);
                        const continuationPrompt = normalizeMessages(continuationMessages);

                        let nextPassText = '';
                        await unifiedExecute({
                            model,
                            prompt: continuationPrompt,
                            messages: continuationMessages,
                            onChunk: (token: string) => {
                                nextPassText += token;
                            },
                            env
                        });

                        if (!nextPassText.trim()) break;

                        const cleanedPass = deduplicateSeam(accumulatedText, nextPassText);
                        if (cleanedPass) {
                            accumulatedText += cleanedPass;
                            await emitDelta(cleanedPass);
                        } else {
                            break;
                        }
                    }
                }

                // Emit final stop chunk
                const stopChunk: ChatCompletionChunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: activeModel,
                    choices: [
                        {
                            index: 0,
                            delta: {},
                            finish_reason: 'stop'
                        }
                    ]
                };
                await sse.writeChunk(stopChunk);
                await sse.writeDone();
            } catch (streamErr: any) {
                console.error('[STREAM ERROR]', streamErr);
                await sse.writeChunk({ error: streamErr?.message || 'Streaming execution error' });
                await sse.writeDone();
            } finally {
                await sse.close();
            }
        })();

        return sse.toResponse(200);
    }

    // --- Instant Mode (Non-Streaming) ---
    const initialResult = await unifiedExecute({ model, prompt, messages, env });
    let fullText = initialResult.response || '';

    // If auto-continuation is opted-in (?ac=1), continue truncated responses
    if (autoContinue && isTruncated(fullText)) {
        let loopCount = 0;
        const maxLoops = 2;

        while (loopCount < maxLoops && isTruncated(fullText)) {
            loopCount++;
            const continuationMessages = buildContinuationMessages(messages, fullText);
            const continuationPrompt = normalizeMessages(continuationMessages);

            const nextPass = await unifiedExecute({
                model,
                prompt: continuationPrompt,
                messages: continuationMessages,
                env
            });

            if (!nextPass.response?.trim()) break;

            const cleanedNext = deduplicateSeam(fullText, nextPass.response);
            if (cleanedNext) {
                fullText += cleanedNext;
            } else {
                break;
            }
        }
    }

    const responsePayload: ChatCompletionResponse = {
        id,
        object: 'chat.completion',
        created,
        model: activeModel,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: fullText
                },
                finish_reason: 'stop'
            }
        ],
        usage: {
            prompt_tokens: Math.ceil(prompt.length / 4),
            completion_tokens: Math.ceil(fullText.length / 4),
            total_tokens: Math.ceil((prompt.length + fullText.length) / 4)
        }
    };

    return jsonResponse(responsePayload);
}

/**
 * Handles autonomous DuckAI VQD token ingestion and verification.
 * Guarded by ADMIN_KEY secret.
 */
async function handleDuckAiTokenEndpoint(request: Request, env?: Env): Promise<Response> {
    const method = request.method.toUpperCase();

    // Authenticate with Bearer token
    const authHeader = request.headers.get('authorization') || '';
    const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    const adminKey = env?.ADMIN_KEY || (typeof process !== 'undefined' ? process.env?.ADMIN_KEY : undefined);

    if (!adminKey || bearerToken !== adminKey) {
        return jsonError(401, 'Unauthorized: Invalid or missing ADMIN_KEY', 'unauthorized');
    }

    if (method === 'POST') {
        let body: any;
        try {
            body = await request.json();
        } catch {
            return jsonError(400, 'Invalid JSON body', 'invalid_json');
        }

        const vqd = typeof body?.vqd === 'string' ? body.vqd.trim() : '';
        if (!vqd) {
            return jsonError(400, 'Missing "vqd" string in request body', 'missing_vqd');
        }

        let storedInKv = false;
        if (env?.ZEROKEY_KV) {
            await env.ZEROKEY_KV.put('DUCKAI_VQD', vqd);
            storedInKv = true;
        }

        return jsonResponse({
            success: true,
            message: 'DuckAI VQD token updated successfully',
            tokenLength: vqd.length,
            storedInKv,
            updatedAt: new Date().toISOString()
        });
    }

    if (method === 'GET') {
        let currentToken = '';
        let storedInKv = false;

        if (env?.ZEROKEY_KV) {
            try {
                currentToken = (await env.ZEROKEY_KV.get('DUCKAI_VQD')) || '';
                storedInKv = true;
            } catch {}
        }
        if (!currentToken && env?.DUCKAI_VQD) {
            currentToken = env.DUCKAI_VQD;
        }

        return jsonResponse({
            hasToken: !!currentToken,
            tokenLength: currentToken.length,
            storedInKv
        });
    }

    return jsonError(405, `Method ${method} not allowed`, 'method_not_allowed');
}

/**
 * Handles standalone /gemini endpoint.
 */
async function handleGeminiEndpoint(request: Request): Promise<Response> {
    const parseResult = await parseAndValidateRequest(request);
    if (parseResult.error) {
        return jsonError(parseResult.error.status, parseResult.error.error);
    }

    if (parseResult.isModelQuery) {
        const models = await getGeminiModels();
        return jsonResponse({ provider: 'gemini', models });
    }

    const { prompt, stream } = parseResult.data!;
    if (stream) {
        return streamSinglePrompt(prompt, (p, onChunk) => askGemini(p, { onChunk }));
    }

    const result = await askGemini(prompt);
    return jsonResponse(result);
}

/**
 * Handles standalone /duckai endpoint.
 */
async function handleDuckAiEndpoint(request: Request, env?: Env): Promise<Response> {
    const parseResult = await parseAndValidateRequest(request);
    if (parseResult.error) {
        return jsonError(parseResult.error.status, parseResult.error.error);
    }

    if (parseResult.isModelQuery) {
        const models = (await fetchDuckAiModels()).models;
        return jsonResponse({ provider: 'duckai', models });
    }

    const { prompt, model, stream } = parseResult.data!;
    if (stream) {
        return streamSinglePrompt(prompt, (p, onChunk) => askDuckAi(p, { model, onChunk }, env));
    }

    const result = await askDuckAi(prompt, { model }, env);
    return jsonResponse(result);
}

/**
 * Helper to stream standalone provider endpoint responses as SSE.
 */
function streamSinglePrompt(
    prompt: string,
    execute: (p: string, onChunk: (t: string) => void) => Promise<any>
): Response {
    const sse = createSseStream();
    (async () => {
        try {
            await execute(prompt, async token => {
                await sse.writeChunk({ response: token });
            });
            await sse.writeDone();
        } catch (err: any) {
            await sse.writeChunk({ error: err?.message || 'Execution error' });
            await sse.writeDone();
        } finally {
            await sse.close();
        }
    })();
    return sse.toResponse(200);
}
