import * as net from 'node:net';

/**
 * The examples' tests never reach a network: every model is a framework's own fake and Oort
 * Cloud is the shared in-process fake. Real keys are removed, fetch refuses, and so does any TCP
 * connect (a pipe, as the test runner may use, still works).
 */
for (const name of [
  'OORT_API_KEY',
  'OORT_CLOUD_URL',
  'OORT_HOME',
  'OORT_AGENT',
  'VOYAGE_API_KEY',
  'TYPESAFE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AI_GATEWAY_API_KEY',
  'LANGSMITH_API_KEY',
]) {
  delete process.env[name];
}
process.env['OORT_NO_KEYCHAIN'] = '1';
process.env['LANGSMITH_TRACING'] = 'false';
process.env['OPENAI_AGENTS_DISABLE_TRACING'] = '1';

const refuse = (what: string): never => {
  throw new Error(`a network call in the examples' tests: ${what}`);
};
globalThis.fetch = (async (input: string | URL | Request) =>
  refuse(`fetch ${String(input instanceof Request ? input.url : input)}`)) as typeof fetch;

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
  const pipe =
    (typeof first === 'string' && !/^\d+$/.test(first)) ||
    (typeof first === 'object' && first !== null && 'path' in first);
  if (!pipe) refuse('a TCP connect');
  return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof connect;
