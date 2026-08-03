import { execSync, ExecSyncOptions } from 'child_process';
import * as vscode from 'vscode';
import { BenchEnvironment, ResolvedCommand } from '../types';

/** Result of a bench command execution. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
  command: string;
}

/**
 * Bench command executor.
 * Routes commands to either the host shell or Docker exec
 * depending on the detected bench environment.
 */
export class BenchExecutor {
  constructor(private env: BenchEnvironment) {}

  /** Update the bench environment (after re-detection). */
  setEnvironment(env: BenchEnvironment): void {
    this.env = env;
  }

  /** Execute a resolved bench command and return the result. */
  async execute(command: ResolvedCommand): Promise<ExecResult> {
    const fullCommand = this.buildCommand(command.resolvedTemplate);

    // Show in VS Code terminal for visibility
    this.showInTerminal(fullCommand);

    try {
      const options: ExecSyncOptions = {
        timeout: 120000, // 2 min default timeout
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        stdio: 'pipe',
        windowsHide: true,
      };

      const stdout = execSync(fullCommand, options).toString();
      return {
        exitCode: 0,
        stdout,
        stderr: '',
        success: true,
        command: fullCommand,
      };
    } catch (error: any) {
      const stderr = error.stderr?.toString() || error.message || 'Unknown error';
      const stdout = error.stdout?.toString() || '';
      return {
        exitCode: error.status ?? 1,
        stdout,
        stderr,
        success: false,
        command: fullCommand,
      };
    }
  }

  /** Retrieve a list of sites in the bench. */
  async getSites(): Promise<string[]> {
    const isFile = (s: string) =>
      s.endsWith('.json') ||
      s.endsWith('.txt') ||
      s.endsWith('.conf') ||
      s.endsWith('.py') ||
      s.endsWith('.md') ||
      s.endsWith('.sh') ||
      s.endsWith('.yml') ||
      s.endsWith('.yaml');

    try {
      const fullCommand = this.buildCommand('bench list-sites');
      const stdout = execSync(fullCommand, { timeout: 10000, stdio: 'pipe', windowsHide: true }).toString();
      const sites = stdout
        .split(/\r?\n/)
        .map((s) => s.trim().replace(/^\*+\s*/, ''))
        .filter((s) => s.length > 0 && s !== 'assets' && !s.includes('warn') && !s.includes('error') && !s.includes('warning') && !s.includes('Error') && !isFile(s));
      if (sites.length > 0) {
        return Array.from(new Set(sites));
      }
    } catch {
      // Fall through to manual check
    }

    // Fallback: Check directories under sites/
    try {
      const ignored = ['assets', 'common_site_config.json', 'apps.txt', 'languages.txt', 'patches.txt', 'nginx.conf'];
      if (this.env.type === 'host' && this.env.benchDir) {
        const fs = require('fs');
        const path = require('path');
        const sitesPath = path.join(this.env.benchDir, 'sites');
        if (fs.existsSync(sitesPath)) {
          const rawSites = fs.readdirSync(sitesPath).filter((f: string) => {
            try {
              const stat = fs.statSync(path.join(sitesPath, f));
              return stat.isDirectory() && !ignored.includes(f) && !isFile(f);
            } catch {
              return false;
            }
          });
          return rawSites.map((s: string) => s.replace(/^\*+\s*/, '').trim());
        }
      } else if (this.env.type === 'docker' && this.env.containerId && this.env.benchDir) {
        const sitesPath = `${this.env.benchDir}/sites`;
        const rawCmd = `docker exec ${this.env.containerId} find ${sitesPath} -maxdepth 1 -type d`;
        const output = execSync(rawCmd, { timeout: 5000, stdio: 'pipe' }).toString();
        return output
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => s.split('/').pop() || '')
          .map((s) => s.replace(/^\*+\s*/, '').trim())
          .filter((s) => s.length > 0 && s !== 'sites' && s !== 'assets' && !ignored.includes(s) && !isFile(s));
      }
    } catch {
      // ignore
    }

