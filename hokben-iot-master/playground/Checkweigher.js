const fs = require("fs");
const path = require("path");
const { SerialPort } = require("serialport");
const { Sender } = require("@questdb/nodejs-client");
const config = require("../config/config.js");

// IMPORT MODUL DAO SQLITE (LOKAL)
const { saveLiveCounter, getLiveCounterSync } = require("./dao/liveCounter");
const { saveCheckweigherEvent } = require("./dao/event");

if (!config || !config.deviceList) {
    console.error('[FATAL] ../config/config.js tidak berisi deviceList.');
    process.exit(1);
}
const debug = config.debug;

console.log("[BOOT] checkweigher.js build 2026-10-21 (Dual Counter + Full SQLite Temporary Storage) -", __filename);

const selectedKeys = Array.isArray(config.currentDevice) ? config.currentDevice : [config.currentDevice];

const todayKey = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ---------------------------------------------------------------------------
// Registry port USB (dipakai bersama oleh semua device dalam 1 proses)
// ---------------------------------------------------------------------------
const realOf = (p) => { try { return fs.realpathSync(p); } catch (_) { return p; } };

const dataPortOwners = new Map();
for (const k of selectedKeys) {
    const d = config.deviceList[k];
    if (d && d.type === "checkweigher" && d.serial && d.serial.com) {
        dataPortOwners.set(realOf(d.serial.com), d.deviceId);
    }
}
const statusClaims = new Set();

// Mapping ID ke Nama Produk Spesifik per Perangkat (CW_25 & CW_26)
const getProductName = (code, deviceId) => {
    if (!code) return "";

    const productMaps = {
        CW_25: {
            "01": "Test",
            "02": "Tori Ball",
            "03": "Shrimp Roll",
            "04": "Egg Chicken Roll",
            "05": "Mini Shrimp Roll",
            "06": "Mini Tori Ball",
            "07": "CP Egg Chicken Roll",
            "08": "mini Chicken Roll",
            "09": "CKB",
            "10": "CP SR",
            "11": "ECR AF",
            "12": "SR Trial48",
            "13": "TRB DC",
            "14": "ECR AF"
        },
        CW_26: {
            "01": "Test",
            "02": "ECR OCS",
            "03": "Tori Ball",
            "04": "Egg Chicken Roll",
            "05": "SR 9+",
            "06": "ECR AF",
            "07": "CP Egg Chicken Roll",
            "08": "Mini ECR",
            "09": "Mini SR",
            "10": "CP-SR",
            "11": "CKB",
            "12": "CP SR",
            "13": "ECR",
            "14": "TRB MINI",
            "15": "CP SR"
        }
    };

    const map = productMaps[deviceId] || productMaps.CW_25;
    return map[code] || `Code ${code}`;
};

