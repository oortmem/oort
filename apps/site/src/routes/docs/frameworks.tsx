import { createFileRoute, Link } from '@tanstack/react-router';
import { Cmd, Code } from '@/components/docs/CodeBlock';
import { DocsPage, DocsTable } from '@/components/docs/DocsPage';
import { FlowDiagram } from '@/components/docs/FlowDiagram';
import { Note } from '@/components/docs/Steps';
import { docsHead } from '@/lib/docs';

export const Route = createFileRoute('/docs/frameworks')({
  head: () => docsHead('/docs/frameworks'),
  component: Page,
});

// Each sample follows the framework's own MCP client docs, read on 2026-11-04 with Context7.
const aiSdk = `import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { generateText, isStepCount } from 'ai';

let client;

try {
  client = await createMCPClient({
    transport: new Experimental_StdioMCPTransport({
      command: 'oort',
      args: ['mcp', '--project', process.cwd()],
    }),
  });

  const tools = await client.tools();

  const { text } = await generateText({
    model: 'anthropic/claude-sonnet-5.5',
    tools,
    stopWhen: isStepCount(5),
    messages: [{ role: 'user', content: 'What did we decide about the deploy?' }],
  });

  console.log(text);
} finally {
  if (client) {
    await client.close();
  }
}`;

const langGraph = `import asyncio

from langchain.agents import create_agent
from langchain_mcp_adapters.client import MultiServerMCPClient


async def main():
    client = MultiServerMCPClient(
        {
            "oort": {
                "command": "oort",
                "args": ["mcp", "--project", "/path/to/repo"],
                "transport": "stdio",
            }
        }
    )
    tools = await client.get_tools()
    agent = create_agent("openai:gpt-4.1", tools)
    result = await agent.ainvoke({"messages": "What did we decide about the deploy?"})
    print(result["messages"][-1].content)


asyncio.run(main())`;

const openAiAgents = `import asyncio

from agents import Agent, Runner
from agents.mcp import MCPServerStdio


async def main():
    async with MCPServerStdio(
        name="Oort",
        params={
            "command": "oort",
            "args": ["mcp", "--project", "/path/to/repo"],
        },
    ) as oort:
        agent = Agent(
            name="Assistant",
            instructions="Use Oort to recall what the user told you before.",
            mcp_servers=[oort],
        )
        result = await Runner.run(agent, "What did we decide about the deploy?")
        print(result.final_output)


asyncio.run(main())`;

const mastra = `import { Agent } from '@mastra/core/agent';
import { MCPClient } from '@mastra/mcp';

const mcp = new MCPClient({
  servers: {
    oort: {
      command: 'oort',
      args: ['mcp', '--project', process.cwd()],
    },
  },
});

const agent = new Agent({
  id: 'assistant',
  name: 'Assistant',
  instructions: 'Use Oort to recall what the user told you before.',
  model: 'openai/gpt-4.1',
  tools: await mcp.listTools(),
});

const response = await agent.generate('What did we decide about the deploy?');
console.log(response.text);`;

const ownCode = `import { execFileSync } from 'node:child_process';

const repo = '/path/to/repo'; // the project comes from the folder

// Before the model call: recall what matters for this message.
const recalled = JSON.parse(
  execFileSync('oort', ['recall', '--json', userText], { cwd: repo, encoding: 'utf8' }),
);
const context = recalled.memories.map((m) => \`- \${m.text}\`).join('\\n');

// After the reply: send the finished turn through the write path.
execFileSync('oort', ['observe'], {
  cwd: repo,
  input: JSON.stringify({ userText, assistantText }),
});`;

