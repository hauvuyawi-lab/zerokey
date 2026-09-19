import { describe, it, expect } from 'bun:test';
import {
    generateIslandKey,
    fetchDeepAiModels,
    getDefaultDeepAiModel,
    askDeepAi
} from '../src/lib/providers/deepai';

describe('DeepAI Provider (lib/providers/deepai.ts)', () => {
    describe('generateIslandKey', () => {
        it('should generate a valid tryit API key string', () => {
            const key = generateIslandKey();
            expect(typeof key).toBe('string');
            expect(key.startsWith('tryit-')).toBe(true);

            const parts = key.split('-');
            expect(parts.length).toBe(3);
            expect(parts[0]).toBe('tryit');
            expect(Number(parts[1])).toBeGreaterThan(0);
            expect(parts[2].length).toBe(32); // MD5 hex length
        });

        it('should compute hash matching user-agent', () => {
            const customUA = 'CustomTestAgent/1.0';
            const key = generateIslandKey(customUA);
            expect(key.startsWith('tryit-')).toBe(true);
        });
    });

    describe('fetchDeepAiModels', () => {
        it('should dynamically scrape catalog of unlocked models live from DeepAI web app', async () => {
            const catalog = await fetchDeepAiModels({ timeoutMs: 5000 });
            expect(catalog.models.length).toBeGreaterThan(0);
            expect(catalog.source).toBe('scrape');

            for (const model of catalog.models) {
                expect(model.locked).toBe(false);
            }

            const modelIds = catalog.models.map(m => m.id);
            expect(modelIds).toContain('standard');
            // Must not contain locked pro models
            expect(modelIds).not.toContain('genius');
            expect(modelIds).not.toContain('supergenius');
            expect(modelIds).not.toContain('claude-opus-5');
        });
    });

    describe('getDefaultDeepAiModel', () => {
        it('should return standard model', async () => {
            const defaultModel = await getDefaultDeepAiModel();
            expect(defaultModel).toBe('standard');
        });
    });

    describe('askDeepAi input validation', () => {
        it('should reject empty prompt or empty array', async () => {
            expect(askDeepAi('')).rejects.toThrow('Prompt or messages must be provided');
            expect(askDeepAi([])).rejects.toThrow('Prompt or messages must be provided');
        });
    });

    describe('Live DeepAI Execution', () => {
        it('should successfully complete a chat query with standard model', async () => {
            const result = await askDeepAi('Respond with exactly: PONG');
            expect(result).toBeDefined();
            expect(typeof result.response).toBe('string');
            expect(result.response.length).toBeGreaterThan(0);
            expect(result.model).toBe('standard');
            expect(result.timeMs).toBeGreaterThan(0);
        }, 15000);

        it('should support streaming token callback', async () => {
            const chunks: string[] = [];
            const result = await askDeepAi('Count 1 to 3', {
                onChunk: (chunk) => {
                    chunks.push(chunk);
                }
            });
            expect(result.response.length).toBeGreaterThan(0);
            expect(chunks.length).toBeGreaterThan(0);
        }, 15000);
    });
});
