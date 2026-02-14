import { logger } from "./logger.js";

export class ProgressTracker {
  private steps: Map<string, { done: number; total: number }> = new Map();

  update(step: string, done: number, total: number): void {
    this.steps.set(step, { done, total });
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    logger.info(`  ${step}: ${done}/${total} (${pct}%)`);
  }

  complete(step: string, message?: string): void {
    logger.info(`  ${step}: ${message ?? "done"}`);
  }
}
