const { loadConfig } = require("../config/env");
const { SqliteStore } = require("./sqliteStore");

const config = loadConfig();
const store = new SqliteStore(config.sqlitePath);
store.close();
console.log("Initialized SQLite store at " + config.sqlitePath);
