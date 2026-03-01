import puppeteer, { Browser, Page } from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { initDatabase, MessageStore } from '../database';
import crypto from 'crypto';

/**
 * REFINED HYPER-AGGRESSIVE BACKFILL
 * Uses coordinate-based "From Me" detection and broader selectors.
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
    throw new Error('Chrome/Edge executable not found for Puppeteer.');
}

async function backfill() {
    console.log('\n🌟 [FINAL PUSH] Starting Deep Instagram History Scan...');

    const db = initDatabase();
    const messageStore = new MessageStore(db);

    if (!fs.existsSync(cookiesPath)) {
        console.error('❌ No cookies found.');
        return;
    }

    const executablePath = await findBrowserPath();
    const browser = await puppeteer.launch({
        executablePath,
        headless: false,
        defaultViewport: { width: 1024, height: 1024 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-notifications', '--window-position=-2000,-2000']
    });

    try {
        const page = await browser.newPage();
        const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
        await page.setCookie(...cookies);

        console.log('🌐 Loading Instagram...');
        await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle2' });
        await page.waitForSelector('div[role="button"]', { timeout: 30000 });

        const processedNames = new Set<string>();
        let totalThreadsProcessed = 0;
        let sidebarScrolls = 0;

        console.log('🚀 Discovery started.');

        while (totalThreadsProcessed < 300) {
            // 1. Identify threads in the DOM
            const threadsInDOM = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
                return buttons.map((el: any, idx) => {
                    const text = el.innerText || '';
                    const hasImg = el.querySelector('img');
                    const isNote = el.classList.contains('xpqajaz') || el.closest('.xpqajaz') || text.includes('Your note');

                    if (hasImg && text.length > 0 && !isNote) {
                        return { name: text.split('\n')[0], idx };
                    }
                    return null;
                }).filter(t => t !== null);
            });

            const candidates = threadsInDOM.filter(t => t && !processedNames.has(t.name));

            if (candidates.length === 0) {
                if (sidebarScrolls > 100) break;
                console.log(`🔄 Scrolling sidebar... (${sidebarScrolls})`);
                await page.evaluate(() => {
                    const sidebar = document.querySelector('div[aria-label="Direct"] div[style*="overflow-y: auto"]') ||
                        document.querySelector('div[role="tablist"]')?.parentElement;
                    if (sidebar) sidebar.scrollBy(0, 800);
                });
                await delay(2000);
                sidebarScrolls++;
                continue;
            }

            // Process visible threads
            for (const cand of candidates) {
                if (!cand || processedNames.has(cand.name)) continue;

                console.log(`\n🧵 [${totalThreadsProcessed + 1}] Processing: ${cand.name}`);

                try {
                    // Click the thread
                    await page.evaluate((targetIdx) => {
                        const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
                        (buttons[targetIdx] as HTMLElement)?.click();
                    }, cand.idx);

                    await delay(3000);

                    // Get real threadId and accurate Name from header
                    const { threadId, realName } = await page.evaluate(() => {
                        const url = window.location.href;
                        const match = url.match(/\/direct\/t\/(\d+)/);
                        const header = document.querySelector('div[role="main"] header');
                        return {
                            threadId: match ? match[1] : 'unknown',
                            realName: header ? (header as any).innerText.split('\n')[0] : 'Unknown'
                        };
                    });

                    console.log(`   🔸 ID: ${threadId} | Name: ${realName}`);

                    // --- DEEP HISTORY SCROLL ---
                    console.log('   📥 Scrolling history (25 cycles)...');
                    for (let step = 0; step < 25; step++) {
                        await page.evaluate(() => {
                            const chat = document.querySelector('div[role="main"] div[style*="overflow-y: auto"]') ||
                                document.querySelector('div[aria-label="Messages"]');
                            if (chat) chat.scrollTop = 0;
                        });
                        await delay(1200);
                    }

                    // --- ROBUST SCRAPE ---
                    const messages = await page.evaluate(() => {
                        // Broader selector to catch all types of message bubbles
                        const bubbles = Array.from(document.querySelectorAll('div[role="button"][aria-label*="Double tap to"], div[role="none"] > div > span'));
                        const windowWidth = window.innerWidth;

                        return bubbles.map((el: any) => {
                            const rect = el.getBoundingClientRect();
                            const text = el.innerText || '';
                            const isMe = rect.left > (windowWidth / 2);

                            // Filter out system messages or things that clearly aren't chat text
                            if (text.length === 0 || text.includes('Double tap to') || text.includes('Seen')) return null;

                            return { text, isFromMe: isMe };
                        }).filter(m => m !== null && m.text.length > 0);
                    });

                    console.log(`   ✅ Candidates: ${messages.length}`);

                    // --- PERSIST (Reverse to maintain chain order) ---
                    let saved = 0;
                    for (let k = 0; k < messages.length; k++) {
                        const m = messages[k]!;

                        if (messageStore.isDuplicate('instagram', threadId, m.text)) continue;

                        messageStore.addMessage({
                            platform: 'instagram',
                            chatId: threadId,
                            senderName: m.isFromMe ? 'You' : realName,
                            senderId: m.isFromMe ? 'me' : 'scraped_user',
                            content: m.text,
                            timestamp: Math.floor(Date.now() / 1000) - (messages.length - k),
                            isFromMe: m.isFromMe
                        });
                        saved++;
                    }
                    console.log(`   ✨ Saved ${saved} new messages.`);

                    processedNames.add(cand.name);
                    totalThreadsProcessed++;
                    break; // Refresh candidate list after sidebar might have moved
                } catch (e: any) {
                    console.log(`   ⚠️ Skip: ${e.message}`);
                    processedNames.add(cand.name);
                }
            }
        }

        console.log(`\n🎉 Processed ${totalThreadsProcessed} threads.`);

    } catch (err: any) {
        console.error('❌ Error:', err.message);
    } finally {
        await browser.close();
        db.close();
    }
}

backfill().catch(console.error);
