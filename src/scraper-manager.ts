// @ts-nocheck
import puppeteer, { Browser, Page } from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { MessageStore } from './database';
import { EventEmitter } from 'events';

/**
 * Instagram DM Scraper Manager
 * Allows starting/stopping the scraper from the dashboard
 */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const CHROME_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export interface ScraperStatus {
    isRunning: boolean;
    currentPhase: 'idle' | 'discovering' | 'scraping' | 'extracting';
    usersDiscovered: number;
    usersProcessed: number;
    totalMessages: number;
    currentThread: string;
    error?: string;
}

export class InstagramScraperManager extends EventEmitter {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private isRunning = false;
    private shouldStop = false;
    private messageStore: MessageStore;
    private cookiesPath: string;

    private status: ScraperStatus = {
        isRunning: false,
        currentPhase: 'idle',
        usersDiscovered: 0,
        usersProcessed: 0,
        totalMessages: 0,
        currentThread: ''
    };

    constructor(messageStore: MessageStore) {
        super();
        this.messageStore = messageStore;
        this.cookiesPath = path.join(__dirname, '..', 'data', 'instagram_cookies.json');
    }

    getStatus(): ScraperStatus {
        return { ...this.status };
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            this.emit('log', '⚠️ Scraper is already running');
            return;
        }

        this.isRunning = true;
        this.shouldStop = false;
        this.status = {
            isRunning: true,
            currentPhase: 'discovering',
            usersDiscovered: 0,
            usersProcessed: 0,
            totalMessages: 0,
            currentThread: ''
        };
        this.emit('status', this.status);