    return [];
  }

  /** Execute a command silently in the bench environment and return stdout. */
  async executeSilent(rawCommand: string): Promise<string> {
    const fullCommand = this.buildCommand(rawCommand);
    try {
      const options: ExecSyncOptions = {
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
        stdio: 'pipe',
        windowsHide: true,
      };
      return execSync(fullCommand, options).toString().trim();
    } catch (error: any) {
      const msg = error.stderr?.toString() || error.message || 'Execution failed';
      const newErr = new Error(msg) as any;
      newErr.stdout = error.stdout?.toString();
      newErr.stderr = error.stderr?.toString();
      throw newErr;
    }
  }

  /** Execute a command and stream output via callback. */
  async executeWithOutput(
    command: ResolvedCommand,
    onOutput: (chunk: string) => void
  ): Promise<ExecResult> {
    const fullCommand = this.buildCommand(command.resolvedTemplate);

    this.showInTerminal(fullCommand);

    const { spawn } = require('child_process');

    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/sh';
      const shellFlag = isWin ? '/c' : '-c';

      const child = spawn(shell, [shellFlag, fullCommand], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        onOutput(chunk);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        onOutput(chunk);
      });

      child.on('close', (exitCode: number) => {
        resolve({
          exitCode: exitCode ?? 1,
          stdout,
          stderr,
          success: exitCode === 0,
          command: fullCommand,
        });
      });

      child.on('error', (err: Error) => {
        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message,
          success: false,
          command: fullCommand,
        });
      });
    });
  }

  /** Get the interactive form of a command (allocating TTY for docker). */
  getInteractiveCommand(rawCommand: string): string {
    switch (this.env.type) {
      case 'host': {
        if (this.env.benchDir) {
          return `cd ${this.escapePath(this.env.benchDir)} && ${rawCommand}`;
        }
        return rawCommand;
      }
      case 'docker': {
        const containerId = this.env.containerId;
        const workdir = this.env.benchDir;
        return `docker exec -it -w ${workdir} ${containerId} ${rawCommand}`;
      }
      default:
        return rawCommand;
    }
  }

  /** Run a command interactively in a dedicated VS Code terminal. */
  runInteractive(rawCommand: string, name: string): void {
    const fullCommand = this.getInteractiveCommand(rawCommand);
    const terminal = vscode.window.createTerminal({ name });
    terminal.show();
    terminal.sendText(fullCommand);
  }

  /** Prefix/transform the command based on the environment. */
  private buildCommand(rawCommand: string): string {
    switch (this.env.type) {
      case 'host': {
        // On host, prepend with cd to bench dir if known
        if (this.env.benchDir) {
          // We use a subshell so the cd only applies to this command
          return `cd ${this.escapePath(this.env.benchDir)} && ${rawCommand}`;
        }
        return rawCommand;
      }

      case 'docker': {
        // Route through docker exec
        const containerId = this.env.containerId;
        const workdir = this.env.benchDir;
        // If the command contains shell metacharacters like pipe or redirection, run it via sh -c
        if (rawCommand.includes('|') || rawCommand.includes('&&') || rawCommand.includes('>') || rawCommand.includes('<')) {
          const escapedCommand = rawCommand.replace(/'/g, "'\\''");
          return `docker exec -w ${workdir} ${containerId} sh -c '${escapedCommand}'`;
        }
        return `docker exec -w ${workdir} ${containerId} ${rawCommand}`;
      }

      case 'not-found':
      default:
        throw new Error(
          `Cannot execute bench command: ${this.env.message || 'No bench environment available'}`
        );
    }
  }

  /** Show the command in a VS Code terminal for visibility. */
  private showInTerminal(command: string): void {
    const terminal = vscode.window.createTerminal('Frappe Bench');
    terminal.show(false); // Don't focus, just show
    terminal.sendText(`# Frappe Copilot executing:\n${command}`);
  }

  /** Escape a path for the shell. */
  private escapePath(path: string): string {
    if (process.platform === 'win32') {
      // Windows: wrap in quotes if it has spaces
      return path.includes(' ') ? `"${path}"` : path;
    }
    // Unix: escape spaces and special chars
    return path.replace(/([^a-zA-Z0-9._/-])/g, '\\$1');
  }
}

/** Check if a bench command needs user confirmation before running. */
export function requiresConfirmation(command: ResolvedCommand): boolean {
  return command.command.destructive;
}
