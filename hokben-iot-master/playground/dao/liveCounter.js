const db = require('./db');

const saveLiveCounter = (deviceId, data) => {
    const query = `
        INSERT INTO live_counter (
            device_id, date, current_product_code, 
            daily_ok, daily_under, daily_over, 
            prod_ok, prod_under, prod_over, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
        ON CONFLICT(device_id) DO UPDATE SET
            date = excluded.date,
            current_product_code = excluded.current_product_code,
            daily_ok = excluded.daily_ok,
            daily_under = excluded.daily_under,
            daily_over = excluded.daily_over,
            prod_ok = excluded.prod_ok,
            prod_under = excluded.prod_under,
            prod_over = excluded.prod_over,
            updated_at = strftime('%s', 'now');
    `;

    db.run(query, [
        deviceId,
        data.date,
        data.currentProductCode || "",
        data.daily.ok || 0,
        data.daily.under || 0,
        data.daily.over || 0,
        data.product.ok || 0,
        data.product.under || 0,
        data.product.over || 0
    ], (err) => {
        if (err) console.error(`[SQLITE] Error saveLiveCounter (${deviceId}):`, err.message);
    });
};

const getLiveCounterSync = (deviceId) => {
    // Karena butuh synchronous init pada bootloader JS biasa, kita gunakan async callback wrapper
    return new Promise((resolve) => {
        const query = `SELECT * FROM live_counter WHERE device_id = ?`;
        db.get(query, [deviceId], (err, row) => {
            if (err || !row) return resolve(null);
            resolve({
                date: row.date,
                currentProductCode: row.current_product_code,
                daily: { ok: row.daily_ok, under: row.daily_under, over: row.daily_over },
                product: { ok: row.prod_ok, under: row.prod_under, over: row.prod_over }
            });
        });
    });
};

module.exports = { saveLiveCounter, getLiveCounterSync };