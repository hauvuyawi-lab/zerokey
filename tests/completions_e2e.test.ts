import { describe, it, expect } from 'bun:test';
import worker from '../src/index';

describe('E2E /v1/chat/completions Handler (Cloudflare Worker)', () => {
    it('handles CORS OPTIONS preflight', async () => {
        const req = new Request('http://localhost/v1/chat/completions', { method: 'OPTIONS' });
        const res = await worker.fetch(req);

        expect(res.status).toBe(200);
        expect(res.headers.get('x-powered-by')).toBe('zerokey-edge');
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('rejects GET requests with 405 Method Not Allowed', async () => {
        const req = new Request('http://localhost/v1/chat/completions', { method: 'GET' });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(405);
        expect(data?.error?.code).toBe('method_not_allowed');
    });

    it('rejects empty messages array with 400', async () => {
        const req = new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [] })
        });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(400);
        expect(data?.error?.code).toBe('missing_messages');
    });

    it('serves /v1/models catalog with standard OpenAI format', async () => {
        const req = new Request('http://localhost/v1/models', { method: 'GET' });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(200);
        expect(data?.object).toBe('list');
        expect(Array.isArray(data?.data)).toBe(true);
        expect(data.data.length).toBeGreaterThan(0);
        expect(data.data[0].object).toBe('model');
        expect(typeof data.data[0].id).toBe('string');
        expect(typeof data.data[0].created).toBe('number');
        expect(typeof data.data[0].owned_by).toBe('string');
    });

    it('retrieves single model via GET /v1/models/:model', async () => {
        const listReq = new Request('http://localhost/v1/models', { method: 'GET' });
        const listRes = await worker.fetch(listReq);
        const listData = await listRes.json() as any;
        const targetModelId = listData.data[0].id;

        const req = new Request(`http://localhost/v1/models/${encodeURIComponent(targetModelId)}`, { method: 'GET' });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(200);
        expect(data?.id).toBe(targetModelId);
        expect(data?.object).toBe('model');
        expect(typeof data?.created).toBe('number');
        expect(typeof data?.owned_by).toBe('string');
    });

    it('returns standard 404 model_not_found for non-existent model on GET /v1/models/:model', async () => {
        const req = new Request('http://localhost/v1/models/non-existent-xyz-999', { method: 'GET' });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(404);
        expect(data?.error?.code).toBe('model_not_found');
        expect(data?.error?.type).toBe('invalid_request_error');
        expect(data?.error?.param).toBe('model');
    });

    it('rejects POST to /v1/models with 405 Method Not Allowed', async () => {
        const req = new Request('http://localhost/v1/models', { method: 'POST' });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(405);
        expect(data?.error?.code).toBe('method_not_allowed');
    });

    it('returns standard OpenAI 404 for unknown /v1 endpoints', async () => {
        const req = new Request('http://localhost/v1/unknown-endpoint', { method: 'GET' });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(404);
        expect(data?.error?.code).toBe('invalid_url');
        expect(data?.error?.type).toBe('invalid_request_error');
    });

    it('rejects non-object body in /v1/chat/completions with 400', async () => {
        const req = new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(['invalid', 'array'])
        });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(400);
        expect(data?.error?.type).toBe('invalid_request_error');
    });

    it('rejects messages lacking required role field with 400', async () => {
        const req = new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ content: 'Hello without role' }]
            })
        });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(400);
        expect(data?.error?.code).toBe('missing_role');
        expect(data?.error?.param).toBe('messages[0].role');
    });

    it('executes real instant mode (stream: false) with exact OpenAI schema and x-request-id', async () => {
        const req = new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gemini',
                messages: [{ role: 'user', content: 'Say "Cloudflare Worker Test Passed" and nothing else.' }],
                stream: false
            })
        });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(200);
        expect(res.headers.get('x-request-id')).toBeTruthy();
        expect(data?.id).toMatch(/^chatcmpl-/);
        expect(data?.object).toBe('chat.completion');
        expect(data?.system_fingerprint).toBeNull();
        expect(data?.choices?.[0]?.message?.role).toBe('assistant');
        expect(data?.choices?.[0]?.message?.content).toBeTruthy();
        expect(data?.choices?.[0]?.message?.refusal).toBeNull();
        expect(data?.choices?.[0]?.logprobs).toBeNull();
        expect(data?.choices?.[0]?.finish_reason).toBe('stop');
        expect(data?.usage?.prompt_tokens).toBeGreaterThan(0);
        expect(data?.usage?.completion_tokens).toBeGreaterThan(0);
        expect(data?.usage?.total_tokens).toBeGreaterThan(0);
    }, 15000);

    it('executes real streaming mode (stream: true) with Web Stream SSE output', async () => {
        const req = new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gemini',
                messages: [{ role: 'user', content: 'Count from 1 to 3.' }],
                stream: true
            })
        });
        const res = await worker.fetch(req);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        expect(res.headers.get('x-request-id')).toBeTruthy();

        const reader = res.body?.getReader();
        expect(reader).toBeTruthy();

        const decoder = new TextDecoder();
        let writtenData = '';

        while (true) {
            const { done, value } = await reader!.read();
            if (done) break;
            writtenData += decoder.decode(value, { stream: true });
        }

        expect(writtenData).toContain('data: ');
        expect(writtenData).toContain('data: [DONE]');

        const lines = writtenData.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
        expect(lines.length).toBeGreaterThan(0);
        const parsed = JSON.parse(lines[0].replace('data: ', ''));
        expect(parsed.object).toBe('chat.completion.chunk');
        expect(parsed.id).toMatch(/^chatcmpl-/);
        expect(parsed.system_fingerprint).toBeNull();
        expect(parsed.choices[0].logprobs).toBeNull();
    }, 15000);

    it('emits usage chunk when stream_options.include_usage is true in streaming mode', async () => {
        const req = new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gemini',
                messages: [{ role: 'user', content: 'Say "Hi".' }],
                stream: true,
                stream_options: { include_usage: true }
            })
        });
        const res = await worker.fetch(req);

        expect(res.status).toBe(200);
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let writtenData = '';

        while (true) {
            const { done, value } = await reader!.read();
            if (done) break;
            writtenData += decoder.decode(value, { stream: true });
        }

        const lines = writtenData.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
        const lastChunk = JSON.parse(lines[lines.length - 1].replace('data: ', ''));
        expect(lastChunk.choices).toEqual([]);
        expect(lastChunk.usage).toBeDefined();
        expect(lastChunk.usage.prompt_tokens).toBeGreaterThan(0);
        expect(lastChunk.usage.completion_tokens).toBeGreaterThan(0);
        expect(lastChunk.usage.total_tokens).toBeGreaterThan(0);
    }, 15000);

    it('supports opt-in auto_continue strictly via query parameter ?ac=1', async () => {
        const req = new Request('http://localhost/v1/chat/completions?ac=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gemini',
                messages: [{ role: 'user', content: 'Say "Continuation enabled test ok."' }],
                stream: false
            })
        });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(200);
        expect(data?.choices?.[0]?.message?.content).toBeTruthy();
    }, 15000);

    it('ignores header or body flags for auto_continue (query param only)', async () => {
        // Without ?ac=1, header and body flags are ignored
        const req = new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-auto-continue': '1'
            },
            body: JSON.stringify({
                model: 'gemini',
                messages: [{ role: 'user', content: 'Say "Standard test ok."' }],
                auto_continue: true,
                stream: false
            })
        });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(200);
        expect(data?.choices?.[0]?.message?.content).toBeTruthy();
    }, 15000);

    it('supports opt-in auto_continue on gemini model via ?ac=1', async () => {
        const req = new Request('http://localhost/v1/chat/completions?ac=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gemini',
                messages: [{ role: 'user', content: 'Say "Gemini Continuation Test Passed" and nothing else.' }],
                stream: false
            })
        });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(200);
        expect(data?.choices?.[0]?.message?.content).toBeTruthy();
    }, 15000);

    describe('DuckAI Standalone & Autonomous Token Ingestion Endpoints', () => {
        it('GET /duckai returns DuckAI models catalog', async () => {
            const req = new Request('http://localhost/duckai', { method: 'GET' });
            const res = await worker.fetch(req);
            const data = await res.json() as any;

            expect(res.status).toBe(200);
            expect(data?.provider).toBe('duckai');
            expect(Array.isArray(data?.models)).toBe(true);
            expect(data.models.length).toBeGreaterThan(0);
        });

        it('/duckai/token rejects unauthorized requests without ADMIN_KEY', async () => {
            const req = new Request('http://localhost/duckai/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ vqd: 'sample-token' })
            });
            const res = await worker.fetch(req, { ADMIN_KEY: 'secret123' });
            const data = await res.json() as any;

            expect(res.status).toBe(401);
            expect(data?.error?.code).toBe('unauthorized');
        });

        it('/duckai/token rejects invalid Bearer token', async () => {
            const req = new Request('http://localhost/duckai/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer wrong-key'
                },
                body: JSON.stringify({ vqd: 'sample-token' })
            });
            const res = await worker.fetch(req, { ADMIN_KEY: 'secret123' });
            const data = await res.json() as any;

            expect(res.status).toBe(401);
            expect(data?.error?.code).toBe('unauthorized');
        });

        it('/duckai/token stores fresh token in KV when authorized', async () => {
            const mockKvStore: Record<string, string> = {};
            const mockKv = {
                put: async (key: string, val: string) => { mockKvStore[key] = val; },
                get: async (key: string) => mockKvStore[key] || null
            } as unknown as KVNamespace;

            const postReq = new Request('http://localhost/duckai/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-admin-key'
                },
                body: JSON.stringify({ vqd: 'harvested-vqd-token-999' })
            });

            const postRes = await worker.fetch(postReq, {
                ADMIN_KEY: 'test-admin-key',
                ZEROKEY_KV: mockKv
            });
            const postData = await postRes.json() as any;

            expect(postRes.status).toBe(200);
            expect(postData?.success).toBe(true);
            expect(postData?.storedInKv).toBe(true);
            expect(postData?.tokenLength).toBe('harvested-vqd-token-999'.length);
            expect(mockKvStore['DUCKAI_VQD']).toBe('harvested-vqd-token-999');

            // Now test GET /duckai/token
            const getReq = new Request('http://localhost/duckai/token', {
                method: 'GET',
                headers: {
                    'Authorization': 'Bearer test-admin-key'
                }
            });
            const getRes = await worker.fetch(getReq, {
                ADMIN_KEY: 'test-admin-key',
                ZEROKEY_KV: mockKv
            });
            const getData = await getRes.json() as any;

            expect(getRes.status).toBe(200);
            expect(getData?.hasToken).toBe(true);
            expect(getData?.tokenLength).toBe('harvested-vqd-token-999'.length);
            expect(getData?.storedInKv).toBe(true);
        });

        it('/duckai/token rejects POST with missing or empty vqd', async () => {
            const req = new Request('http://localhost/duckai/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-admin-key'
                },
                body: JSON.stringify({ vqd: '   ' })
            });
            const res = await worker.fetch(req, { ADMIN_KEY: 'test-admin-key' });
            const data = await res.json() as any;

            expect(res.status).toBe(400);
            expect(data?.error?.code).toBe('missing_vqd');
        });
    });

    it('handles multimodal content arrays (images/files) in /v1/chat/completions without crashing', async () => {
        const req = new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gemini',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Say "Multimodal safe"' },
                            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } }
                        ]
                    }
                ],
                stream: false
            })
        });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(200);
        expect(data?.choices?.[0]?.message?.content).toBeTruthy();
    }, 15000);
});
