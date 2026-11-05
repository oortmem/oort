import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { cloudSpaces, createOortServer, localSpaces } from '../mcp.js';
import { Refusal, echo, withWired, type Ctx } from '../util.js';

/** Serves `factory` on this process's stdin/stdout until the host closes stdin. */
export type ServeFn = (factory: () => McpServer, onError: (e: Error) => void) => Promise<void>;

const serveProcessStdio: ServeFn = async (factory, onError) => {
  const ended = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve).once('close', resolve);
  });
  const handle = serveStdio(factory, { onerror: onError });
  await ended;
  await handle.close();
};

/**
 * `oort mcp [--project <dir>]`: the local MCP server on stdio, for hosts to
 * start. Its scope is the project of the directory it starts in (a host
 * starts it in the workspace, or the config passes `--project`), resolved
 * through the same trust rules as every other command; outside a repository
 * it is global. stdout carries only MCP messages; diagnostics go to stderr.
 */
export async function mcpCommand(
  opts: { project?: string },
  ctx: Ctx,
  serve: ServeFn = serveProcessStdio,
): Promise<number> {
  let cwd = ctx.io.cwd;
  if (opts.project !== undefined && (opts.project === '' || /\$\{[^}]*\}/.test(opts.project))) {
    // `connect` writes `--project ${workspaceFolder}` for Cursor and VS Code; a host that
    // leaves it as is (or empty, with no folder open) gets the directory it started us in.
    ctx.io.err(
      `oort: the host did not fill in --project ${echo(opts.project)}; using the directory it started oort in.\n`,
    );
  } else if (opts.project !== undefined) {
    cwd = path.resolve(ctx.io.cwd, opts.project);
    if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Refusal(`--project ${echo(opts.project)} is not a directory.`);
    }
  }
  if (ctx.io.stdinIsTTY) {
    ctx.io.err(
      'oort: `oort mcp` speaks MCP on stdin and stdout for an agent host to start; add it to one with `oort connect <host>`.\n',
    );
  }
  return withWired({ ...ctx, io: { ...ctx.io, cwd } }, async (w) => {
    // What the tools may reach is fixed here, once, from trusted config (CON-64): the model can
    // pick inside it and never widen it.
    const spaces =
      w.mode === 'cloud' && w.cloud !== undefined ? await cloudSpaces(w, w.cloud) : localSpaces(w);
    await serve(
      () => createOortServer({ wired: w, spaces }),
      (e) => ctx.io.err(`oort: mcp: ${e.message}\n`),
    );
    return 0;
  });
}
