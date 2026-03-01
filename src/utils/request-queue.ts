
export class RequestQueue {
    private queue: Array<() => Promise<void>> = [];
    private isProcessing = false;
    private delayMs: number;
    private temporaryDelayMs: number | null = null;

    constructor(delayMs: number = 4000) {
        this.delayMs = delayMs;
    }

    add(task: () => Promise<void>) {
        this.queue.push(task);
        this.processNext();
    }

    addFirst(task: () => Promise<void>) {
        this.queue.unshift(task);
        this.processNext();
    }

    pause(ms: number) {
        this.temporaryDelayMs = ms;
    }

    private async processNext() {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;
        const task = this.queue.shift();

        try {
            if (task) {
                console.log(`🚥 Processing queue item (${this.queue.length} remaining)...`);
                await task();
            }
        } catch (error) {
            console.error('Queue task failed:', error);
        } finally {
            // Determine delay (use temporary if set, then reset it)
            const delay = this.temporaryDelayMs !== null ? this.temporaryDelayMs : this.delayMs;
            this.temporaryDelayMs = null; // Reset after use

            // Wait for delay before processing next
            setTimeout(() => {
                this.isProcessing = false;
                this.processNext();
            }, delay);
        }
    }
}
