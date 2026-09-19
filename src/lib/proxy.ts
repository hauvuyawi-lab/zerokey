/**
 * src/lib/proxy.ts - Proxy pool management and request forwarder for ZeroKey.
 * Enables IP rotation through Vercel Edge proxies to bypass upstream rate limits (HTTP 429)
 * and anonymous usage quotas.
 */

export interface ProxyEndpoint {
    url: string;
}

/**
 * Extracts and validates configured proxy URLs from environment bindings.
 * Supports comma-separated URLs in env.PROXY_URLS or process.env.PROXY_URLS.
 * Automatically appends /proxy if the user supplied the root domain (e.g. https://xyz.vercel.app).
 */
export function getProxyEndpoints(env?: any): string[] {
    const raw = env?.PROXY_URLS || (typeof process !== 'undefined' ? process.env?.PROXY_URLS : undefined);
    if (!raw || typeof raw !== 'string') {
        return [];
    }

    return raw
        .split(',')
        .map(u => {
            let clean = u.trim().replace(/\/+$/, '');
            if (!clean) return '';
            // Auto-append /proxy if only base domain was provided
            if (!clean.endsWith('/proxy')) {
                clean += '/proxy';
            }
            return clean;
        })
        .filter(u => u.length > 0 && /^https?:\/\//i.test(u));
}

/**
 * Selects a random proxy endpoint from available pool for load distribution.
 */
export function selectProxy(env?: any): string | null {
    const proxies = getProxyEndpoints(env);
    if (proxies.length === 0) return null;
    const idx = Math.floor(Math.random() * proxies.length);
    return proxies[idx];
}

/**
 * Executes an HTTP fetch, transparently routing through the Vercel Edge proxy pool if configured.
 * Automatically falls back to direct fetch if proxies are unavailable or fail.
 */
export async function fetchWithProxy(
    targetUrl: string,
    init: RequestInit = {},
    env?: any
): Promise<Response> {
    const proxies = getProxyEndpoints(env);

    // If no proxies configured, perform standard direct fetch
    if (proxies.length === 0) {
        return fetch(targetUrl, init);
    }

    // Attempt through random proxy endpoint
    const proxyUrl = proxies[Math.floor(Math.random() * proxies.length)];
    const proxyKey = env?.PROXY_KEY || (typeof process !== 'undefined' ? process.env?.PROXY_KEY : undefined);

    const headers = new Headers(init.headers || {});
    headers.set('X-Target-URL', targetUrl);
    if (proxyKey && proxyKey.trim()) {
        headers.set('X-Proxy-Key', proxyKey.trim());
    }

    try {
        const proxyInit: any = {
            ...init,
            headers
        };
        // Node / Bun fetch requires duplex: 'half' when streaming request bodies
        if (init.body && typeof init.body === 'object' && typeof (init.body as any).getReader === 'function') {
            proxyInit.duplex = 'half';
        }

        const res = await fetch(proxyUrl, proxyInit);

        // If proxy returned a gateway error (502/504), fallback to direct fetch
        if (res.status >= 500 || res.status === 404 || res.status === 403 || res.status === 429 || res.status === 400) {
            return fetch(targetUrl, init);
        }

        return res;
    } catch {
        // Fallback to direct fetch on proxy network connection failure
        return fetch(targetUrl, init);
    }
}
