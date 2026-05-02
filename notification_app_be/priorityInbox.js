const axios = require("axios");
const Log = require("../logging_middleware/logger");

const NOTIFICATIONS_API = "http://20.207.122.201/evaluation-service/notifications";

const PRIORITY = {
  Placement: 3,
  Result: 2,
  Event: 1,
};

function getTop10(notifications) {
  return [...notifications]
    .sort((a, b) => {
      const pa = PRIORITY[a.Type] ?? 0;
      const pb = PRIORITY[b.Type] ?? 0;

      if (pb !== pa) return pb - pa;
      return new Date(b.Timestamp) - new Date(a.Timestamp);
    })
    .slice(0, 10);
}

const AUTH_API = "http://20.207.122.201/evaluation-service/auth";
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
  if (cachedToken && now < tokenExpiresAt - 60) return cachedToken;
  try {
    const res = await axios.post(AUTH_API, AUTH_BODY, { timeout: 5000 });
    cachedToken = res.data.access_token;
    tokenExpiresAt = res.data.expires_in;
    return cachedToken;
  } catch (err) {
    return null;
  }
}

async function getAuthHeaders() {
  const token = await getToken();
  return {
    "Content-Type": "application/json",
    ...(token && { Authorization: `Bearer ${token}` }),
  };
}

async function run() {
  await Log("backend", "info", "service", "priorityInbox: starting run");

  try {
    await Log("backend", "info", "service", "priorityInbox: fetching notifications");
    const headers = await getAuthHeaders();
    const res = await axios.get(NOTIFICATIONS_API, { headers, timeout: 10000 });

    const notifications = res.data.notifications;

    if (!notifications || notifications.length === 0) {
      await Log("backend", "warn", "service", "priorityInbox: no notifications returned");
      console.log("No notifications found.");
      return;
    }

    await Log(
      "backend",
      "debug",
      "service",
      `priorityInbox: received ${notifications.length} notification(s)`
    );

    const top10 = getTop10(notifications);

    await Log(
      "backend",
      "info",
      "service",
      `priorityInbox: top 10 selected from ${notifications.length} total`
    );

    console.log(JSON.stringify(top10, null, 2));

    await Log("backend", "info", "service", "priorityInbox: completed successfully");

  } catch (err) {
    await Log("backend", "error", "service", `priorityInbox: error - ${err.message}`);
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { getTop10, run };

run();
