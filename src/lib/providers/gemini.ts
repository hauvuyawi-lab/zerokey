import type { GeminiResult, AskGeminiOptions } from './types';

// Re-export interface for convenience
export type { GeminiResult, AskGeminiOptions };

/**
 * Cleans Google internal UI tags and artifacts (Sections, Elicitations, code metadata)
 * while preserving clean Markdown and text content.
 */
export function cleanResponse(raw: string): string {
    if (!raw || typeof raw !== 'string') return '';

    return raw
        // Remove Google internal suggestion / elicitation blocks
        .replace(/<Elicitations[\s\S]*?<\/Elicitations>/gi, '')
        // Extract text content from <TextBox ... text="..." /> tags if present
        .replace(/<TextBox\b[^>]*?\btext="([^"]*)"[^>]*\/?>/gi, '$1\n')
        // Strip custom Google UI wrapper tags like <Section> and </Section>
        .replace(/<\/?(?:Section|TextBox|Elicitation)\b[^>]*>/gi, '')
        // Clean Google internal code-runner URL query parameters
        .replace(/\?(?:code_reference|code_stdout)&code_event_index=\d+/g, '')
        // Normalize multiple blank lines
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Fast stream-based fetch to extract Google's latest build label (bl / cfb2h).
 * Reads only the first few KB of HTML until "cfb2h" is matched, then cancels the stream.
 */
export async function fetchLatestBl(): Promise<string> {
    try {
        const res = await fetch('https://gemini.google.com', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        if (!res.body) return 'boq_assistant-bard-web-server_20260916.10_p0';

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let text = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            text += decoder.decode(value, { stream: true });
            const match = text.match(/"cfb2h":"([^"]+)"/);
            if (match) {
                reader.cancel().catch(() => {});
                return match[1];
            }
        }
    } catch {}
    return 'boq_assistant-bard-web-server_20260916.10_p0';
}

/**
 * Executes a one-shot Gemini request.
 * Completely stateless: zero global memory or cached variables (safe for serverless/edge).
 * Emits real-time tokens via `onChunk` callback if provided.
 */
export async function askGemini(
    prompt: string,
    options: AskGeminiOptions = {},
    env?: any
): Promise<GeminiResult> {
    const { onChunk = null, raw = false } = options;
    const startTime = Date.now();

    // 32-character random hex string representing the client interaction turn ID
    const turnHash = Array.from({ length: 32 }, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join('');

    // Randomized client interaction UUID
    const clientUuid = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'B9ECC548-B2B3-4CFA-9DE5-047C1E48217A';

    // Google Protobuf (JSPB) request array structure:
    // [0] = Prompt array | [1] = Locale | [2] = Turn history (null for one-shot)
    // [3] = BotGuard (null for guest) | [4] = Turn hash | [47] = Client UUID
    const inner = [
        [prompt, 0, null, null, null, null, 0],
        ['en-US'],
        null, null, turnHash,
        null, [1], 1, null, null, 1, 0, null, null, null, null, null,
        [[1]], 0, null, null, null, null, null, null, null, null, 1,
        null, null, [4], null, null, null, null, null, null, null, null,
        null, null, [2], null, null, null, null, null, null, null, null,
        null, null, null, 0, null, null, null, null, null,
        clientUuid,
        null, [], null, null, null, null, null, null, 2, null, null,
        null, null, null, null, null, null, null, null, 6, null, null,
        null, null, null, null, null, null, null, null, null, 0, null,
        null, null, null, 0, null, 1
    ];

    const reqId = Math.floor(Math.random() * 900000) + 100000;
    const body = new URLSearchParams({
        'f.req': JSON.stringify([null, JSON.stringify(inner)])
    }).toString();

    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Accept': 'application/json; charset=utf-8',
        'x-same-domain': '1',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    let bl = 'boq_assistant-bard-web-server_20260916.10_p0';
    let url = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(bl)}&f.sid=0&hl=en-US&_reqid=${reqId}&rt=c`;

    let controller = new AbortController();
    let res = await fetch(url, { method: 'POST', signal: controller.signal, headers, body });

    // If default bl is rejected (Google updated build), auto-fetch latest bl and retry
    if (!res.ok) {
        bl = await fetchLatestBl();
        url = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(bl)}&f.sid=0&hl=en-US&_reqid=${reqId}&rt=c`;
        controller = new AbortController();
        res = await fetch(url, { method: 'POST', signal: controller.signal, headers, body });
        if (!res.ok) {
            throw new Error(`Gemini request failed (${res.status})`);
        }
    }

    if (!res.body) {
        throw new Error('Gemini response body is empty');
    }

    // Read response chunks in real-time
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let model = '';
    let emittedLength = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let isComplete = false;

        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Retain incomplete trailing line in buffer

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || /^\d+$/.test(trimmed)) continue;

            try {
                // Strip anti-XSSI prefix ")]}'" before JSON parse
                const parsed = JSON.parse(trimmed.replace(/^\)\]\}'\s*/, ''));
                for (const item of parsed) {
                    // "wrb.fr" is Google's Web RPC Batch Frame Response envelope
                    if (item[0] === 'wrb.fr' && item[2]) {
                        const data = JSON.parse(item[2]);

                        // Extract model name dynamically from Google's response
                        if (!model && Array.isArray(data)) {
                            if (typeof data[42] === 'string' && data[42]) {
                                model = data[42];
                            } else {
                                for (const val of data) {
                                    if (typeof val === 'string' && val.length > 0 && val.length < 50 && (val.includes('Flash') || val.includes('Pro') || val.includes('Lite') || val.includes('Gemini') || val.includes('Ultra'))) {
                                        model = val;
                                        break;
                                    }
                                }
                            }
                        }

                        // data[4][0][1][0] contains the candidate reply text
                        if (data[4]?.[0]?.[1]?.[0]) {
                            answer = data[4][0][1][0];

                            // Real-time streaming callback: emit token delta as it arrives
                            if (typeof onChunk === 'function' && answer.length > emittedLength) {
                                const delta = answer.slice(emittedLength);
                                emittedLength = answer.length;
                                onChunk(delta, model || 'gemini');
                            }
                        }

                        // data[4][0][8] is status: [1] = in-progress, [2] = generation complete.
                        // Key "26" in data[2] is the end-of-turn context token.
                        if (data[4]?.[0]?.[8]?.[0] === 2 || data[2]?.['26']) {
                            isComplete = true;
                            break;
                        }
                    }
                }
            } catch {}
            if (isComplete) break;
        }

        // Abort early once text is complete to avoid waiting 2-3s for trailing metadata
        if (isComplete) {
            reader.cancel().catch(() => {});
            controller.abort();
            break;
        }
    }

    return {
        response: raw ? answer : cleanResponse(answer),
        model: model || 'gemini',
        timeMs: Date.now() - startTime
    };
}

/**
 * Returns available models for Google Gemini provider.
 */
export function getGeminiModels() {
    return [
        {
            id: 'gemini',
            name: 'Gemini',
            provider: 'google',
            entityHasAccess: true
        }
    ];
}