const startCheckweigher = async (key) => {
    const cw = config.deviceList[key];
    if (!cw || cw.type !== "checkweigher") return null;

    const { deviceId, panelId, plantId, meterType } = cw;
    const serialCfg = cw.serial;
    const tag = `[${deviceId}]`;

    let queue = [];
    let isFlushing = false;
    let reconnectTimer = null;
    let currentPort = null;
    let lastEvent = null;
    let lastDataTs = 0;
    const stats = { bytes: 0, received: 0, parsed: 0, unparsed: 0, idle: 0, sent: 0, stateRows: 0 };

    const counterDir = cw.counterDir || path.join(__dirname, "data");
    const counterFile = path.join(counterDir, `counter_${deviceId}.json`);
    const statusFile = path.join(counterDir, `status_${deviceId}.json`);
    let counterDirty = false;

    // Kondisi Mesin (ON/OFF) dan Aktivitas (running/idle/off)
    const sm = Object.assign({
        signalTrusted: false,
        usbCandidates: ["/dev/ttyUSB0", "/dev/ttyUSB1"],
        baudRate: 9600,
        signalLine: "dsr",
        activeHigh: true,
        driveDtrRts: true,
        pollMs: 500,
        debounceMs: 3000,
        debounceOnlineMs: 1000,
        startupGraceMs: 3000,
        idleAfterMs: 30000,
        offAfterIdleMs: 0,
        retryOpenMs: 5000
    }, cw.machineStatus || {});
    const bootTs = Date.now();

    const mstate = {
        online: null,
        since: Date.now(),
        reason: "init",
        pending: null,
        pendingSince: 0
    };

    let statusPort = null;
    let statusPath = "";
    let statusShared = false;
    let statusOpening = false;
    let lastResolveTry = 0;
    let pollBusy = false;
    let lastActivity = null;

    const activityNow = () => {
        if (!mstate.online) return "off";
        return (lastDataTs > 0 && Date.now() - lastDataTs < sm.idleAfterMs) ? "running" : "idle";
    };

    const newCounterGroup = () => ({ ok: 0, under: 0, over: 0 });

    // -----------------------------------------------------------------------
    // RECOVERY DATA SAAT BOOTING: SQLITE PERTAMA, JSON SEBAGAI FALLBACK
    // -----------------------------------------------------------------------
    const sqliteCounter = await getLiveCounterSync(deviceId);
    let counterData;

    if (sqliteCounter && sqliteCounter.date === todayKey()) {
        counterData = sqliteCounter;
        console.log(tag, "[SQLITE RECOVERY] Berhasil load counter dari SQLite:", counterData);
    } else {
        try {
            const c = JSON.parse(fs.readFileSync(counterFile, "utf8"));
            if (c.date === todayKey()) {
                counterData = {
                    date: c.date,
                    daily: { ok: c.daily?.ok || 0, under: c.daily?.under || 0, over: c.daily?.over || 0 },
                    currentProductCode: c.currentProductCode || "",
                    product: { ok: c.product?.ok || 0, under: c.product?.under || 0, over: c.product?.over || 0 }
                };
            }
        } catch (_) {}

        if (!counterData) {
            counterData = {
                date: todayKey(),
                daily: newCounterGroup(),
                currentProductCode: "",
                product: newCounterGroup()
            };
        }
    }

    let currentProductCode = counterData.currentProductCode;
    let currentProductName = getProductName(currentProductCode, deviceId);

    const saveCounter = () => {
        if (!counterDirty) return;
        try {
            // 1. Simpan ke File JSON Backup
            fs.mkdirSync(counterDir, { recursive: true });
            fs.writeFileSync(counterFile, JSON.stringify(counterData));

            // 2. Simpan/Update ke Database SQLite Lokal
            saveLiveCounter(deviceId, counterData);

            counterDirty = false;
        } catch (e) {
            console.error(tag, "Gagal simpan counter:", e.message);
        }
    };

    // KODE BARU (Kontinu / No Cut-off):
const rollDay = () => {
    if (counterData.date !== todayKey()) {
        counterData.date = todayKey();
        // counterData.daily = newCounterGroup(); // DIHAPUS agar angka akumulasi jalan terus
        counterDirty = true;
        saveCounter();
        console.log(tag, `[DATE UPDATE] Tanggal berganti ke ${counterData.date}. Hitungan daily dilanjutkan.`);
    }
};

    const writeStatusFile = () => {
        try {
            fs.mkdirSync(counterDir, { recursive: true });
            const tmp = statusFile + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify({
                deviceId,
                online: mstate.online,
                kondisi: mstate.online ? "ON" : "OFF",
                activity: activityNow(),
                reason: mstate.reason,
                since: mstate.since,
                statusPort: statusPath,
                updatedAt: Date.now()
            }));
            fs.renameSync(tmp, statusFile);
        } catch (e) {
            console.error(tag, "Gagal tulis status file:", e.message);
        }
    };

    const pushStateRow = () => {
        rollDay();
        const ev = {
            kind: "state",
            ts: Date.now(),
            status: "-",
            kondisi: mstate.online ? "ON" : "OFF",
            activity: activityNow(),
            reason: mstate.reason,
            productCode: currentProductCode,
            productName: currentProductName,
            countOk: counterData.daily.ok,
            countReject: counterData.daily.under + counterData.daily.over,
            countUnder: counterData.daily.under,
            countOver: counterData.daily.over,
            prodCountOk: counterData.product.ok,
            prodCountReject: counterData.product.under + counterData.product.over,
            prodCountUnder: counterData.product.under,
            prodCountOver: counterData.product.over
        };
        queue.push(ev);

        // PERSIST LOG STATE KE SQLITE LOKAL (SKEMA LENGKAP)
        saveCheckweigherEvent(cw, ev);

        if (queue.length > cw.maxQueue) queue.splice(0, queue.length - cw.maxQueue);
    };

    const commitState = (online, reason) => {
        const prev = mstate.online;
        mstate.online = online;
        mstate.reason = reason;
        mstate.since = Date.now();
        mstate.pending = null;
        lastActivity = activityNow();
        pushStateRow();
        writeStatusFile();
        console.log(tag, `[KONDISI] ${prev === null ? "INIT" : (prev ? "ON" : "OFF")} -> ` +
            `${online ? "ON" : "OFF"}/${lastActivity} (reason: ${reason})`);
    };

    const tickStatus = (signalOn) => {
        const now = Date.now();
        const portAlive = !!(currentPort && currentPort.isOpen);
        const dataRecent = lastDataTs > 0 && (now - lastDataTs) < sm.idleAfterMs;
        const silentMs = now - (lastDataTs || bootTs);
        let online, why;

        if (sm.signalTrusted && signalOn !== null) {
            online = signalOn; why = "signal";
            if (!online && dataRecent) { online = true; why = "data_override"; }
        } else if (!portAlive) {
            online = false; why = "port_lost";
        } else if (sm.offAfterIdleMs > 0 && silentMs >= sm.offAfterIdleMs) {
            online = false; why = "idle_timeout";
        } else {
            online = true; why = sm.signalTrusted ? "link_fallback" : "link";
        }

        if (mstate.online === null) {
            if (!online && now - bootTs < sm.startupGraceMs) return;
            return commitState(online, why);
        }

        if (online === mstate.online) {
            mstate.pending = null;
            mstate.reason = why;
            return;
        }

        if (mstate.pending !== online) {
            mstate.pending = online;
            mstate.pendingSince = now;
        } else if (now - mstate.pendingSince >= (online ? sm.debounceOnlineMs : sm.debounceMs)) {
            commitState(online, why);
        }
    };

    const checkActivity = () => {
        if (mstate.online === null) return;
        const act = activityNow();
        if (lastActivity === null) { lastActivity = act; return; }
        if (act === lastActivity) return;
        const prev = lastActivity;
        lastActivity = act;
        if (act === "idle" && prev === "running") {
            pushStateRow();
            writeStatusFile();
            console.log(tag, `[KONDISI] ON/running -> ON/idle (tidak ada timbangan > ${Math.round(sm.idleAfterMs / 1000)} detik)`);
        } else {
            writeStatusFile();
        }
    };

    const getStatusPort = () => {
        if (statusShared) return currentPort;
        if (statusPort) return statusPort.isOpen ? statusPort : null;
        if (statusOpening) return null;
        if (Date.now() - lastResolveTry < sm.retryOpenMs) return null;
        lastResolveTry = Date.now();

        for (const cand of sm.usbCandidates) {
            if (!fs.existsSync(cand)) continue;
            const real = realOf(cand);
            const owner = dataPortOwners.get(real);

            if (owner === deviceId) {
                statusShared = true;
                statusPath = cand;
                console.log(tag, `[KONDISI] status port = port data (${cand}), baca line ${sm.signalLine.toUpperCase()}`);
                return currentPort;
            }
            if (owner || statusClaims.has(real)) continue;

            statusClaims.add(real);
            statusPath = cand;
            statusOpening = true;
            const p = new SerialPort({ path: cand, baudRate: sm.baudRate, autoOpen: false });
            p.on("error", (e) => console.error(tag, "[STATUS PORT ERROR]", e.message));
            p.on("close", () => {
                statusClaims.delete(real);
                if (statusPort === p) statusPort = null;
                statusOpening = false;
                statusPath = "";
            });
            p.open((err) => {
                statusOpening = false;
                if (err) {
                    statusClaims.delete(real);
                    statusPath = "";
                    console.error(tag, `[STATUS PORT] gagal buka ${cand}:`, err.message);
                    return;
                }
                statusPort = p;
                if (sm.driveDtrRts) p.set({ dtr: true, rts: true }, () => {});
                console.log(tag, `[KONDISI] status port dedicated ${cand} terbuka, baca line ${sm.signalLine.toUpperCase()}`);
            });
            return null;
        }
        return null;
    };

    const pollSignal = () => {
        if (pollBusy) return;
        if (!sm.signalTrusted) return tickStatus(null);

        const port = getStatusPort();
        if (!port || !port.isOpen) return tickStatus(null);

        pollBusy = true;
        port.get((err, flags) => {
            pollBusy = false;
            if (err || !flags) return tickStatus(null);
            const raw = !!flags[sm.signalLine];
            tickStatus(sm.activeHigh ? raw : !raw);
        });
    };

    const parseFrame = (line) => {
        const m = line.match(cw.frameRegex);
        if (!m || !m.groups) return null;

        const weight = parseFloat(m.groups.weight);
        if (!isFinite(weight)) return null;

        // Validasi Status Anritsu: 1=under, 2=ok, E=over
        const statCode = (m.groups.status || "").toUpperCase();
        let status = "weigh";
        if (statCode === "1") status = "under";
        else if (statCode === "2") status = "ok";
        else if (statCode === "E") status = "over";

        const productCode = m.groups.product || "";

        return {
            productCode,
            status,
            weight
        };
    };

    const handleLine = (rawLine) => {
        const line = rawLine.replace(/[\x00-\x1F\x7F\s]/g, "");
        if (!line) return;
        stats.received++;

        const parsed = parseFrame(line);
        if (!parsed) {
            stats.unparsed++;
            if (debug) console.log(tag, "[UNPARSED]", JSON.stringify(line));
            return;
        }

        stats.parsed++;
        rollDay();

        // 1. FILTER KETAT: Hanya loloskan jika status bernilai ok, under, atau over
        const validStatuses = ["ok", "under", "over"];
        if (!validStatuses.includes(parsed.status)) {
            if (debug) console.log(tag, `[SKIPPED] Status: "${parsed.status}" - Data diabaikan`);
            return;
        }

        // 2. DETEKSI PERGANTIAN PRODUK: Reset Counter Produk jika kode produk berubah
        if (parsed.productCode && parsed.productCode !== currentProductCode) {
            const oldProduct = currentProductName || "Awal";
            currentProductCode = parsed.productCode;
            currentProductName = getProductName(parsed.productCode, deviceId);

            counterData.currentProductCode = currentProductCode;
            counterData.product = newCounterGroup(); // RESET COUNTER BATCH PRODUK KE 0

            console.log(tag, `\n==================================================`);
            console.log(tag, `[PERGANTIAN PRODUK] ${oldProduct} -> ${currentProductName} (${currentProductCode})`);
            console.log(tag, `[COUNTER PRODUK RESET] Counter batch di-reset ke 0 pcs`);
            console.log(tag, `==================================================\n`);
        }

        // 3. INCREMENT DUAL COUNTER (Total Harian & Batch Produk)
        const status = parsed.status;
        if (status === "ok") {
            counterData.daily.ok++;
            counterData.product.ok++;
        } else if (status === "under") {
            counterData.daily.under++;
            counterData.product.under++;
        } else if (status === "over") {
            counterData.daily.over++;
            counterData.product.over++;
        }
        counterDirty = true;

        const dailyReject = counterData.daily.under + counterData.daily.over;
        const productReject = counterData.product.under + counterData.product.over;

        // 4. PAYLOAD EVENT
        const event = {
            kind: "weigh",
            ts: Date.now(),
            raw: line,
            status,
            kondisi: "ON",
            activity: "running",
            weight: parsed.weight,
            productCode: currentProductCode,
            productName: currentProductName,
            countOk: counterData.daily.ok,
            countReject: dailyReject,
            countUnder: counterData.daily.under,
            countOver: counterData.daily.over,
            prodCountOk: counterData.product.ok,
            prodCountReject: productReject,
            prodCountUnder: counterData.product.under,
            prodCountOver: counterData.product.over
        };
        queue.push(event);
        lastEvent = event;

        // PERSIST LOG PENIMBANGAN KE SQLITE LOKAL (SKEMA LENGKAP)
        saveCheckweigherEvent(cw, event);

        if (queue.length > cw.maxQueue) queue.splice(0, queue.length - cw.maxQueue);
        if (debug) {
            const prodText = currentProductName ? ` | Produk: ${currentProductName}` : "";
            console.log(tag, `[${status.toUpperCase()}] ${parsed.weight}g${prodText} | ` +
                `DAILY(OK:${counterData.daily.ok} REJ:${dailyReject}) | ` +
                `PROD_BATCH(OK:${counterData.product.ok} REJ:${productReject})`);
        }
    };

    let rxBuf = "";
    let gapTimer = null;

    const emitFrame = () => {
        const frame = rxBuf;
        rxBuf = "";
        if (frame.replace(/[\x00-\x20]/g, "") === "") return;
        handleLine(frame);
    };

    const feedBytes = (buf) => {
        stats.bytes += buf.length;
        lastDataTs = Date.now();
        for (const ch of buf.toString("latin1")) {
            if (ch === "\x02") {
                emitFrame();
                rxBuf = ch;
            } else if (ch === "\x03" || ch === "\r" || ch === "\n") {
                rxBuf += ch;
                emitFrame();
            } else {
                rxBuf += ch;
            }
        }
        if (rxBuf.length > 512) rxBuf = "";
        clearTimeout(gapTimer);
        if (rxBuf) gapTimer = setTimeout(emitFrame, cw.frameGapMs || 200);
    };

    const sendToQuestDB = async () => {
        if (isFlushing) return;
        rollDay();

        if (queue.length === 0) return;
        isFlushing = true;

        const batch = queue.splice(0, queue.length);
        const sender = Sender.fromConfig(
            `http::addr=${config.questdb.host}:${config.questdb.port};username=${config.questdb.username};password=${config.questdb.password};`
        );

        try {
            for (const ev of batch) {
                let row = sender
                    .table(config.questdb.checkweigherTable)
                    .symbol("plant_id", plantId)
                    .symbol("panel_id", panelId)
                    .symbol("device_id", deviceId)
                    .symbol("meter_type", meterType)
                    .symbol("status", ev.status)
                    .symbol("kondisi", ev.kondisi)
                    .symbol("activity", ev.activity);
                if (ev.reason) row = row.symbol("reason", ev.reason);

                row = row
                    .stringColumn("product_name", ev.productName || "")
                    .stringColumn("code", ev.kind === "weigh" ? (ev.raw || "") : "")
                    .stringColumn("code_product", ev.productCode || "");
                if (ev.kind === "weigh") row = row.floatColumn("weight", ev.weight);

                await row
                    .intColumn("count_ok", ev.countOk)
                    .intColumn("count_reject", ev.countReject)
                    .intColumn("count_under", ev.countUnder)
                    .intColumn("count_over", ev.countOver)
                    .intColumn("prod_count_ok", ev.prodCountOk)
                    .intColumn("prod_count_reject", ev.prodCountReject)
                    .intColumn("prod_count_under", ev.prodCountUnder)
                    .intColumn("prod_count_over", ev.prodCountOver)
                    .at(ev.ts, "ms");
            }
            await sender.flush();
            stats.sent += batch.length;
            stats.stateRows += batch.filter((e) => e.kind === "state").length;
        } catch (error) {
            console.error(tag, `Gagal mengirim data QuestDB:`, error.message);
            queue = batch.concat(queue).slice(-cw.maxQueue);
        } finally {
            try { await sender.close(); } catch (_) {}
            isFlushing = false;
        }
    };

    const scheduleReconnect = () => {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectSerial();
        }, cw.reconnectMs);
    };

    const connectSerial = () => {
        const port = new SerialPort({
            path: serialCfg.com,
            baudRate: serialCfg.baudRate,
            dataBits: serialCfg.dataBits,
            parity: serialCfg.parity,
            stopBits: serialCfg.stopBits,
            autoOpen: false
        });
        currentPort = port;

        port.on("data", feedBytes);
        port.on("error", (err) => console.error(tag, "[SERIAL ERROR]", err.message));
        port.on("close", () => scheduleReconnect());

        port.open((err) => {
            if (err) return scheduleReconnect();
        });
    };

    connectSerial();
    const sendTimer = setInterval(sendToQuestDB, cw.sendIntervalMs);
    const saveTimer = setInterval(saveCounter, 5000);
    const pollTimer = setInterval(() => { pollSignal(); checkActivity(); }, sm.pollMs);

    return {
        deviceId, com: serialCfg.com,
        statusText: () => {
            const last = lastEvent ? `${lastEvent.weight}g(${lastEvent.status})` : "-";
            const st = mstate.online === null ? "INIT" : (mstate.online ? "ONLINE" : "OFFLINE");
            return `${deviceId} ${st}/${activityNow()}(${mstate.reason}) DAILY_OK:${counterData.daily.ok} PROD_OK:${counterData.product.ok} q:${queue.length} last:${last}`;
        },
        shutdown: async () => {
            clearInterval(pollTimer);
            clearInterval(sendTimer); clearInterval(saveTimer);
            try { await sendToQuestDB(); } catch (_) {}
            saveCounter();
            if (statusPort && statusPort.isOpen) statusPort.close();
            if (currentPort && currentPort.isOpen) currentPort.close();
        }
    };
};

// INTI INISIALISASI ASYNC UNTUK SEMUA DEVICE
(async () => {
    const devices = (await Promise.all(selectedKeys.map(startCheckweigher))).filter(Boolean);
    if (devices.length === 0) process.exit(1);

    if (debug) {
        const interval = config.deviceList[selectedKeys[0]].statsIntervalMs || 1000;
        setInterval(() => console.log("[STATUS]", devices.map((d) => d.statusText()).join(" | ")), interval);
    }

    process.on("SIGINT", async () => {
        console.log("\nShutting down...");
        await Promise.all(devices.map((d) => d.shutdown()));
        process.exit(0);
    });
})();