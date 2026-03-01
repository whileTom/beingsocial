import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { EventEmitter } from 'events';

export type MessageType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location' | 'contact' | 'unknown';

export interface IncomingMessage {
    platform: 'whatsapp' | 'instagram';
    chatId: string;
    senderName: string;
    senderId: string;
    content: string;
    timestamp: number;
    isFromMe: boolean;
    messageType: string; // Relaxed type to allow flexible mapping
    mediaData?: string;
    mediaMimetype?: string;
    mediaFilename?: string;
    skipAI?: boolean;
}

export class WhatsAppMonitor extends EventEmitter {
    private client: Client;
    private isReady: boolean = false;

    constructor() {
        super();

        this.client = new Client({
            authStrategy: new LocalAuth({
                dataPath: '.wwebjs_auth',
            }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            },
        });

        this.setupEventHandlers();
    }

    private setupEventHandlers(): void {
        this.client.on('qr', (qr: string) => {
            console.log('\n📱 Scan this QR code with WhatsApp:\n');
            qrcode.generate(qr, { small: true });
            this.emit('qr', qr);
        });

        this.client.on('ready', async () => {
            console.log('✅ WhatsApp client is ready!');
            this.isReady = true;
            this.emit('ready');

            // Apply patches to fix known WWebJS bugs
            try {
                console.log('🩹 Applying WWebJS patches...');
                // @ts-ignore
                await this.client.pupPage.evaluate(() => {
                    // Patch 1: Fix sendSeen undefined check
                    // @ts-ignore
                    const win = window;

                    if (win.WWebJS) {
                        const originalSendSeen = win.WWebJS.sendSeen;
                        win.WWebJS.sendSeen = async function (chatId: string) {
                            try {
                                // Check if chat exists first
                                const chat = win.Store.Chat.get(chatId);
                                if (!chat) return false;

                                // Perform original logic safely
                                if (chat.markedUnread) {
                                    await win.Store.ReadSeen.markRead(chatId);
                                } else if (chat.unreadCount > 0) {
                                    await win.Store.ReadSeen.markSeen(chatId);
                                }
                                return true;
                            } catch (err) {
                                console.error('Safe sendSeen failed:', err);
                                return false;
                            }
                        };
                    }
                });
                console.log('✅ WWebJS patches applied successfully');
            } catch (err) {
                console.error('❌ Failed to apply WWebJS patches:', err);
            }
        });

        this.client.on('authenticated', () => {
            console.log('🔐 WhatsApp authenticated successfully');
            this.emit('authenticated');
        });

        this.client.on('auth_failure', (msg: string) => {
            console.error('❌ WhatsApp authentication failed:', msg);
            this.emit('auth_failure', msg);
        });

        this.client.on('disconnected', (reason: string) => {
            console.log('📴 WhatsApp disconnected:', reason);
            this.isReady = false;
            this.emit('disconnected', reason);
        });

        this.client.on('message', async (message: Message) => {
            try {
                // Ignore messages older than 60 seconds (prevents ghost messages on startup)
                const now = Math.floor(Date.now() / 1000);
                const msgTimestamp = message.timestamp;
                const age = now - msgTimestamp;

                console.log(`[DEBUG] Message received. ID: ${message.id._serialized}, TS: ${msgTimestamp}, Now: ${now}, Age: ${age}s`);

                if (msgTimestamp && (age > 60)) {
                    console.log(`👻 Ignoring old message from ${message.from} (${age}s old)`);
                    return;
                }

                // Ignore status updates
                if (message.from === 'status@broadcast') {
                    console.log('👻 Ignoring status update');
                    return;
                }

                const chat = await message.getChat();
                const contact = await message.getContact();

                // Determine message type
                let messageType: MessageType = 'text';
                let content = message.body || '';
                let mediaData: string | undefined;
                let mediaMimetype: string | undefined;
                let mediaFilename: string | undefined;

                if (message.hasMedia) {
                    try {
                        const media = await message.downloadMedia();
                        if (media) {
                            mediaData = media.data;
                            mediaMimetype = media.mimetype;
                            mediaFilename = media.filename || undefined;

                            // Determine type from mimetype
                            if (media.mimetype.startsWith('image/')) {
                                messageType = 'image';
                                content = content || '[Image]';
                            } else if (media.mimetype.startsWith('audio/')) {
                                messageType = 'audio';
                                content = content || '[Voice Message]';
                            } else if (media.mimetype.startsWith('video/')) {
                                messageType = 'video';
                                content = content || '[Video]';
                            } else if (media.mimetype === 'image/webp') {
                                messageType = 'sticker';
                                content = '[Sticker]';
                            } else {
                                messageType = 'document';
                                content = content || `[Document: ${media.filename || 'file'}]`;
                            }
                        }
                    } catch (mediaError) {
                        console.error('Error downloading media:', mediaError);
                        content = '[Media - failed to download]';
                        messageType = 'unknown';
                    }
                } else if (message.type === 'location') {
                    messageType = 'location';
                    content = `[Location: ${message.location?.latitude}, ${message.location?.longitude}]`;
                } else if (message.type === 'vcard' || message.type === 'multi_vcard') {
                    messageType = 'contact';
                    content = '[Contact Card]';
                } else if (!content) {
                    messageType = 'unknown';
                    content = `[${message.type || 'Unknown'} message]`;
                }

                const incomingMessage: IncomingMessage = {
                    platform: 'whatsapp',
                    chatId: chat.id._serialized,
                    senderName: contact.pushname || contact.name || contact.number,
                    senderId: contact.id._serialized,
                    content,
                    timestamp: message.timestamp,
                    isFromMe: message.fromMe,
                    messageType,
                    mediaData,
                    mediaMimetype,
                    mediaFilename,
                };

                this.emit('message', incomingMessage);
            } catch (error) {
                console.error('Error processing message:', error);
            }
        });
    }

