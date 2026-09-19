import { describe, it, expect } from 'bun:test';
import {
    cleanResponse,
    getGeminiModels,
    fetchGeminiModels,
    getDefaultGeminiModel,
    resolveGeminiModel,
    formatGeminiModelId,
    buildGeminiModelList,
    scrapeGeminiModelName,
    fetchLatestBl,
    askGemini
} from '../src/lib/providers/gemini';

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

    describe('Model Formatting & Helpers', () => {
        it('formatGeminiModelId should format raw names to slugified IDs', () => {
            expect(formatGeminiModelId('3.5 Flash-Lite')).toBe('gemini-3.5-flash-lite');
            expect(formatGeminiModelId('Gemini 2.0 Flash')).toBe('gemini-2.0-flash');
            expect(formatGeminiModelId('gemini')).toBe('gemini');
            expect(formatGeminiModelId('')).toBe('gemini');
        });

        it('buildGeminiModelList should return only the dynamic model with no aliases', () => {
            const list = buildGeminiModelList('3.5 Flash-Lite');
            expect(list).toHaveLength(1);
            expect(list[0].id).toBe('gemini-3.5-flash-lite');
            expect(list[0].name).toBe('Gemini 3.5 Flash-Lite');
            expect(list[0].provider).toBe('google');
            expect(list[0].entityHasAccess).toBe(true);
            expect(list.some(m => m.id === 'gemini')).toBe(false);
        });
    });

    describe('Dynamic Model Discovery & Resolution', () => {
        it('fetchGeminiModels should dynamically discover and cache live models with no aliases', async () => {
            const catalog = await fetchGeminiModels();
            expect(catalog.models.length).toBe(1);
            expect(catalog.count).toBe(1);

            // Dynamic model should be present
            const primary = catalog.models[0];
            expect(primary.provider).toBe('google');
            expect(primary.entityHasAccess).toBe(true);
            expect(primary.id).not.toBe('gemini');

            // Verify no generic gemini alias is present in the catalog
            expect(catalog.models.some(m => m.id === 'gemini')).toBe(false);
        }, 10000);

        it('getGeminiModels should return array of models without aliases', async () => {
            const models = await getGeminiModels();
            expect(models.length).toBe(1);
            expect(models.every(m => m.provider === 'google' && m.entityHasAccess === true)).toBe(true);
            expect(models.some(m => m.id === 'gemini')).toBe(false);
        });

        it('getDefaultGeminiModel should return the primary model ID', async () => {
            const defaultModel = await getDefaultGeminiModel();
            expect(typeof defaultModel).toBe('string');
            expect(defaultModel.length).toBeGreaterThan(0);
            expect(defaultModel).not.toBe('gemini');
        });

        it('resolveGeminiModel should resolve to dynamic model ID without aliases', async () => {
            const defaultModel = await getDefaultGeminiModel();
            const resolvedGemini = await resolveGeminiModel('gemini');
            expect(resolvedGemini).toBe(defaultModel);

            const resolvedWithPrefix = await resolveGeminiModel('gemini/3.5-flash-lite');
            expect(resolvedWithPrefix).toContain('flash-lite');
        });
    });

    describe('Live Gemini Scraper & Execution', () => {
        it('should dynamically scrape build label (bl) live from gemini.google.com', async () => {
            const bl = await fetchLatestBl();
            expect(typeof bl).toBe('string');
            expect(bl.length).toBeGreaterThan(0);
        }, 10000);

        it('should scrape live model name from Google Gemini stream', async () => {
            const modelName = await scrapeGeminiModelName();
            expect(typeof modelName).toBe('string');
            expect(modelName.length).toBeGreaterThan(0);
        }, 10000);

        it('should complete live chat query via Google web stream', async () => {
            const result = await askGemini('Respond with exactly: PONG');
            expect(result.response.length).toBeGreaterThan(0);
            expect(result.timeMs).toBeGreaterThan(0);
            expect(result.model.length).toBeGreaterThan(0);
        }, 15000);
    });
});
