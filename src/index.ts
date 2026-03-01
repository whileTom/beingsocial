import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { initDatabase, MessageStore } from './database';
import { WhatsAppMonitor, IncomingMessage } from './monitors/whatsapp';
import { InstagramMonitor } from './monitors/instagram';
import { TelegramNotifier } from './notifications/telegram';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { generateResponses } from './ai';
import { RequestQueue } from './utils/request-queue';
import { InstagramScraperManager } from './scraper-manager';

dotenv.config();

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3005;

// Serve Dashboard
app.use(express.static(path.join(__dirname, 'dashboard', 'public')));
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard', 'public', 'index.html'));
});

// Initialize components
const db = initDatabase();
const messageStore = new MessageStore(db);
const whatsappMonitor = new WhatsAppMonitor();
const instagramMonitor = new InstagramMonitor(messageStore);
const telegramNotifier = new TelegramNotifier();
const scraperManager = new InstagramScraperManager(messageStore);

// Forward scraper events to all connected clients
scraperManager.on('status', (status) => {
    io.emit('scraper_status', status);
});
scraperManager.on('log', (message) => {
    io.emit('scraper_log', message);
});

// Track WhatsApp status
let whatsappReady = false;

// Rate Limiter Queue (4 seconds between AI calls to stay under 15 RPM)
const requestQueue = new RequestQueue(4000);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        whatsapp: whatsappReady ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString(),
    });
});

// API endpoint to get pending messages
app.get('/api/messages/pending', (req, res) => {
    const messages = messageStore.getUnprocessedMessages();
    res.json(messages);
});

// Debug API endpoint to view all threads from database
app.get('/api/debug/threads', (req, res) => {
    const threads = messageStore.getThreads();
    console.log(`📊 Debug API: Returning ${threads.length} threads`);
    res.json({
        count: threads.length,
        threads: threads
    });
});

// Socket.io Connection
io.on('connection', (socket) => {
    console.log('🔌 Dashboard connected');

    // Send last 50 messages to populate dashboard history
    const history = messageStore.getRecentMessages(50);
    // Reverse again if needed, but getRecentMessages returns oldest->newest usually?
    // Wait, DB Logic: ORDER BY timestamp DESC gives Newest first.
    // reverse() in DB util makes it Oldest first.
    // So we iterate and emit them in order of arrival.

    history.forEach((msg) => {
        socket.emit('new_message', {
            platform: msg.platform,
            senderName: msg.senderName,
            content: msg.content,
            timestamp: msg.timestamp,
            isFromMe: msg.isFromMe // Include so dashboard styles correctly
        });

    });

    // Request for thread list
    socket.on('get_threads', () => {
        const threads = messageStore.getThreads();
        socket.emit('threads_list', threads);
    });

    // Request for specific thread history
    socket.on('get_thread_messages', (data: { platform: string, chatId: string }) => {
        const messages = messageStore.getThreadMessages(data.platform, data.chatId);
        socket.emit('thread_history', {
            platform: data.platform,
            chatId: data.chatId,
            messages
        });
    });

    // Scraper control handlers
    socket.on('start_scraper', () => {
        console.log('📥 Dashboard requested scraper start');
        scraperManager.start();
    });

    socket.on('stop_scraper', () => {
        console.log('📥 Dashboard requested scraper stop');
        scraperManager.stop();
    });

    socket.on('get_scraper_status', () => {
        socket.emit('scraper_status', scraperManager.getStatus());
    });
});