        try {
            await this.run();
        } catch (err: any) {
            this.status.error = err.message;
            this.emit('log', `❌ Error: ${err.message}`);
        } finally {
            this.isRunning = false;
            this.status.isRunning = false;
            this.status.currentPhase = 'idle';
            this.emit('status', this.status);
            await this.cleanup();
        }
    }

    async stop(): Promise<void> {
        if (!this.isRunning) {
            this.emit('log', '⚠️ Scraper is not running');
            return;
        }

        this.emit('log', '🛑 Stopping scraper...');
        this.shouldStop = true;
    }

    private async cleanup(): Promise<void> {
        if (this.browser) {
            try {
                await this.browser.close();
            } catch { }
            this.browser = null;
            this.page = null;
        }
    }

    private async findBrowserPath(): Promise<string> {
        for (const p of CHROME_PATHS) {
            if (fs.existsSync(p)) return p;
        }
        throw new Error('Chrome/Edge not found.');
    }

    private async run(): Promise<void> {
        this.emit('log', '🔥 Starting Instagram DM Scraper...');

        if (!fs.existsSync(this.cookiesPath)) {
            throw new Error('No Instagram cookies found. Please log in first.');
        }

        const executablePath = await this.findBrowserPath();
        this.browser = await puppeteer.launch({
            executablePath,
            headless: false, // Keep visible for persistent profile
            defaultViewport: { width: 1400, height: 900 },
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-notifications', '--window-position=-2000,-2000']
        });

        this.page = await this.browser.newPage();
        this.page.setDefaultTimeout(60000);

        const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'));
        await this.page.setCookie(...cookies);

        this.emit('log', '🌐 Navigating to Instagram Inbox...');
        await this.page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle2', timeout: 90000 });
        await delay(5000);

        if (this.shouldStop) return;

        // PHASE 1: Discover users
        this.status.currentPhase = 'discovering';
        this.emit('status', this.status);
        this.emit('log', '📂 Phase 1: Discovering users...');

        const allDiscoveredUsers = new Set<string>();
        let noNewUsersCount = 0;

        while (noNewUsersCount < 10 && !this.shouldStop) {
            const threads = await this.getThreadButtons();
            let newThisRound = 0;

            for (const t of threads) {
                if (!allDiscoveredUsers.has(t.name)) {
                    allDiscoveredUsers.add(t.name);
                    newThisRound++;
                }
            }

            if (newThisRound === 0) {
                noNewUsersCount++;
            } else {
                noNewUsersCount = 0;
                this.status.usersDiscovered = allDiscoveredUsers.size;
                this.emit('status', this.status);
                this.emit('log', `✅ Found ${allDiscoveredUsers.size} users`);
            }

            await this.page.evaluate(() => {
                const sidebar = document.querySelector('div.xb57i2i');
                if (sidebar) sidebar.scrollBy(0, 400);
            });
            await delay(1200);
        }

        if (this.shouldStop) return;

        this.emit('log', `✅ Phase 1 complete: ${allDiscoveredUsers.size} users discovered`);

        // PHASE 2: Process each thread
        this.status.currentPhase = 'scraping';
        this.emit('status', this.status);
        this.emit('log', '💬 Phase 2: Scraping messages...');

        await this.page.evaluate(() => {
            const sidebar = document.querySelector('div.xb57i2i');
            if (sidebar) sidebar.scrollTop = 0;
        });
        await delay(1000);

        const processedUsers = new Set<string>();
        const processedThreadIds = new Set<string>();

        for (let pass = 0; pass < 5 && !this.shouldStop; pass++) {
            await this.page.evaluate(() => {
                const sidebar = document.querySelector('div.xb57i2i');
                if (sidebar) sidebar.scrollTop = 0;
            });
            await delay(1000);

            let noNewThreadCount = 0;

            while (noNewThreadCount < 15 && !this.shouldStop) {
                const currentThreads = await this.getThreadButtons();
                let foundNew = false;

                for (const thread of currentThreads) {
                    if (processedUsers.has(thread.name) || this.shouldStop) continue;

                    this.status.currentThread = thread.name;
                    this.emit('status', this.status);
                    this.emit('log', `🧵 Processing: ${thread.name}`);

                    processedUsers.add(thread.name);
                    foundNew = true;

                    try {
                        // Click thread
                        await this.page.evaluate((idx) => {
                            const sidebar = document.querySelector('div.xb57i2i');
                            if (!sidebar) return;
                            const buttons = Array.from(sidebar.querySelectorAll('div[role="button"]'));
                            const btn = buttons[idx] as HTMLElement;
                            if (btn) btn.click();
                        }, thread.element);

                        await delay(3000);

                        const url = this.page!.url();
                        const threadIdMatch = url.match(/\/direct\/t\/(\d+)/);
                        const threadId = threadIdMatch ? threadIdMatch[1] : `thread_${thread.name.replace(/[^a-zA-Z0-9]/g, '_')}`;

                        if (processedThreadIds.has(threadId)) continue;

                        // Scroll to load history
                        const messageCount = await this.scrollChatToTop();

                        if (messageCount > 0) {
                            // Extract and save messages
                            const messages = await this.extractMessages();
                            let savedCount = 0;

                            for (let i = 0; i < messages.length; i++) {
                                const msg = messages[i];
                                if (this.messageStore.isDuplicate('instagram', threadId, msg.text)) continue;

                                this.messageStore.addMessage({
                                    platform: 'instagram',
                                    chatId: threadId,
                                    senderName: msg.isFromMe ? 'You' : thread.name,
                                    senderId: msg.isFromMe ? 'me' : 'user',
                                    content: msg.text,
                                    timestamp: Math.floor(Date.now() / 1000) - (messages.length - i),
                                    isFromMe: msg.isFromMe
                                });
                                savedCount++;
                                this.status.totalMessages++;
                            }

                            this.emit('log', `✨ Saved ${savedCount} messages from ${thread.name}`);
                        }

                        processedThreadIds.add(threadId);
                        this.status.usersProcessed = processedUsers.size;
                        this.emit('status', this.status);

                    } catch (e: any) {
                        this.emit('log', `❌ Error on ${thread.name}: ${e.message}`);
                    }

                    break;
                }

                if (!foundNew) {
                    await this.page.evaluate(() => {
                        const sidebar = document.querySelector('div.xb57i2i');
                        if (sidebar) sidebar.scrollBy(0, 300);
                    });
                    await delay(800);
                    noNewThreadCount++;
                } else {
                    noNewThreadCount = 0;
                }
            }
        }

        this.emit('log', `🎉 Scraping complete! ${this.status.totalMessages} messages saved.`);
    }

    private async getThreadButtons(): Promise<{ name: string, element: number }[]> {
        if (!this.page) return [];
        return this.page.evaluate(() => {
            const sidebar = document.querySelector('div.xb57i2i');
            if (!sidebar) return [];

            const buttons = Array.from(sidebar.querySelectorAll('div[role="button"]'));
            const threads: { name: string, element: number }[] = [];

            buttons.forEach((btn, idx) => {
                const titleSpan = btn.querySelector('span[title]');
                if (titleSpan) {
                    const name = titleSpan.getAttribute('title') || '';
                    if (name && name.length > 0) {
                        threads.push({ name, element: idx });
                    }
                }
            });

            return threads;
        });
    }

    private async scrollChatToTop(): Promise<number> {
        if (!this.page) return 0;

        await delay(3000);

        let previousMsgCount = 0;
        let stableCount = 0;
        const MAX_SCROLL_ATTEMPTS = 500;
        const STABILITY_THRESHOLD = 20;

        while (stableCount < STABILITY_THRESHOLD && !this.shouldStop) {
            if (stableCount >= MAX_SCROLL_ATTEMPTS) break;

            await this.page.evaluate(() => {
                const grid = document.querySelector('div[role="grid"][aria-label*="Messages"]');
                if (grid) {
                    (grid as HTMLElement).scrollTop = 0;
                    grid.scrollBy(0, -5000);
                }
            });

            await this.page.keyboard.press('Home');
            for (let i = 0; i < 5; i++) {
                await this.page.keyboard.press('PageUp');
            }

            await delay(1500);

            const msgCount = await this.page.evaluate(() => {
                return document.querySelectorAll('div[aria-label*="Double tap"]').length;
            });

            if (msgCount === previousMsgCount) {
                stableCount++;
            } else {
                stableCount = 0;
            }

            previousMsgCount = msgCount;
        }

        return previousMsgCount;
    }

    private async extractMessages(): Promise<{ text: string, isFromMe: boolean }[]> {
        if (!this.page) return [];

        return this.page.evaluate(() => {
            const results: { text: string, isFromMe: boolean }[] = [];
            const windowWidth = window.innerWidth;

            const bubbles = document.querySelectorAll('div[aria-label*="Double tap"]');

            bubbles.forEach((bubble: any) => {
                const textEls = bubble.querySelectorAll('span[dir="auto"], div[dir="auto"]');
                let text = '';

                textEls.forEach((el: any) => {
                    const t = el.innerText?.trim() || '';
                    if (t && !t.includes('Double tap') && !t.includes('Enter') && t.length > 0 && t.length < 5000) {
                        if (!text || t.length > text.length) text = t;
                    }
                });

                if (!text) {
                    if (bubble.querySelector('img[alt*="photo"], img[alt*="Open"]')) text = '[Image]';
                    else if (bubble.querySelector('video')) text = '[Video]';
                    else if (bubble.querySelector('svg[aria-label="Clip"]')) text = '[Reel/Clip]';
                }

                if (!text) return;

                const rect = bubble.getBoundingClientRect();
                const isFromMe = rect.left > (windowWidth / 2);

                results.push({ text, isFromMe });
            });

            return results;
        });
    }
}
