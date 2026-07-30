import { execSync } from 'child_process';
import * as vscode from 'vscode';
import { BenchEnvironment } from '../types';
import { findBenchDir } from '../workspace/structure';

/** Options for the bench detector. */
interface DetectOptions {
  /** Force re-detection even if already cached. */
  force?: boolean;
}

/**
 * Bench environment detector.
 *
 * Detection strategy:
 * 1. Check if a manual path is configured in VS Code settings → use that.
 * 2. Try local `bench --version` on host → found on host.
 * 3. Look for frappe Docker containers → found in Docker.
 * 4. None of the above → not-found.
 */
export class BenchDetector {
  private cached: BenchEnvironment | null = null;

  /** Run detection and return the result. */
  async detect(options: DetectOptions = {}): Promise<BenchEnvironment> {
    if (this.cached && !options.force) {
      return this.cached;
    }

    // 1. Check user-configured settings first
    const configured = this.checkConfigured();
    if (configured) {
      this.cached = configured;
      return configured;
    }

    // 2. Try host detection
    const hostResult = this.detectHost();
    if (hostResult) {
      this.cached = hostResult;
      return hostResult;
    }

    // 3. Try Docker detection
    const dockerResult = await this.detectDocker();
    if (dockerResult) {
      this.cached = dockerResult;
      return dockerResult;
    }

    // 4. Not found
    this.cached = {
      type: 'not-found',
      message: 'No bench environment detected. Install bench or start your Frappe Docker containers.',
    };
    return this.cached;
  }

  /** Clear the cached detection result (forces re-detection on next call). */
  clearCache(): void {
    this.cached = null;
  }

  /** Check if the user has manually configured paths in settings. */
  private checkConfigured(): BenchEnvironment | null {
    const config = vscode.workspace.getConfiguration('frappe-copilot.bench');

    const dockerContainer = config.get<string>('dockerContainerName', '');
    const hostPath = config.get<string>('hostPath', '');
    const benchDir = config.get<string>('frappeBenchPath', '');

    // If Docker container is specified, use that
    if (dockerContainer) {
      try {
        execSync(`docker ps --filter "name=${dockerContainer}" --format "{{.ID}}"`, {
          timeout: 5000,
          stdio: 'pipe',
        });
        const dir = benchDir || '/home/frappe/frappe-bench';
        return {
          type: 'docker',
          containerId: dockerContainer,
          containerName: dockerContainer,
          benchDir: dir,
        };
      } catch {
        // Container not running, fall through
      }
    }

    // If host path is specified, use that
    if (hostPath) {
      try {
        execSync(`"${hostPath}" --version`, { timeout: 5000, stdio: 'pipe' });
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
        const dir = benchDir || findBenchDir(wsPath);
        return {
          type: 'host',
          benchPath: hostPath,
          benchDir: dir,
        };
      } catch {
        // Bench not at that path, fall through
      }
    }

    return null;
  }

  /** Try to find bench on the host machine. */
  private detectHost(): BenchEnvironment | null {
    try {
      const output = execSync('which bench', {
        timeout: 5000,
        stdio: 'pipe',
        windowsHide: true,
      }).toString().trim();

      if (output) {
        const benchPath = output;
        let benchDir = '';
        try {
          execSync('bench --version', {
            timeout: 5000,
            stdio: 'pipe',
            windowsHide: true,
          }).toString().trim();

          // bench is available — resolve the bench directory
          const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
          benchDir = findBenchDir(wsPath);
        } catch {
          const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
          benchDir = findBenchDir(wsPath);
        }

        return {
          type: 'host',
          benchPath,
          benchDir,
        };
      }
    } catch {
      // bench not found on host
    }

    return null;
  }

  /** Try to find bench running inside a frappe_docker container. */
  private async detectDocker(): Promise<BenchEnvironment | null> {
    try {
      // Check if Docker is available
      execSync('docker --version', { timeout: 5000, stdio: 'pipe' });
    } catch {
      return null; // Docker not installed
    }

    // Look for frappe containers — check multiple possible names
    const searchPatterns = ['frappe', 'frappe-worker', 'frappe-default', 'backend'];

    for (const pattern of searchPatterns) {
      try {
        const output = execSync(
          `docker ps --filter "name=${pattern}" --format "{{.ID}}\t{{.Names}}" --latest`,
          { timeout: 5000, stdio: 'pipe' }
        ).toString().trim();

        if (output) {
          const [containerId, containerName] = output.split('\t');

          // 1. Get container's default active directory path using pwd command
          let defaultDir = '/home/frappe/frappe-bench';
          try {
            const pwdOutput = execSync(`docker exec ${containerId} pwd`, { timeout: 5000, stdio: 'pipe' }).toString().trim();
            if (pwdOutput && pwdOutput.startsWith('/')) {
              defaultDir = pwdOutput;
            }
          } catch {
            // Use fallback /home/frappe/frappe-bench if pwd execution errors out
          }

          // 2. Verify bench is available inside the resolved path
          try {
            execSync(
              `docker exec -w ${defaultDir} ${containerId} bench --version`,
              { timeout: 10000, stdio: 'pipe' }
            );

            return {
              type: 'docker',
              containerId,
              containerName,
              benchDir: defaultDir,
            };
          } catch {
            // If the automated path verification fails, ask the user to provide the correct path!
            const userInput = await vscode.window.showInputBox({
              prompt: `Frappe Copilot: Enter the absolute path of the bench directory inside the Docker container '${containerName}' (run 'pwd' inside the container to verify).`,
              placeHolder: '/home/frappe/frappe-bench',
              value: defaultDir,
              ignoreFocusOut: true
            });

            if (userInput) {
              return {
                type: 'docker',
                containerId,
                containerName,
                benchDir: userInput.trim(),
              };
            }
          }
        }
      } catch {
        // No container matched this pattern
        continue;
      }
    }

    return null;
  }
}

/**
 * Quick synchronous check: is bench available on the host?
 * Used for fast status indicator updates.
 */
export function isBenchAvailableOnHost(): boolean {
  try {
    const result = execSync('which bench', {
      timeout: 3000,
      stdio: 'pipe',
      windowsHide: true,
    });
    return result.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Quick check: is Docker running with frappe containers?
 */
export function isDockerFrappeRunning(): boolean {
  try {
    const result = execSync(
      'docker ps --filter "name=frappe" --format "{{.ID}}" --latest',
      { timeout: 5000, stdio: 'pipe' }
    );
    return result.toString().trim().length > 0;
  } catch {
    return false;
  }
}
