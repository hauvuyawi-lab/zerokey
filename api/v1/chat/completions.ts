import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import {
    unifiedExecute,
    normalizeMessages,
    resolveProvider
} from '../../../lib/providers/router';
import type {
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatCompletionChunk
} from '../../../lib/providers/types';
import { setCorsHeaders, resolveHttpStatus } from '../../../lib/http';

/**
 * OpenAI-compatible /v1/chat/completions endpoint
 * Unifies all providers (Gemini, DeepAI) behind the standard OpenAI API specification.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (setCorsHeaders(res, req)) return;

    if (req.method !== 'POST') {
        res.status(405).json({
            error: {
                message: `Method ${req.method} not allowed. Use POST.`,
                type: 'invalid_request_error',
                param: null,
                code: 'method_not_allowed'
            }
        });
        return;
    }

    let body: ChatCompletionRequest;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        res.status(400).json({
            error: {
                message: 'Invalid JSON payload in request body.',
                type: 'invalid_request_error',
                param: null,
                code: 'invalid_json'
            }
        });
        return;
    }

    const { model, messages, stream = false } = body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({
            error: {
                message: 'Missing or invalid "messages" array in request body.',
                type: 'invalid_request_error',
                param: 'messages',
                code: 'missing_messages'
            }
        });
        return;
    }

    const prompt = normalizeMessages(messages);
    if (!prompt) {
        res.status(400).json({
            error: {
                message: 'No message content provided in "messages" array.',
                type: 'invalid_request_error',
                param: 'messages',
                code: 'empty_prompt'
            }
        });
        return;
    }

    const { targetModel } = resolveProvider(model);
    const activeModel = targetModel || model || 'unified-model';
    const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);

    try {
        if (stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
                'Access-Control-Allow-Origin': '*'
            });

            // Initial role chunk
            const initialChunk: ChatCompletionChunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model: activeModel,
                choices: [
                    {
                        index: 0,
                        delta: { role: 'assistant' },
                        finish_reason: null
                    }
                ]
            };
            res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

            // Stream incremental token deltas
            await unifiedExecute({
                model,
                prompt,
                messages,
                onChunk: (token: string) => {
                    const chunk: ChatCompletionChunk = {
                        id,
                        object: 'chat.completion.chunk',
                        created,
                        model: activeModel,
                        choices: [
                            {
                                index: 0,
                                delta: { content: token },
                                finish_reason: null
                            }
                        ]
                    };
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    if (typeof (res as any).flush === 'function') {
                        (res as any).flush();
                    }
                }
            });

            // Final stop chunk
            const finalChunk: ChatCompletionChunk = {
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
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        // Non-streaming completion
        const result = await unifiedExecute({ model, prompt, messages });

        const responsePayload: ChatCompletionResponse = {
            id,
            object: 'chat.completion',
            created,
            model: result.model || activeModel,
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: result.response
                    },
                    finish_reason: 'stop'
                }
            ],
            usage: {
                prompt_tokens: Math.ceil(prompt.length / 4),
                completion_tokens: Math.ceil(result.response.length / 4),
                total_tokens: Math.ceil((prompt.length + result.response.length) / 4)
            }
        };

        res.status(200).json(responsePayload);
    } catch (error: any) {
        console.error('OpenAI Completions Error:', error);

        const status = resolveHttpStatus(error);
        const message = error?.message || 'Internal Server Error';

        if (stream) {
            res.write(`data: ${JSON.stringify({ error: { message, status } })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'api_error';
        const code = status === 418 ? 'bot_protection_418' : status === 429 ? 'rate_limit_exceeded' : status === 400 ? 'invalid_request' : 'internal_error';

        res.status(status).json({
            error: {
                message,
                type,
                param: null,
                code
            }
        });
    }
}
