import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Cmd, Code } from './CodeBlock';
import { FlowDiagram } from './FlowDiagram';
import { Step, Steps } from './Steps';

/** The path Oort writes for `command`: the real location of the installed `oort` bin. */
export const BIN = '/abs/path/to/oort';

export interface HostGuideProps {
  /** The host name `oort connect` takes, such as `cursor`. */
  host: string;
  /** The product name, such as "Cursor". */
  name: string;
  /** How to restart the host, one sentence. */
  restart: string;
  /** How to see that Oort is connected. */
  check: ReactNode;
  /** Where Oort writes the entry, and what it writes. */
  file: string;
  entry: string;
}

/**
 * The common path for an MCP host: install, connect, restart, check. Then what Oort wrote and
 * how to undo it. Pages add their host's own notes after it.
 */
export function HostGuide({ host, name, restart, check, file, entry }: HostGuideProps) {
  return (
    <>
      <FlowDiagram
        title={`${name} with Oort`}
        desc={`${name} starts the oort mcp server on your machine over stdio. The server keeps your memories in ~/.oort, also on your machine.`}
        nodes={[
          { label: name, sub: 'your agent' },
          { label: 'oort mcp', sub: 'local MCP server', tone: 'oort' },
          { label: 'Memory', sub: '~/.oort', tone: 'store' },
        ]}
        edges={['stdio', undefined]}
        machine={[0, 2]}
      />

      <Steps>
        <Step title="Install the CLI.">
          <Cmd>npm i -g oortmem</Cmd>
          <p>Skip this if you already have it. Node.js 22.15 or newer.</p>
        </Step>
        <Step title={`Connect ${name}.`}>
          <Cmd>{`oort connect ${host}`}</Cmd>
          <p>
            Oort backs up the file, prints the change, then adds one server named{' '}
            <code>oort</code>. Add <code>--dry-run</code> to see the change without writing it.
          </p>
        </Step>
        <Step title={`Restart ${name}.`}>
          <p>{restart}</p>
        </Step>
        <Step title="Check it is connected.">{check}</Step>
      </Steps>

      <h2>What Oort writes</h2>
      <Code caption={file}>{entry}</Code>
      <p>
        <code>command</code> is the full path of your installed <code>oort</code>. The rest of
        the file stays as it was. The first change keeps a copy of the original next to it, ending
        in <code>.oort-backup</code>.
      </p>

      <h2>Undo</h2>
      <Cmd>{`oort disconnect ${host}`}</Cmd>
      <p>
        This removes only the <code>oort</code> entry. Your memories stay in{' '}
        <code>~/.oort</code>. If something does not work, see{' '}
        <Link to="/docs/troubleshooting">Troubleshooting</Link>.
      </p>
    </>
  );
}

/** Keys are needed for saving new memories; recall works on words alone without them. */
export function KeysLine() {
  return (
    <p>
      Recall works without keys, matching on words only. To save new memories, use{' '}
      <Link to="/docs/pro">Oort Pro</Link> or <Link to="/docs/own-keys">your own keys</Link>.
    </p>
  );
}
