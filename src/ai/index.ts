import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { RateLimiter } from '../utils/rate-limiter';
import { PERSONA, STYLE_GUIDE } from './persona';

dotenv.config();

export interface AIResponse {
    casual: string;
    technical: string;
    transparent: string;
    brief: string;
    detailed: string;
}

export interface ConversationMessage {
    content: string;
    isFromMe: boolean;
    senderName?: string;
    messageType?: string;
}

// Available Gemini models for text generation
const GEMINI_MODELS = [
    'gemini-2.5-flash-lite', // 10 RPM
    'gemini-2.5-flash',      // 5 RPM
];

// Model specifically for audio transcription (Multimodal)
const GEMINI_AUDIO_MODEL = 'gemini-2.5-flash-tts';

// Track backoff state for each key
interface BackoffState {
    lastError: number;
    backoffMs: number;
}

const keyBackoffState: Map<string, BackoffState> = new Map();
const MIN_BACKOFF_MS = 5000;      // 5 seconds initial backoff
const MAX_BACKOFF_MS = 300000;    // 5 minutes max backoff

// Use the imported PERSONA and STYLE_GUIDE
const SYSTEM_PROMPT = `${PERSONA}
*** IMPORTANT INSTRUCTIONS ***
1. You are NOT an AI assistant. You ARE the PERSONA defined above.
2. Do NOT use robotic phrases like "I understand", "Certainly", "Here are suggestions".
3. ADHERE STRICTLY to the "Anti-Robot Protocol" in the persona definition.
4. TEXT like a real person on a phone. Typos, lowercase, and fragments are encouraged for 'casual' style.
5. Your goal is to build rapport and keep the conversation going, not "assist" the user.

Guide for styles:
- CASUAL: ${STYLE_GUIDE.casual}
- TECHNICAL: ${STYLE_GUIDE.technical}
- TRANSPARENT: ${STYLE_GUIDE.transparent}
- BRIEF: ${STYLE_GUIDE.brief}
- DETAILED: ${STYLE_GUIDE.detailed}
`;

function buildPrompt(
    senderName: string,
    incomingMessage: string,
    context: ConversationMessage[]
): string {
    let contextStr = '';
    if (context.length > 0) {
        contextStr = 'Recent conversation (oldest to newest):\n' + context
            .map(m => {
                const sender = m.isFromMe ? 'You (the PERSONA)' : (m.senderName || senderName);
                const content = m.messageType === 'audio' ? '[Voice Message Transcription]: ' + m.content : m.content;
                return `${sender}: ${content}`;
            })
            .join('\n') + '\n\n';
    }

    return `${contextStr}Latest message from ${senderName}: "${incomingMessage}"

Generate 5 response options based on the PERSONA:
1. CASUAL: Lowercase, friendly, slang
2. TECHNICAL: Precise, analytical, correct terminology
3. TRANSPARENT: Direct, honest about intentions
4. BRIEF: Binary or emoji
5. DETAILED: Thorough, grounded in logic

Format your response exactly as:
CASUAL: [response]
TECHNICAL: [response]
TRANSPARENT: [response]
BRIEF: [response]
DETAILED: [response]`;
}

function parseResponses(text: string): AIResponse {
    const casualMatch = text.match(/CASUAL:\s*(.+?)(?=TECHNICAL:|$)/s);
    const technicalMatch = text.match(/TECHNICAL:\s*(.+?)(?=TRANSPARENT:|$)/s);
    const transparentMatch = text.match(/TRANSPARENT:\s*(.+?)(?=BRIEF:|$)/s);
    const briefMatch = text.match(/BRIEF:\s*(.+?)(?=DETAILED:|$)/s);
    const detailedMatch = text.match(/DETAILED:\s*(.+?)$/s);

    return {
        casual: casualMatch?.[1]?.trim() || 'Sounds good!',
        technical: technicalMatch?.[1]?.trim() || 'Acknowledged.',
        transparent: transparentMatch?.[1]?.trim() || 'I want to be clear about my intentions.',
        brief: briefMatch?.[1]?.trim() || '👍',
        detailed: detailedMatch?.[1]?.trim() || 'Thanks for letting me know, I appreciate the update.',
    };
}

// Parse Gemini API keys from environment (cached)
let geminiKeysCache: string[] | null = null;

