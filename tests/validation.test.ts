import { describe, it, expect } from 'bun:test';
import { parseAndValidateRequest, resolveHttpStatus } from '../lib/http';
import type { VercelRequest } from '@vercel/node';

function createMockReq(overrides: Partial<any> = {}): VercelRequest {
    return {
        method: 'POST',
        headers: {},
        query: {},
        body: {},
        ...overrides
    } as unknown as VercelRequest;
}

describe('Request Validation (lib/http.ts)', () => {
    describe('HTTP Method Check', () => {
        it('should allow GET and POST methods', () => {
            const getReq = createMockReq({ method: 'GET', query: { prompt: 'hello' } });
            const postReq = createMockReq({ method: 'POST', body: { prompt: 'hello' } });

            expect(parseAndValidateRequest(getReq).error).toBeUndefined();
            expect(parseAndValidateRequest(postReq).error).toBeUndefined();
        });

        it('should return 405 for disallowed HTTP methods', () => {
            const deleteReq = createMockReq({ method: 'DELETE' });
            const putReq = createMockReq({ method: 'PUT' });

            const delRes = parseAndValidateRequest(deleteReq);
            expect(delRes.error?.status).toBe(405);
            expect(delRes.error?.error).toContain('Method DELETE not allowed');

            const putRes = parseAndValidateRequest(putReq);
            expect(putRes.error?.status).toBe(405);
            expect(putRes.error?.error).toContain('Method PUT not allowed');
        });
    });

    describe('Model Catalog Discovery on GET', () => {
        it('should detect model query when ?models=true is present', () => {
            const req = createMockReq({ method: 'GET', query: { models: 'true' } });
            const res = parseAndValidateRequest(req);
            expect(res.isModelQuery).toBe(true);
        });

        it('should detect model query on GET when prompt is missing', () => {
            const req = createMockReq({ method: 'GET', query: {} });
            const res = parseAndValidateRequest(req);
            expect(res.isModelQuery).toBe(true);
        });

        it('should parse chat request on GET when prompt is provided', () => {
            const req = createMockReq({ method: 'GET', query: { prompt: 'What is 2+2?', stream: 'true' } });
            const res = parseAndValidateRequest(req);
            expect(res.isModelQuery).toBeUndefined();
            expect(res.data?.prompt).toBe('What is 2+2?');
            expect(res.data?.stream).toBe(true);
        });
    });

    describe('JSON Payload & Body Validation (POST)', () => {
        it('should return 400 when body is invalid JSON string', () => {
            const req = createMockReq({ method: 'POST', body: '{malformed json' });
            const res = parseAndValidateRequest(req);
            expect(res.error?.status).toBe(400);
            expect(res.error?.error).toBe('Invalid JSON payload in request body.');
        });

        it('should return 400 when body is an array or primitive', () => {
            const reqArray = createMockReq({ method: 'POST', body: ['hello'] });
            const resArray = parseAndValidateRequest(reqArray);
            expect(resArray.error?.status).toBe(400);
            expect(resArray.error?.error).toBe('Request body must be a valid JSON object.');

            const reqNull = createMockReq({ method: 'POST', body: null });
            const resNull = parseAndValidateRequest(reqNull);
            expect(resNull.error?.status).toBe(400);
        });

        it('should return 400 when both prompt and messages are missing', () => {
            const req = createMockReq({ method: 'POST', body: {} });
            const res = parseAndValidateRequest(req);
            expect(res.error?.status).toBe(400);
            expect(res.error?.error).toBe("Missing required 'prompt' or 'messages' in request.");
        });
    });

    describe('Field Type & Value Validation', () => {
        it('should reject non-string prompt', () => {
            const req = createMockReq({ method: 'POST', body: { prompt: 12345 } });
            const res = parseAndValidateRequest(req);
            expect(res.error?.status).toBe(400);
            expect(res.error?.error).toBe("Field 'prompt' must be a string.");
        });

        it('should reject empty or whitespace-only prompt', () => {
            const reqEmpty = createMockReq({ method: 'POST', body: { prompt: '' } });
            expect(parseAndValidateRequest(reqEmpty).error?.error).toBe("Field 'prompt' cannot be empty.");

            const reqSpaces = createMockReq({ method: 'POST', body: { prompt: '    \n  ' } });
            expect(parseAndValidateRequest(reqSpaces).error?.error).toBe("Field 'prompt' cannot be empty.");
        });

        it('should reject non-boolean stream', () => {
            const req = createMockReq({ method: 'POST', body: { prompt: 'hi', stream: 'true' } });
            const res = parseAndValidateRequest(req);
            expect(res.error?.status).toBe(400);
            expect(res.error?.error).toBe("Field 'stream' must be a boolean (true or false).");
        });

        it('should reject empty model or non-string model', () => {
            const reqNum = createMockReq({ method: 'POST', body: { prompt: 'hi', model: 123 } });
            expect(parseAndValidateRequest(reqNum).error?.error).toBe("Field 'model' must be a string.");

            const reqEmpty = createMockReq({ method: 'POST', body: { prompt: 'hi', model: '   ' } });
            expect(parseAndValidateRequest(reqEmpty).error?.error).toBe("Field 'model' cannot be empty.");
        });

        it('should correctly extract messages array', () => {
            const req = createMockReq({
                method: 'POST',
                body: {
                    messages: [
                        { role: 'system', content: 'You are helpful.' },
                        { role: 'user', content: 'What is gravity?' }
                    ]
                }
            });
            const res = parseAndValidateRequest(req);
            expect(res.error).toBeUndefined();
            expect(res.data?.prompt).toContain('Instructions: You are helpful.');
            expect(res.data?.prompt).toContain('User: What is gravity?');
        });

        it('should reject invalid messages format', () => {
            const reqNotArr = createMockReq({ method: 'POST', body: { messages: 'not an array' } });
            expect(parseAndValidateRequest(reqNotArr).error?.error).toBe("Field 'messages' must be a non-empty array.");

            const reqEmptyArr = createMockReq({ method: 'POST', body: { messages: [] } });
            expect(parseAndValidateRequest(reqEmptyArr).error?.error).toBe("Field 'messages' must be a non-empty array.");

            const reqBadItem = createMockReq({ method: 'POST', body: { messages: [{ role: 'user' }] } });
            expect(parseAndValidateRequest(reqBadItem).error?.error).toContain("must be an object with string 'content'");
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
