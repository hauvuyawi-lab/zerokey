import { describe, it, expect } from 'bun:test';
import { getProxyEndpoints, selectProxy, fetchWithProxy } from '../src/lib/proxy';

describe('Proxy Pool Manager (src/lib/proxy.ts)', () => {
    describe('getProxyEndpoints', () => {
        it('returns empty array when PROXY_URLS is undefined or empty', () => {
            expect(getProxyEndpoints({})).toEqual([]);
            expect(getProxyEndpoints({ PROXY_URLS: '' })).toEqual([]);
            expect(getProxyEndpoints({ PROXY_URLS: '   ' })).toEqual([]);
            expect(getProxyEndpoints(undefined)).toEqual([]);
        });

        it('parses comma-separated URLs and trims whitespace', () => {
            const env = {
                PROXY_URLS: 'https://proxy-1.vercel.app/proxy, https://proxy-2.vercel.app/proxy  ,https://proxy-3.vercel.app/proxy'
            };
            expect(getProxyEndpoints(env)).toEqual([
                'https://proxy-1.vercel.app/proxy',
                'https://proxy-2.vercel.app/proxy',
                'https://proxy-3.vercel.app/proxy'
            ]);
        });

        it('filters out invalid non-HTTP/HTTPS URLs', () => {
            const env = {
                PROXY_URLS: 'ftp://invalid.com, https://valid-proxy.vercel.app/proxy, not-a-url'
            };
            expect(getProxyEndpoints(env)).toEqual([
                'https://valid-proxy.vercel.app/proxy'
            ]);
        });
    });

    describe('selectProxy', () => {
        it('returns null when no proxies are configured', () => {
            expect(selectProxy({})).toBeNull();
        });

        it('returns one of the configured proxies randomly', () => {
            const env = {
                PROXY_URLS: 'https://proxy-a.vercel.app, https://proxy-b.vercel.app'
            };
            const selected = selectProxy(env);
            expect(selected).toBeTruthy();
            expect(['https://proxy-a.vercel.app/proxy', 'https://proxy-b.vercel.app/proxy']).toContain(selected!);
        });
    });

    describe('fetchWithProxy', () => {
        it('falls back to direct fetch when no proxies configured', async () => {
            const res = await fetchWithProxy('https://example.com', {}, {});
            expect(res.status).toBe(200);
        });

        it('falls back to direct fetch when proxy returns 502/504 or is unreachable', async () => {
            // Point to a non-existent proxy port that will fail connection
            const env = {
                PROXY_URLS: 'http://127.0.0.1:59999/proxy'
            };
            const res = await fetchWithProxy('https://example.com', {}, env);
            expect(res.status).toBe(200);
        }, 15000);
    });
});
