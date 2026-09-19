/**
 * src/index.ts - Zerokey Cloudflare Worker Entry Point.
 * High-performance, edge-native, multi-model AI gateway with Web Standards.
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
import { askDeepAi, fetchDeepAiModels } from './lib/providers/deepai';
import { isTruncated, deduplicateSeam, buildContinuationMessages } from './lib/continuation';
import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatCompletionChunk
} from './lib/providers/types';

export interface Env {
    ENVIRONMENT?: string;
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
                        deepai: '/deepai'
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
                return handleChatCompletions(request, url);
            }

            // 5. /gemini
            if (path === '/gemini') {
                return handleGeminiEndpoint(request);
            }

            // 6. /deepai
            if (path === '/deepai') {
                return handleDeepAiEndpoint(request);
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
async function handleChatCompletions(request: Request, url: URL): Promise<Response> {
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

    const { targetModel } = resolveProvider(model);
    const activeModel = targetModel || model || 'unified-model';
    const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    // --- Streaming Mode ---
    if (stream) {
        const sse = createSseStream();

        // Run streaming in background context of the response
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
                    }
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
                            }
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
    const initialResult = await unifiedExecute({ model, prompt, messages });
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
                messages: continuationMessages
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
 * Handles standalone /deepai endpoint.
 */
async function handleDeepAiEndpoint(request: Request): Promise<Response> {
    const parseResult = await parseAndValidateRequest(request);
    if (parseResult.error) {
        return jsonError(parseResult.error.status, parseResult.error.error);
    }

    if (parseResult.isModelQuery) {
        const models = (await fetchDeepAiModels()).models;
        return jsonResponse({ provider: 'deepai', models });
    }

    const { prompt, model, stream } = parseResult.data!;
    if (stream) {
        return streamSinglePrompt(prompt, (p, onChunk) => askDeepAi(p, { model, onChunk }));
    }

    const result = await askDeepAi(prompt, { model });
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
