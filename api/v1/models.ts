import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUnifiedOpenAIModels } from '../../lib/providers/router';
import { setCorsHeaders } from '../../lib/http';

/**
 * OpenAI-compatible /v1/models endpoint
 * Lists all available models across providers in OpenAI standard schema.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (setCorsHeaders(res, req)) return;

    if (req.method !== 'GET') {
        res.status(405).json({
            error: {
                message: `Method ${req.method} not allowed. Use GET.`,
                type: 'invalid_request_error',
                param: null,
                code: 'method_not_allowed'
            }
        });
        return;
    }

    try {
        const modelData = await getUnifiedOpenAIModels();

        // Cache on Vercel Edge CDN for 1 hour, revalidating in background up to 1 day
        res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
        res.status(200).json(modelData);
    } catch (error: any) {
        console.error('OpenAI Models Error:', error);
        res.status(500).json({
            error: {
                message: error?.message || 'Internal Server Error',
                type: 'api_error',
                param: null,
                code: 'internal_error'
            }
        });
    }
}