function getGeminiKeys(): string[] {
    if (geminiKeysCache) return geminiKeysCache;

    const keys: string[] = [];

    // Try GEMINI_API_KEYS first (comma-separated)
    const commaKeys = (process.env.GEMINI_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
    if (commaKeys.length > 0) {
        keys.push(...commaKeys);
    } else {
        // Fall back to numbered keys
        for (let i = 1; i <= 10; i++) {
            const key = process.env[`GEMINI_API_KEY_${i}`];
            if (key && key.trim()) {
                keys.push(key.trim());
            }
        }
    }

    console.log(`🔑 Loaded ${keys.length} Gemini API keys and ${GEMINI_MODELS.length} models`);
    geminiKeysCache = keys;
    return keys;
}

// Rate limiter instance
const rateLimiter = new RateLimiter(
    parseInt(process.env.GEMINI_DAILY_LIMIT || '20'),
    parseInt(process.env.GEMINI_MINUTE_LIMIT || '5')
);

// Track rotation indices
let currentKeyIndex = 0;
let currentModelIndex = 0;

// Check if a key is in backoff
function isKeyInBackoff(keyId: string): boolean {
    const state = keyBackoffState.get(keyId);
    if (!state) return false;

    const timeSinceError = Date.now() - state.lastError;
    if (timeSinceError >= state.backoffMs) {
        // Backoff period expired, reset
        keyBackoffState.delete(keyId);
        return false;
    }

    return true;
}

// Record an error for a key (exponential backoff)
function recordKeyError(keyId: string): void {
    const existing = keyBackoffState.get(keyId);
    const newBackoff = existing
        ? Math.min(existing.backoffMs * 2, MAX_BACKOFF_MS)
        : MIN_BACKOFF_MS;

    keyBackoffState.set(keyId, {
        lastError: Date.now(),
        backoffMs: newBackoff,
    });
    // Silent backoff - don't spam console
    // console.log(`⏳ ${keyId} in backoff for ${newBackoff / 1000}s`);
}

// Find an available key-model combination
function findAvailableKeyModel(): { apiKey: string; model: string; keyId: string } | null {
    const keys = getGeminiKeys();
    const totalCombinations = keys.length * GEMINI_MODELS.length;

    for (let attempt = 0; attempt < totalCombinations; attempt++) {
        const keyIndex = (currentKeyIndex + Math.floor(attempt / GEMINI_MODELS.length)) % keys.length;
        const modelIndex = (currentModelIndex + attempt) % GEMINI_MODELS.length;

        const keyId = `key${keyIndex}-${GEMINI_MODELS[modelIndex]}`;

        // Check rate limits and backoff
        if (!rateLimiter.canUseKey(keyId)) {
            continue;
        }

        if (isKeyInBackoff(keyId)) {
            continue;
        }

        // Found an available combination!
        return {
            apiKey: keys[keyIndex],
            model: GEMINI_MODELS[modelIndex],
            keyId,
        };
    }

    return null;
}

// Advance to next key-model combination
function advanceToNextCombination(): void {
    currentModelIndex = (currentModelIndex + 1) % GEMINI_MODELS.length;
    if (currentModelIndex === 0) {
        currentKeyIndex = (currentKeyIndex + 1) % getGeminiKeys().length;
    }
}

// Transcribe audio using Gemini
export async function transcribeAudio(
    audioData: string,
    mimeType: string = 'audio/ogg'
): Promise<string> {
    const keys = getGeminiKeys();
    // For audio, we just need ANY valid key, but we always use the audio model
    let selectedKey: string | null = null;
    let keyIdString = '';

    // Find a key not in backoff
    for (let i = 0; i < keys.length; i++) {
        const kId = `transcribe-key${i}`;
        if (!isKeyInBackoff(kId)) {
            selectedKey = keys[i];
            keyIdString = kId;
            break;
        }
    }

    if (!selectedKey) {
        selectedKey = keys[0];
        keyIdString = 'transcribe-key0';
    }

    const transcriptionModel = GEMINI_AUDIO_MODEL;
    console.log(`🎤 Transcribing using ${keyIdString} (${transcriptionModel})...`);

    try {
        const ai = new GoogleGenAI({ apiKey: selectedKey });

        const response = await ai.models.generateContent({
            model: transcriptionModel,
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: "Transcribe this voice message exactly as spoken." },
                        {
                            inlineData: {
                                mimeType: mimeType,
                                data: audioData
                            }
                        }
                    ]
                }
            ]
        });

        const text = response.text || '[Audio Transcription Failed]';
        return text;
    } catch (error: any) {
        console.error(`❌ Transcription failed:`, error.message);
        recordKeyError(keyIdString);
        throw error;
    }
}

