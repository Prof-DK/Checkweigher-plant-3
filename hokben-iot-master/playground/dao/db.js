const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbDir = path.resolve(__dirname, "../../data/db");
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, "localCheckweigher.db");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Tabel Live Counter (Tetap Sesuai Kebutuhan Recovery)
    db.run(`CREATE TABLE IF NOT EXISTS live_counter (
        device_id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        current_product_code TEXT,
        daily_ok INTEGER DEFAULT 0,
        daily_under INTEGER DEFAULT 0,
        daily_over INTEGER DEFAULT 0,
        prod_ok INTEGER DEFAULT 0,
        prod_under INTEGER DEFAULT 0,
        prod_over INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )`);

    // Tabel Log Event (LENGKAP SAMPAI 100% FITUR QUESTDB)
    db.run(`CREATE TABLE IF NOT EXISTS checkweigher_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        plant_id TEXT,
        panel_id TEXT,
        device_id TEXT NOT NULL,
        meter_type TEXT,
        kind TEXT NOT NULL,
        status TEXT,
        kondisi TEXT,
        activity TEXT,
        reason TEXT,
        raw_code TEXT,
        product_code TEXT,
        product_name TEXT,
        weight REAL,
        count_ok INTEGER,
        count_reject INTEGER,
        count_under INTEGER,
        count_over INTEGER,
        prod_count_ok INTEGER,
        prod_count_reject INTEGER,
        prod_count_under INTEGER,
        prod_count_over INTEGER
    )`);
});

module.exports = db;