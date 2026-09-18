import { describe, it, expect } from 'bun:test';
import { isTruncated, deduplicateSeam, buildContinuationMessages } from '../lib/continuation';
import type { ChatMessage } from '../lib/providers/types';

describe('Auto-Continuation Module', () => {
    describe('isTruncated()', () => {
        it('returns false for complete, closed text', () => {
            expect(isTruncated('The capital of France is Paris.')).toBe(false);
            expect(isTruncated('Here is your answer!\nHave a great day.')).toBe(false);
            expect(isTruncated('')).toBe(false);
        });

        it('detects unclosed markdown code fences', () => {
            const incompleteCode = '```javascript\nfunction greet() {\n    console.log("hello");\n';
            expect(isTruncated(incompleteCode)).toBe(true);

            const completeCode = '```javascript\nfunction greet() {\n    console.log("hello");\n}\n```\nAll done.';
            expect(isTruncated(completeCode)).toBe(false);
        });

        it('detects trailing unfinished operators and keywords', () => {
            expect(isTruncated('function calculateTotal(items) {\n    return items.reduce((acc, item) => acc +')).toBe(true);
            expect(isTruncated('The primary components of modern AI include machine learning, deep learning, and')).toBe(true);
            expect(isTruncated('We can configure this using const')).toBe(true);
        });

        it('returns false for closed JSON and brackets', () => {
            expect(isTruncated('{"status": "ok", "count": 42}')).toBe(false);
            expect(isTruncated('(Parenthesized statement).')).toBe(false);
        });

        it('supports non-Latin multilingual terminal punctuation (CJK, Arabic, Indic)', () => {
            // Japanese / Chinese full-stop
            expect(isTruncated('これは日本語のテストです。')).toBe(false);
            expect(isTruncated('这是中文测试。')).toBe(false);

            // Arabic question mark
            expect(isTruncated('كيف حالك اليوم؟')).toBe(false);

            // Truncated CJK without terminal punctuation
            const truncatedJapanese = 'これは日本語のテストであり、非常に長い文章の途中で突然中断された状態のテキストであり、読者が文脈を理解できるように継続する必要があり、まだ完了していない内容を含んで';
            expect(isTruncated(truncatedJapanese)).toBe(true);
        });
    });

    describe('deduplicateSeam()', () => {
        it('strips overlapping tokens at the seam', () => {
            const tail = 'function calculateSum(a, b) {\n    return a +';
            const head = '+ b;\n}';
            expect(deduplicateSeam(tail, head)).toBe(' b;\n}');
        });

        it('strips conversational preambles if a model accidentally outputs them', () => {
            const tail = 'The solution is:';
            const head = 'Sure, here is the continuation: const answer = 42;';
            expect(deduplicateSeam(tail, head)).toBe('const answer = 42;');
        });

        it('handles longer multi-word overlaps', () => {
            const tail = 'Here is the detailed analysis of the performance impact';
            const head = 'analysis of the performance impact on the server:';
            expect(deduplicateSeam(tail, head)).toBe(' on the server:');
        });

        it('returns head unchanged when there is no overlap', () => {
            const tail = 'Step 1 is complete.\n';
            const head = 'Step 2 begins now.';
            expect(deduplicateSeam(tail, head)).toBe('Step 2 begins now.');
        });

        it('handles empty inputs safely', () => {
            expect(deduplicateSeam('', 'hello')).toBe('hello');
            expect(deduplicateSeam('world', '')).toBe('');
        });
    });

    describe('buildContinuationMessages()', () => {
        it('preserves system instructions and appends language-preserving continuation prompt', () => {
            const original: ChatMessage[] = [
                { role: 'system', content: 'You are a helpful coding assistant.' },
                { role: 'user', content: 'Write a long script.' }
            ];
            const accumulated = 'function step1() { console.log(1); }';

            const result = buildContinuationMessages(original, accumulated);

            expect(result.length).toBe(3);
            expect(result[0]).toEqual({ role: 'system', content: 'You are a helpful coding assistant.' });
            expect(result[1]).toEqual({ role: 'assistant', content: accumulated });
            expect(result[2].role).toBe('user');
            expect(result[2].content).toContain('Continue generating immediately');
            expect(result[2].content).toContain('exact same language');
        });
    });
});
