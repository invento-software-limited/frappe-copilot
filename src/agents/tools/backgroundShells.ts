import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { ToolResult, ok, fail } from './result';

const MAX_BUFFER_CHARS = 2_000_000;
const MAX_READ_CHARS = 30_000;

interface Shell {
  command: string;
  proc: ChildProcess;
  output: string;
  /** Characters of `output` already returned by command_output. */
  readTo: number;
  exitCode: number | null;
  startedAt: number;
}

/** Long-running commands (bench start, watch builds, dev servers) started
 *  with run_in_background and polled via command_output / kill_command. */
export class BackgroundShells {
  private shells = new Map<string, Shell>();
  private seq = 0;

  start(command: string, cmdToRun: string, options: SpawnOptions): ToolResult {
    const id = `bg_${++this.seq}`;
    const proc = spawn(cmdToRun, [], { ...options, detached: process.platform !== 'win32' });
    const shell: Shell = { command, proc, output: '', readTo: 0, exitCode: null, startedAt: Date.now() };
    const append = (d: Buffer) => {
      shell.output += d.toString();
      if (shell.output.length > MAX_BUFFER_CHARS) {
        const drop = shell.output.length - MAX_BUFFER_CHARS;
        shell.output = shell.output.slice(drop);
        shell.readTo = Math.max(0, shell.readTo - drop);
      }
    };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);
    proc.on('close', code => { shell.exitCode = code ?? -1; });
    proc.on('error', err => { shell.output += `\n[failed to start: ${err.message}]`; shell.exitCode = -1; });
    this.shells.set(id, shell);
    return ok(`Started in background with id '${id}'. Use command_output with this id to read its output, and kill_command to stop it.`);
  }

  read(id: string, filter?: string): ToolResult {
    const shell = this.shells.get(id);
    if (!shell) return fail(`No background command '${id}'. Known: ${[...this.shells.keys()].join(', ') || 'none'}`);
    let fresh = shell.output.slice(shell.readTo);
    shell.readTo = shell.output.length;
    if (filter) {
      try {
        const re = new RegExp(filter);
        fresh = fresh.split('\n').filter(l => re.test(l)).join('\n');
      } catch (e: any) {
        return fail(`Invalid filter regex: ${e.message}`);
      }
    }
    if (fresh.length > MAX_READ_CHARS) fresh = `… (${fresh.length - MAX_READ_CHARS} earlier chars omitted)\n` + fresh.slice(-MAX_READ_CHARS);
    const secs = Math.round((Date.now() - shell.startedAt) / 1000);
    const status = shell.exitCode === null ? `running (${secs}s)` : `exited with code ${shell.exitCode}`;
    return ok(`[${id}: ${shell.command}] status: ${status}\n${fresh || '(no new output)'}`);
  }

  kill(id: string): ToolResult {
    const shell = this.shells.get(id);
    if (!shell) return fail(`No background command '${id}'.`);
    if (shell.exitCode === null) killTree(shell.proc);
    this.shells.delete(id);
    return ok(`Stopped '${id}' (${shell.command}).`);
  }

  disposeAll(): void {
    for (const id of [...this.shells.keys()]) this.kill(id);
  }
}

/** Kills the whole process group, since shell:true puts the real command
 *  in a child of the shell we spawned. */
export function killTree(proc: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, 'SIGTERM');
    else proc.kill('SIGTERM');
  } catch {
    proc.kill('SIGTERM');
  }
}
