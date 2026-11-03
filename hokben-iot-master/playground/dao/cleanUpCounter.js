const db = require('./db');

const MAX_ROWS_EVENTS = 500000;
const BATCH_DELETE = 1000;

const cleanUpCheckweigherEvents = () => {
    db.get('SELECT COUNT(*) AS count FROM checkweigher_events', (err, row) => {
        if (err) return console.error("[SQLITE CLEANUP] Gagal menghitung baris:", err.message);

        if (row && row.count > MAX_ROWS_EVENTS + BATCH_DELETE) {
            db.run(`
                DELETE FROM checkweigher_events
                WHERE id IN (
                    SELECT id FROM checkweigher_events
                    ORDER BY id ASC
                    LIMIT ?
                )
            `, [BATCH_DELETE], function (err) {
                if (err) {
                    console.error("[SQLITE CLEANUP] Gagal hapus data lama:", err.message);
                } else {
                    console.log(`[SQLITE CLEANUP] ${this.changes} baris event lama dihapus.`);
                }
            });
        }
    });
};

module.exports = { cleanUpCheckweigherEvents };