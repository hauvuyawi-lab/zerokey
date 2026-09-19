import { describe, it, expect } from 'bun:test';
import { cleanResponse, getGeminiModels, fetchLatestBl, askGemini } from '../src/lib/providers/gemini';

describe('Google Gemini Provider (lib/providers/gemini.ts)', () => {
    describe('cleanResponse', () => {
        it('should strip Google internal UI tags (<Section>, <TextBox>)', () => {
            const raw = '<Section>\nHello world\n</Section>';
            expect(cleanResponse(raw)).toBe('Hello world');
        });

        it('should extract text from <TextBox text="..." />', () => {
            const raw = '<TextBox text="Extracted text" />';
            expect(cleanResponse(raw)).toBe('Extracted text');
        });

        it('should remove <Elicitations> suggestion blocks', () => {
            const raw = 'Answer to question.<Elicitations><Query>what next?</Query></Elicitations>';
            expect(cleanResponse(raw)).toBe('Answer to question.');
        });

        it('should clean Google code-runner internal URL parameters', () => {
            const raw = 'Check out https://gemini.google.com/run?code_reference&code_event_index=4 for details';
            expect(cleanResponse(raw)).toBe('Check out https://gemini.google.com/run for details');
        });

        it('should normalize excessive blank lines', () => {
            const raw = 'Paragraph 1\n\n\n\n\nParagraph 2';
            expect(cleanResponse(raw)).toBe('Paragraph 1\n\nParagraph 2');
        });

        it('should handle empty or nullish strings safely', () => {
            expect(cleanResponse('')).toBe('');
            expect(cleanResponse(null as any)).toBe('');
            expect(cleanResponse(undefined as any)).toBe('');
        });
    });

    describe('getGeminiModels', () => {
        it('should return the generic model without any hardcoded version tag', () => {
            const models = getGeminiModels();
            expect(models).toHaveLength(1);
            expect(models[0].id).toBe('gemini');
            expect(models[0].name).toBe('Gemini');
            expect(models[0].provider).toBe('google');
            expect(models[0].entityHasAccess).toBe(true);
            expect(models[0].name).not.toContain('3.5');
            expect(models[0].name).not.toContain('Flash-Lite');
        });
    });

    describe('Live Gemini Scraper & Execution', () => {
        it('should dynamically scrape build label (bl) live from gemini.google.com', async () => {
            const bl = await fetchLatestBl();
            expect(typeof bl).toBe('string');
            expect(bl.length).toBeGreaterThan(0);
        }, 10000);

        it('should complete live chat query via Google web stream', async () => {
            const result = await askGemini('Respond with exactly: PONG');
            expect(result.response.length).toBeGreaterThan(0);
            expect(result.timeMs).toBeGreaterThan(0);
        }, 15000);
    });
});
