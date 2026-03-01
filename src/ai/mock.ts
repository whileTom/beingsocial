
import { AIResponse } from './index';

export function getMockResponses(content: string): AIResponse {
    const lower = content.toLowerCase();

    // Basic context-aware fallback templates
    if (lower.includes('haha') || lower.includes('lol')) {
        return {
            casual: 'haha right?',
            technical: 'Humorous observation acknowledged.',
            transparent: 'I genuinely laughed at that.',
            brief: '😂',
            detailed: 'That is quite funny, I must admit.'
        };
    }

    if (lower.includes('?') || lower.includes('what') || lower.includes('where')) {
        return {
            casual: 'good question hmm',
            technical: 'I require more data to answer.',
            transparent: 'I\'m not sure about that yet.',
            brief: '🤔',
            detailed: 'That involves a few factors, let me think.'
        };
    }

    if (lower.includes('sleep') || lower.includes('tired') || lower.includes('night')) {
        return {
            casual: 'get some rest!',
            technical: 'Sleep is essential for recovery.',
            transparent: 'I hope you sleep well.',
            brief: '😴',
            detailed: 'Optimizing your sleep schedule is important.'
        };
    }

    // Generic Fallback
    return {
        casual: 'oh really?',
        technical: 'Message received and processed.',
        transparent: 'I hear you.',
        brief: '👍',
        detailed: 'That is an interesting point you make.'
    };
}
