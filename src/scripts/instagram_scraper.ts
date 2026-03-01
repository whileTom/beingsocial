// @ts-nocheck
/**
 * Standalone Instagram DM Scraper - Single Pass Version
 * 
 * Optimized for sequential, top-down scraping of all threads.
 * Skips discovery and complex searching.
 * 
 * Usage: npx ts-node --transpile-only src/scripts/instagram_scraper.ts
 */

import puppeteer, { Browser, Page } from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { initDatabase, MessageStore } from '../database';

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
    console.log('\n🔥 Instagram DM Scraper - Single Pass Mode\n');
    console.log('Iteratively scraping sidebar threads from Top to Bottom...');

    const db = initDatabase();
    const messageStore = new MessageStore(db);

    if (!fs.existsSync(cookiesPath)) {
        console.error('❌ No Instagram cookies found. Run main app first to log in.');
        return;
    }

    const executablePath = await findBrowserPath();
    const browser = await puppeteer.launch({
        executablePath,
        headless: false,
        defaultViewport: { width: 1400, height: 900 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-notifications']
    });

    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(60000);

        page.on('console', msg => {
            const text = msg.text();
            if (!text.includes('[HMR]') && !text.includes('stop!')) console.log(`[PAGE] ${text}`);
        });

        const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
        await page.setCookie(...cookies);

        console.log('🌐 Navigating to Instagram Inbox...');
        await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle2', timeout: 90000 });
        await delay(5000);

        console.log('🚀 Starting Sequential Scrape Loop...');
        const processedThreads = new Set<string>();
        let stuckCount = 0;
        const MAX_STUCK = 25; // More patience for 300+ threads
        let totalMessagesSaved = 0;

        while (stuckCount < MAX_STUCK) {
            console.log(`\n🔍 Scanning sidebar (Processed: ${processedThreads.size} threads)...`);

            // Find visible, unprocessed threads with robust heuristic
            const result = await page.evaluate((processedList) => {
                const processed = new Set(processedList);

                const isScrollable = (el: Element) => {
                    const style = window.getComputedStyle(el);
                    return el.scrollHeight > el.clientHeight && ['auto', 'scroll'].includes(style.overflowY);
                };

                // Heuristic Sidebar Finder
                let sidebar: Element | null = null;
                const buttons = document.querySelectorAll('div[role="button"]');
                for (const btn of buttons) {
                    if (btn.querySelector('img') && (btn as HTMLElement).innerText.includes('\n')) {
                        let p = btn.parentElement;
                        while (p && p !== document.body) {
                            if (isScrollable(p)) {
                                sidebar = p;
                                break;
                            }
                            p = p.parentElement;
                        }
                        if (sidebar) break;
                    }
                }

                if (!sidebar) return { name: null, error: 'Sidebar not found' };

                const threadButtons = Array.from(sidebar.querySelectorAll('div[role="button"]'));
                const visible = threadButtons.map(b => b.querySelector('span[title]')?.getAttribute('title')).filter(Boolean);

                console.log(`📡 Sidebar visible threads: ${visible.join(', ')}`);

                for (const btn of threadButtons) {
                    const titleSpan = btn.querySelector('span[title]');
                    if (titleSpan) {
                        const name = titleSpan.getAttribute('title');
                        if (name && !processed.has(name)) {
                            (btn as HTMLElement).click();
                            return { name, error: null };
                        }
                    }
                }

                return { name: null, error: 'All visible threads already processed', count: visible.length, sidebarFound: !!sidebar };
            }, Array.from(processedThreads));

            if (result.name) {
                const targetThread = result.name;
                console.log(`💬 Found Thread: ${targetThread}`);
                processedThreads.add(targetThread);
                stuckCount = 0;

                await delay(2500); // Wait for thread to load

                try {
                    const messages = await scrapeCurrentThreadMessages(page);
                    if (messages.length > 0) {
                        const threadId = `ig_${targetThread.replace(/[^a-zA-Z0-9]/g, '_')}`;
                        let saved = 0;
                        for (const msg of messages) {
                            if (!messageStore.isDuplicate('instagram', threadId, msg.text)) {
                                messageStore.addMessage({
                                    platform: 'instagram',
                                    chatId: threadId,
                                    senderName: msg.isFromMe ? 'You' : targetThread,
                                    senderId: msg.isFromMe ? 'me' : 'user',
                                    content: msg.text,
                                    timestamp: msg.timestamp,
                                    isFromMe: msg.isFromMe
                                });
                                saved++;
                                totalMessagesSaved++;
                            }
                        }
                        console.log(`   ✅ Saved ${saved}/${messages.length} new messages`);
                    } else {
                        console.log(`   ⚠️ No messages found in ${targetThread}`);
                    }
                } catch (e: any) {
                    console.log(`   ❌ Error scraping ${targetThread}: ${e.message}`);
                }
            } else {
                console.log(`   ⬇️ ${result.error || 'No target found'}. Scrolling sidebar down...`);
                // Scroll the sidebar logic
                const scrolled = await page.evaluate(() => {
                    const isScrollable = (el: Element) => {
                        const s = window.getComputedStyle(el);
                        return el.scrollHeight > el.clientHeight && ['auto', 'scroll'].includes(s.overflowY);
                    };

                    let sidebar: Element | null = null;
                    const buttons = document.querySelectorAll('div[role="button"]');
                    for (const btn of buttons) {
                        if (btn.querySelector('img') && (btn as HTMLElement).innerText.includes('\n')) {
                            let p = btn.parentElement;
                            while (p && p !== document.body) {
                                if (isScrollable(p)) { sidebar = p; break; }
                                p = p.parentElement;
                            }
                            if (sidebar) break;
                        }
                    }

                    if (sidebar) {
                        const prev = sidebar.scrollTop;
                        sidebar.scrollBy(0, 700); // Scroll nearly a full page
                        return Math.abs(sidebar.scrollTop - prev) > 1;
                    }
                    return false;
                });

                if (scrolled) {
                    stuckCount = 0;
                    console.log(`      (Scroll successful)`);
                    await delay(1500); // Let new threads load
                } else {
                    stuckCount++;
                    console.log(`      ⚠️ Scroll failed/reached end (${stuckCount}/${MAX_STUCK})`);
                    await delay(1000);
                }
            }
        }

        console.log(`\n🎉 Scraping Complete! Processed: ${processedThreads.size} threads. Total Saved: ${totalMessagesSaved}`);

    } catch (err: any) {
        console.error('❌ Fatal Error:', err.message);
    } finally {
        await browser.close();
        db.close();
    }
}

