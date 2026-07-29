const CAPTURE_STATES = {
  START_REQUESTED: "start_requested",
  DISCORD_THREAD_CREATED: "discord_thread_created",
  APPS_SCRIPT_STARTING: "apps_script_starting",
  VERIFYING_AFTER_TIMEOUT: "verifying_after_timeout",
  ACTIVE: "active",
  STOP_REQUESTED: "stop_requested",
  APPS_SCRIPT_STOPPING: "apps_script_stopping",
  STOPPED: "stopped",
  FAILED: "failed"
};

const TERMINAL_STATES = new Set([
  CAPTURE_STATES.STOPPED,
  CAPTURE_STATES.FAILED
]);

module.exports = {
  CAPTURE_STATES,
  TERMINAL_STATES
};