function Page() {
  return (
    <DocsPage
      to="/docs/frameworks"
      lede={
        <p>
          Your agent framework can start <code>oort mcp</code> through its MCP client, like any
          other MCP server. Or call the <code>oort</code> CLI from your own code.
        </p>
      }
    >
      <FlowDiagram
        title="An agent framework with Oort"
        desc="Your agent code starts oort mcp through the framework's MCP client, or runs the oort CLI directly. Either way, memories stay in ~/.oort on your machine."
        nodes={[
          { label: 'Your agent code', sub: 'any framework' },
          { label: 'oort', sub: 'MCP server or CLI', tone: 'oort' },
          { label: 'Memory', sub: '~/.oort', tone: 'store' },
        ]}
        machine={[0, 2]}
      />

      <p>
        Every example below needs the CLI on your PATH (<code>npm i -g oortmem</code>). Each one
        passes <code>--project</code> so the agent sees one project's memories, plus global ones.
        Recall works without keys. Saving new memories needs <Link to="/docs/pro">Oort Pro</Link>{' '}
        or <Link to="/docs/own-keys">your own keys</Link>.
      </p>

      <h2>Vercel AI SDK</h2>
      <Cmd>npm i ai @ai-sdk/mcp</Cmd>
      <Code caption="TypeScript">{aiSdk}</Code>
      <p>
        <code>client.tools()</code> turns Oort's MCP tools into AI SDK tools.{' '}
        <code>stopWhen</code> lets the model call <code>recall</code> and then answer. Close the
        client when you are done, so the <code>oort mcp</code> process ends.
      </p>

      <h2>LangGraph</h2>
      <Cmd>pip install langchain-mcp-adapters langchain langchain-openai</Cmd>
      <Code caption="Python">{langGraph}</Code>
      <p>
        <code>MultiServerMCPClient</code> loads Oort's tools as LangChain tools, and{' '}
        <code>create_agent</code> runs them in a LangGraph agent. Without a long-lived session,
        the adapter starts a new <code>oort mcp</code> for each tool call.
      </p>

      <h2>OpenAI Agents SDK</h2>
      <Cmd>pip install openai-agents</Cmd>
      <Code caption="Python">{openAiAgents}</Code>
      <p>
        <code>MCPServerStdio</code> starts <code>oort mcp</code> and stops it when the{' '}
        <code>async with</code> block ends.
      </p>

      <h2>Mastra</h2>
      <Cmd>npm i @mastra/core @mastra/mcp</Cmd>
      <Code caption="TypeScript">{mastra}</Code>
      <p>
        <code>listTools()</code> names each tool after its server, so the agent sees{' '}
        <code>oort_recall</code>, <code>oort_remember</code> and so on.
      </p>

      <h2>Your own code</h2>
      <p>No framework? Run the CLI. Recall before the model call, and observe after it.</p>
      <Cmd>
        {
          '# memories for a question, as JSON\noort recall --json "how do we deploy?"\n# run one finished turn through the write path\noort observe --user "We deploy from main with wrangler." --assistant "Noted."'
        }
      </Cmd>
      <p>
        Without <code>--json</code>, <code>oort recall</code> prints an{' '}
        <code>{'<oort-memory>'}</code> block you can put straight into a prompt.{' '}
        <code>oort observe</code> also reads one turn as JSON on stdin:
      </p>
      <Cmd>
        {
          'echo \'{"userText": "We deploy from main with wrangler.", "assistantText": "Noted."}\' | oort observe'
        }
      </Cmd>
      <p>The same two calls from Node.js:</p>
      <Code caption="TypeScript">{ownCode}</Code>
      <DocsTable
        head={['Command', 'Prints']}
        rows={[
          [
            <code>oort recall --json</code>,
            <>
              <code>memories</code>, each with <code>id</code>, <code>text</code>,{' '}
              <code>type</code>, <code>tier</code> and an <code>explanation</code> of its ranks.
            </>,
          ],
          [
            <code>oort observe</code>,
            <>
              The <code>outcome</code> (<code>added</code>, <code>reinforced</code>,{' '}
              <code>updated</code>, <code>superseded</code> or <code>skipped</code>), the memory id
              and the decisions behind it.
            </>,
          ],
          [
            <code>oort observe --dry-run</code>,
            'What the scrubber would redact. It saves nothing and calls no provider.',
          ],
        ]}
      />

      <Note title="Run it in the project folder">
        <p>
          The CLI reads the project of the folder it runs in, plus global memories. Set the working
          directory, as the Node.js example does with <code>cwd</code>.
        </p>
      </Note>
    </DocsPage>
  );
}
