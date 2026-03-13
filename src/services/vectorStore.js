const config = require("../config");
const { db } = require("../db");
const { createSqliteVectorStore } = require("./vectorProviders/sqliteVectorStore");
const { createHnswSidecarStore } = require("./vectorProviders/hnswSidecarStore");

const sqliteStore = createSqliteVectorStore(db);
const vectorStore =
  config.vectorProvider === "hnswlib"
    ? createHnswSidecarStore(sqliteStore)
    : sqliteStore;

module.exports = { vectorStore };
