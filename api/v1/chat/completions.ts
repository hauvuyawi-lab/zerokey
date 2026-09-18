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
import {
    isTruncated,
    deduplicateSeam,
    buildContinuationMessages
} from '../../../lib/continuation';

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

    const {
        model,
        messages,
        stream = false,
        auto_continue = true,
        max_continuations = 1
    } = body || {};

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
    const executionStartTime = Date.now();
    const MAX_TIME_BUDGET_MS = 10500;
    const allowedContinuations = Math.min(Math.max(0, max_continuations), 2);

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

            let accumulatedText = '';
            let currentMessages = messages;
            let currentPrompt = prompt;
            let pass = 0;

            const emitDelta = (content: string) => {
                const chunk: ChatCompletionChunk = {
                    id,
                    object: 'chat.completion.chunk',
                    created,
                    model: activeModel,
                    choices: [
                        {
                            index: 0,
                            delta: { content },
                            finish_reason: null
                        }
                    ]
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                if (typeof (res as any).flush === 'function') {
                    (res as any).flush();
                }
            };

            while (pass <= allowedContinuations) {
                let passBuffer = '';
                let passIsCheckingSeam = pass > 0;

                await unifiedExecute({
                    model,
                    prompt: currentPrompt,
                    messages: currentMessages,
                    onChunk: (token: string) => {
                        if (pass === 0) {
                            accumulatedText += token;
                            emitDelta(token);
                        } else {
                            if (passIsCheckingSeam) {
                                passBuffer += token;
                                if (passBuffer.length >= 30 || token.includes('\n')) {
                                    const deduped = deduplicateSeam(accumulatedText, passBuffer);
                                    accumulatedText += deduped;
                                    if (deduped) emitDelta(deduped);
                                    passIsCheckingSeam = false;
                                    passBuffer = '';
                                }
                            } else {
                                accumulatedText += token;
                                emitDelta(token);
                            }
                        }
                    }
                });

                if (passIsCheckingSeam && passBuffer) {
                    const deduped = deduplicateSeam(accumulatedText, passBuffer);
                    accumulatedText += deduped;
                    if (deduped) emitDelta(deduped);
                    passIsCheckingSeam = false;
                }

                pass++;

                const timeElapsed = Date.now() - executionStartTime;
                if (
                    !auto_continue ||
                    pass > allowedContinuations ||
                    timeElapsed > MAX_TIME_BUDGET_MS ||
                    !isTruncated(accumulatedText)
                ) {
                    break;
                }

                currentMessages = buildContinuationMessages(messages, accumulatedText);
                currentPrompt = normalizeMessages(currentMessages);
            }

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

        // Non-streaming completion with auto-continuation
        let accumulatedText = '';
        let currentMessages = messages;
        let currentPrompt = prompt;
        let pass = 0;
        let activeResultModel = activeModel;

        while (pass <= allowedContinuations) {
            const result = await unifiedExecute({
                model,
                prompt: currentPrompt,
                messages: currentMessages
            });
            activeResultModel = result.model || activeResultModel;

            if (pass === 0) {
                accumulatedText = result.response;
            } else {
                const cleanChunk = deduplicateSeam(accumulatedText, result.response);
                accumulatedText += cleanChunk;
            }

            pass++;

            const timeElapsed = Date.now() - executionStartTime;
            if (
                !auto_continue ||
                pass > allowedContinuations ||
                timeElapsed > MAX_TIME_BUDGET_MS ||
                !isTruncated(accumulatedText)
            ) {
                break;
            }

            currentMessages = buildContinuationMessages(messages, accumulatedText);
            currentPrompt = normalizeMessages(currentMessages);
        }

        const responsePayload: ChatCompletionResponse = {
            id,
            object: 'chat.completion',
            created,
            model: activeResultModel,
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: accumulatedText
                    },
                    finish_reason: 'stop'
                }
            ],
            usage: {
                prompt_tokens: Math.ceil(prompt.length / 4),
                completion_tokens: Math.ceil(accumulatedText.length / 4),
                total_tokens: Math.ceil((prompt.length + accumulatedText.length) / 4)
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