    async start(): Promise<void> {
        console.log('🚀 Starting WhatsApp monitor...');
        await this.client.initialize();
    }

    async stop(): Promise<void> {
        console.log('🛑 Stopping WhatsApp monitor...');
        await this.client.destroy();
        this.isReady = false;
    }

    async sendMessage(chatId: string, content: string): Promise<boolean> {
        if (!this.isReady) {
            console.error('WhatsApp client is not ready');
            return false;
        }

        console.log(`[DEBUG] Attempting to send message to ${chatId}`);

        // Retry up to 3 times with small delays
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                // Try to get chat first to verify it exists
                const chat = await this.client.getChatById(chatId);
                console.log(`[DEBUG] Chat found: ${chat.name} (${chat.id._serialized})`);

                // Send using client.sendMessage which is the most direct method
                // We await it to catch errors
                const msg = await this.client.sendMessage(chatId, content);
                console.log(`✉️ Message sent to ${chatId} (ID: ${msg.id._serialized})`);
                return true;
            } catch (error: any) {
                console.error(`[ERROR] Send attempt ${attempt}/3 failed:`);
                console.error(`Error name: ${error.name}`);
                console.error(`Error message: ${error.message}`);
                if (error.stack) console.error(`Stack trace: ${error.stack}`);

                if (attempt < 3) {
                    const delay = 1000 * Math.pow(2, attempt - 1);
                    console.log(`[DEBUG] Waiting ${delay}ms before retry...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        console.error('❌ Failed to send message after 3 attempts');
        return false;
    }

    async getChatHistory(chatId: string, limit: number = 20): Promise<IncomingMessage[]> {
        if (!this.isReady) return [];

        try {
            const chat = await this.client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit });

            return Promise.all(messages.map(async (msg) => {
                let contact;
                // WWebJS crashes if id/author is missing when calling getContact
                if (!msg.author && !msg.from) {
                    contact = {
                        pushname: 'Unknown',
                        name: 'Unknown',
                        number: 'Unknown',
                        id: { _serialized: 'unknown' }
                    } as any;
                } else {
                    try {
                        contact = await msg.getContact();
                    } catch (err) {
                        // Fallback if getContact fails (common in WWebJS)
                        contact = {
                            pushname: 'Unknown',
                            name: 'Unknown',
                            number: 'Unknown',
                            id: { _serialized: msg.author || msg.from }
                        } as any;
                    }
                }

                let content = msg.body;
                let messageType = 'text';

                if (msg.hasMedia) {
                    messageType = 'media';
                    content = '[Media]';
                    if (msg.type === 'ptt' || msg.type === 'audio') {
                        messageType = 'audio';
                        content = '[Voice Message]';
                    }
                }

                return {
                    platform: 'whatsapp',
                    chatId,
                    senderName: contact.pushname || contact.name || contact.number || 'Unknown',
                    senderId: contact.id?._serialized || 'unknown',
                    content,
                    timestamp: msg.timestamp,
                    isFromMe: msg.fromMe,
                    messageType,
                } as IncomingMessage;
            }));
        } catch (error) {
            console.error('Error fetching chat history:', error);
            return [];
        }
    }

    getStatus(): { ready: boolean } {
        return { ready: this.isReady };
    }
}

export default WhatsAppMonitor;
