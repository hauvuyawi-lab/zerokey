import { describe, it, expect } from 'bun:test';
import { resolveProvider, normalizeMessages, extractPrompt } from '../src/lib/providers/router';

describe('Router Logic (lib/providers/router.ts)', () => {
    describe('resolveProvider', () => {
        it('should route gemini aliases to the gemini provider', () => {
            expect(resolveProvider('gemini')).toEqual({ provider: 'gemini', targetModel: 'gemini' });
            expect(resolveProvider('GEMINI')).toEqual({ provider: 'gemini', targetModel: 'gemini' });
            expect(resolveProvider('gemini-pro')).toEqual({ provider: 'gemini', targetModel: 'gemini' });
            expect(resolveProvider('google')).toEqual({ provider: 'gemini', targetModel: 'gemini' });
        });

        it('should strip deepai/ prefix and route to deepai provider', () => {
            expect(resolveProvider('deepai/gpt-4o-mini')).toEqual({
                provider: 'deepai',
                targetModel: 'gpt-4o-mini'
            });
        });

        it('should route arbitrary models to deepai by default', () => {
            expect(resolveProvider('gpt-4o-mini')).toEqual({
                provider: 'deepai',
                targetModel: 'gpt-4o-mini'
            });
            expect(resolveProvider('llama-3.3-70b-instruct')).toEqual({
                provider: 'deepai',
                targetModel: 'llama-3.3-70b-instruct'
            });
        });

        it('should fallback to deepai provider when no model is specified', () => {
            expect(resolveProvider()).toEqual({ provider: 'deepai' });
            expect(resolveProvider(undefined)).toEqual({ provider: 'deepai' });
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
