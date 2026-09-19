/**
 * src/lib/sse.ts - Native Web Streams Server-Sent Events (SSE) formatter for Cloudflare Workers.
 */

import { setCorsHeaders } from './http';

export function createSseStream() {
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    let closed = false;

    return {
        readable,
        async writeChunk(data: any): Promise<void> {
            if (closed) return;
            const text = typeof data === 'string' ? data : JSON.stringify(data);
            try {
                await writer.write(encoder.encode(`data: ${text}\n\n`));
            } catch {
                closed = true;
            }
        },
        async writeDone(): Promise<void> {
            if (closed) return;
            try {
                await writer.write(encoder.encode('data: [DONE]\n\n'));
            } catch {
                closed = true;
            }
        },
        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            try {
                await writer.close();
            } catch {}
        },
        toResponse(status = 200, extraHeaders?: HeadersInit): Response {
            const headers = new Headers(extraHeaders);
            headers.set('Content-Type', 'text/event-stream; charset=utf-8');
            headers.set('Cache-Control', 'no-cache, no-transform');
            headers.set('Connection', 'keep-alive');
            setCorsHeaders(headers);
            return new Response(readable, { status, headers });
        }
    };
}
