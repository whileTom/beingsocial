import puppeteer, { Browser, Page, HTTPResponse } from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { initDatabase, MessageStore } from '../database';

/**
 * DEBUG VERSION - Captures and logs all GraphQL responses to understand Instagram's API structure
 */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const CHROME_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const cookiesPath = path.join(__dirname, '..', '..', 'data', 'instagram_cookies.json');

async function findBrowserPath(): Promise<string> {
    for (const p of CHROME_PATHS) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error('Chrome/Edge not found.');
}

async function main() {
    console.log('\n🔍 [DEBUG] Starting Instagram API Investigation...\n');

    const db = initDatabase();
    const messageStore = new MessageStore(db);

    if (!fs.existsSync(cookiesPath)) {
        console.error('❌ No cookies.');
        return;
    }

    const executablePath = await findBrowserPath();
    const browser = await puppeteer.launch({
        executablePath,
        headless: false,
        defaultViewport: { width: 1280, height: 900 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-notifications', '--window-position=-2000,-2000']
    });

    try {
        const page = await browser.newPage();
        const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
        await page.setCookie(...cookies);

        // Capture ALL responses that might contain message data
        const capturedResponses: any[] = [];

        page.on('response', async (response: HTTPResponse) => {
            const url = response.url();

            // Log all API calls
            if (url.includes('instagram.com/api') || url.includes('direct') || url.includes('graphql')) {
                try {
                    const contentType = response.headers()['content-type'] || '';
                    if (contentType.includes('json') || contentType.includes('text')) {
                        const text = await response.text();

                        // Look for message-related content
                        if (text.includes('thread') || text.includes('message') || text.includes('inbox') || text.includes('items')) {
                            console.log(`📦 Captured: ${url.substring(0, 80)}...`);

                            // Save to file for analysis
                            const filename = `graphql_${Date.now()}.json`;
                            fs.writeFileSync(path.join(__dirname, '..', '..', 'data', filename), text);
                            console.log(`   💾 Saved to ${filename}`);

                            // Try to parse
                            try {
                                const json = JSON.parse(text);
                                capturedResponses.push({ url, data: json });

                                // Deep search for items/messages
                                const findItems = (obj: any, depth = 0): any[] => {
                                    if (depth > 10) return [];
                                    const results: any[] = [];

                                    if (Array.isArray(obj)) {
                                        for (const item of obj) {
                                            results.push(...findItems(item, depth + 1));
                                        }
                                    } else if (obj && typeof obj === 'object') {
                                        if (obj.items && Array.isArray(obj.items)) {
                                            results.push(...obj.items);
                                        }
                                        if (obj.thread_id || obj.thread_v2_id) {
                                            results.push({ type: 'thread', data: obj });
                                        }
                                        for (const key of Object.keys(obj)) {
                                            results.push(...findItems(obj[key], depth + 1));
                                        }
                                    }
                                    return results;
                                };

                                const items = findItems(json);
                                if (items.length > 0) {
                                    console.log(`   🔎 Found ${items.length} potential items/threads`);
                                }
                            } catch (e) {
                                // Not valid JSON
                            }
                        }
                    }
                } catch (e) {
                    // Failed to read response
                }
            }
        });

        console.log('🌐 Navigating to Instagram Inbox...');
        await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('✅ Page loaded. Waiting for API calls...');
        await delay(10000);

        // Click a thread to trigger message fetch
        console.log('👆 Clicking first thread to trigger API call...');
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
            const thread = buttons.find((el: any) => {
                const text = el.innerText || '';
                const hasImg = el.querySelector('img');
                return hasImg && text.length > 0 && text.includes('\n');
            });
            if (thread) (thread as HTMLElement).click();
        });

        await delay(10000);

        // Scroll chat to trigger more API calls
        console.log('📜 Scrolling chat...');
        for (let i = 0; i < 5; i++) {
            await page.evaluate(() => {
                const chat = document.querySelector('div[role="main"] div[style*="overflow-y: auto"]');
                if (chat) chat.scrollTop = 0;
            });
            await delay(3000);
        }

        console.log(`\n📊 Captured ${capturedResponses.length} relevant API responses`);

        // Write summary
        fs.writeFileSync(
            path.join(__dirname, '..', '..', 'data', 'api_summary.json'),
            JSON.stringify(capturedResponses.map(r => ({ url: r.url, keys: Object.keys(r.data || {}) })), null, 2)
        );

        console.log('\n✅ Debug complete. Check data/ folder for captured responses.');

    } catch (err: any) {
        console.error('❌ Error:', err.message);
    } finally {
        await browser.close();
        db.close();
    }
}

main().catch(console.error);
