import { execSync } from "node:child_process";
import { logger } from "./logger.js";

export function getChangedFiles(projectRoot: string): string[] | null {
  try {
    const output = execSync("git diff --name-only HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
    });
    return output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function getCurrentBranch(projectRoot: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

export function getCurrentCommit(projectRoot: string): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}
