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
