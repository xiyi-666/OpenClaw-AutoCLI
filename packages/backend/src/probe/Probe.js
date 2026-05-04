import { EventEmitter } from 'node:events';

export class Probe extends EventEmitter {
  constructor(session, orchestrator, { maxRetry = 5, tokenThreshold = 80_000 } = {}) {
    super();
    this.session = session;
    this.orchestrator = orchestrator;
    this.retryCount = 0;
    this.maxRetry = maxRetry;
    this.tokenThreshold = tokenThreshold;

    session.on('output', (data) => this.analyze(data));
    session.on('exit', () => this.handleExit());
  }

  analyze(data) {
    this.session.tokenCount += Math.ceil(data.length / 4);

    if (this.session.tokenCount > this.tokenThreshold) {
      this.orchestrator?.compressContext?.(this.session);
      this.emit('probe:compact', { sessionId: this.session.id, tokenCount: this.session.tokenCount });
    }

    if (/error|failed|exception/i.test(data)) {
      this.handleError(data);
      return;
    }

    if (/task complete|done|finished/i.test(data)) {
      this.orchestrator?.onTaskComplete?.(this.session, data);
      this.emit('probe:complete', { sessionId: this.session.id, data });
    }
  }

  handleError(data) {
    this.retryCount += 1;
    if (this.retryCount > this.maxRetry) {
      this.orchestrator?.escalate?.(this.session, data);
      this.emit('probe:escalate', { sessionId: this.session.id, data, retryCount: this.retryCount });
      return;
    }
    this.orchestrator?.requestFix?.(this.session, data);
    this.emit('probe:fix-request', { sessionId: this.session.id, data, retryCount: this.retryCount });
  }

  handleExit() {
    if (this.session.status !== 'done') {
      this.orchestrator?.recoverSession?.(this.session);
      this.emit('probe:recover', { sessionId: this.session.id });
    }
  }
}