// Handle incoming WhatsApp messages
whatsappMonitor.on('message', async (message: IncomingMessage) => {
    // Skip our own messages
    if (message.isFromMe) {
        console.log(`📤 Outgoing message to ${message.chatId}`);
        messageStore.addMessage(message);
        return;
    }

    console.log(`📩 New ${message.messageType} from ${message.senderName}`);
    if (message.messageType === 'text') {
        console.log(`   Content: ${message.content.substring(0, 50)}...`);
    }

    // Handle Audio Transcription
    if (message.messageType === 'audio' && message.mediaData) {
        try {
            // Import transcribeAudio dynamically (or add to imports at top)
            const { transcribeAudio } = require('./ai');
            console.log('🎤 Audio message detected, transcribing...');

            const transcription = await transcribeAudio(
                message.mediaData,
                message.mediaMimetype
            );

            console.log(`📝 Transcription: "${transcription}"`);

            // Update content with transcription for AI context
            message.content = `[Voice Message]: "${transcription}"`;

        } catch (error: any) {
            console.error('❌ Transcription failed:', error.message);
            // Keep original content "[Voice Message]"
        }
    }

    // Emit to dashboard
    io.emit('new_message', {
        platform: 'whatsapp',
        chatId: message.chatId,
        senderName: message.senderName,
        content: message.content,
        timestamp: Date.now(),
        isFromMe: message.isFromMe
    });

    // Store the message
    // Store the message
    const messageId = messageStore.addMessage(message);

    // Process in queue
    // Process in queue
    const processTask = async () => {
        try {
            // FILTER: Skip AI for "> You:" messages
            if (message.content.startsWith('> You:')) {
                console.log('🚫 Skipping AI generation for "> You:" message');
                return;
            }

            console.log('🤖 Generating AI responses...');

            // Fetch comprehensive history from DB (up to 50 messages)
            const dbHistory = messageStore.getConversationContext('whatsapp', message.chatId, 50);

            // Map to format expected by AI service
            const context = dbHistory.map(msg => ({
                content: msg.content,
                isFromMe: msg.isFromMe,
                senderName: msg.senderName,
                messageType: 'text' // DB schema defaults
            }));

            // Generate context summary for Telegram (last 3 messages)
            const recentHistory = dbHistory
                .filter(msg => msg.timestamp < message.timestamp)
                .slice(-3);

            const contextSummary = recentHistory.map(msg => {
                const name = msg.isFromMe ? 'You' : msg.senderName.split(' ')[0];
                return `_${name}_: ${msg.content.substring(0, 50)}${msg.content.length > 50 ? '...' : ''}`;
            }).join('\n');

            // Skip AI for multimedia (unless it's transcribed audio)
            if (message.messageType !== 'text' && !message.content.includes('[Voice Message]:')) {
                console.log(`⏩ Skipping AI for ${message.messageType} message`);
                await telegramNotifier.sendNotification({
                    messageId,
                    platform: message.platform,
                    senderName: message.senderName,
                    content: `[Received ${message.messageType}]: ${message.content}`,
                    contextSummary,
                    suggestions: []
                });
                return;
            }

            const { responses, provider } = await generateResponses(
                message.senderName,
                message.content,
                context
            );

            // Emit AI activity to dashboard
            if (responses) {
                io.emit('ai_response', {
                    recipient: message.senderName,
                    thought: `Generating for ${message.platform}...`,
                    response: responses.casual, // Show casual as preview
                    timestamp: Date.now()
                });
            }

            // Store suggestions
            const suggestions = [
                { style: 'casual' as const, content: responses.casual },
                { style: 'technical' as const, content: responses.technical },
                { style: 'transparent' as const, content: responses.transparent },
                { style: 'brief' as const, content: responses.brief },
                { style: 'detailed' as const, content: responses.detailed },
            ].map((s) => ({
                id: messageStore.addSuggestion({
                    messageId,
                    content: s.content,
                    style: s.style,
                    aiProvider: provider,
                }),
                ...s,
            }));

            // Send Telegram notification
            await telegramNotifier.sendNotification({
                messageId,
                platform: message.platform,
                senderName: message.senderName,
                content: message.content, // Now includes transcription
                contextSummary,
                suggestions,
            });

            console.log('📱 Notification sent to Telegram');
        } catch (error: any) {
            if (error.message === 'RATE_LIMIT_EXCEEDED') {
                console.log(`⏳ Rate limit hit for ${message.senderName}. Pausing queue for 60s and retrying...`);
                requestQueue.pause(60000);
                requestQueue.addFirst(processTask);
            } else {
                console.error('Error processing message:', error);
            }
        }
    };

    console.log(`📥 Queued message from ${message.senderName} (WhatsApp) for AI processing`);
    requestQueue.add(processTask);
});

