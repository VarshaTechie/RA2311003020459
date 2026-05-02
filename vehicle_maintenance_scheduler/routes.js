const express = require("express");
const router = express.Router();
const axios = require("axios");

const Log = require("../logging_middleware/logger");
const knapsack = require("./service");

const DEPOT_API = "http://20.207.122.201/evaluation-service/depots";
const VEHICLE_API = "http://20.207.122.201/evaluation-service/vehicles";

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

router.get("/schedule", async (req, res) => {
  try {
    await Log("backend", "info", "handler", "GET /api/schedule");

    let depots;
    let vehicles;
    const headers = await getAuthHeaders();

    try {
      await Log("backend", "info", "service", "Fetching depots");
      const depotsRes = await axios.get(DEPOT_API, { headers, timeout: 10000 });
      depots = depotsRes.data.depots;
    } catch (apiErr) {
      depots = [];
    }

    try {
      await Log("backend", "info", "service", "Fetching vehicles");
      const vehiclesRes = await axios.get(VEHICLE_API, { headers, timeout: 10000 });
      vehicles = vehiclesRes.data.vehicles;
    } catch (apiErr) {
      vehicles = [];
    }

    if (!depots || depots.length === 0 || !vehicles || vehicles.length === 0) {
      return res.status(200).json({ results: [] });
    }

    const results = [];

    for (const depot of depots) {
      const result = knapsack(vehicles, depot.MechanicHours);

      results.push({
        depotId: depot.ID,
        totalImpact: result.maxImpact,
        selectedTasks: result.selectedTasks.map((t) => t.TaskID),
      });
    }

    await Log("backend", "info", "handler", "Schedule success");
    return res.status(200).json({ results });

  } catch (err) {
    await Log("backend", "error", "handler", err.message);
    return res.status(500).json({ error: "Something went wrong" });
  }
});

module.exports = router;
