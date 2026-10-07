import Module = require('module');
import * as stub from './vscodeStub';

/** Loaded with `node --require` before any test: answers `require('vscode')`
 *  with the stub, since the real module only exists inside VS Code. */
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const original = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return stub;
  return original.call(this, request, ...rest);
};
