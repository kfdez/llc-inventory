const { randomUUID } = require("crypto");
const { CAPTURE_STATES } = require("./captureStates");
const { transitionCaptureState } = require("./captureStateMachine");

class CaptureService {
  constructor({ store, appsScriptClient, discordAdapter, logger, dryRun = true }) {
    this.store = store;
    this.appsScriptClient = appsScriptClient;
    this.discordAdapter = discordAdapter;
    this.logger = logger;
    this.dryRun = dryRun;
  }

  requestStart({ organizerKey, sessionName, requestedBy }) {
    const id = randomUUID();
    const session = this.store.upsertCaptureSession({
      id,
      state: CAPTURE_STATES.START_REQUESTED,
      requestedName: sessionName || "",
      discordThreadId: "",
      discordThreadName: "",
      appsScriptSession: {}
    });
    const job = this.store.createJob({
      type: "capture.start",
      state: "pending",
      payload: {
        captureSessionId: id,
        organizerKey,
        sessionName,
        requestedBy
      }
    });
    return { session, job };
  }

  requestStop({ captureSessionId, requestedBy }) {
    const session = this.store.getCaptureSession(captureSessionId);
    if (!session) {
      throw new Error("Capture session not found: " + captureSessionId);
    }
    const nextSession = transitionCaptureState(session, CAPTURE_STATES.STOP_REQUESTED);
    this.store.upsertCaptureSession(nextSession);
    const job = this.store.createJob({
      type: "capture.stop",
      state: "pending",
      payload: {
        captureSessionId,
        requestedBy
      }
    });
    return { session: this.store.getCaptureSession(captureSessionId), job };
  }

  requestStopLatest({ requestedBy }) {
    const session = this.store.findLatestCaptureSessionByStates([
      CAPTURE_STATES.ACTIVE
    ]);
    if (!session) {
      throw new Error("No active or starting capture session found.");
    }
    return this.requestStop({
      captureSessionId: session.id,
      requestedBy
    });
  }

  getStatus() {
    const activeSession = this.store.findLatestCaptureSessionByStates([
      CAPTURE_STATES.ACTIVE,
      CAPTURE_STATES.VERIFYING_AFTER_TIMEOUT,
      CAPTURE_STATES.APPS_SCRIPT_STARTING,
      CAPTURE_STATES.DISCORD_THREAD_CREATED,
      CAPTURE_STATES.START_REQUESTED,
      CAPTURE_STATES.STOP_REQUESTED,
      CAPTURE_STATES.APPS_SCRIPT_STOPPING
    ]);
    const recentJobs = this.store.listJobs({ limit: 10 });
    return {
      activeSession,
      recentJobs
    };
  }

  getActiveSessionForThread(threadId) {
    return this.store.findCaptureSessionByDiscordThreadId(threadId, [
      CAPTURE_STATES.ACTIVE
    ]);
  }

  async processStartJob(job) {
    const session = this.requireSession(job);
    let current = session;

    if (!current.discordThreadId) {
      const thread = await this.discordAdapter.createCaptureThread({
        organizerKey: job.payload.organizerKey,
        sessionName: job.payload.sessionName,
        requestedBy: job.payload.requestedBy
      });
      current = transitionCaptureState(current, CAPTURE_STATES.DISCORD_THREAD_CREATED, {
        discordThreadId: thread.id,
        discordThreadName: thread.name
      });
      this.store.upsertCaptureSession(current);
    }

    current = transitionCaptureState(current, CAPTURE_STATES.APPS_SCRIPT_STARTING);
    this.store.upsertCaptureSession(current);

    if (this.dryRun) {
      current = transitionCaptureState(current, CAPTURE_STATES.ACTIVE, {
        appsScriptSession: {
          session_id: current.id,
          session_name: current.requestedName || current.discordThreadName || "Dry run",
          sheet_tab_name: "DRY RUN"
        }
      });
      this.store.upsertCaptureSession(current);
      return this.store.updateJob(job.id, {
        state: "completed",
        result: { captureSessionId: current.id, dryRun: true },
        lockedUntilMs: 0
      });
    }

    const response = await this.appsScriptClient.startCaptureSession({
      threadId: current.discordThreadId,
      sessionName: current.requestedName || current.discordThreadName,
      startedBy: job.payload.requestedBy
    });

    current = transitionCaptureState(current, CAPTURE_STATES.ACTIVE, {
      appsScriptSession: response.session || {}
    });
    this.store.upsertCaptureSession(current);
    return this.store.updateJob(job.id, {
      state: "completed",
      result: { captureSessionId: current.id, appsScript: response },
      lockedUntilMs: 0
    });
  }

  async processStopJob(job) {
    const session = this.requireSession(job);
    let current = transitionCaptureState(session, CAPTURE_STATES.APPS_SCRIPT_STOPPING);
    this.store.upsertCaptureSession(current);

    if (!this.dryRun) {
      await this.appsScriptClient.stopCaptureSession({
        threadId: current.discordThreadId,
        endedBy: job.payload.requestedBy
      });
    }

    current = transitionCaptureState(current, CAPTURE_STATES.STOPPED);
    this.store.upsertCaptureSession(current);
    return this.store.updateJob(job.id, {
      state: "completed",
      result: { captureSessionId: current.id, dryRun: this.dryRun },
      lockedUntilMs: 0
    });
  }

  async processNextJob() {
    const startJob = this.store.claimNextJob({
      type: "capture.start",
      states: ["pending"],
      leaseMs: 120000
    });
    if (startJob) {
      return this.withJobFailureHandling(startJob, () => this.processStartJob(startJob));
    }

    const stopJob = this.store.claimNextJob({
      type: "capture.stop",
      states: ["pending"],
      leaseMs: 120000
    });
    if (stopJob) {
      return this.withJobFailureHandling(stopJob, () => this.processStopJob(stopJob));
    }

    return null;
  }

  async withJobFailureHandling(job, handler) {
    try {
      return await handler();
    } catch (error) {
      const session = this.store.getCaptureSession(job.payload.captureSessionId);
      if (session) {
        this.store.upsertCaptureSession(transitionCaptureState(session, CAPTURE_STATES.FAILED, {
          appsScriptSession: session.appsScriptSession
        }));
      }
      this.logger && this.logger.error({ err: error, jobId: job.id }, "Capture job failed.");
      return this.store.updateJob(job.id, {
        state: "failed",
        error: error.message,
        lockedUntilMs: 0
      });
    }
  }

  requireSession(job) {
    const session = this.store.getCaptureSession(job.payload.captureSessionId);
    if (!session) {
      throw new Error("Capture session not found for job: " + job.id);
    }
    return session;
  }
}

module.exports = {
  CaptureService
};
