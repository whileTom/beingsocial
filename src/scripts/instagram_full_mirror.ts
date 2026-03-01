import puppeteer, { Browser, Page } from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { initDatabase, MessageStore } from '../database';

/**
 * COMPLETE INSTAGRAM DM SCRAPER v3
 * 
 * ORDER OF OPERATIONS:
 * 1. Click on a thread
 * 2. SCROLL UP INFINITELY in the message grid to load FULL history
 * 3. Extract all messages
 * 4. Save to database
 * 5. Move to next thread in sidebar
 * 
 * Key elements:
 * - Message grid: div[role="grid"][aria-label*="Messages in conversation"]
 * - Sidebar threads: div.xb57i2i ... div[role="button"]
 * - Message bubbles: div[aria-label*="Double tap"]
 */

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const CHROME_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const cookiesPath = path.join(__dirname, '..', '..', 'data', 'instagram_cookies.json');

const processedThreadIds = new Set<string>();
const processedMessageKeys = new Set<string>();
let totalMessagesSaved = 0;

async function findBrowserPath(): Promise<string> {
    for (const p of CHROME_PATHS) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error('Chrome/Edge not found.');
}

async function main() {
    console.log('\n🔥 [IG SCRAPER v3] Starting Complete Instagram DM Extraction...\n');

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
        defaultViewport: { width: 1400, height: 900 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-notifications', '--window-position=-2000,-2000']
    });

    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(60000);

        const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
        await page.setCookie(...cookies);

        console.log('🌐 Navigating to Instagram Inbox...');
        await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle2', timeout: 90000 });
        await delay(5000);

        // --- HELPER: Get thread buttons from sidebar ---
        const getThreadButtons = async () => {
            return page.evaluate(() => {
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
        };

        // --- HELPER: Scroll message grid UP infinitely until no more messages load ---
        const scrollChatToTop = async (threadName: string): Promise<number> => {
            console.log(`   📜 Scrolling chat UP to load FULL history (may take a while for long chats)...`);

            // Wait for chat to fully render
            await delay(3000);

            let previousMsgCount = 0;
            let stableCount = 0;
            let totalScrollAttempts = 0;
            const MAX_SCROLL_ATTEMPTS = 500; // Allow up to 500 scroll attempts for very long chats
            const STABILITY_THRESHOLD = 20; // Need 20 consecutive stable counts before considering done

            // First, focus on the message area
            await page.evaluate(() => {
                const grid = document.querySelector('div[role="grid"][aria-label*="Messages"]');
                if (grid) {
                    (grid as HTMLElement).focus();
                }
            });

            while (stableCount < STABILITY_THRESHOLD && totalScrollAttempts < MAX_SCROLL_ATTEMPTS) {
                totalScrollAttempts++;

                // Try multiple scroll strategies - VERY AGGRESSIVE
                await page.evaluate(() => {
                    // Try multiple selectors for the scrollable message container
                    const selectors = [
                        'div[role="grid"][aria-label*="Messages"]',
                        'div[aria-label*="Messages in conversation"]',
                        'div[data-pagelet="IGDOpenMessageList"] div[role="grid"]',
                    ];

                    let grid: Element | null = null;
                    for (const sel of selectors) {
                        grid = document.querySelector(sel);
                        if (grid) break;
                    }

                    if (!grid) {
                        // Fallback: find scrollable container with messages
                        const allDivs = document.querySelectorAll('div[style*="overflow"]');
                        for (const div of allDivs) {
                            if (div.querySelector('div[aria-label*="Double tap"]') &&
                                (div as HTMLElement).scrollHeight > 500) {
                                grid = div;
                                break;
                            }
                        }
                    }

                    if (!grid) return;

                    // AGGRESSIVE scroll methods
                    const el = grid as HTMLElement;
                    el.scrollTop = 0; // Force to very top
                    el.scrollBy(0, -5000); // Very large scroll up

                    // Fire multiple wheel events to trigger lazy loading
                    for (let i = 0; i < 5; i++) {
                        grid.dispatchEvent(new WheelEvent('wheel', { deltaY: -1000, bubbles: true }));
                    }
                });

                // Use keyboard scrolling - multiple presses
                await page.keyboard.press('Home');
                for (let i = 0; i < 5; i++) {
                    await page.keyboard.press('PageUp');
                }

                await delay(1500); // Longer wait for content to load

                // Count messages
                const msgCount = await page.evaluate(() => {
                    return document.querySelectorAll('div[aria-label*="Double tap"]').length;
                });

                if (msgCount === previousMsgCount) {
                    stableCount++;
                    // Only log stability progress occasionally
                    if (stableCount % 5 === 0) {
                        console.log(`   ⏳ Waiting for more messages... (${stableCount}/${STABILITY_THRESHOLD} stable, ${msgCount} loaded)`);
                    }
                } else {
                    stableCount = 0;
                    // Log progress every time we get new messages
                    console.log(`   📊 ${msgCount} messages loaded (scroll #${totalScrollAttempts})`);
                }

                previousMsgCount = msgCount;
            }

            const reason = stableCount >= STABILITY_THRESHOLD ? 'no more messages' : 'max attempts reached';
            console.log(`   ✅ Chat fully loaded: ${previousMsgCount} messages (${reason})`);
            return previousMsgCount;
        };

        // --- PHASE 1: DISCOVER ALL USERS BY SCROLLING SIDEBAR DOWN ---
        console.log('\n📂 PHASE 1: Discovering all users in sidebar...');

        const allDiscoveredUsers = new Set<string>();
        let noNewUsersCount = 0;

        while (noNewUsersCount < 10) {
            const threads = await getThreadButtons();
            let newThisRound = 0;

            for (const t of threads) {
                if (!allDiscoveredUsers.has(t.name)) {
                    allDiscoveredUsers.add(t.name);
                    newThisRound++;
                }
            }

            if (newThisRound === 0) {
                noNewUsersCount++;
                console.log(`   ⏳ Scrolling sidebar DOWN... (${noNewUsersCount}/10, ${allDiscoveredUsers.size} users found)`);
            } else {
                noNewUsersCount = 0;
                console.log(`   ✅ Found ${newThisRound} new users (Total: ${allDiscoveredUsers.size})`);
            }

            // Scroll sidebar DOWN
            await page.evaluate(() => {
                const sidebar = document.querySelector('div.xb57i2i');
                if (sidebar) sidebar.scrollBy(0, 400);
            });
            await delay(1200);
        }

        console.log(`\n✅ PHASE 1 COMPLETE: Discovered ${allDiscoveredUsers.size} unique threads\n`);

        // --- PHASE 2: PROCESS EACH THREAD ---
        console.log('💬 PHASE 2: Processing each thread (scroll UP → extract → save)...\n');

        // Scroll sidebar back to top
        await page.evaluate(() => {
            const sidebar = document.querySelector('div.xb57i2i');
            if (sidebar) sidebar.scrollTop = 0;
        });
        await delay(1000);

        const processedUsers = new Set<string>();
        let consecutiveEmptyPasses = 0;

        for (let pass = 0; pass < 5 && consecutiveEmptyPasses < 2; pass++) {
            console.log(`\n🔄 Pass ${pass + 1}/5`);

            await page.evaluate(() => {
                const sidebar = document.querySelector('div.xb57i2i');
                if (sidebar) sidebar.scrollTop = 0;
            });
            await delay(1000);

            let processedThisPass = 0;
            let noNewThreadCount = 0;

            while (noNewThreadCount < 15) {
                const currentThreads = await getThreadButtons();
                let foundNew = false;

                for (const thread of currentThreads) {
                    if (processedUsers.has(thread.name)) continue;

                    console.log(`\n═══════════════════════════════════════════════`);
                    console.log(`🧵 [${processedUsers.size + 1}/${allDiscoveredUsers.size}] ${thread.name}`);
                    console.log(`═══════════════════════════════════════════════`);

                    processedUsers.add(thread.name);
                    foundNew = true;
                    processedThisPass++;

                    try {
                        // STEP 1: Click the thread
                        console.log(`   👆 Clicking thread...`);
                        await page.evaluate((idx) => {
                            const sidebar = document.querySelector('div.xb57i2i');
                            if (!sidebar) return;
                            const buttons = Array.from(sidebar.querySelectorAll('div[role="button"]'));
                            const btn = buttons[idx] as HTMLElement;
                            if (btn) btn.click();
                        }, thread.element);

                        await delay(3000);

                        // Get thread ID from URL
                        const url = page.url();
                        const threadIdMatch = url.match(/\/direct\/t\/(\d+)/);
                        const threadId = threadIdMatch ? threadIdMatch[1] : `thread_${thread.name.replace(/[^a-zA-Z0-9]/g, '_')}`;

                        if (processedThreadIds.has(threadId)) {
                            console.log(`   ⏭️ Thread already processed, skipping`);
                            continue;
                        }

                        // STEP 2: SCROLL UP INFINITELY to load FULL chat history
                        const messageCount = await scrollChatToTop(thread.name);

                        if (messageCount === 0) {
                            console.log(`   ⚠️ No messages found in this thread`);
                            processedThreadIds.add(threadId);
                            continue;
                        }

                        // STEP 3: Extract ALL messages WITH timestamps
                        console.log(`   📤 Extracting messages with timestamps...`);

                        // First, get the list of all message bubbles
                        const bubbleCount = await page.evaluate(() => {
                            return document.querySelectorAll('div[aria-label*="Double tap"]').length;
                        });

                        console.log(`   📊 Found ${bubbleCount} message bubbles`);

                        const messages: { text: string, isFromMe: boolean, timestamp: string }[] = [];

                        // Process each message one by one to get timestamps
                        for (let idx = 0; idx < bubbleCount; idx++) {
                            try {
                                // Get message text and position
                                const msgData = await page.evaluate((i) => {
                                    const bubbles = document.querySelectorAll('div[aria-label*="Double tap"]');
                                    const bubble = bubbles[i] as HTMLElement;
                                    if (!bubble) return null;

                                    // Extract text
                                    const textEls = bubble.querySelectorAll('span[dir="auto"], div[dir="auto"]');
                                    let text = '';
                                    textEls.forEach((el: any) => {
                                        const t = el.innerText?.trim() || '';
                                        if (t && !t.includes('Double tap') && !t.includes('Enter') && t.length > 0 && t.length < 5000) {
                                            if (!text || t.length > text.length) text = t;
                                        }
                                    });

                                    // Check for media
                                    if (!text) {
                                        if (bubble.querySelector('img[alt*="photo"], img[alt*="Open"]')) text = '[Image]';
                                        else if (bubble.querySelector('video')) text = '[Video]';
                                        else if (bubble.querySelector('svg[aria-label="Clip"]')) text = '[Reel/Clip]';
                                    }

                                    // Get position for sender detection
                                    const rect = bubble.getBoundingClientRect();
                                    const isFromMe = rect.left > (window.innerWidth / 2);

                                    return { text, isFromMe, rect: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
                                }, idx);

                                if (!msgData || !msgData.text) continue;

                                // Hover over the message to reveal the options button
                                await page.mouse.move(msgData.rect.x, msgData.rect.y);
                                await delay(400);

                                // Try to find and click the three-dot options button
                                let timestamp = '';
                                const optionsClicked = await page.evaluate((i) => {
                                    const bubbles = document.querySelectorAll('div[aria-label*="Double tap"]');
                                    const bubble = bubbles[i] as HTMLElement;
                                    if (!bubble) return false;

                                    // Find the options button near this bubble (the three-dot menu)
                                    const parent = bubble.closest('[role="row"], [role="gridcell"]') || bubble.parentElement?.parentElement;
                                    if (!parent) return false;

                                    const optBtn = parent.querySelector('svg[aria-label*="more options"], div[aria-expanded]');
                                    if (optBtn) {
                                        const btn = optBtn.closest('[role="button"]') as HTMLElement;
                                        if (btn) {
                                            btn.click();
                                            return true;
                                        }
                                    }
                                    return false;
                                }, idx);

                                if (optionsClicked) {
                                    await delay(500);

                                    // Extract timestamp from the popup
                                    timestamp = await page.evaluate(() => {
                                        // Look for timestamp text like "Today at 11:32 AM" or "January 19 at 2:30 PM"
                                        const dateSpans = document.querySelectorAll('span.x1vvkbs, h6 span');
                                        for (const span of dateSpans) {
                                            const text = span.textContent || '';
                                            if (text.match(/\d{1,2}:\d{2}\s*(AM|PM)/i) ||
                                                text.match(/today|yesterday|january|february|march|april|may|june|july|august|september|october|november|december/i)) {
                                                return text;
                                            }
                                        }
                                        return '';
                                    });

                                    // Close the popup by clicking elsewhere
                                    await page.keyboard.press('Escape');
                                    await delay(200);
                                }

                                messages.push({
                                    text: msgData.text,
                                    isFromMe: msgData.isFromMe,
                                    timestamp: timestamp || ''
                                });

                                // Log progress every 10 messages
                                if ((idx + 1) % 10 === 0) {
                                    console.log(`   ⏳ Processed ${idx + 1}/${bubbleCount} messages`);
                                }

                            } catch (e) {
                                // Skip this message on error
                            }
                        }

                        console.log(`   ✅ Extracted ${messages.length} messages with timestamps`);

                        // STEP 4: Save to database with parsed timestamps
                        let savedCount = 0;

                        // Helper to parse Instagram timestamp strings
                        const parseTimestamp = (ts: string): number => {
                            if (!ts) return Math.floor(Date.now() / 1000);

                            const now = new Date();
                            const currentYear = now.getFullYear();

                            // Match "Today at 11:32 AM" or "11:32 AM"
                            const todayMatch = ts.match(/today\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i) ||
                                ts.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
                            if (todayMatch) {
                                let hours = parseInt(todayMatch[1]);
                                const mins = parseInt(todayMatch[2]);
                                const ampm = todayMatch[3].toUpperCase();
                                if (ampm === 'PM' && hours < 12) hours += 12;
                                if (ampm === 'AM' && hours === 12) hours = 0;
                                const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins);
                                return Math.floor(date.getTime() / 1000);
                            }

                            // Match "Yesterday at 3:45 PM"
                            const yesterdayMatch = ts.match(/yesterday\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
                            if (yesterdayMatch) {
                                let hours = parseInt(yesterdayMatch[1]);
                                const mins = parseInt(yesterdayMatch[2]);
                                const ampm = yesterdayMatch[3].toUpperCase();
                                if (ampm === 'PM' && hours < 12) hours += 12;
                                if (ampm === 'AM' && hours === 12) hours = 0;
                                const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hours, mins);
                                return Math.floor(date.getTime() / 1000);
                            }

                            // Match "January 19 at 2:30 PM" or "Jan 19 at 2:30 PM"
                            const dateMatch = ts.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
                            if (dateMatch) {
                                const monthNames: { [key: string]: number } = {
                                    'january': 0, 'jan': 0, 'february': 1, 'feb': 1, 'march': 2, 'mar': 2,
                                    'april': 3, 'apr': 3, 'may': 4, 'june': 5, 'jun': 5,
                                    'july': 6, 'jul': 6, 'august': 7, 'aug': 7, 'september': 8, 'sep': 8,
                                    'october': 9, 'oct': 9, 'november': 10, 'nov': 10, 'december': 11, 'dec': 11
                                };
                                const month = monthNames[dateMatch[1].toLowerCase()];
                                const day = parseInt(dateMatch[2]);
                                let hours = parseInt(dateMatch[3]);
                                const mins = parseInt(dateMatch[4]);
                                const ampm = dateMatch[5].toUpperCase();
                                if (ampm === 'PM' && hours < 12) hours += 12;
                                if (ampm === 'AM' && hours === 12) hours = 0;
                                const date = new Date(currentYear, month, day, hours, mins);
                                return Math.floor(date.getTime() / 1000);
                            }

                            // Fallback: use current time minus index offset
                            return Math.floor(Date.now() / 1000);
                        };

                        for (let i = 0; i < messages.length; i++) {
                            const msg = messages[i];
                            const messageKey = `${threadId}:${msg.text.substring(0, 80)}:${i}`;

                            if (processedMessageKeys.has(messageKey)) continue;
                            if (messageStore.isDuplicate('instagram', threadId, msg.text)) continue;

                            // Parse the timestamp or use fallback
                            const timestamp = msg.timestamp ? parseTimestamp(msg.timestamp) : Math.floor(Date.now() / 1000) - (messages.length - i);

                            messageStore.addMessage({
                                platform: 'instagram',
                                chatId: threadId,
                                senderName: msg.isFromMe ? 'You' : thread.name,
                                senderId: msg.isFromMe ? 'me' : 'user',
                                content: msg.text,
                                timestamp: timestamp,
                                isFromMe: msg.isFromMe
                            });

                            processedMessageKeys.add(messageKey);
                            savedCount++;
                            totalMessagesSaved++;
                        }

                        console.log(`   ✨ Saved ${savedCount} new messages`);
                        console.log(`   📈 Total messages saved: ${totalMessagesSaved}`);
                        processedThreadIds.add(threadId);

                    } catch (e: any) {
                        console.log(`   ❌ Error: ${e.message}`);
                    }

                    break; // Process one thread per iteration
                }

                if (!foundNew) {
                    await page.evaluate(() => {
                        const sidebar = document.querySelector('div.xb57i2i');
                        if (sidebar) sidebar.scrollBy(0, 300);
                    });
                    await delay(800);
                    noNewThreadCount++;
                } else {
                    noNewThreadCount = 0;
                }
            }

            if (processedThisPass === 0) {
                consecutiveEmptyPasses++;
            } else {
                consecutiveEmptyPasses = 0;
            }
        }

        console.log(`\n🎉 ═══════════════════════════════════════════════`);
        console.log(`   EXTRACTION COMPLETE!`);
        console.log(`   📂 Threads processed: ${processedThreadIds.size}`);
        console.log(`   💬 Total messages saved: ${totalMessagesSaved}`);
        console.log(`═══════════════════════════════════════════════\n`);

    } catch (err: any) {
        console.error('❌ Fatal error:', err.message);
    } finally {
        await browser.close();
        db.close();
    }
}

main().catch(console.error);
