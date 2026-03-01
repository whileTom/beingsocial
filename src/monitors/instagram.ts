import puppeteer, { Browser, Page } from 'puppeteer-core';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { IncomingMessage } from './whatsapp';
import { MessageStore } from '../database';

// Browser globals for Puppeteer evaluate blocks
declare const document: any;
declare const HTMLElement: any;
declare const window: any;

// Helper to parse Instagram timestamp strings from the UI popup
function parseInstagramTimestamp(ts: string): number {
    if (!ts) return 0;

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

    // Match "December 31, 2025 at 2:15 AM" (Month Day, Year)
    const yearMatch = ts.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),\s+(\d{4})(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (yearMatch) {
        const monthNames: { [key: string]: number } = {
            'january': 0, 'jan': 0, 'february': 1, 'feb': 1, 'march': 2, 'mar': 2,
            'april': 3, 'apr': 3, 'may': 4, 'june': 5, 'jun': 5,
            'july': 6, 'jul': 6, 'august': 7, 'aug': 7, 'september': 8, 'sep': 8,
            'october': 9, 'oct': 9, 'november': 10, 'nov': 10, 'december': 11, 'dec': 11
        };
        const month = monthNames[yearMatch[1].toLowerCase()];
        const day = parseInt(yearMatch[2]);
        const year = parseInt(yearMatch[3]);
        let hours = parseInt(yearMatch[4]);
        const mins = parseInt(yearMatch[5]);
        const ampm = yearMatch[6].toUpperCase();
        if (ampm === 'PM' && hours < 12) hours += 12;
        if (ampm === 'AM' && hours === 12) hours = 0;
        const date = new Date(year, month, day, hours, mins);
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

    return 0;
}

// Chrome paths for Windows
const CHROME_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export class InstagramMonitor extends EventEmitter {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private isReady: boolean = false;
    private isScanning: boolean = false;
    private processedMessageIds: Set<string> = new Set();
    private lastCheckTime: number = Date.now() - 600000; // 10 minutes ago for testing
    private currentThreadName: string = 'unknown';
    // Store chat history by threadId (or threadName)
    private chatHistory: Map<string, any[]> = new Map();

    // Config
    private cookiesPath = path.join(__dirname, '..', '..', 'data', 'instagram_cookies.json');
    private pollingInterval: NodeJS.Timeout | null = null;
    private messageStore?: MessageStore;

    constructor(messageStore?: MessageStore) {
        super();
        this.messageStore = messageStore;
    }

    private findBrowserPath(): string {
        for (const p of CHROME_PATHS) {
            if (fs.existsSync(p)) return p;
        }
        throw new Error('Chrome/Edge executable not found for Puppeteer.');
    }

    async start(): Promise<void> {
        console.log('\n' + '='.repeat(40));
        console.log('📸 [SESSION START] Instagram Monitor');
        console.log(`⏰ Time: ${new Date().toLocaleString()}`);
        console.log('='.repeat(40) + '\n');

        if (!fs.existsSync(this.cookiesPath)) {
            console.warn('⚠️ No Instagram cookies found. Run `npm run login:ig:browser` first.');
            return;
        }

        console.log('📸 Starting Instagram Monitor (Browser Mode)...');

        try {
            const executablePath = this.findBrowserPath();
            console.log(`🚀 Launching browser: ${executablePath}`);
            this.browser = await puppeteer.launch({
                executablePath,
                headless: false, // Keep visible for persistent profile
                defaultViewport: { width: 1024, height: 768 },
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-notifications', '--window-size=1024,768', '--window-position=-2000,-2000']
            });

            this.page = await this.browser.newPage();

            // Load cookies
            const cookiesString = fs.readFileSync(this.cookiesPath, 'utf-8');
            const cookies = JSON.parse(cookiesString);
            await this.page.setCookie(...cookies);

            console.log('🍪 Cookies loaded. Navigating to Inbox...');

            // Setup Network Interception BEFORE navigation
            await this.setupNetworkInterception();
            console.log('🔍 Network hooks registered.');

            // Navigate with a timeout to avoid hanging
            console.log('🌐 Loading Instagram...');
            try {
                await this.page.goto('https://www.instagram.com/direct/inbox/', {
                    waitUntil: 'domcontentloaded',  // Less strict than networkidle2
                    timeout: 30000 // 30 second timeout
                });
                console.log('✅ Page loaded!');
            } catch (navError: any) {
                console.error('⚠️ Navigation timeout/error:', navError.message);
                console.log('📍 Checking current URL anyway...');
            }

            // Verify login by checking title or URL
            const url = this.page.url();
            console.log(`📍 Current URL: ${url}`);

            if (!url.includes('instagram.com/direct/inbox')) {
                console.warn('⚠️ Login might have failed. Page URL:', url);
                if (url.includes('login')) {
                    console.error('❌ Cookies expired or invalid. Please re-run login script.');
                    return;
                }
            }

            console.log('✅ Instagram Browser Ready & Monitoring!');
            this.isReady = true;
            this.emit('ready');

            // Start simple navigation loop to keep session alive and trigger updates
            this.startPolling();

        } catch (error: any) {
            console.error('❌ Instagram Browser Error:', error.message);
            console.error('Stack:', error.stack);
        }
    }

    private async setupNetworkInterception() {
        if (!this.page) return;

        console.log('🔍 Network interception active - monitoring Instagram API...');

        this.page.on('response', async (response) => {
            const url = response.url();

            // Skip noisy API logging - only log actual data processing
            // GraphQL interception DISABLED - not being used, scraper handles message collection
            /*
            if (url.includes('/api/graphql') || url.includes('/graphql/query')) {
                try {
                    const json = await response.json();
                    // Process silently - only log important data actions
                    if (json?.data?.get_slide_mailbox_for_iris_subscription) {
                        const mailbox = json.data.get_slide_mailbox_for_iris_subscription;
                        if (mailbox.threads_by_folder) {
                            await this.processInstagramMailbox(mailbox);
                        }
                    }
                    if (json?.data?.get_slide_thread) {
                        const threadData = json.data.get_slide_thread;
                        if (threadData.as_ig_direct_thread) {
                            await this.processThreadMessages(threadData.as_ig_direct_thread);
                        }
                    }
                    if (json?.data?.viewer?.actor?.direct_message_threads) {
                        const edges = json.data.viewer.actor.direct_message_threads.edges || [];
                        await this.processGraphQLInboxData(json);
                    }
                } catch (e: any) {
                    // Many GraphQL responses, ignore parse errors
                }
            }
            */

            // Also check old REST API format (fallback) - but ignore HTML
            if (url.includes('direct_v2/inbox') || url.includes('direct_v2/threads')) {
                // Only if it's actually an API endpoint, not the HTML page
                if (!url.endsWith('/direct/inbox/') && !url.endsWith('/direct/inbox')) {
                    try {
                        const json = await response.json();
                        await this.processInboxData(json);
                    } catch (e: any) {
                        // Ignore - likely HTML
                    }
                }
            }
        });
    }

    private async processInstagramMailbox(mailbox: any) {
        // Instagram's actual structure: threads_by_folder has edges (GraphQL pagination)
        const threadsByFolder = mailbox.threads_by_folder;
        if (!threadsByFolder?.edges) {
            console.log(`   ⚠️ No edges in threads_by_folder`);
            return;
        }

        const edges = threadsByFolder.edges;
        console.log(`📦 Processing ${edges.length} thread edges`);

        for (const edge of edges) {
            const threadWrapper = edge.node;
            if (!threadWrapper) continue;

            // The actual thread data is nested in as_ig_direct_thread
            const thread = threadWrapper.as_ig_direct_thread || threadWrapper;

            // Log thread structure for first thread
            if (edges.indexOf(edge) === 0) {
                console.log(`   Thread wrapper keys: ${Object.keys(threadWrapper).join(', ')}`);
                if (threadWrapper.as_ig_direct_thread) {
                    console.log(`   Actual thread keys: ${Object.keys(thread).slice(0, 15).join(', ')}`);
                }
            }

            // Try to find messages in the thread
            if (edges.indexOf(edge) === 0 && thread.slide_messages) {
                console.log(`   slide_messages type: ${typeof thread.slide_messages}`);
                console.log(`   slide_messages is array: ${Array.isArray(thread.slide_messages)}`);
                if (typeof thread.slide_messages === 'object' && thread.slide_messages !== null) {
                    console.log(`   slide_messages keys: ${Object.keys(thread.slide_messages).join(', ')}`);
                    if (thread.slide_messages.edges) {
                        console.log(`   slide_messages has ${thread.slide_messages.edges.length} message edges`);
                    }
                }
            }

            const messages = thread.slide_messages?.nodes || thread.slide_messages?.edges || thread.messages?.nodes || thread.items?.nodes || thread.last_permanent_item;
            if (!messages || (Array.isArray(messages) && messages.length === 0)) {
                if (edges.indexOf(edge) === 0) {
                    console.log(`   ⚠️ No messages or empty messages array`);
                }
                continue;
            }

            const messageArray = Array.isArray(messages) ? messages : [messages];
            if (messageArray.length === 0) continue;

            // If messages are in edges format, extract the nodes
            const lastMessageEdge = messageArray[0];
            const lastMessage = lastMessageEdge?.node || lastMessageEdge; // Handle both edge.node and direct message
            if (!lastMessage) continue;

            const msgId = lastMessage.message_id || lastMessage.item_id || lastMessage.id;
            if (!msgId) continue;

            // Ignore "Liked a message" pseudo-messages
            if (lastMessage.igd_snippet === 'Liked a message') {
                console.log(`   🚫 Ignoring 'Liked a message' event: ${msgId}`);
                continue;
            }

            const timestamp = lastMessage.timestamp_precise || lastMessage.timestamp;
            let msgTimestamp: number;
            const tsNum = parseInt(timestamp);
            if (isNaN(tsNum) || tsNum <= 0) {
                // Skip messages with truly invalid timestamps
                continue;
            } else if (tsNum > 1e15) {
                // Microseconds (Instagram timestamp_precise format)
                msgTimestamp = Math.floor(tsNum / 1000000);
            } else if (tsNum > 1e12) {
                // Milliseconds
                msgTimestamp = Math.floor(tsNum / 1000);
            } else {
                // Already in seconds
                msgTimestamp = tsNum;
            }

            // Only new messages, not from me
            const isFromMe = lastMessage.is_sent_by_viewer || lastMessage.is_from_me || false;

            if (msgTimestamp > (this.lastCheckTime / 1000) && !isFromMe) {
                if (this.processedMessageIds.has(msgId)) continue;
                this.processedMessageIds.add(msgId);
            } else if (!isFromMe) {
                continue; // Old/processed message
            } else {
                continue;
            }
            // ... processing continues


            let content = '';
            let messageType = 'text';

            // Extract content
            const msg = lastMessage.message || lastMessage;
            if (msg.text) {
                content = msg.text;
            } else if (msg.media) {
                messageType = 'image';
                content = '[Image]';
            } else if (msg.voice_media) {
                messageType = 'audio';
                content = '[Voice Message]';
            } else if (msg.like) {
                content = '❤️';
            } else if (msg.clip) {
                messageType = 'video';
                const caption = msg.clip.clip?.caption?.text || '';
                content = `[Reel Shared] ${caption}`;
            } else if (msg.link) {
                messageType = 'link';
                content = msg.link.text || '[Link]';
            } else if (msg.media_share) {
                messageType = 'image';
                const caption = msg.media_share.text || '';
                content = `[Post Shared] ${caption}`;
            } else if (lastMessage.igd_snippet) {
                // FALLBACK: User confirmed this contains text for some message types
                content = lastMessage.igd_snippet;
            } else {
                console.log('⚠️ [IG-DEBUG] Unknown message structure:', JSON.stringify(lastMessage, null, 2));
                content = `[${lastMessage.item_type || 'unknown'}]`;
                messageType = 'unknown';
            }

            // Find sender
            const senderId = lastMessage.sender_id || lastMessage.user_id;
            const sender = thread.users?.find((u: any) => u.pk === senderId || u.id === senderId);
            const senderName = sender ? (sender.full_name || sender.username) : 'Unknown User';

            const incomingMessage: IncomingMessage = {
                platform: 'instagram',
                chatId: thread.thread_id || thread.id,
                senderName: senderName,
                senderId: senderId?.toString() || 'unknown',
                content,
                timestamp: msgTimestamp,
                isFromMe: false,
                messageType,
            };

            console.log(`📩 [IG] New message from ${senderName}: ${content}`);
            this.emit('message', incomingMessage);
        }
    }

    private async processThreadMessages(thread: any) {
        // Extract messages from individual thread query (get_slide_thread)
        // Safety check for messages array access
        const messages = thread.slide_messages?.edges || [];

        if (!messages || messages.length === 0) {
            // Log warning but don't crash
            if (process.env.DEBUG_IG) {
                console.log(`   ⚠️ Thread has no messages (or structure changed)`);
            }
            return;
        }

        console.log(`   📦 Processing ${messages.length} messages from thread`);

        for (const edge of messages) {
            const message = edge.node;
            if (!message) continue;

            const msgId = message.message_id || message.item_id || message.id;
            if (!msgId) continue;

            // Check if already processed
            if (this.processedMessageIds.has(msgId)) continue;

            const timestamp = message.timestamp_precise || message.timestamp;
            const msgTimestamp = Math.floor(parseInt(timestamp) / 1000000);

            // Only new messages, not from me
            const isFromMe = message.is_sent_by_viewer || message.is_from_me;
            if (msgTimestamp > (this.lastCheckTime / 1000) && !isFromMe) {
                this.processedMessageIds.add(msgId);

                let content = '';
                let messageType = 'text';

                // Extract content
                const msg = message.message || message;
                if (msg.text) {
                    content = msg.text;
                } else if (msg.media) {
                    messageType = 'image';
                    content = '[Image]';
                } else if (msg.voice_media) {
                    messageType = 'audio';
                    content = '[Voice Message]';
                } else if (msg.like) {
                    content = '❤️';
                } else if (message.igd_snippet) {
                    // FALLBACK: User confirmed this contains text for some message types
                    content = message.igd_snippet;
                } else {
                    console.log('⚠️ [IG-DEBUG] Unknown thread message structure:', JSON.stringify(message, null, 2));
                    content = `[${message.item_type || 'unknown'}]`;
                    messageType = 'unknown';
                }

                // Find sender
                const senderId = message.sender_id || message.user_id;
                const sender = thread.users?.find((u: any) => u.pk === senderId || u.id === senderId);
                const senderName = sender ? (sender.full_name || sender.username) : 'Unknown User';

                const incomingMessage: IncomingMessage = {
                    platform: 'instagram',
                    chatId: thread.thread_id || thread.id,
                    senderName: senderName,
                    senderId: senderId?.toString() || 'unknown',
                    content,
                    timestamp: msgTimestamp,
                    isFromMe: false,
                    messageType,
                };

                const SYSTEM_PHRASES = ['Video chat ended', 'Audio chat ended', 'Call ended', 'Missed audio call', 'Missed video call', 'started a video chat', 'started an audio chat', 'sent an attachment.', 'sent a voice message.'];
                if (SYSTEM_PHRASES.some(p => content.includes(p))) {
                    console.log(`   🚫 [IG] Ignoring system msg from ${senderName}: ${content}`);
                    continue;
                }

                console.log(`📩 [IG] New message from ${senderName}: ${content}`);
                this.emit('message', incomingMessage);
            }
        }

        this.lastCheckTime = Date.now();
    }

    private async processGraphQLInboxData(data: any) {
        const edges = data?.data?.viewer?.actor?.direct_message_threads?.edges;
        if (!edges || edges.length === 0) return;

        const myUserId = data?.data?.viewer?.actor?.pk;

        for (const edge of edges) {
            const thread = edge.node;
            if (!thread?.thread_items?.nodes || thread.thread_items.nodes.length === 0) continue;

            const lastMessage = thread.thread_items.nodes[0]; // Most recent
            if (!lastMessage?.item_id) continue;

            let msgTimestamp = parseInt(lastMessage.timestamp);
            if (isNaN(msgTimestamp)) {
                console.log(`⚠️ Timestamp NaN, using current time: ${Math.floor(Date.now() / 1000)}`);
                msgTimestamp = Math.floor(Date.now() / 1000);
            } else {
                msgTimestamp = Math.floor(msgTimestamp / 1000000);
            }

            // Process all new messages (incoming and outgoing)
            if (msgTimestamp > (this.lastCheckTime / 1000)) {
                if (this.processedMessageIds.has(lastMessage.item_id)) continue;
                this.processedMessageIds.add(lastMessage.item_id);

                let content = '';
                let messageType = 'text';

                // Extract content based on type
                if (lastMessage.text) {
                    content = lastMessage.text;
                } else if (lastMessage.media) {
                    messageType = 'image';
                    content = '[Image]';
                } else if (lastMessage.voice_media) {
                    messageType = 'audio';
                    content = '[Voice Message]';
                } else if (lastMessage.like) {
                    content = '❤️';
                } else {
                    content = `[${lastMessage.item_type || 'unknown'}]`;
                    messageType = 'unknown';
                }

                // Find sender
                const sender = thread.users?.find((u: any) => u.pk?.toString() === lastMessage.user_id?.toString());
                const senderName = sender ? (sender.full_name || sender.username) : 'Unknown User';

                const incomingMessage: IncomingMessage = {
                    platform: 'instagram',
                    chatId: thread.thread_id || thread.id,
                    senderName: senderName,
                    senderId: lastMessage.user_id?.toString() || 'unknown',
                    content,
                    timestamp: msgTimestamp,
                    isFromMe: lastMessage.user_id?.toString() === myUserId?.toString(),
                    messageType,
                };

                const SYSTEM_PHRASES = ['Video chat ended', 'Audio chat ended', 'Call ended', 'Missed audio call', 'Missed video call', 'started a video chat', 'started an audio chat', 'sent an attachment.', 'sent a voice message.'];
                if (SYSTEM_PHRASES.some(p => content.includes(p))) {
                    continue;
                }

                console.log(`📩 [IG] New message from ${senderName}: ${content}`);
                this.emit('message', incomingMessage);
            }
        }

        this.lastCheckTime = Date.now();
    }

    private async processInboxData(data: any) {
        if (!data?.inbox?.threads) return;

        const threads = data.inbox.threads;
        const myUserId = data.viewer?.pk;

        for (const thread of threads) {
            const lastItem = thread.items[0];
            if (!lastItem) continue;

            let msgTimestamp = parseInt(lastItem.timestamp);
            if (isNaN(msgTimestamp)) {
                console.log(`⚠️ Timestamp NaN, using current time: ${Math.floor(Date.now() / 1000)}`);
                msgTimestamp = Math.floor(Date.now() / 1000);
            } else {
                msgTimestamp = Math.floor(msgTimestamp / 1000000); // Microseconds to seconds
            }

            // Process all new messages (incoming and outgoing)
            if (msgTimestamp > (this.lastCheckTime / 1000)) {

                if (this.processedMessageIds.has(lastItem.item_id)) continue;
                this.processedMessageIds.add(lastItem.item_id);

                // Extract content
                let content = '';
                let messageType = 'text';

                switch (lastItem.item_type) {
                    case 'text':
                        content = lastItem.text;
                        break;
                    case 'media':
                    case 'image_share':
                    case 'raven_media':
                        messageType = 'image';
                        content = '[Image]';
                        break;
                    case 'voice_media':
                        messageType = 'audio';
                        content = '[Voice Message]';
                        break;
                    case 'like':
                        content = '❤️';
                        break;
                    default:
                        content = `[${lastItem.item_type}]`;
                        messageType = 'unknown';
                }

                // Find sender
                const sender = thread.users.find((u: any) => u.pk.toString() === lastItem.user_id.toString());
                const senderName = sender ? (sender.full_name || sender.username) : 'Unknown User';

                const incomingMessage: IncomingMessage = {
                    platform: 'instagram',
                    chatId: thread.thread_id,
                    senderName: senderName,
                    senderId: lastItem.user_id.toString(),
                    content,
                    timestamp: msgTimestamp,
                    isFromMe: lastItem.user_id.toString() === myUserId?.toString(),
                    messageType,
                };

                const SYSTEM_PHRASES = ['Video chat ended', 'Audio chat ended', 'Call ended', 'Missed audio call', 'Missed video call', 'started a video chat', 'started an audio chat', 'sent an attachment.', 'sent a voice message.'];
                if (SYSTEM_PHRASES.some(p => content.includes(p))) {
                    continue;
                }

                console.log(`📩 [IG] New message from ${senderName}: ${content}`);
                this.emit('message', incomingMessage);
            }
        }

        this.lastCheckTime = Date.now();
    }

    private startPolling() {
        // Scan threads every 10 seconds to trigger message loading
        this.pollingInterval = setInterval(async () => {
            if (this.page && this.isReady) {
                await this.scanThreads();
            }
        }, 20000); // 20 seconds (user requested: scan last 10 chats every 20s)

        // REMOVED: Initial scan on startup to prevent "full scrape" behavior
        // The polling interval above will handle scanning after the first 20s window.
        /*
        setTimeout(async () => {
            if (this.page && this.isReady) {
                await this.scanThreads();
            }
        }, 5000); 
        */
    }

    private logDebug(message: string) {
        try {
            const timestamp = new Date().toISOString();
            const logFile = `${process.cwd()}/instagram_debug.log`;
            fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
            // Also log to console for user to see
            console.log(`[DEBUG] ${message}`);
        } catch (e: any) {
            console.error('DEBUG LOG FAILED:', e.message);
        }
    }

    private async scanThreads() {
        if (!this.page || !this.isReady || this.isScanning) return;
        this.isScanning = true;

        try {
            console.log('🔍 Scanning Instagram threads...');

            // Navigate back to inbox if not there
            const currentUrl = this.page.url();
            if (!currentUrl.includes('/direct/inbox')) {
                await this.page.goto('https://www.instagram.com/direct/inbox/', {
                    waitUntil: 'domcontentloaded',
                    timeout: 10000
                });
                await new Promise(r => setTimeout(r, 2000));
            }

            // Click through threads
            // Need to re-fetch threads each time to avoid stale handles
            // User requested scanning last 25 chats
            for (let i = 0; i < 25; i++) {
                try {
                    // Re-find threads to get fresh handles
                    // Filter for buttons that look like threads (have img and text)
                    // We use evaluateHandle to filter in browser context
                    const threadHandles = await this.page.evaluateHandle(() => {
                        // Use the precise class container for threads found by inspection (.xb57i2i is the Vertical List)
                        // Notes are in a separate container at top with class xpqajaz

                        // Fallback: Select buttons that are likely in the vertical list if class names change
                        // Inspection showed Threads don't have 'xpqajaz' class.
                        // We target buttons that are NOT notes.

                        const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
                        return buttons.filter((el: any) => {
                            const hasImg = el.querySelector('img');
                            const text = (el as any).innerText || '';

                            // Notes specific block
                            const isNote = el.classList.contains('xpqajaz') || el.closest('.xpqajaz') || text.includes('Your note');

                            // Also check for the vertical list container parent if possible, but class names rotate.
                            // Better heuristic: Threads usually have a timestamp or "·" separator line 2
                            // But simple text length > 3 is a decent backup.

                            const hasNewline = text.includes('\n');

                            return hasImg && text.length > 0 && !isNote && hasNewline;
                        });
                    });

                    const threads = [];
                    const properties = await threadHandles.getProperties();
                    for (const property of properties.values()) {
                        const element = property.asElement();
                        if (element) threads.push(element);
                    }

                    if (threads.length <= i) break; // No more threads

                    const threadName = await this.page.evaluate((idx: number) => {
                        const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
                        const filtered = buttons.filter((el: any) => {
                            const hasImg = el.querySelector('img');
                            const text = (el as any).innerText || '';
                            const isNote = el.classList.contains('xpqajaz') || el.closest('.xpqajaz') || text.includes('Your note');
                            const hasNewline = text.includes('\n');
                            return hasImg && text.length > 0 && !isNote && hasNewline;
                        });
                        return filtered[idx] ? (filtered[idx] as any).innerText.split('\n')[0] : 'unknown';
                    }, i);

                    this.currentThreadName = threadName;

                    // Re-fetch handle specifically for the click to minimize "context find" errors
                    const handleToClick = await this.page.evaluateHandle((idx: number) => {
                        const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
                        const filtered = buttons.filter((el: any) => {
                            const hasImg = el.querySelector('img');
                            const text = (el as any).innerText || '';
                            const isNote = el.classList.contains('xpqajaz') || el.closest('.xpqajaz') || text.includes('Your note');
                            const hasNewline = text.includes('\n');
                            return hasImg && text.length > 0 && !isNote && hasNewline;
                        });
                        return filtered[idx];
                    }, i);

                    if (handleToClick.asElement()) {
                        await (handleToClick.asElement() as any).click();
                        await handleToClick.dispose(); // Drop it immediately
                    }

                    // Wait for thread to load by checking for messages
                    try {
                        await this.page.waitForSelector('div[role="button"][aria-label*="Double tap to"]', { timeout: 8000 });
                    } catch (e) {
                        this.logDebug('   ⚠️ Timed out waiting for messages to render');
                    }

                    // User Request: Scroll UP twice to catch slightly older messages/context
                    for (let s = 0; s < 2; s++) {
                        await this.page.evaluate(() => {
                            const grid = document.querySelector('div[role="grid"][aria-label*="Messages"]');
                            if (grid) {
                                (grid as any).scrollTop = 0; // Scroll to top to trigger loader
                            }
                        });
                        await new Promise(r => setTimeout(r, 1000)); // Wait for load
                    }

                    // Scrape messages
                    await this.scrapeThreadMessages();

                } catch (e: any) {
                    if (e.message.includes('Protocol error')) {
                        this.logDebug(`   ⚠️ Navigation sync issue on thread ${i}, continuing...`);
                    } else {
                        console.log(`   ⚠️ Failed to scan thread ${i}: ${e.message}`);
                    }
                }
            }
            console.log('✅ Scanned threads');
        } catch (error: any) {
            console.error(`❌ Thread scanning error: ${error.message}`);
        } finally {
            this.isScanning = false;
        }
    }

    private async scrapeThreadMessages() {
        if (!this.page) return;

        try {
            // Zoom out to see more history (0.5 = 50%)
            await this.page.evaluate(() => {
                document.body.style.zoom = '0.5';
            });

            // Find message bubbles using the "Double tap" aria-label (very specific to bubbles)
            const messageElements = await this.page.$$('div[role="button"][aria-label*="Double tap to"]');

            if (messageElements.length === 0) {
                return; // No messages to process
            }

            // Extract info from ALL visible messages for history
            const allMessages = await this.page.evaluate((els: any[]) => {
                const windowWidth = window.innerWidth;
                return els.map(el => {
                    const htmlEl = el as any;
                    const rect = htmlEl.getBoundingClientRect();

                    // Simple text extraction
                    let text = htmlEl.innerText || '';
                    let type = 'text';

                    // Try to detect media
                    // Specific to Instagram's DOM structure
                    if (htmlEl.querySelector('img[alt*="Photo"]')) {
                        type = 'image';
                        text = '[Image]';
                    } else if (htmlEl.querySelector('video') || htmlEl.querySelector('img[alt*="Video"]')) {
                        type = 'video';
                        text = '[Video]';
                    } else if (htmlEl.querySelector('audio') || text.includes('Voice message')) {
                        type = 'audio';
                        text = '[Voice Message]';
                    } else if (htmlEl.querySelector('svg[aria-label="Like"]')) {
                        text = '❤️';
                    } else if (text === '') {
                        // Fallback
                        text = '[Media/Unknown]';
                    }

                    return {
                        text: text,
                        type: type,
                        left: rect.left,
                        windowWidth: windowWidth,
                        is_from_me: rect.left > (windowWidth / 2) // Coordinate based detection
                    };
                });
            }, messageElements);

            // LOG EVERY FOUND MESSAGE AS REQUESTED
            for (const msg of allMessages) {
                const sender = msg.is_from_me ? 'Me' : (this.currentThreadName || 'Instagram User');
                const displayContent = (msg.type !== 'text') ? `[Media: ${msg.type}]` : msg.text.replace(/\n/g, ' ');
                this.logDebug(`[IG-CHAT] From ${sender}: ${displayContent}`);
            }

            // Extract real thread ID from URL
            const url = this.page.url();
            const threadIdMatch = url.match(/\/direct\/t\/(\d+)/);
            const threadId = threadIdMatch ? threadIdMatch[1] : 'scraped_unknown';

            // Store in history (using basic timestamping for now since we can't easily parse relative time from DOM)
            // We assume they appear in order.
            const history = allMessages.map((msg: any, index: number) => ({
                ...msg,
                timestamp: Date.now() - ((allMessages.length - index) * 1000), // Fake timestamp for ordering
                user_id: msg.is_from_me ? 'You' : (this.currentThreadName || 'Instagram User')
            }));

            this.chatHistory.set(threadId, history);



            // Loop through ALL messages to backfill history
            for (let i = 0; i < allMessages.length; i++) {
                const data = allMessages[i];
                const text = data.text;

                if (!text || text.toLowerCase().includes('loading...') || text.toLowerCase() === 'unknown') continue;

                // Coordinate-based "From Me" detection
                const isFromMe = data.is_from_me;
                // We save "From Me" messages for context, but ALWAYS skip AI for them.

                // Create a content hash ID
                const msgId = `scraped_${text.substring(0, 30).replace(/\s+/g, '_')}`;

                if (this.processedMessageIds.has(msgId)) continue;

                // Calculate timestamp for this message (interpolated for live monitor)
                const msgTimestamp = Math.floor(Date.now() / 1000) - (allMessages.length - i);

                // DB Persistence Check: Prevent re-processing on restart
                if (this.messageStore && this.messageStore.isDuplicate('instagram', threadId, text, msgTimestamp, isFromMe)) {
                    // Start tracking it as processed in memory so we don't check DB every loop
                    this.processedMessageIds.add(msgId);
                    continue;
                }

                this.processedMessageIds.add(msgId);

                // Skip AI for all messages except the very last one (assumed to be the new one)
                // This prevents the bot from replying to the entire chat history on load
                const isLastMessage = (i === allMessages.length - 1);

                const incomingMessage: IncomingMessage = {
                    platform: 'instagram',
                    chatId: threadId,
                    senderName: isFromMe ? 'You' : (this.currentThreadName || 'Instagram User'),
                    senderId: isFromMe ? 'me' : 'scraped_user',
                    content: text,
                    timestamp: msgTimestamp,
                    isFromMe: isFromMe,
                    messageType: data.type || 'text',
                    skipAI: isFromMe || !isLastMessage
                };

                this.emit('message', incomingMessage);
                console.log(`   📩 [IG] Scraped message (${i + 1}/${allMessages.length}): "${text.substring(0, 30)}..." (SkipAI=${!isLastMessage})`);
            }

        } catch (error: any) {
            // console.log(`   ⚠️ Error scraping messages: ${error.message}`);
        }
    }

    async stop(): Promise<void> {
        if (this.pollingInterval) clearInterval(this.pollingInterval);
        if (this.browser) await this.browser.close();
        this.isReady = false;
        console.log('📸 Instagram monitor stopped');
    }

    async sendMessage(threadId: string, content: string): Promise<boolean> {
        if (!this.page || !this.isReady) return false;

        try {
            console.log(`📸 Sending DM to thread ${threadId}...`);
            await this.page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'domcontentloaded' });

            // Wait for input selector
            const inputSelector = 'div[contenteditable="true"][role="textbox"]';

            try {
                await this.page.waitForSelector(inputSelector, { timeout: 10000 });
            } catch (e) {
                // Fallback selector
                console.log('Trying fallback selector...');
            }

            // Click focus
            await this.page.click(inputSelector);

            // Type message
            await this.page.type(inputSelector, content, { delay: 50 });

            // Press Enter
            await this.page.keyboard.press('Enter');

            // Wait a bit
            await new Promise(r => setTimeout(r, 2000));
            console.log('✅ Instagram DM sent!');
            return true;

        } catch (error: any) {
            console.error('❌ Failed to send Instagram DM:', error.message);
            return false;
        }
    }

    async getChatHistory(chatId: string, limit: number = 20): Promise<any[]> {
        const history = this.chatHistory.get(chatId) || [];
        // Map to standard format
        return history.slice(-limit).map(msg => ({
            content: msg.text,
            isFromMe: msg.is_from_me,
            senderName: msg.is_from_me ? 'You' : msg.user_id,
            timestamp: msg.timestamp / 1000,
            messageType: 'text'
        }));
    }
}
