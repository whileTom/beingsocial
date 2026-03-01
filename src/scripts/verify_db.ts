import { initDatabase } from '../database';

const db = initDatabase();

console.log('--- Verifying Message Timestamps ---');

try {
    const row = db.prepare(`
        SELECT text, sender_name, timestamp, datetime(timestamp, 'unixepoch', 'localtime') as pretty_time
        FROM messages 
        WHERE platform = 'instagram'
        ORDER BY timestamp DESC
        LIMIT 1
    `).get() as any;

    if (row) {
        console.log(`✅ Latest Message Found:`);
        console.log(`   Text: "${row.text?.substring(0, 50)}..."`);
        console.log(`   Sender: ${row.sender_name}`);
        console.log(`   Timestamp: ${row.timestamp} (${row.pretty_time})`);

        // Validation
        if (row.timestamp > 0 && row.timestamp < Date.now() / 1000 + 3600) {
            console.log('   RESULT: Timestamp looks VALID.');
        } else {
            console.log('   RESULT: Timestamp looks SUSPICIOUS (0 or future).');
        }
    } else {
        console.log('❌ No messages found in DB.');
    }
} catch (e) {
    console.error('Query failed:', e);
}
