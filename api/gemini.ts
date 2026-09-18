import type { VercelRequest, VercelResponse } from '@vercel/node';
import { askGemini, getGeminiModels } from '../lib/providers/gemini';
import { handleProviderRequest } from '../lib/http';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    return handleProviderRequest(req, res, 'gemini', getGeminiModels, ({ prompt, onChunk }) =>
        askGemini(prompt, { onChunk })
    );
}