// Handle incoming Instagram messages
instagramMonitor.on('message', async (message: IncomingMessage) => {
    console.log(`📸 New ${message.messageType} from ${message.senderName} (Instagram)`);

    // Emit to dashboard
    io.emit('new_message', {
        platform: 'instagram',
        chatId: message.chatId,
        senderName: message.senderName,
        content: message.content,
        timestamp: Date.now(),
        isFromMe: message.isFromMe
    });

    // Store the message
    const messageId = messageStore.addMessage(message);

    // Skip AI for our own messages
    if (message.isFromMe) {
        console.log(`📤 Outgoing message to ${message.chatId} (saved, no AI)`);
        return;
    }

    // Process in queue
    // Process in queue
    const processTask = async () => {
        try {
            if (message.skipAI) {
                console.log('⏩ Skipping AI generation for historical message');
                return;
            }

            // FILTER: Skip AI for self-referential messages
            if (message.content.startsWith('> You:') ||
                message.content.includes('You sent a photo') ||
                message.content.includes('You sent a voice message') ||
                message.content.includes('You sent an attachment')) {
                console.log('🚫 Skipping AI for self-referential message');
                return;
            }

            console.log(`🤖 Generating AI responses for Instagram... (Type: ${message.messageType})`);

            // Fetch history for AI context
            // Fetch history for AI context from DB
            const dbHistory = messageStore.getConversationContext('instagram', message.chatId, 50);

            const context = dbHistory.map(msg => ({
                content: msg.content,
                isFromMe: msg.isFromMe,
                senderName: msg.senderName,
                messageType: 'text'
            }));

            // Skip AI for multimedia
            if (message.messageType !== 'text' && !message.content.includes('[Voice Message]:')) {
                console.log(`⏩ Skipping AI for ${message.messageType} message: "${message.content}"`);
                await telegramNotifier.sendNotification({
                    messageId,
                    platform: message.platform,
                    senderName: message.senderName,
                    content: `[Received ${message.messageType}]: ${message.content}`,
                    suggestions: []
                });
                return;
            }

            const { responses, provider } = await generateResponses(
                message.senderName,
                message.content,
                context
            );

            // Emit AI activity to dashboard
            if (responses) {
                io.emit('ai_response', {
                    recipient: message.senderName,
                    thought: `Generating for ${message.platform}...`,
                    response: responses.casual, // Show casual as preview
                    timestamp: Date.now()
                });
            }

            // Store suggestions
            const suggestions = [
                { style: 'casual' as const, content: responses.casual },
                { style: 'technical' as const, content: responses.technical },
                { style: 'transparent' as const, content: responses.transparent },
                { style: 'brief' as const, content: responses.brief },
                { style: 'detailed' as const, content: responses.detailed },
            ].map((s) => ({
                id: messageStore.addSuggestion({
                    messageId,
                    content: s.content,
                    style: s.style,
                    aiProvider: provider,
                }),
                ...s,
            }));

            // Send Telegram notification
            await telegramNotifier.sendNotification({
                messageId,
                platform: message.platform,
                senderName: message.senderName,
                content: message.content,
                suggestions,
            });

            console.log('📱 Instagram Notification sent to Telegram');
        } catch (error: any) {
            if (error.message === 'RATE_LIMIT_EXCEEDED') {
                console.log(`⏳ Rate limit hit for ${message.senderName} (IG). Pausing queue for 60s and retrying...`);
                requestQueue.pause(60000);
                requestQueue.addFirst(processTask);
            } else {
                console.error('Error processing Instagram message:', error);
            }
        }
    };

    console.log(`📥 Queued message from ${message.senderName} (Instagram) for AI processing`);
    requestQueue.add(processTask);
});

