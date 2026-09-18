import { describe, it, expect } from 'bun:test';
import handler from '../api/v1/chat/completions';
import type { VercelRequest, VercelResponse } from '@vercel/node';

function createMockReq(options: {
    method?: string;
    body?: any;
    headers?: Record<string, string>;
}): VercelRequest {
    return {
        method: options.method || 'POST',
        headers: options.headers || {},
        body: options.body || {}
    } as unknown as VercelRequest;
}

function createMockRes() {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    let writtenData = '';
    let ended = false;
    let jsonBody: any = null;

    const res = {
        status(code: number) {
            statusCode = code;
            return this;
        },
        setHeader(k: string, v: string) {
            headers[k.toLowerCase()] = v;
            return this;
        },
        getHeader(k: string) {
            return headers[k.toLowerCase()];
        },
        writeHead(code: number, hdrs?: Record<string, string>) {
            statusCode = code;
            if (hdrs) {
                for (const [k, v] of Object.entries(hdrs)) {
                    headers[k.toLowerCase()] = v;
                }
            }
            return this;
        },
        write(chunk: any) {
            writtenData += chunk ? chunk.toString() : '';
            return true;
        },
        end(chunk?: any) {
            if (chunk) writtenData += chunk.toString();
            ended = true;
        },
        json(data: any) {
            jsonBody = data;
            ended = true;
        },
        get statusCode() { return statusCode; },
        get writtenData() { return writtenData; },
        get jsonBody() { return jsonBody; },
        get ended() { return ended; },
        headers
    };

    return res as unknown as VercelResponse & {
        statusCode: number;
        writtenData: string;
        jsonBody: any;
        ended: boolean;
        headers: Record<string, string>;
    };
}

describe('E2E /v1/chat/completions Handler (Local Verification)', () => {
    it('handles CORS OPTIONS preflight', async () => {
        const req = createMockReq({ method: 'OPTIONS' });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.headers['x-powered-by']).toBe('zerokey');
    });

    it('rejects GET requests with 405 Method Not Allowed', async () => {
        const req = createMockReq({ method: 'GET' });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(405);
        expect(res.jsonBody?.error?.code).toBe('method_not_allowed');
    });

    it('rejects empty messages array with 400', async () => {
        const req = createMockReq({
            method: 'POST',
            body: { messages: [] }
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.jsonBody?.error?.code).toBe('missing_messages');
    });

    it('executes real instant mode (stream: false) with auto_continue enabled', async () => {
        const req = createMockReq({
            method: 'POST',
            body: {
                model: 'standard',
                messages: [{ role: 'user', content: 'Say "AutoContinue Test Passed" and nothing else.' }],
                stream: false,
                auto_continue: true
            }
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.jsonBody?.object).toBe('chat.completion');
        expect(res.jsonBody?.choices?.[0]?.message?.content).toBeTruthy();
        expect(res.jsonBody?.choices?.[0]?.finish_reason).toBe('stop');
        expect(res.jsonBody?.usage?.completion_tokens).toBeGreaterThan(0);
    }, 15000);

    it('executes real streaming mode (stream: true) with SSE output', async () => {
        const req = createMockReq({
            method: 'POST',
            body: {
                model: 'standard',
                messages: [{ role: 'user', content: 'Count from 1 to 3.' }],
                stream: true,
                auto_continue: true
            }
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.writtenData).toContain('data: ');
        expect(res.writtenData).toContain('data: [DONE]');

        // Validate chunks parse as valid JSON
        const lines = res.writtenData.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
        expect(lines.length).toBeGreaterThan(1);
        const parsed = JSON.parse(lines[0].replace('data: ', ''));
        expect(parsed.object).toBe('chat.completion.chunk');
    }, 15000);
});