async function scrapeCurrentThreadMessages(page: Page) {
    console.log(`   📜 Loading message history...`);

    // 1. Scroll Up to load history
    let previousCount = 0;
    let stable = 0;
    const MAX_LOAD_STABLE = 5; // Increased for better accuracy
    let totalScrollAttempts = 0;
    const MAX_SCROLL_ATTEMPTS = 150;

    while (stable < MAX_LOAD_STABLE && totalScrollAttempts < MAX_SCROLL_ATTEMPTS) {
        totalScrollAttempts++;

        // Robust Scroller Finder + Jump Up
        const scrollState = await page.evaluate(() => {
            const grid = document.querySelector('div[role="grid"][aria-label*="Messages"]');
            if (!grid) return { found: false };

            const isS = (el: Element) => {
                const s = window.getComputedStyle(el);
                return ['auto', 'scroll'].includes(s.overflowY) && el.scrollHeight > el.clientHeight;
            };

            let scrollable = grid;
            while (scrollable && scrollable !== document.body) {
                if (isS(scrollable)) break;
                scrollable = scrollable.parentElement!;
            }

            if (!scrollable || scrollable === document.body) {
                // Secondary check: Find anything that is scrollable and in the chat area
                const all = document.querySelectorAll('div');
                for (const div of all) {
                    const rect = div.getBoundingClientRect();
                    if (rect.width > 300 && rect.left > 200 && isS(div)) {
                        scrollable = div;
                        break;
                    }
                }
            }

            if (scrollable) {
                // Trigger load: If at top, wiggle down then jump back to 0
                if (scrollable.scrollTop < 50) {
                    scrollable.scrollTop = 200;
                }
                scrollable.scrollTop = 0;
                scrollable.scrollBy(0, -2000); // Forces scroll event

                const rect = scrollable.getBoundingClientRect();
                return {
                    found: true,
                    scrollTop: scrollable.scrollTop,
                    x: rect.x + rect.width / 2,
                    y: rect.y + rect.height / 2
                };
            }
            return { found: false };
        });

        // Simulating physical wheel scroll (Very robust for lazy loaders)
        if (scrollState.found) {
            await page.mouse.move(scrollState.x, scrollState.y);
            await page.mouse.wheel({ deltaY: -2000 });
            await page.mouse.wheel({ deltaY: -2000 });
        }

        await delay(1200); // Network wait

        const count = await page.evaluate(() => document.querySelectorAll('div[aria-label*="Double tap"]').length);

        if (count === previousCount) {
            stable++;
            if (totalScrollAttempts % 5 === 0) {
                console.log(`   ⏳ Loading... (Count: ${count}, Stable: ${stable}/${MAX_LOAD_STABLE}, Attempt: ${totalScrollAttempts})`);
            }
        } else {
            stable = 0;
            console.log(`   📊 ${count} messages loaded...`);
        }
        previousCount = count;
    }

    console.log(`   ✅ Finished loading history. Total: ${previousCount} messages.`);

    // 2. Extractions
    const messages = await page.evaluate(() => {
        const bubbles = document.querySelectorAll('div[aria-label*="Double tap"]');
        const results = [];

        bubbles.forEach((bubble) => {
            const rect = bubble.getBoundingClientRect();
            // Simple text extraction
            const textEls = bubble.querySelectorAll('span[dir="auto"], div[dir="auto"]');
            let text = '';
            textEls.forEach((el: any) => {
                const t = el.innerText?.trim();
                if (t && t.length > text.length && !t.includes('Double tap')) text = t;
            });

            if (!text) {
                if (bubble.querySelector('img[alt*="photo"]')) text = '[Image]';
                else if (bubble.querySelector('video')) text = '[Video]';
            }

            if (text) {
                results.push({
                    text,
                    isFromMe: rect.left > (window.innerWidth / 2),
                    timestamp: Math.floor(Date.now() / 1000) // Fallback timestamp strategy
                });
            } else {
                // Diagnostic logging for skipped bubbles
                const classList = bubble.className;
                const inner = (bubble as HTMLElement).innerText?.substring(0, 30).replace(/\n/g, ' ');
                console.log(`📡 Skipped bubble: class="${classList}", text="${inner}..."`);
            }
        });
        return results;
    });

    return messages;
}

main().catch(console.error);
