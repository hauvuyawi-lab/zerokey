import { describe, it, expect } from 'bun:test';
import {
    fetchDuckAiModels,
    getDefaultDuckAiModel,
    resolveDuckAiModel,
    askDuckAi
} from '../src/lib/providers/duckai';

describe('DuckAI Provider (lib/providers/duckai.ts)', () => {
    describe('fetchDuckAiModels', () => {
        it('should dynamically query DuckAI and strictly return accessible free-tier models only', async () => {
            const catalog = await fetchDuckAiModels({ timeoutMs: 5000 });
            expect(catalog).toBeDefined();
            expect(catalog.source).toBe('api');
            expect(catalog.models.length).toBeGreaterThan(0);

            for (const model of catalog.models) {
                expect(model.id).toBeTruthy();
                expect(model.name).toBeTruthy();
                expect(model.provider).toBeTruthy();
                // Strictly free accessible models only
                expect(model.entityHasAccess).toBe(true);
            }
        });

        it('should use memory cache on subsequent calls', async () => {
            const first = await fetchDuckAiModels();
            const second = await fetchDuckAiModels();
            expect(first.models.length).toBe(second.models.length);
            expect(first.models[0].id).toBe(second.models[0].id);
        });
    });

    describe('getDefaultDuckAiModel', () => {
        it('should return a valid default model from the dynamic catalog', async () => {
            const defaultModel = await getDefaultDuckAiModel();
            expect(defaultModel).toBeTruthy();
            const catalog = await fetchDuckAiModels();
            expect(catalog.models.map(m => m.id)).toContain(defaultModel);
        });
    });

    describe('resolveDuckAiModel dynamic resolution', () => {
        it('should return default model when input is empty or undefined', async () => {
            const defaultModel = await getDefaultDuckAiModel();
            expect(await resolveDuckAiModel()).toBe(defaultModel);
            expect(await resolveDuckAiModel('')).toBe(defaultModel);
            expect(await resolveDuckAiModel('   ')).toBe(defaultModel);
        });

        it('should dynamically resolve live model IDs from catalog', async () => {
            const catalog = await fetchDuckAiModels();
            for (const m of catalog.models) {
                expect(await resolveDuckAiModel(m.id)).toBe(m.id);
            }
        });

        it('should strip duckai/ prefix and resolve dynamically', async () => {
            const catalog = await fetchDuckAiModels();
            const sample = catalog.models[0];
            expect(await resolveDuckAiModel(`duckai/${sample.id}`)).toBe(sample.id);
        });

        it('should resolve models without vendor prefix dynamically', async () => {
            const catalog = await fetchDuckAiModels();
            const prefixed = catalog.models.find(m => m.id.includes('/'));
            if (prefixed) {
                const stripped = prefixed.id.split('/').pop()!;
                expect(await resolveDuckAiModel(stripped)).toBe(prefixed.id);
            }
        });
    });

    describe('askDuckAi validation & error handling', () => {
        it('should reject empty prompt or empty array', async () => {
            await expect(askDuckAi('')).rejects.toThrow('Prompt or messages must be provided');
            await expect(askDuckAi('   ')).rejects.toThrow('Prompt or messages must be provided');
            await expect(askDuckAi([])).rejects.toThrow('Prompt or messages must be provided');
        });

        it('should throw clear error when VQD token is missing', async () => {
            await expect(
                askDuckAi('Hello', { vqd: '' }, { ZEROKEY_KV: { get: async () => null } })
            ).rejects.toThrow('DuckAI site pass missing');
        });

        it('should fold messages array including multimodal content without error before VQD check', async () => {
            const messages = [
                { role: 'system' as const, content: 'System instruction' },
                {
                    role: 'user' as const,
                    content: [
                        { type: 'text', text: 'Hello duck' },
                        { type: 'image_url', image_url: { url: 'data:...' } }
                    ]
                }
            ];
            await expect(
                askDuckAi(messages, { vqd: '' }, { ZEROKEY_KV: { get: async () => null } })
            ).rejects.toThrow('DuckAI site pass missing');
        });
    });
});
