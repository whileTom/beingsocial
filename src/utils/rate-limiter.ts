import fs from 'fs';
import path from 'path';

interface KeyUsage {
    requestsToday: number;
    requestsThisMinute: number;
    lastResetDay: string;
    lastResetMinute: number;
}

interface RateLimitState {
    [key: string]: KeyUsage;
}

const STATE_FILE = path.join(__dirname, '..', '..', 'data', 'rate-limits.json');

export class RateLimiter {
    private state: RateLimitState = {};
    private dailyLimit: number;
    private minuteLimit: number;

    constructor(dailyLimit: number = 20, minuteLimit: number = 5) {
        this.dailyLimit = dailyLimit;
        this.minuteLimit = minuteLimit;
        this.loadState();
    }

    private loadState(): void {
        try {
            if (fs.existsSync(STATE_FILE)) {
                const data = fs.readFileSync(STATE_FILE, 'utf-8');
                this.state = JSON.parse(data);
            }
        } catch (error) {
            console.error('Error loading rate limit state:', error);
            this.state = {};
        }
    }

    private saveState(): void {
        try {
            const dataDir = path.dirname(STATE_FILE);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
        } catch (error) {
            console.error('Error saving rate limit state:', error);
        }
    }

    private getCurrentDay(): string {
        return new Date().toISOString().split('T')[0];
    }

    private getCurrentMinute(): number {
        return Math.floor(Date.now() / 60000);
    }

    private resetIfNeeded(keyId: string): void {
        if (!this.state[keyId]) {
            this.state[keyId] = {
                requestsToday: 0,
                requestsThisMinute: 0,
                lastResetDay: this.getCurrentDay(),
                lastResetMinute: this.getCurrentMinute(),
            };
        }

        const currentDay = this.getCurrentDay();
        const currentMinute = this.getCurrentMinute();

        // Reset daily counter if it's a new day
        if (this.state[keyId].lastResetDay !== currentDay) {
            this.state[keyId].requestsToday = 0;
            this.state[keyId].lastResetDay = currentDay;
        }

        // Reset minute counter if it's a new minute
        if (this.state[keyId].lastResetMinute !== currentMinute) {
            this.state[keyId].requestsThisMinute = 0;
            this.state[keyId].lastResetMinute = currentMinute;
        }
    }

    canUseKey(keyId: string): boolean {
        this.resetIfNeeded(keyId);

        const usage = this.state[keyId];
        return (
            usage.requestsToday < this.dailyLimit &&
            usage.requestsThisMinute < this.minuteLimit
        );
    }

    recordRequest(keyId: string): void {
        this.resetIfNeeded(keyId);

        this.state[keyId].requestsToday++;
        this.state[keyId].requestsThisMinute++;

        this.saveState();
    }

    getUsageStats(keyId: string): { daily: number; minute: number } {
        this.resetIfNeeded(keyId);
        return {
            daily: this.state[keyId].requestsToday,
            minute: this.state[keyId].requestsThisMinute,
        };
    }

    findAvailableKey(keyIds: string[]): string | null {
        // Find a key that can be used
        for (const keyId of keyIds) {
            if (this.canUseKey(keyId)) {
                return keyId;
            }
        }
        return null;
    }
}

export default RateLimiter;
