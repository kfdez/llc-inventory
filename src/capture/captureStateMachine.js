const { CAPTURE_STATES, TERMINAL_STATES } = require("./captureStates");

const ALLOWED_TRANSITIONS = {
  [CAPTURE_STATES.START_REQUESTED]: [
    CAPTURE_STATES.DISCORD_THREAD_CREATED,
    CAPTURE_STATES.APPS_SCRIPT_STARTING,
    CAPTURE_STATES.FAILED
  ],
  [CAPTURE_STATES.DISCORD_THREAD_CREATED]: [
    CAPTURE_STATES.APPS_SCRIPT_STARTING,
    CAPTURE_STATES.FAILED
  ],
  [CAPTURE_STATES.APPS_SCRIPT_STARTING]: [
    CAPTURE_STATES.ACTIVE,
    CAPTURE_STATES.VERIFYING_AFTER_TIMEOUT,
    CAPTURE_STATES.FAILED
  ],
  [CAPTURE_STATES.VERIFYING_AFTER_TIMEOUT]: [
    CAPTURE_STATES.ACTIVE,
    CAPTURE_STATES.FAILED
  ],
  [CAPTURE_STATES.ACTIVE]: [
    CAPTURE_STATES.STOP_REQUESTED,
    CAPTURE_STATES.FAILED
  ],
  [CAPTURE_STATES.STOP_REQUESTED]: [
    CAPTURE_STATES.APPS_SCRIPT_STOPPING,
    CAPTURE_STATES.STOPPED,
    CAPTURE_STATES.FAILED
  ],
  [CAPTURE_STATES.APPS_SCRIPT_STOPPING]: [
    CAPTURE_STATES.STOPPED,
    CAPTURE_STATES.VERIFYING_AFTER_TIMEOUT,
    CAPTURE_STATES.FAILED
  ],
  [CAPTURE_STATES.STOPPED]: [],
  [CAPTURE_STATES.FAILED]: []
};

function canTransition(fromState, toState) {
  return (ALLOWED_TRANSITIONS[fromState] || []).includes(toState);
}

function assertTransition(fromState, toState) {
  if (fromState === toState) {
    return;
  }
  if (TERMINAL_STATES.has(fromState)) {
    throw new Error("Cannot transition from terminal capture state " + fromState + " to " + toState + ".");
  }
  if (!canTransition(fromState, toState)) {
    throw new Error("Invalid capture transition: " + fromState + " -> " + toState + ".");
  }
}

function transitionCaptureState(session, toState, patch = {}) {
  const currentState = session && session.state;
  assertTransition(currentState, toState);
  return {
    ...session,
    ...patch,
    state: toState
  };
}

module.exports = {
  ALLOWED_TRANSITIONS,
  canTransition,
  assertTransition,
  transitionCaptureState
};
