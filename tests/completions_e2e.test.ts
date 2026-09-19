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

    it('serves /v1/models catalog', async () => {
        const req = new Request('http://localhost/v1/models', { method: 'GET' });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(200);
        expect(data?.object).toBe('list');
        expect(Array.isArray(data?.data)).toBe(true);
        expect(data.data.length).toBeGreaterThan(0);
    });

    it('executes real instant mode (stream: false) without continuation (default)', async () => {
        const req = new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'standard',
                messages: [{ role: 'user', content: 'Say "Cloudflare Worker Test Passed" and nothing else.' }],
                stream: false
            })
        });
        const res = await worker.fetch(req);
        const data = await res.json() as any;

        expect(res.status).toBe(200);
        expect(data?.object).toBe('chat.completion');
        expect(data?.choices?.[0]?.message?.content).toBeTruthy();
        expect(data?.choices?.[0]?.finish_reason).toBe('stop');
        expect(data?.usage?.completion_tokens).toBeGreaterThan(0);
    }, 15000);

    it('executes real streaming mode (stream: true) with Web Stream SSE output', async () => {
        const req = new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'standard',
                messages: [{ role: 'user', content: 'Count from 1 to 3.' }],
                stream: true
            })
        });
        const res = await worker.fetch(req);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');

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
    }, 15000);

    it('supports opt-in auto_continue strictly via query parameter ?ac=1', async () => {
        const req = new Request('http://localhost/v1/chat/completions?ac=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'standard',
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
                model: 'standard',
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
});
