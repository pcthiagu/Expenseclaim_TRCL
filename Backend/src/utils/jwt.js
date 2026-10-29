const jwt = require("jsonwebtoken");
const authConfig = require("../config/authConfig");

function signAccessToken(user) {
  return jwt.sign(
    { employeeId: user.employeeId, role: user.role, name: user.employeeName },
    authConfig.jwt.accessTokenSecret,
    { expiresIn: authConfig.jwt.accessTokenExpiresIn, issuer: authConfig.jwt.issuer }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, authConfig.jwt.accessTokenSecret, { issuer: authConfig.jwt.issuer });
}

module.exports = { signAccessToken, verifyAccessToken };
