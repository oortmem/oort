import { handleRelay, type RelayEnv, type WaitUntilLike } from './relay.js';

export default {
  fetch(request: Request, env: RelayEnv, ctx: WaitUntilLike): Promise<Response> {
    return handleRelay(request, env, ctx);
  },
};
