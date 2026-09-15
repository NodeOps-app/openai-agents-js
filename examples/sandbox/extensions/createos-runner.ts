import { Runner } from '@openai/agents';
import { CreateOSSandboxClient } from '@openai/agents-extensions/sandbox/createos';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { finished } from 'node:stream/promises';
import {
  DEFAULT_MODEL,
  getOptionalStringArg,
  getStringArg,
  hasFlag,
  requireEnv,
  requireOpenAIKey,
  runExampleMain,
} from '../support';

const DEFAULT_QUESTION =
  'Summarize this cloud sandbox workspace in 2 sentences.';
const DEFAULT_SHAPE = 's-1vcpu-1gb';

function buildManifest(): Manifest {
  return new Manifest({
    entries: {
      'README.md': {
        type: 'file',
        content: `# CreateOS Demo Workspace

This workspace validates the CreateOS sandbox backend.
`,
      },
      'project/status.md': {
        type: 'file',
        content: `# Project Status

- Backend: CreateOS cloud sandbox
- Persistence: portable workspace tar archives
- Lifecycle: optional pause-on-exit and serialized session resume
`,
      },
    },
    environment: {
      DEMO_ENV: 'createos-agent-demo',
    },
  });
}

async function main() {
  requireOpenAIKey();
  requireEnv('CREATEOS_SANDBOX_API_KEY');
  requireEnv('CREATEOS_SANDBOX_BASE_URL');

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const shape = getStringArg('--shape', DEFAULT_SHAPE);
  const rootfs = getOptionalStringArg('--rootfs');
  const pauseOnExit = hasFlag('--pause-on-exit');
  const stream = hasFlag('--stream');
  const client = new CreateOSSandboxClient({ shape, rootfs, pauseOnExit });
  const agent = new SandboxAgent({
    name: 'CreateOS Sandbox Assistant',
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect the files before answering, keep the response concise, and cite the file names you inspected.',
    defaultManifest: buildManifest(),
    capabilities: [shell()],
  });
  const runner = new Runner({
    workflowName: 'CreateOS sandbox example',
    sandbox: { client },
  });

  if (!stream) {
    const result = await runner.run(agent, question);
    console.log(result.finalOutput);
    return;
  }

  const result = await runner.run(agent, question, { stream: true });
  process.stdout.write('assistant> ');
  const textStream = result.toTextStream({ compatibleWithNodeStreams: true });
  textStream.pipe(process.stdout);
  await finished(textStream);
  await result.completed;
  process.stdout.write('\n');
}

await runExampleMain(main);
