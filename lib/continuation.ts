import type { ChatMessage } from './providers/types';

/**
 * Universal terminal characters across Western (Latin/Cyrillic), CJK (Chinese, Japanese, Korean),
 * Arabic/Persian/Urdu, and Indic scripts.
 */
const UNIVERSAL_TERMINAL_CHARS = new Set([
    // Latin, Cyrillic, Greek
    '.', '!', '?', '"', "'", '`', ')', ']', '}', '>', ':', ';',
    // CJK (Fullwidth punctuation & quotation marks)
    '。', '！', '？', '；', '：', '）', '】', '」', '』', '〉', '》', '”', '’', '…', '～', '—',
    // Arabic, Persian, Urdu
    '؟', '؛', '۔', 'ۛ', '“', '”', '!', '.',
    // Indic (Devanagari, Bengali) & Thai
    '।', '॥', 'ฯ'
]);

/**
 * Universal programming language keywords and syntax delimiters indicating incomplete code.
 */
const INCOMPLETE_SYNTAX_PATTERNS = [
    /[,:=+\-*\/><&|({[]$/,
    /\b(?:and|or|with|to|of|for|in|return|const|let|var|function|class|import|export|from|def|fn|async|await|if|else|elif|switch|case|try|catch|finally|while|for)$/i
];

/**
 * Detects whether an LLM generation appears to have been truncated mid-output.
 * Designed to be language-agnostic and model-agnostic.
 */
export function isTruncated(text: string): boolean {
    if (!text || text.trim().length === 0) return false;

    const trimmed = text.trimEnd();

    // 1. Unclosed markdown code fences (odd number of ```)
    const backticksCount = (trimmed.match(/```/g) || []).length;
    if (backticksCount % 2 !== 0) {
        return true;
    }

    // 2. Trailing syntax, connectors, or code operators
    for (const pattern of INCOMPLETE_SYNTAX_PATTERNS) {
        if (pattern.test(trimmed)) {
            return true;
        }
    }

    // 3. For substantive responses (> 60 chars / ~15 words), ending abruptly without recognized terminal punctuation
    if (trimmed.length > 60) {
        const lastChar = trimmed.slice(-1);
        if (!UNIVERSAL_TERMINAL_CHARS.has(lastChar)) {
            return true;
        }
    }

    return false;
}

/**
 * Removes conversational preambles (e.g. "Sure, here is the continuation:") and duplicate
 * overlapping tokens at the seam between two contiguous generation passes.
 */
export function deduplicateSeam(tail: string, head: string): string {
    if (!tail || !head) return head;

    let cleanHead = head.trimStart();

    // Strip compound conversational filler if a weaker model accidentally adds it
    const preamblePattern = /^(?:sure(?: thing)?[,!.]?\s*|here is the continuation[:\s]*|continuing[:\s]*|as requested[,:\s]*)/i;
    while (preamblePattern.test(cleanHead)) {
        cleanHead = cleanHead.replace(preamblePattern, '').trimStart();
    }

    const maxCheck = Math.min(tail.length, cleanHead.length, 60);
    for (let len = maxCheck; len >= 1; len--) {
        const tailEnd = tail.slice(-len);
        const headStart = cleanHead.slice(0, len);
        if (tailEnd === headStart) {
            return cleanHead.slice(len);
        }
    }

    return cleanHead;
}

/**
 * Formats continuation prompt for the next pass.
 * Explicitly instructs the model to stay in the EXACT SAME LANGUAGE and tone,
 * without conversational preamble.
 */
export function buildContinuationMessages(
    originalMessages: ChatMessage[],
    accumulatedText: string
): ChatMessage[] {
    const continuationPrompt =
        'Continue generating immediately from where you stopped. ' +
        'Preserve the exact same language, script, formatting, and tone. ' +
        'Do NOT repeat any previous text and do NOT add any conversational preamble (like "sure" or "continuing"). ' +
        'Simply output the remaining text.';

    const systemMessages = originalMessages.filter(
        m => m.role === 'system' || (m.role as string) === 'developer'
    );

    return [
        ...systemMessages,
        {
            role: 'assistant',
            content: accumulatedText
        },
        {
            role: 'user',
            content: continuationPrompt
        }
    ];
}
