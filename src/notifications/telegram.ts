import { Telegraf, Context, Markup } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

export interface NotificationPayload {
    messageId: number;
    platform: string;
    senderName: string;
    content: string;
    contextSummary?: string;
    suggestions: Array<{
        id: number;
        style: string;
        content: string;
    }>;
}

export type ActionCallback = (
    messageId: number,
    action: 'approve' | 'skip' | 'regenerate',
    suggestionId?: number,
    customText?: string
) => Promise<void>;

export class TelegramNotifier {
    private bot: Telegraf;
    private chatId: string;
    private actionCallback?: ActionCallback;
    private pendingEdits: Map<number, { messageId: number; platform: string }> = new Map();

    constructor() {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) {
            throw new Error('TELEGRAM_BOT_TOKEN is required');
        }

        this.bot = new Telegraf(token);
        this.chatId = process.env.TELEGRAM_CHAT_ID || '';

        this.setupHandlers();
    }

    private setupHandlers(): void {
        // Command to get chat ID (must be before text handler!)
        this.bot.command('start', async (ctx) => {
            console.log('📩 Received /start command from', ctx.from?.username || ctx.from?.id);
            await ctx.reply(
                `👋 Welcome to Being Social!\n\nYour Chat ID is: \`${ctx.chat.id}\`\n\nAdd this to your .env file as TELEGRAM_CHAT_ID`,
                { parse_mode: 'Markdown' }
            );
        });

        // Status command
        this.bot.command('status', async (ctx) => {
            console.log('📩 Received /status command');
            await ctx.reply('🟢 Bot is running and monitoring messages');
        });

        // Handle callback queries from inline buttons
        this.bot.on('callback_query', async (ctx) => {
            const data = (ctx.callbackQuery as any).data;
            if (!data) return;

            const [action, messageId, suggestionId] = data.split(':');

            if (action === 'approve' && this.actionCallback) {
                await this.actionCallback(parseInt(messageId), 'approve', parseInt(suggestionId));
                await ctx.answerCbQuery('✅ Response sent!');
                await ctx.editMessageText('✅ Response approved and sent!');
            } else if (action === 'skip' && this.actionCallback) {
                await this.actionCallback(parseInt(messageId), 'skip');
                await ctx.answerCbQuery('⏭️ Skipped');
                await ctx.editMessageText('⏭️ Message skipped');
            } else if (action === 'regenerate' && this.actionCallback) {
                await this.actionCallback(parseInt(messageId), 'regenerate');
                await ctx.answerCbQuery('🔄 Regenerating...');
            } else if (action === 'edit') {
                this.pendingEdits.set(ctx.from!.id, {
                    messageId: parseInt(messageId),
                    platform: 'whatsapp',
                });
                await ctx.answerCbQuery('✏️ Send your custom response');
                await ctx.reply('✏️ Type your custom response:');
            }
        });

        // Handle text messages (for custom responses) - MUST be after commands!
        this.bot.on('text', async (ctx) => {
            const pending = this.pendingEdits.get(ctx.from.id);
            if (pending && this.actionCallback) {
                await this.actionCallback(pending.messageId, 'approve', undefined, ctx.message.text);
                this.pendingEdits.delete(ctx.from.id);
                await ctx.reply('✅ Custom response sent!');
            }
        });
    }

    setActionCallback(callback: ActionCallback): void {
        this.actionCallback = callback;
    }

    async start(): Promise<void> {
        console.log('🤖 Starting Telegram bot...');

        // Use Telegraf's internal telegram client to verify connection
        try {
            const me = await this.bot.telegram.getMe();
            console.log(`✅ Telegram bot connected as @${me.username}`);
        } catch (error) {
            console.error('❌ Failed to connect to Telegram:', error);
            return;
        }

        // Launch in background (non-blocking)
        this.bot.launch({
            dropPendingUpdates: true,
        });

        // Graceful shutdown
        process.once('SIGINT', () => this.bot.stop('SIGINT'));
        process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
    }

    async stop(): Promise<void> {
        this.bot.stop('SIGTERM');
    }

    async sendNotification(payload: NotificationPayload): Promise<void> {
        if (!this.chatId) {
            console.error('TELEGRAM_CHAT_ID not set');
            return;
        }

        // Escape markdown special characters in user-generated content
        const escapeMarkdown = (text: string): string => {
            return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
        };

        const platformEmoji = payload.platform === 'whatsapp' ? '💬' : '📸';
        const safeSenderName = escapeMarkdown(payload.senderName);
        const safeContent = escapeMarkdown(payload.content);

        let message = `${platformEmoji} **New message from ${safeSenderName}**\n\n`;
        message += `> ${safeContent}\n\n`;

        if (payload.contextSummary) {
            message += `**Context:**\n${payload.contextSummary}\n\n`;
        }

        console.log(`[DEBUG] Sending Telegram notification with ${payload.suggestions.length} suggestions`);

        if (payload.suggestions.length > 0) {
            message += `**Suggested responses:**\n\n`;
        } else {
            message += `_(No AI suggestions available)_\n\n`;
        }

        // Build inline keyboard with response options
        const buttons: any[][] = [];

        payload.suggestions.forEach((suggestion, index) => {
            let styleEmoji = '⚡';
            switch (suggestion.style) {
                case 'casual': styleEmoji = '😊'; break;
                case 'technical': styleEmoji = '🤓'; break;
                case 'transparent': styleEmoji = '🤝'; break;
                case 'brief': styleEmoji = '⚡'; break;
                case 'detailed': styleEmoji = '📝'; break;
            }
            message += `${styleEmoji} **${suggestion.style}**: ${escapeMarkdown(suggestion.content)}\n\n`;

            buttons.push([
                Markup.button.callback(
                    `${styleEmoji} Send ${suggestion.style}`,
                    `approve:${payload.messageId}:${suggestion.id}`
                ),
            ]);
        });

        // Add action buttons
        buttons.push([
            Markup.button.callback('✏️ Edit', `edit:${payload.messageId}`),
            Markup.button.callback('🔄 Regenerate', `regenerate:${payload.messageId}`),
            Markup.button.callback('⏭️ Skip', `skip:${payload.messageId}`),
        ]);

        await this.bot.telegram.sendMessage(
            this.chatId,
            message,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons),
            }
        );
    }
}

export default TelegramNotifier;
