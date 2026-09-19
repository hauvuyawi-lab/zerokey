#!/usr/bin/env node
/**
 * scripts/harvest.js - Autonomous DuckAI VQD token harvester.
 * Captures fresh X-Vqd-Hash-1 tokens via headless Chrome and pushes to Cloudflare Worker KV.
 */

import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const CHROME_PATHS = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

function findChromePath() {
    for (const p of CHROME_PATHS) {
        if (p && fs.existsSync(p)) return p;
    }
    throw new Error(
        'Google Chrome or Chromium binary not found. Please install Chromium or set CHROME_BIN.'
    );
}

function updateEnvLocal(vqdToken) {
    const envPath = path.join(process.cwd(), '.env.local');
    let content = '';
    if (fs.existsSync(envPath)) {
        content = fs.readFileSync(envPath, 'utf8');
    }

    const regex = /^DUCKAI_VQD=.*$/m;
    if (regex.test(content)) {
        content = content.replace(regex, `DUCKAI_VQD=${vqdToken}`);
    } else {
        content = (content.trim() + `\nDUCKAI_VQD=${vqdToken}\n`).trim() + '\n';
    }

    fs.writeFileSync(envPath, content, 'utf8');
    console.log(`[HARVESTER] Successfully saved fresh DUCKAI_VQD to ${envPath}`);
}

async function syncToWorker(vqdToken) {
    const workerUrl = process.env.WORKER_URL ? process.env.WORKER_URL.replace(/\/+$/, '') : null;
    const adminKey = process.env.ADMIN_KEY;

    if (!workerUrl) {
        console.log('[HARVESTER] WORKER_URL not set. Skipping push to Cloudflare Worker.');
        return;
    }

    if (!adminKey) {
        console.log('[HARVESTER] ADMIN_KEY not set. Skipping push to Cloudflare Worker.');
        return;
    }

    console.log(`[HARVESTER] Pushing token to Cloudflare Worker: ${workerUrl}/duckai/token...`);
    try {
        const res = await fetch(`${workerUrl}/duckai/token`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${adminKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ vqd: vqdToken })
        });

        const data = await res.json();
        if (res.ok) {
            console.log(`[HARVESTER] Cloudflare Worker updated:`, data);
        } else {
            console.error(`[HARVESTER] Worker update failed (HTTP ${res.status}):`, data);
        }
    } catch (err) {
        console.error(`[HARVESTER] Error pushing to worker:`, err.message);
    }
}

export async function harvestToken() {
    const chromePath = findChromePath();
    console.log(`[HARVESTER] Launching Chrome binary: ${chromePath}`);

    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        await page.setUserAgent(
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        );

        let capturedVqd = null;
        let chatStatus = null;

        page.on('request', req => {
            if (req.url().includes('/duckchat/v1/chat')) {
                const headers = req.headers();
                const vqd = headers['x-vqd-hash-1'];
                if (vqd && !capturedVqd) {
                    capturedVqd = vqd;
                    console.log(`[HARVESTER] Intercepted valid X-Vqd-Hash-1 token (length: ${vqd.length})`);
                }
            }
        });

        page.on('response', res => {
            if (res.url().includes('/duckchat/v1/chat')) {
                chatStatus = res.status();
                console.log(`[HARVESTER] Upstream chat status: HTTP ${chatStatus}`);
            }
        });

        console.log('[HARVESTER] Navigating to https://duck.ai/...');
        await page.goto('https://duck.ai/', { waitUntil: 'networkidle2', timeout: 30000 });

        console.log('[HARVESTER] Typing prompt in chat input...');
        const textarea = await page.waitForSelector('textarea', { timeout: 15000 });
        if (!textarea) {
            throw new Error('Chat input textarea not found');
        }

        await textarea.type('hello');
        await new Promise(r => setTimeout(r, 400));

        const askButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(
                b => b.innerText.trim() === 'Ask' || b.getAttribute('aria-label')?.includes('Ask') || b.type === 'submit'
            );
        });

        if (askButton) {
            await askButton.click();
        } else {
            await page.keyboard.press('Enter');
        }

        for (let i = 0; i < 24; i++) {
            if (capturedVqd && chatStatus) break;
            await new Promise(r => setTimeout(r, 500));
        }

        if (!capturedVqd) {
            throw new Error('Timeout: Did not intercept X-Vqd-Hash-1 header');
        }

        updateEnvLocal(capturedVqd);
        await syncToWorker(capturedVqd);

        return capturedVqd;
    } finally {
        await browser.close();
    }
}

if (process.argv[1] && process.argv[1].endsWith('harvest.js')) {
    harvestToken()
        .then(() => {
            console.log('[HARVESTER] Finished successfully.');
            process.exit(0);
        })
        .catch(err => {
            console.error('[HARVESTER] Error:', err.message);
            process.exit(1);
        });
}
