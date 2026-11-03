const db = require('./db');
const { cleanUpCheckweigherEvents } = require('./cleanUpCounter');

let eventWriteCount = 0;
const CLEANUP_THRESHOLD = 1000;

const saveCheckweigherEvent = (cwConfig, ev) => {
    const query = `
        INSERT INTO checkweigher_events (
            timestamp, plant_id, panel_id, device_id, meter_type,
            kind, status, kondisi, activity, reason,
            raw_code, product_code, product_name, weight,
            count_ok, count_reject, count_under, count_over,
            prod_count_ok, prod_count_reject, prod_count_under, prod_count_over
        ) VALUES (
            strftime('%s', 'now'), ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?
        )
    `;

    db.run(query, [
        cwConfig.plantId || "",
        cwConfig.panelId || "",
        cwConfig.deviceId || "",
        cwConfig.meterType || "",
        ev.kind || "weigh",
        ev.status || "-",
        ev.kondisi || "OFF",
        ev.activity || "off",
        ev.reason || "",
        ev.raw || "",
        ev.productCode || "",
        ev.productName || "",
        ev.weight || 0,
        ev.countOk || 0,
        ev.countReject || 0,
        ev.countUnder || 0,
        ev.countOver || 0,
        ev.prodCountOk || 0,
        ev.prodCountReject || 0,
        ev.prodCountUnder || 0,
        ev.prodCountOver || 0
    ], function (err) {
        if (err) console.error(`[SQLITE] Error saveCheckweigherEvent (${cwConfig.deviceId}):`, err.message);
    });

    eventWriteCount++;
    if (eventWriteCount >= CLEANUP_THRESHOLD) {
        cleanUpCheckweigherEvents();
        eventWriteCount = 0;
    }
};

module.exports = { saveCheckweigherEvent };