module.exports = {
	logger : {
		interval : 1,
		dbName : 'local.sqlite3',
		dbPath : '/data/db/'
	},
	modbusServer: {
		deviceInterval: 500,
		com: '/dev/ttyACM0',
		timeout: 1000,
		baudRate: 9600,
		availableIds: [21] 
	},

	questdb: {
		host: "172.18.100.125",
		port: 9000,
		username: "admin",
		password: "D0r43m0n2025",
		database: "power_monitoring",            
		checkweigherTable: "checkweigher_p3"
	},

	deviceList: {
		PMP1: {
			deviceId: "PMP1",
			panelId: "sdp_plant1",
			plantId: "plant1",
			loadId: {
				21: {name: "sdp_p1", meterType: "IEM3255"},
			}
		},
		PMP2: {
			deviceId: "PMP2",
			panelId: "lvmdp-plant2",
			plantId: "plant2",
			loadId: {
				31: {name: "PP-GAS_P2", meterType: "L40"},
				32: {name: "SDB-MCC.N_P2", meterType: "L40"}, 
				33: {name: "MDB-REFRIGERANT_P2", meterType: "L40"},
				34: {name: "MDB-LP_P2", meterType: "L40"}, 
				36: {name: "PP-VENTILASI GOLDEN_P2", meterType: "L40"},
				37: {name: "PP-LIFT_P2", meterType: "L40"}, 
				38: {name: "SDB-MCC.E_P2", meterType: "L40"}, 
				39: {name: "MDB-PUMP_P2", meterType: "L40"}, 
				40: {name: "LVMDB_P2", meterType: "L40"},
			}
		},
		PMP3: {
			deviceId: "PMP3",
			panelId: "sdp_plant3",
			plantId: "plant3",
			loadId: {
				1: {name: "sdp_f3", meterType: "PM2100"},
				2: {name: "sdp_mesin_produksi", meterType: "PM2100"},
			}
		},
		PMP4: {
			deviceId: "PMP4",
			panelId: "lvmdp-plant4",
			plantId: "plant4",
			loadId: {
				1: {name: "lvmdb_p4", meterType: "PM2200"},
				2: {name: "sdp_p4", meterType: "PM2100"},
			}
		},

		// Checkweigher Anritsu Line 1 (CW_25)
		CW_25: {
			type: "checkweigher",
			deviceId: "CW_25",
			panelId: "Checkweigher_p3",
			plantId: "plant3",
			meterType: "ANRITSU",
			serial: { com: '/dev/checkweigher', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, delimiter: '\r\n' },

			// REGEX CW_25: Menangkap 2 Digit Kode Produk
			frameRegex: /\*?(?<product>\d{2})(?<status>[12Ee])(?<weight>\d+\.\d+|\d+)(?<unit>[A-Za-z]+)/i,

			// Deteksi mesin ONLINE/OFFLINE via USB (/dev/ttyUSB0 atau /dev/ttyUSB1)
			machineStatus: {
				signalTrusted: false,   // true HANYA jika DSR/CTS sudah dikabel ke sinyal power/run mesin
				offAfterIdleMs: 0,      // 0 = diam tidak pernah dianggap OFF (isi ms jika ingin, mis. 1800000 = 30 menit)
				usbCandidates: ["/dev/ttyUSB0", "/dev/ttyUSB1"],  // urutan prioritas
				signalLine: "dsr",                                // "cts" | "dsr" | "dcd"
				activeHigh: true,                                 // false jika aktif = line low
				driveDtrRts: true,                                // DTR/RTS HIGH sbg sumber tegangan referensi
				pollMs: 500,
				debounceMs: 3000,
				idleAfterMs: 30000,
			},

			minWeight: 0,
			maxWeight: 100000,
			sendIntervalMs: 1000, sendZeroWhenIdle: true, idleUnit: "g",
			statsIntervalMs: 1000, debugRaw: true, frameGapMs: 200, reconnectMs: 5000, maxQueue: 10000
		},

		// Checkweigher Anritsu Line 2 (CW_26)
		CW_26: {
			type: "checkweigher",
			deviceId: "CW_26",
			panelId: "Checkweigher_p3",
			plantId: "plant3",
			meterType: "ANRITSU",
			serial: { com: '/dev/serial_dev2', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, delimiter: '\r\n' },

			// REGEX CW_26: Menangkap Optional 2 Digit Kode Produk + Status + Berat
			frameRegex: /\*?(?:(?<product>\d{2}))?(?<status>[12Ee])(?<weight>\d+\.\d+|\d+)(?<unit>[A-Za-z]+)/i,

			// Deteksi mesin ONLINE/OFFLINE via USB (urutan dibalik agar tidak berebut dengan CW_25)
			machineStatus: {
				signalTrusted: false,   // true HANYA jika DSR/CTS sudah dikabel ke sinyal power/run mesin
				offAfterIdleMs: 0,      // 0 = diam tidak pernah dianggap OFF (isi ms jika ingin, mis. 1800000 = 30 menit)
				usbCandidates: ["/dev/ttyUSB1", "/dev/ttyUSB0"],
				signalLine: "dsr",
				activeHigh: true,
				driveDtrRts: true,
				pollMs: 500,
				debounceMs: 3000,
				idleAfterMs: 30000,
			},

			minWeight: 0,
			maxWeight: 100000,
			sendIntervalMs: 1000, sendZeroWhenIdle: true, idleUnit: "g",
			statsIntervalMs: 1000, debugRaw: true, frameGapMs: 200, reconnectMs: 5000, maxQueue: 10000
		},
	},

	currentDevice: ["CW_25", "CW_26"],
	debug: true
};