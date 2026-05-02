"use strict";

const logger = require("../logging_middleware/logger");
const service = require("../vehicle_maintenance_scheduler/service");

// ── Interval: check every 60 seconds (configurable) ─────────────────────────
const CHECK_INTERVAL_MS = 60 * 1000;

/**
 * Core notification function.
 * Queries for due maintenance, logs, and "sends" notification.
 */
async function checkAndNotify() {
  logger.info("service", "Notifier: starting due-maintenance check");

  try {
    const result = service.getDueMaintenances();

    if (!result.success) {
      logger.error("service", "Notifier: failed to fetch due maintenances", {
        error: result.error,
      });
      return;
    }

    const dueRecords = result.data;

    if (dueRecords.length === 0) {
      logger.debug("service", "Notifier: no due maintenance found at this check");
      return;
    }

    logger.warn(
      "service",
      `Notifier: ${dueRecords.length} maintenance record(s) are due!`
    );

    // ── Process each due record ──────────────────────────────────────────
    for (const record of dueRecords) {
      // Skip already-notified records (prevent notification spam)
      if (record.notified) {
        logger.debug(
          "service",
          `Notifier: record ${record.id} already notified — skipping`
        );
        continue;
      }

      // Trigger notification (console log as acceptable implementation)
      triggerNotification(record);

      // Mark as notified in the store so it isn't repeated
      const { maintenanceRecords } = service.getStores();
      record.notified = true;
      maintenanceRecords.set(record.id, record);

      logger.info(
        "service",
        `Notifier: notification sent for record ${record.id}`,
        {
          vehicleId: record.vehicleId,
          type: record.type,
          serviceDate: record.serviceDate,
          mileageThreshold: record.mileageThreshold,
        }
      );
    }
  } catch (err) {
    // Notification failure must NEVER crash the server
    logger.fatal(
      "service",
      `Notifier: unexpected error during check — ${err.message}`
    );
  }
}

/**
 * Sends the notification payload (console + extensible hook).
 */
function triggerNotification(record) {
  const timestamp = new Date().toISOString();
  const message =
    `🔔 [MAINTENANCE ALERT] [${timestamp}]` +
    ` | Record ID: ${record.id}` +
    ` | Vehicle ID: ${record.vehicleId}` +
    ` | Type: ${record.type}` +
    (record.serviceDate ? ` | Due Date: ${record.serviceDate}` : "") +
    (record.mileageThreshold ? ` | Mileage Threshold: ${record.mileageThreshold} km` : "");

  console.log("\n" + message + "\n");
  logger.warn("service", "Notifier: maintenance alert triggered", {
    recordId: record.id,
    vehicleId: record.vehicleId,
    type: record.type,
  });
}

/**
 * Starts the periodic notifier loop.
 * Called once from server.js at startup.
 */
function startNotifier() {
  logger.info(
    "service",
    `Notifier: started — checking every ${CHECK_INTERVAL_MS / 1000}s`
  );

  // Run immediately on startup, then on every interval
  checkAndNotify();
  const interval = setInterval(checkAndNotify, CHECK_INTERVAL_MS);

  // Graceful shutdown support
  process.on("SIGTERM", () => {
    logger.warn("service", "Notifier: SIGTERM received — stopping interval");
    clearInterval(interval);
  });

  process.on("SIGINT", () => {
    logger.warn("service", "Notifier: SIGINT received — stopping interval");
    clearInterval(interval);
  });
}

module.exports = { startNotifier, checkAndNotify };
