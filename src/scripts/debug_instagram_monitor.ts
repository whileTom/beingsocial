import { InstagramMonitor } from '../monitors/instagram';
import dotenv from 'dotenv';
import path from 'path';

// Load env
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function run() {
    console.log('Starting standalone Instagram Monitor...');

    const monitor = new InstagramMonitor();

    monitor.on('new_message', (data) => {
        console.log('\n✨ NEW MESSAGE EVENT ✨');
        console.log(JSON.stringify(data, null, 2));
    });

    try {
        await monitor.start();
        console.log('Monitor started. Waiting for logs...');

        // Keep alive
        setInterval(() => { }, 10000);
    } catch (e) {
        console.error('Failed to start:', e);
    }
}

run();
