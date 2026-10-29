const crypto = require("crypto");

function generateRefreshToken() {
  return crypto.randomBytes(48).toString("hex"); // opaque, unguessable
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = { generateRefreshToken, hashToken };
