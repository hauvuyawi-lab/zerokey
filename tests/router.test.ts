import { describe, it, expect } from 'bun:test';
import {
    resolveProvider,
    normalizeMessages,
    extractPrompt,
    getUnifiedOpenAIModels
} from '../src/lib/providers/router';
import { fetchDuckAiModels } from '../src/lib/providers/duckai';
import { getDefaultGeminiModel } from '../src/lib/providers/gemini';

describe('Router Logic (lib/providers/router.ts)', () => {
    describe('resolveProvider - Direct Provider Routing (Gemini & DuckAI)', () => {
        it('should route gemini requests to the gemini provider with dynamic target model', async () => {
            const defaultModel = await getDefaultGeminiModel();
            expect(await resolveProvider('gemini')).toEqual({ provider: 'gemini', targetModel: defaultModel });
            expect(await resolveProvider('GEMINI')).toEqual({ provider: 'gemini', targetModel: defaultModel });
            expect(await resolveProvider('gemini-pro')).toEqual({ provider: 'gemini', targetModel: defaultModel });
            expect(await resolveProvider('google')).toEqual({ provider: 'gemini', targetModel: defaultModel });
            expect(await resolveProvider(defaultModel)).toEqual({ provider: 'gemini', targetModel: defaultModel });
        });

        it('should dynamically route live free DuckAI models to duckai provider', async () => {
            const duckCatalog = await fetchDuckAiModels();
            expect(duckCatalog.models.length).toBeGreaterThan(0);

            for (const m of duckCatalog.models) {
                const res = await resolveProvider(m.id);
                expect(res.provider).toBe('duckai');
                expect(res.targetModel).toBe(m.id);
            }
        });

        it('should strip duckai/ prefix and route to duckai provider', async () => {
            expect(await resolveProvider('duckai/custom-chat')).toEqual({
                provider: 'duckai',
                targetModel: 'custom-chat'
            });
        });

        it('should fallback to gemini provider when no model is specified or unrecognized', async () => {
            const defaultModel = await getDefaultGeminiModel();
            expect(await resolveProvider()).toEqual({ provider: 'gemini', targetModel: defaultModel });
            expect(await resolveProvider(undefined)).toEqual({ provider: 'gemini', targetModel: defaultModel });
            expect(await resolveProvider('')).toEqual({ provider: 'gemini', targetModel: defaultModel });
            expect(await resolveProvider('unknown-model-xyz')).toEqual({ provider: 'gemini', targetModel: defaultModel });
        });
    });

    describe('getUnifiedOpenAIModels catalog deduplication', () => {
        it('should aggregate models across Gemini and DuckAI with zero duplicates and no aliases', async () => {
            const result = await getUnifiedOpenAIModels();
            expect(result).toBeDefined();
            expect(result.object).toBe('list');
            expect(Array.isArray(result.data)).toBe(true);
            expect(result.data.length).toBeGreaterThan(0);

            // 1. Verify dynamic Gemini model is present and has no alias
            const defaultModel = await getDefaultGeminiModel();
            const gemini = result.data.find(m => m.id.toLowerCase() === defaultModel.toLowerCase());
            expect(gemini).toBeDefined();
            expect(gemini?.owned_by).toBe('google');

            // Verify no aliases exist in catalog
            expect(result.data.some(m => m.id.toLowerCase() === 'gemini')).toBe(false);

            // 2. Verify dynamic DuckAI free models are present
            const duckCatalog = await fetchDuckAiModels();
            for (const dm of duckCatalog.models) {
                const found = result.data.find(m => m.id.toLowerCase() === dm.id.toLowerCase());
                expect(found).toBeDefined();
                expect(found?.owned_by).toBe(dm.provider.toLowerCase());
            }

            // 3. Verify total absence of duplicate model IDs
            const seen = new Set<string>();
            for (const item of result.data) {
                const lower = item.id.toLowerCase();
                expect(seen.has(lower)).toBe(false);
                seen.add(lower);
            }
        });
    });

    describe('normalizeMessages', () => {
        it('should return plain text for single user message', () => {
            const res = normalizeMessages([{ role: 'user', content: 'What is photosynthesis?' }]);
            expect(res).toBe('What is photosynthesis?');
        });

        it('should format multi-turn conversations with appropriate role headers', () => {
            const res = normalizeMessages([
                { role: 'system', content: 'You are concise.' },
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi' },
                { role: 'user', content: '2+2?' }
            ]);

            expect(res).toContain('Instructions: You are concise.');
            expect(res).toContain('User: Hello');
            expect(res).toContain('Assistant: Hi');
            expect(res).toContain('User: 2+2?');
        });

        it('should treat developer role like system instructions in multi-message prompts', () => {
            const res = normalizeMessages([
                { role: 'developer', content: 'Format as JSON' },
                { role: 'user', content: 'List items' }
            ]);
            expect(res).toContain('Instructions: Format as JSON');
            expect(res).toContain('User: List items');
        });

        it('should handle empty or invalid message arrays', () => {
            expect(normalizeMessages([])).toBe('');
            expect(normalizeMessages([{ role: 'user', content: '' }])).toBe('');
        });

        it('should parse multimodal content arrays (images, audio, files) without throwing errors', () => {
            const multimodalMessages = [
                {
                    role: 'user' as const,
                    content: [
                        { type: 'text', text: 'Can you describe this image and audio?' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
                        { type: 'input_audio', input_audio: { data: '...', format: 'wav' } }
                    ]
                }
            ];
            const prompt = normalizeMessages(multimodalMessages);
            expect(prompt).toContain('Can you describe this image and audio?');
            expect(prompt).toContain('[Attached Image]');
            expect(prompt).toContain('[Attached Audio]');
        });

        it('should handle multi-turn conversations with multimodal attachments', () => {
            const messages = [
                { role: 'system' as const, content: 'You are a helpful assistant' },
                {
                    role: 'user' as const,
                    content: [
                        { type: 'text', text: 'Look at this file' },
                        { type: 'file', file: { name: 'document.pdf' } }
                    ]
                },
                { role: 'assistant' as const, content: 'I see your attached file.' },
                { role: 'user' as const, content: 'Summarize it' }
            ];
            const prompt = normalizeMessages(messages);
            expect(prompt).toContain('Instructions: You are a helpful assistant');
            expect(prompt).toContain('[Attached File]');
            expect(prompt).toContain('Summarize it');
        });
    });

    describe('extractPrompt', () => {
        it('should prioritize string prompt over messages array', () => {
            const res = extractPrompt({
                prompt: 'Direct prompt',
                messages: [{ role: 'user', content: 'From messages' }]
            });
            expect(res).toBe('Direct prompt');
        });

        it('should extract from messages when prompt is missing', () => {
            const res = extractPrompt({
                messages: [{ role: 'user', content: 'From messages' }]
            });
            expect(res).toBe('From messages');
        });
    });
});