async function generateResponsesGemini(
    senderName: string,
    incomingMessage: string,
    context: ConversationMessage[]
): Promise<{ responses: AIResponse; keyId: string; model: string }> {
    const MAX_RETRIES = 5;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const available = findAvailableKeyModel();

        if (!available) {
            const nextAvailable = Math.min(
                ...Array.from(keyBackoffState.values()).map(s => s.lastError + s.backoffMs - Date.now())
            );

            if (attempt === 1) {
                throw new Error(`All Gemini keys are rate limited. Next key available in ${Math.ceil(Math.max(nextAvailable, 1000) / 1000)}s`);
            }

            console.log('⏳ No available keys, waiting 2s...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
        }

        const { apiKey, model, keyId } = available;
        const prompt = `${SYSTEM_PROMPT}\n\n${buildPrompt(senderName, incomingMessage, context)}`;

        // Silent retry - only log on final attempt
        // console.log(`🤖 Trying ${keyId} (Attempt ${attempt}/${MAX_RETRIES})...`);

        try {
            const ai = new GoogleGenAI({ apiKey });

            const response = await ai.models.generateContent({
                model,
                contents: prompt,
            });

            const text = response.text || '';

            rateLimiter.recordRequest(keyId);
            keyBackoffState.delete(keyId);

            const stats = rateLimiter.getUsageStats(keyId);
            console.log(`✅ ${keyId}: ${stats.minute} RPM, ${stats.daily} RPD`);

            advanceToNextCombination();

            return {
                responses: parseResponses(text),
                keyId,
                model,
            };
        } catch (error: any) {
            // Suppress individual failure logs - only log on final failure
            // console.error(`❌ ${keyId} failed:`, error.message?.substring(0, 100));
            lastError = error;
            recordKeyError(keyId);
            advanceToNextCombination();
        }
    }

    throw lastError || new Error('Failed to generate responses after multiple attempts');
}

async function generateResponsesOpenAI(
    senderName: string,
    incomingMessage: string,
    context: ConversationMessage[]
): Promise<AIResponse> {
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await openai.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildPrompt(senderName, incomingMessage, context) },
        ],
        temperature: 0.7,
        max_tokens: 500,
    });

    const text = response.choices[0]?.message?.content || '';
    return parseResponses(text);
}

async function generateResponsesAnthropic(
    senderName: string,
    incomingMessage: string,
    context: ConversationMessage[]
): Promise<AIResponse> {
    const anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const response = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [
            { role: 'user', content: buildPrompt(senderName, incomingMessage, context) },
        ],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    return parseResponses(text);
}

export async function generateResponses(
    senderName: string,
    incomingMessage: string,
    context: ConversationMessage[]
): Promise<{ responses: AIResponse; provider: string }> {
    // Try Gemini first (it's free)
    const geminiKeys = getGeminiKeys();
    if (geminiKeys.length > 0) {
        try {
            const result = await generateResponsesGemini(senderName, incomingMessage, context);
            return {
                responses: result.responses,
                provider: `gemini (${result.model})`
            };
        } catch (error: any) {
            console.log(`⚠️ Gemini unavailable: ${error.message?.substring(0, 50)}`);
        }
    }

    // Fall back to OpenAI
    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key_here') {
        try {
            console.log('🤖 Falling back to OpenAI...');
            const responses = await generateResponsesOpenAI(senderName, incomingMessage, context);
            return { responses, provider: 'openai' };
        } catch (error: any) {
            console.log(`⚠️ OpenAI unavailable: ${error.message?.substring(0, 50)}`);
        }
    }

    // Fall back to Anthropic
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here') {
        try {
            console.log('🤖 Falling back to Anthropic...');
            const responses = await generateResponsesAnthropic(senderName, incomingMessage, context);
            return { responses, provider: 'anthropic' };
        } catch (error: any) {
            console.log(`⚠️ Anthropic unavailable: ${error.message?.substring(0, 50)}`);
        }
    }

    console.error('❌ All AI providers are unavailable or rate limited.');
    throw new Error('RATE_LIMIT_EXCEEDED');
}

export default { generateResponses, transcribeAudio };
