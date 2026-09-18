import type { VercelRequest, VercelResponse } from '@vercel/node';
import { askDeepAi, fetchDeepAiModels } from '../lib/providers/deepai';
import { handleProviderRequest } from '../lib/http';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    return handleProviderRequest(
        req,
        res,
        'deepai',
        async () => (await fetchDeepAiModels()).models,
        ({ prompt, model, onChunk }) => askDeepAi(prompt, { model, onChunk })
    );
}
