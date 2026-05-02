const express = require("express");
const cors = require("cors");
const Log = require("./logging_middleware/logger");
const routes = require("./vehicle_maintenance_scheduler/routes");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  Log("backend", "debug", "handler", `Incoming ${req.method} ${req.originalUrl}`);
  next();
});

app.use("/api", routes);

app.get("/", (req, res) => {
  Log("backend", "info", "handler", "GET / - health check");
  res.status(200).json({ status: "ok", message: "Backend Running" });
});

app.use((req, res) => {
  Log("backend", "warn", "handler", `404 - Route not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ success: false, error: "Route not found" });
});

app.use((err, req, res, next) => {
  Log("backend", "fatal", "handler", `Unhandled error: ${err.message}`);
  res.status(500).json({ success: false, error: "Internal server error" });
});

app.listen(PORT, () => {
  Log("backend", "info", "handler", `Server started on port ${PORT}`);
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
