const axios = require("axios");

const LOG_API = "http://20.207.122.201/evaluation-service/logs";
const AUTH_API = "http://20.207.122.201/evaluation-service/auth";

const allowedLevels = ["debug", "info", "warn", "error", "fatal"];
const allowedPackages = ["handler", "controller", "service", "repository", "db", "domain"];

const AUTH_BODY = {
  email: "vv4743@srmist.edu.in",
  name: "Varsha V",
  rollNo: "RA2311003020459",
  accessCode: "QkbpxH",
  clientID: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
};

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < tokenExpiresAt - 60) {
    return cachedToken;
  }
  try {
    const res = await axios.post(AUTH_API, AUTH_BODY, { timeout: 5000 });
    cachedToken = res.data.access_token;
    tokenExpiresAt = res.data.expires_in;
    return cachedToken;
  } catch (err) {
    return null;
  }
}

async function Log(stack, level, pkg, message) {
  try {
    if (stack !== "backend") throw new Error("Invalid stack");
    if (!allowedLevels.includes(level)) throw new Error("Invalid level");
    if (!allowedPackages.includes(pkg)) throw new Error("Invalid package");

    const token = await getToken();
    if (!token) return;

    await axios.post(
      LOG_API,
      { stack, level, package: pkg, message },
      {
        timeout: 5000,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );
  } catch (err) {
  }
}

module.exports = Log;
