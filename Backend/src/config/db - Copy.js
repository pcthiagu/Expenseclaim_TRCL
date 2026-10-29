const sql = require("mssql");

const dbConfig = {
  server: process.env.DB_SERVER || "localhost",
  port: Number(process.env.DB_PORT) || 1433,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: process.env.DB_ENCRYPT === "true",
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === "true",
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let poolPromise;

function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(dbConfig)
      .connect()
      .then((pool) => {
        console.log("[db] Connected to SQL Server:", dbConfig.database);
        return pool;
      })
      .catch((err) => {
        poolPromise = null;
        console.error("[db] Connection failed:", err.message);
        throw err;
      });
  }
  return poolPromise;
}

module.exports = { sql, getPool, dbConfig };