// Handle Telegram actions
telegramNotifier.setActionCallback(async (messageId, action, suggestionId, customText) => {
    console.log(`📲 Action received: ${action} for message ${messageId}`);

    if (action === 'skip') {
        messageStore.recordAction({
            messageId,
            actionType: 'skipped',
        });
        messageStore.markAsProcessed(messageId);
        return;
    }

    if (action === 'regenerate') {
        // Get the original message
        const messages = messageStore.getUnprocessedMessages();
        const originalMessage = messages.find((m) => m.id === messageId);
        if (!originalMessage) return;

        const context = messageStore.getConversationContext(
            originalMessage.platform,
            originalMessage.chatId,
            10
        );

        const { responses, provider } = await generateResponses(
            originalMessage.senderName,
            originalMessage.content,
            context
        );

        const suggestions = [
            { style: 'casual' as const, content: responses.casual },
            { style: 'technical' as const, content: responses.technical },
            { style: 'transparent' as const, content: responses.transparent },
            { style: 'brief' as const, content: responses.brief },
            { style: 'detailed' as const, content: responses.detailed },
        ].map((s) => ({
            id: messageStore.addSuggestion({
                messageId,
                content: s.content,
                style: s.style,
                aiProvider: provider,
            }),
            ...s,
        }));

        await telegramNotifier.sendNotification({
            messageId,
            platform: originalMessage.platform,
            senderName: originalMessage.senderName,
            content: originalMessage.content,
            suggestions,
        });
        return;
    }

    if (action === 'approve') {
        // Get the response to send
        let responseText: string;

        if (customText) {
            responseText = customText;
            messageStore.recordAction({
                messageId,
                actionType: 'custom',
                finalResponse: responseText,
            });
        } else if (suggestionId) {
            const suggestions = messageStore.getSuggestionsForMessage(messageId);
            const suggestion = suggestions.find((s) => s.id === suggestionId);
            if (!suggestion) return;

            responseText = suggestion.content;
            messageStore.recordAction({
                messageId,
                suggestionId,
                actionType: 'approved',
                finalResponse: responseText,
            });
        } else {
            return;
        }

        // Get the original message to find the chat ID
        const messages = messageStore.getUnprocessedMessages();
        const originalMessage = messages.find((m) => m.id === messageId);
        if (!originalMessage) return;

        // Send the message based on platform
        let success = false;
        if (originalMessage.platform === 'whatsapp') {
            success = await whatsappMonitor.sendMessage(
                originalMessage.chatId,
                responseText
            );
        } else if (originalMessage.platform === 'instagram') {
            success = await instagramMonitor.sendMessage(
                originalMessage.chatId,
                responseText
            );
        }

        if (success) {
            messageStore.markAsProcessed(messageId);
        }
    }
});

// Track WhatsApp connection status
whatsappMonitor.on('ready', () => {
    whatsappReady = true;
});

whatsappMonitor.on('disconnected', () => {
    whatsappReady = false;
});

// Start everything
async function main() {
    console.log('🚀 Starting Being Social...\n');

    // Start Server
    httpServer.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📊 Dashboard available at http://localhost:${PORT}/dashboard`);
    });

    // Start Telegram bot
    await telegramNotifier.start();

    // Start Whatsapp monitor (this will show QR code)
    await whatsappMonitor.start();

    // Start Instagram monitor
    await instagramMonitor.start();

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n👋 Shutting down...');
        await whatsappMonitor.stop();
        await instagramMonitor.stop();
        await telegramNotifier.stop();
        db.close();
        process.exit(0);
    });
}

main().catch(console.error);
