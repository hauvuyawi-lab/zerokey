import { describe, it, expect } from 'bun:test';
import { parseAndValidateRequest, resolveHttpStatus } from '../src/lib/http';

describe('Request Validation (src/lib/http.ts)', () => {
    describe('HTTP Method Check', () => {
        it('should allow GET and POST methods', async () => {
            const getReq = new Request('http://localhost/gemini?prompt=hello', { method: 'GET' });
            const postReq = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'hello' })
            });

            expect((await parseAndValidateRequest(getReq)).error).toBeUndefined();
            expect((await parseAndValidateRequest(postReq)).error).toBeUndefined();
        });

        it('should return 405 for disallowed HTTP methods', async () => {
            const delReq = new Request('http://localhost/gemini', { method: 'DELETE' });
            const putReq = new Request('http://localhost/gemini', { method: 'PUT' });

            const delRes = await parseAndValidateRequest(delReq);
            expect(delRes.error?.status).toBe(405);
            expect(delRes.error?.error).toContain('Method DELETE not allowed');

            const putRes = await parseAndValidateRequest(putReq);
            expect(putRes.error?.status).toBe(405);
            expect(putRes.error?.error).toContain('Method PUT not allowed');
        });
    });

    describe('Model Catalog Discovery on GET', () => {
        it('should detect model query when ?models=true is present', async () => {
            const req = new Request('http://localhost/gemini?models=true', { method: 'GET' });
            const res = await parseAndValidateRequest(req);
            expect(res.isModelQuery).toBe(true);
        });

        it('should detect model query on GET when prompt is missing', async () => {
            const req = new Request('http://localhost/gemini', { method: 'GET' });
            const res = await parseAndValidateRequest(req);
            expect(res.isModelQuery).toBe(true);
        });

        it('should parse chat request on GET when prompt is provided', async () => {
            const req = new Request('http://localhost/gemini?prompt=What+is+2%2B2%3F&stream=true', { method: 'GET' });
            const res = await parseAndValidateRequest(req);
            expect(res.isModelQuery).toBeUndefined();
            expect(res.data?.prompt).toBe('What is 2+2?');
            expect(res.data?.stream).toBe(true);
        });
    });

    describe('JSON Payload & Body Validation (POST)', () => {
        it('should return 400 when body is invalid JSON string', async () => {
            const req = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{malformed json'
            });
            const res = await parseAndValidateRequest(req);
            expect(res.error?.status).toBe(400);
            expect(res.error?.error).toBe('Invalid JSON payload in request body.');
        });

        it('should return 400 when body is an array or primitive', async () => {
            const reqArray = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(['hello'])
            });
            const resArray = await parseAndValidateRequest(reqArray);
            expect(resArray.error?.status).toBe(400);
            expect(resArray.error?.error).toBe('Request body must be a valid JSON object.');

            const reqNull = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(null)
            });
            const resNull = await parseAndValidateRequest(reqNull);
            expect(resNull.error?.status).toBe(400);
        });

        it('should return 400 when both prompt and messages are missing', async () => {
            const req = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const res = await parseAndValidateRequest(req);
            expect(res.error?.status).toBe(400);
            expect(res.error?.error).toBe("Missing required 'prompt' or 'messages' in request.");
        });
    });

    describe('Field Type & Value Validation', () => {
        it('should reject non-string prompt', async () => {
            const req = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 12345 })
            });
            const res = await parseAndValidateRequest(req);
            expect(res.error?.status).toBe(400);
            expect(res.error?.error).toBe("Field 'prompt' must be a string.");
        });

        it('should reject empty or whitespace-only prompt', async () => {
            const reqEmpty = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: '' })
            });
            expect((await parseAndValidateRequest(reqEmpty)).error?.error).toBe("Field 'prompt' cannot be empty.");

            const reqSpaces = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: '    \n  ' })
            });
            expect((await parseAndValidateRequest(reqSpaces)).error?.error).toBe("Field 'prompt' cannot be empty.");
        });

        it('should reject non-boolean stream', async () => {
            const req = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'hi', stream: 'true' })
            });
            const res = await parseAndValidateRequest(req);
            expect(res.error?.status).toBe(400);
            expect(res.error?.error).toBe("Field 'stream' must be a boolean (true or false).");
        });

        it('should reject empty model or non-string model', async () => {
            const reqNum = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'hi', model: 123 })
            });
            expect((await parseAndValidateRequest(reqNum)).error?.error).toBe("Field 'model' must be a string.");

            const reqEmpty = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'hi', model: '   ' })
            });
            expect((await parseAndValidateRequest(reqEmpty)).error?.error).toBe("Field 'model' cannot be empty.");
        });

        it('should correctly extract messages array', async () => {
            const req = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: 'You are helpful.' },
                        { role: 'user', content: 'What is gravity?' }
                    ]
                })
            });
            const res = await parseAndValidateRequest(req);
            expect(res.error).toBeUndefined();
            expect(res.data?.prompt).toContain('Instructions: You are helpful.');
            expect(res.data?.prompt).toContain('User: What is gravity?');
        });

        it('should reject invalid messages format', async () => {
            const reqNotArr = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: 'not an array' })
            });
            expect((await parseAndValidateRequest(reqNotArr)).error?.error).toBe("Field 'messages' must be a non-empty array.");

            const reqEmptyArr = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: [] })
            });
            expect((await parseAndValidateRequest(reqEmptyArr)).error?.error).toBe("Field 'messages' must be a non-empty array.");

            const reqBadItem = new Request('http://localhost/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: [{ role: 'user' }] })
            });
            expect((await parseAndValidateRequest(reqBadItem)).error?.error).toContain("must be an object with string 'content'");
        });
    });

    describe('HTTP Status Resolution (resolveHttpStatus)', () => {
        it('should map unknown model and validation errors to 400', () => {
            expect(resolveHttpStatus(new Error("Unknown model 'foo'."))).toBe(400);
            expect(resolveHttpStatus(new Error("Missing required field"))).toBe(400);
            expect(resolveHttpStatus(new Error("Invalid JSON payload"))).toBe(400);
        });

        it('should map anti-bot challenge to 418', () => {
            expect(resolveHttpStatus(new Error("Bot Protection (418): challenge required"))).toBe(418);
            expect(resolveHttpStatus(new Error("ERR_CHALLENGE"))).toBe(418);
        });

        it('should map rate limit errors to 429', () => {
            expect(resolveHttpStatus(new Error("rate limit reached"))).toBe(429);
            expect(resolveHttpStatus(new Error("HTTP 429 Too Many Requests"))).toBe(429);
        });

        it('should map upstream outages/timeouts to 502', () => {
            expect(resolveHttpStatus(new Error("fetch failed"))).toBe(502);
            expect(resolveHttpStatus(new Error("Gemini response body is empty"))).toBe(502);
            expect(resolveHttpStatus(new Error("Gemini request failed (503)"))).toBe(502);
        });

        it('should fallback to 500 for generic unhandled errors', () => {
            expect(resolveHttpStatus(new Error("Unexpected internal crash"))).toBe(500);
        });
    });
});
