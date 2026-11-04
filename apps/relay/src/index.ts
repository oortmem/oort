import { handleRelay, type RelayEnv, type WaitUntilLike } from './relay.js';

export default {
  /**
   * Invocation logs are off (wrangler.jsonc), so this line is all Workers Logs keep for a request:
   * the status and how long it took. No URL, header, IP, key or body.
   */
  async fetch(request: Request, env: RelayEnv, ctx: WaitUntilLike): Promise<Response> {
    const started = Date.now();
    const res = await handleRelay(request, env, ctx);
    console.log(JSON.stringify({ status: res.status, ms: Date.now() - started }));
    return res;
  },
};
