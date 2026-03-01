import { initDatabase } from './src/database';

async function clearDB() {
    console.log('🗑️ Clearing message database...');
    const db = initDatabase();
    try {
        db.prepare('DELETE FROM messages').run();
        console.log('✅ Messages table cleared.');
        // If there are other tables like threads or processed, clear them too if they exist
        try { db.prepare('DELETE FROM processed_messages').run(); } catch (e) { }
    } catch (e: any) {
        console.error('❌ Error clearing DB:', e.message);
    } finally {
        db.close();
    }
}

clearDB();
