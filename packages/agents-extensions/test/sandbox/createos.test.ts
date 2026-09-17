import {
  Manifest,
  SandboxUnsupportedFeatureError,
} from '@openai/agents-core/sandbox';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CreateOSSandboxClient } from '../../src/sandbox/createos';
import {
  resolvedRemoteEffectivePathFromCommand,
  resolvedRemotePathFromValidationCommand,
} from './remotePathValidation';
import { makeTarArchive } from './tarFixture';

const mocks = vi.hoisted(() => ({
  clientOptions: vi.fn(),
  createSandbox: vi.fn(),
  getSandbox: vi.fn(),
  runCommand: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  refresh: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  destroy: vi.fn(),
  waitUntilRunning: vi.fn(),
  waitUntilPaused: vi.fn(),
  waitUntilDestroyed: vi.fn(),
  previewUrl: vi.fn(),
  processCreate: vi.fn(),
  processConnect: vi.fn(),
  processInput: vi.fn(),
  processDelete: vi.fn(),
}));

vi.mock('@nodeops-createos/sandbox', () => ({
  CreateosSandboxClient: class {
    constructor(options: unknown) {
      mocks.clientOptions(options);
    }

    createSandbox = mocks.createSandbox;
    getSandbox = mocks.getSandbox;
  },
}));

const files = new Map<string, string | Uint8Array>();
let sandboxStatus = 'running';

const sandbox = {
  id: 'sb_createos_test',
  get status() {
    return sandboxStatus;
  },
  files: {
    upload: mocks.upload,
    download: mocks.download,
  },
  runCommand: mocks.runCommand,
  refresh: mocks.refresh,
  pause: mocks.pause,
  resume: mocks.resume,
  destroy: mocks.destroy,
  waitUntilRunning: mocks.waitUntilRunning,
  waitUntilPaused: mocks.waitUntilPaused,
  waitUntilDestroyed: mocks.waitUntilDestroyed,
  previewUrl: mocks.previewUrl,
  processes: {
    create: mocks.processCreate,
    connect: mocks.processConnect,
    input: mocks.processInput,
    delete: mocks.processDelete,
  },
};

describe('CreateOSSandboxClient', () => {
  beforeEach(() => {
    files.clear();
    sandboxStatus = 'running';
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.createSandbox.mockResolvedValue(sandbox);
    mocks.getSandbox.mockResolvedValue(sandbox);
    mocks.upload.mockImplementation(
      async (path: string, content: string | Uint8Array) => {
        files.set(path, content);
      },
    );
    mocks.download.mockImplementation(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error('not found');
      }
      const bytes =
        typeof content === 'string'
          ? new TextEncoder().encode(content)
          : content;
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    });
    mocks.runCommand.mockImplementation(
      async (_cmd: string, args: string[]) => {
        const command = args[args.length - 1] ?? '';
        const resolvedPath =
          resolvedRemotePathFromValidationCommand(command) ??
          resolvedRemoteEffectivePathFromCommand(command);
        if (resolvedPath) {
          return response(`${resolvedPath}\n`);
        }
        const move = command.match(/mv -f -- '([^']+)' '([^']+)'$/u);
        if (move) {
          files.set(move[2], files.get(move[1]) ?? '');
          files.delete(move[1]);
        }
        if (command.endsWith('&& pwd')) {
          return response('/workspace\n');
        }
        if (command.endsWith('&& echo hello')) {
          return response('hello\n');
        }
        return response();
      },
    );
    mocks.refresh.mockResolvedValue(sandbox);
    mocks.pause.mockImplementation(async () => {
      sandboxStatus = 'paused';
      return sandbox;
    });
    mocks.resume.mockImplementation(async () => {
      sandboxStatus = 'running';
      return sandbox;
    });
    mocks.destroy.mockImplementation(async () => {
      sandboxStatus = 'destroyed';
      return { status: 'destroyed' };
    });
    mocks.waitUntilRunning.mockResolvedValue(sandbox);
    mocks.waitUntilPaused.mockResolvedValue(sandbox);
    mocks.waitUntilDestroyed.mockResolvedValue(sandbox);
    mocks.previewUrl.mockReturnValue(
      'https://sb-createos-test-8080.example.test',
    );
    mocks.processCreate.mockResolvedValue({ process_id: 'process_test' });
    mocks.processConnect.mockImplementation(async function* () {
      yield { type: 'heartbeat' };
    });
    mocks.processInput.mockResolvedValue({ input_seq: 1 });
    mocks.processDelete.mockResolvedValue({
      process_id: 'process_test',
      exit_code: 0,
    });
  });

  test('requires a shape before calling CreateOS', async () => {
    await expect(
      new CreateOSSandboxClient().create(new Manifest()),
    ).rejects.toThrow('requires a non-empty `shape` option');
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  test('requires a rootfs before calling CreateOS', async () => {
    const client = new CreateOSSandboxClient({ shape: 's-1vcpu-1gb' });

    await expect(client.create(new Manifest())).rejects.toThrow(
      'requires a non-empty `rootfs` option',
    );
    await expect(
      client.create(new Manifest(), { rootfs: '  ' }),
    ).rejects.toThrow('requires a non-empty `rootfs` option');
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  test('accepts a rootfs supplied for an individual create call', async () => {
    const client = new CreateOSSandboxClient({ shape: 's-1vcpu-1gb' });

    await client.create(new Manifest(), { rootfs: 'devbox:1' });

    expect(mocks.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ rootfs: 'devbox:1' }),
      { timeoutMs: undefined },
    );
  });

  test('does not follow redirects from CreateOS with provider credentials', async () => {
    await new CreateOSSandboxClient({
      shape: 's-1vcpu-1gb',
      rootfs: 'devbox:1',
    }).create(new Manifest());
    const options = mocks.clientOptions.mock.lastCall?.[0] as {
      fetch: typeof fetch;
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://other.example.test/' },
      }),
    );
    try {
      const { CreateosSandboxClient: SdkClient } = await vi.importActual<
        typeof import('@nodeops-createos/sandbox')
      >('@nodeops-createos/sandbox');
      const sdkClient = new SdkClient({
        apiKey: 'test-key',
        baseUrl: 'https://createos.example.test',
        fetch: options.fetch,
      });
      await expect(
        sdkClient.createSandbox({ shape: 's-1vcpu-1gb', rootfs: 'devbox:1' }),
      ).rejects.toThrow();
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://createos.example.test/v1/sandboxes',
        expect.objectContaining({ redirect: 'manual' }),
      );
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('rejects unsafe environment names before provider effects', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      env: { '--split-string': 'printf injected' },
    });

    await expect(client.create(new Manifest())).rejects.toThrow(
      'Invalid environment variable name',
    );
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  test('creates a sandbox, applies the manifest, and runs in the workspace', async () => {
    const client = new CreateOSSandboxClient({
      shape: 's-1vcpu-1gb',
      rootfs: 'devbox:1',
      exposedPorts: [8080],
      env: { APP_ENV: 'test' },
      apiKey: 'secret-api-key',
      baseUrl: 'https://createos.example.test',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'README.md': { type: 'file', content: '# CreateOS\n' },
        },
      }),
    );

    expect(mocks.clientOptions).toHaveBeenCalledWith({
      apiKey: 'secret-api-key',
      baseUrl: 'https://createos.example.test',
      fetch: expect.any(Function),
      timeoutMs: undefined,
    });
    expect(mocks.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        shape: 's-1vcpu-1gb',
        rootfs: 'devbox:1',
        ingress_enabled: true,
        envs: { APP_ENV: 'test' },
      }),
      { timeoutMs: undefined },
    );
    expect(
      new TextDecoder().decode(await session.readFile({ path: 'README.md' })),
    ).toBe('# CreateOS\n');

    const output = await session.execCommand({ cmd: 'echo hello' });
    expect(output).toContain('hello');
    expect(output).toContain('Process exited with code 0');
    expect(mocks.runCommand).toHaveBeenLastCalledWith(
      'env',
      ['APP_ENV=test', 'bash', '-lc', "cd -- '/workspace' && echo hello"],
      { timeoutMs: undefined },
    );

    await expect(session.resolveExposedPort(8080)).resolves.toEqual({
      host: 'sb-createos-test-8080.example.test',
      port: 443,
      query: '',
      tls: true,
      url: 'https://sb-createos-test-8080.example.test',
    });
  });

  test('rejects unsupported snapshots and mounts', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    });
    await expect(
      client.create({ manifest: new Manifest(), snapshot: { type: 'remote' } }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    await expect(
      client.create(
        new Manifest({
          entries: {
            data: {
              type: 'mount',
              source: '/tmp/data',
            },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  test('reports PTY support only for a complete managed-process API', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    });
    const session = await client.create(new Manifest());
    expect(session.supportsPty()).toBe(true);

    mocks.createSandbox.mockResolvedValueOnce({
      ...sandbox,
      processes: undefined,
    });
    const legacySession = await client.create(new Manifest());
    expect(legacySession.supportsPty()).toBe(false);
    await expect(
      legacySession.execCommand({ cmd: 'bash', tty: true }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(mocks.processCreate).not.toHaveBeenCalled();
  });

  test('runs interactive PTY commands and writes subsequent stdin', async () => {
    let finishProcess!: () => void;
    const processFinished = new Promise<void>((resolve) => {
      finishProcess = resolve;
    });
    mocks.processConnect.mockImplementationOnce(async function* () {
      yield { type: 'data', data: 'terminal-ready\n' };
      await processFinished;
      yield { type: 'data', data: 'terminal-done\n' };
      yield { type: 'exit', exitCode: 0 };
    });
    mocks.processInput.mockImplementation(async (_id, data: string) => {
      if (data === 'exit\n') {
        finishProcess();
      }
      return { input_seq: 1 };
    });
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      env: { APP_ENV: 'test' },
      requestTimeoutMs: 123,
    }).create(new Manifest());

    const started = await session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/u)?.[1],
    );
    const finished = await session.writeStdin({
      sessionId,
      chars: 'exit\n',
      yieldTimeMs: 250,
    });

    expect(started).toContain('terminal-ready');
    expect(finished).toContain('terminal-done');
    expect(finished).toContain('Process exited with code 0');
    expect(mocks.processCreate).toHaveBeenCalledWith(
      {
        cwd: '/workspace',
        env: { APP_ENV: 'test' },
        pty: { rows: 24, cols: 80 },
      },
      { timeoutMs: 123 },
    );
    expect(mocks.processInput).toHaveBeenNthCalledWith(
      1,
      'process_test',
      "/bin/sh -c 'echo ready'\n",
      { timeoutMs: 123 },
    );
    expect(mocks.processInput).toHaveBeenNthCalledWith(
      2,
      'process_test',
      'exit\n',
      { timeoutMs: 123 },
    );
    expect(mocks.processDelete).toHaveBeenCalledWith('process_test', {
      timeoutMs: 123,
    });
  });

  test('rejects PTY runAs before creating a managed process', async () => {
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    }).create(new Manifest());

    await expect(
      session.execCommand({ cmd: 'id', tty: true, runAs: 'sandbox' }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(mocks.processCreate).not.toHaveBeenCalled();
  });

  test('terminates a managed PTY when the initial input fails', async () => {
    mocks.processInput.mockRejectedValueOnce(new Error('input failed'));
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      requestTimeoutMs: 123,
    }).create(new Manifest());

    await expect(
      session.execCommand({ cmd: 'echo ready', tty: true }),
    ).rejects.toThrow('input failed');

    expect(mocks.processDelete).toHaveBeenCalledWith('process_test', {
      timeoutMs: 123,
    });
    expect(mocks.processConnect).not.toHaveBeenCalled();
  });

  test('waits for an in-flight PTY creation before pausing', async () => {
    let creationStarted!: () => void;
    let finishCreation!: () => void;
    const started = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finishCreation = resolve;
    });
    mocks.processCreate.mockImplementationOnce(async () => {
      creationStarted();
      await pending;
      return { process_id: 'process_test' };
    });
    mocks.processConnect.mockImplementationOnce(async function* () {
      yield { type: 'data', data: 'ready\n' };
      await new Promise(() => {});
    });
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    }).create(new Manifest());

    const exec = session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    await started;
    const close = session.close();
    finishCreation();
    await exec;
    await close;

    expect(mocks.processDelete).toHaveBeenCalledWith('process_test', {
      timeoutMs: undefined,
    });
    expect(mocks.processDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pause.mock.invocationCallOrder[0],
    );
    mocks.processCreate.mockClear();
    await expect(
      session.execCommand({ cmd: 'echo late', tty: true }),
    ).rejects.toThrow('session is stopping');
    expect(mocks.processCreate).not.toHaveBeenCalled();

    await session.start();
    await session.execCommand({ cmd: 'echo restarted', tty: true });
    expect(mocks.processCreate).toHaveBeenCalledOnce();
  });

  test('waits for initial PTY input before destructive cleanup', async () => {
    let inputStarted!: () => void;
    let finishInput!: () => void;
    const started = new Promise<void>((resolve) => {
      inputStarted = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finishInput = resolve;
    });
    mocks.processInput.mockImplementationOnce(async () => {
      inputStarted();
      await pending;
      return { input_seq: 1 };
    });
    mocks.processConnect.mockImplementationOnce(async function* () {
      yield { type: 'data', data: 'ready\n' };
      await new Promise(() => {});
    });
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    }).create(new Manifest());

    const exec = session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    await started;
    const deletion = session.delete();
    finishInput();
    await exec;
    await deletion;

    expect(mocks.processDelete).toHaveBeenCalledWith('process_test', {
      timeoutMs: undefined,
    });
    expect(mocks.processDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.destroy.mock.invocationCallOrder[0],
    );
  });

  test('rejects a stale PTY request after shutdown and restart', async () => {
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    }).create(new Manifest());

    const staleExec = session.execCommand({
      cmd: 'echo stale',
      tty: true,
      yieldTimeMs: 250,
    });
    const shutdown = session.shutdown();
    const restart = session.start();
    const staleRejected = expect(staleExec).rejects.toThrow(
      'session is stopping',
    );

    await shutdown;
    await restart;
    await staleRejected;
    expect(mocks.processCreate).not.toHaveBeenCalled();

    await session.execCommand({
      cmd: 'echo current',
      tty: true,
      yieldTimeMs: 250,
    });
    expect(mocks.processCreate).toHaveBeenCalledOnce();
  });

  test('serializes resumable state without provider credentials', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
      apiKey: 'secret-api-key',
      baseUrl: 'https://createos.example.test',
      env: { RUNTIME_SECRET: 'runtime-secret-value' },
    });
    const session = await client.create(new Manifest());
    const serialized = await client.serializeSessionState(session.state);

    expect(serialized).toMatchObject({
      sandboxId: 'sb_createos_test',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    });
    expect(JSON.stringify(serialized)).not.toContain('secret-api-key');
    expect(JSON.stringify(serialized)).not.toContain('createos.example.test');
    expect(JSON.stringify(serialized)).not.toContain('runtime-secret-value');

    await session.close();
    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(mocks.waitUntilPaused).toHaveBeenCalledOnce();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  test('drops unknown serialized fields instead of persisting credentials', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    });
    const session = await client.create(new Manifest());
    const serialized = {
      ...(await client.serializeSessionState(session.state)),
      environment: { PATH: '/workspace/attacker-bin', INJECTED: 'value' },
      apiKey: 'injected-api-key',
      baseUrl: 'https://injected.example.test',
      token: 'injected-token',
    };

    const state = await client.deserializeSessionState(serialized);
    const roundTripped = await client.serializeSessionState(state);

    expect(state).not.toHaveProperty('apiKey');
    expect(state).not.toHaveProperty('baseUrl');
    expect(state).not.toHaveProperty('token');
    expect(state.environment).toEqual({});
    expect(JSON.stringify(roundTripped)).not.toContain('injected');
  });

  test('rejects unsafe serialized manifest environment names', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    });
    const session = await client.create(new Manifest());
    const serialized = await client.serializeSessionState(session.state);
    const manifest = serialized.manifest as Record<string, unknown>;

    await expect(
      client.deserializeSessionState({
        ...serialized,
        manifest: {
          ...manifest,
          environment: {
            '--split-string': { value: 'printf injected' },
          },
        },
        environment: { '--split-string': 'printf injected' },
      }),
    ).rejects.toThrow('Invalid environment variable name');
    expect(mocks.getSandbox).not.toHaveBeenCalled();
  });

  test.each([
    ['sandboxId', undefined],
    ['shape', { invalid: true }],
    ['networkIds', ['network-1', 2]],
    ['nodeSelector', { pool: 2 }],
    ['configuredExposedPorts', [0]],
    ['pauseOnExit', 'true'],
    ['requestTimeoutMs', Number.NaN],
    ['environment', ['SECRET=value']],
    ['environment', 'SECRET=value'],
    ['environment', 7],
    ['environment', null],
  ])('rejects malformed serialized field %s', async (field, value) => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    });
    const session = await client.create(new Manifest());
    const serialized = await client.serializeSessionState(session.state);

    await expect(
      client.deserializeSessionState({ ...serialized, [field]: value }),
    ).rejects.toThrow();
  });

  test.each([
    ['sandboxId', ''],
    ['shape', ''],
    ['configuredExposedPorts', [0]],
    ['pauseOnExit', 'true'],
    ['requestTimeoutMs', Number.NaN],
    ['lifecycleTimeoutMs', 0],
    ['environment', undefined],
  ])(
    'rejects malformed direct resume field %s before provider effects',
    async (field, value) => {
      const client = new CreateOSSandboxClient({
        rootfs: 'devbox:1',
        shape: 's-1vcpu-1gb',
      });
      const session = await client.create(new Manifest());
      mocks.clientOptions.mockClear();
      mocks.getSandbox.mockClear();

      await expect(
        client.resume({ ...session.state, [field]: value }),
      ).rejects.toThrow();

      expect(mocks.clientOptions).not.toHaveBeenCalled();
      expect(mocks.getSandbox).not.toHaveBeenCalled();
    },
  );

  test('persists and hydrates portable tar workspaces', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    mocks.runCommand.mockImplementation(
      async (_cmd: string, args: string[]) => {
        const command = args[args.length - 1] ?? '';
        const resolvedPath = resolvedRemotePathFromValidationCommand(command);
        if (resolvedPath) {
          return response(`${resolvedPath}\n`);
        }
        const archivePath = command.match(/-cf '([^']+)'/u)?.[1];
        if (archivePath) {
          files.set(archivePath, archive);
        }
        const move = command.match(/mv -f -- '([^']+)' '([^']+)'$/u);
        if (move) {
          files.set(move[2], files.get(move[1]) ?? '');
          files.delete(move[1]);
        }
        return response();
      },
    );
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    }).create(new Manifest());

    await expect(session.persistWorkspace()).resolves.toEqual(archive);
    await session.hydrateWorkspace(archive);

    expect(
      mocks.runCommand.mock.calls.some(([, args]) =>
        String(args[args.length - 1]).includes('tar -C'),
      ),
    ).toBe(true);
  });

  test('uses constructor archive limits for newly created sessions', async () => {
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      archiveLimits: { maxInputBytes: 1 },
    }).create(new Manifest());

    await expect(
      session.hydrateWorkspace(
        makeTarArchive([{ name: 'too-large.txt', content: 'too large' }]),
      ),
    ).rejects.toThrow();
  });

  test('keeps portable archives outside a /tmp workspace root', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    mocks.runCommand.mockImplementation(
      async (_cmd: string, args: string[]) => {
        const command = args[args.length - 1] ?? '';
        const resolvedPath = resolvedRemotePathFromValidationCommand(command);
        if (resolvedPath) {
          return response(`${resolvedPath}\n`);
        }
        const archivePath = command.match(/-cf '([^']+)'/u)?.[1];
        if (archivePath) {
          files.set(archivePath, archive);
        }
        const move = command.match(/mv -f -- '([^']+)' '([^']+)'$/u);
        if (move) {
          files.set(move[2], files.get(move[1]) ?? '');
          files.delete(move[1]);
        }
        return response();
      },
    );
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    }).create(new Manifest({ root: '/tmp' }));

    await expect(session.persistWorkspace()).resolves.toEqual(archive);
    await session.hydrateWorkspace(archive);

    const archiveCommands = mocks.runCommand.mock.calls
      .map(([, args]) => String(args[args.length - 1]))
      .filter((command) => command.includes('.tar'));
    expect(archiveCommands.length).toBeGreaterThan(0);
    expect(
      archiveCommands.every((command) => command.includes('/var/tmp/')),
    ).toBe(true);
  });

  test('reconnects and resumes a paused serialized sandbox', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      requestTimeoutMs: 123,
    });
    const original = await client.create(new Manifest());
    const serialized = await client.serializeSessionState(original.state);
    const state = await client.deserializeSessionState(serialized);
    sandboxStatus = 'paused';

    const resumed = await client.resume(state);

    expect(resumed.state.sandboxId).toBe('sb_createos_test');
    expect(mocks.getSandbox).toHaveBeenCalledWith('sb_createos_test', {
      timeoutMs: 123,
    });
    expect(mocks.resume).toHaveBeenCalledWith({ timeoutMs: 123 });
    expect(mocks.waitUntilRunning).toHaveBeenCalledWith({
      timeoutMs: undefined,
      request: { timeoutMs: 123 },
    });
    expect(resumed.state.requestTimeoutMs).toBe(123);

    mocks.clientOptions.mockClear();
    mocks.getSandbox.mockClear();
    mocks.resume.mockClear();
    mocks.waitUntilRunning.mockClear();
    sandboxStatus = 'paused';
    const overridden = await client.resume(state, {
      clientOptions: { shape: 's-1vcpu-1gb', requestTimeoutMs: 456 },
    });

    expect(mocks.clientOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 456 }),
    );
    expect(mocks.getSandbox).toHaveBeenLastCalledWith('sb_createos_test', {
      timeoutMs: 456,
    });
    expect(mocks.resume).toHaveBeenLastCalledWith({ timeoutMs: 456 });
    expect(overridden.state.requestTimeoutMs).toBe(456);
  });

  test('applies rehydrated environment values to resumed commands', async () => {
    const originalClient = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      env: { API_TOKEN: 'old-token' },
    });
    const original = await originalClient.create(
      new Manifest({
        environment: {
          API_TOKEN: { value: 'old-token', ephemeral: true },
        },
      }),
    );
    const serialized = await originalClient.serializeSessionState(
      original.state,
    );
    const currentClient = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      env: { API_TOKEN: 'new-token' },
    });
    const state = await currentClient.deserializeSessionState(serialized);
    const resumed = await currentClient.resume(state, {
      clientOptions: {
        shape: 's-1vcpu-1gb',
        env: { API_TOKEN: 'resume-token' },
      },
    });
    mocks.runCommand.mockClear();

    await resumed.execCommand({ cmd: 'printenv API_TOKEN' });

    expect(mocks.runCommand).toHaveBeenCalledWith(
      'env',
      [
        'API_TOKEN=resume-token',
        'bash',
        '-lc',
        "cd -- '/workspace' && printenv API_TOKEN",
      ],
      { timeoutMs: undefined },
    );
  });

  test('rejects invalid resume environment before provider effects', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    });
    const session = await client.create(new Manifest());
    mocks.getSandbox.mockClear();
    mocks.resume.mockClear();
    mocks.waitUntilRunning.mockClear();

    await expect(
      client.resume(session.state, {
        clientOptions: {
          shape: 's-1vcpu-1gb',
          env: { '--split-string': 'printf injected' },
        },
      }),
    ).rejects.toThrow('Invalid environment variable name');

    expect(mocks.getSandbox).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.waitUntilRunning).not.toHaveBeenCalled();

    session.state.manifest = new Manifest({
      environment: { '--split-string': 'printf injected' },
    });
    session.state.environment = { '--split-string': 'printf injected' };
    await expect(client.resume(session.state)).rejects.toThrow(
      'Invalid environment variable name',
    );
    expect(mocks.getSandbox).not.toHaveBeenCalled();
  });

  test('snapshots direct resume state before provider awaits', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    });
    const session = await client.create(
      new Manifest({ environment: { ORIGINAL: 'value' } }),
    );
    const input = {
      ...session.state,
      environment: { ORIGINAL: 'value' },
    };
    let finishLookup!: () => void;
    const lookupPending = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    mocks.getSandbox.mockImplementationOnce(async () => {
      await lookupPending;
      return sandbox;
    });

    const resumedPromise = client.resume(input);
    await vi.waitFor(() => expect(mocks.getSandbox).toHaveBeenCalledOnce());
    input.sandboxId = 'sb_mutated';
    input.shape = 'mutated-shape';
    input.environment.ORIGINAL = 'mutated';
    finishLookup();
    const resumed = await resumedPromise;

    expect(mocks.getSandbox).toHaveBeenCalledWith('sb_createos_test', {
      timeoutMs: undefined,
    });
    expect(resumed.state.sandboxId).toBe('sb_createos_test');
    expect(resumed.state.shape).toBe('s-1vcpu-1gb');
    expect(resumed.state.environment).toEqual({ ORIGINAL: 'value' });
  });

  test('revalidates environment names before every command', async () => {
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    }).create(new Manifest());
    session.state.environment['--split-string'] = 'printf injected';
    mocks.runCommand.mockClear();

    await expect(session.execCommand({ cmd: 'echo safe' })).rejects.toThrow(
      'Invalid environment variable name',
    );
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  test('accepts zero timeout values during create and resume', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      requestTimeoutMs: 0,
      commandTimeoutMs: 0,
    });
    const original = await client.create(new Manifest());
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(original.state),
    );
    sandboxStatus = 'paused';

    const resumed = await client.resume(state, {
      clientOptions: {
        shape: 's-1vcpu-1gb',
        requestTimeoutMs: 0,
        commandTimeoutMs: 0,
      },
    });

    expect(mocks.getSandbox).toHaveBeenLastCalledWith('sb_createos_test', {
      timeoutMs: 0,
    });
    expect(mocks.waitUntilRunning).toHaveBeenLastCalledWith({
      timeoutMs: undefined,
      request: { timeoutMs: 0 },
    });
    expect(resumed.state).toMatchObject({
      requestTimeoutMs: 0,
      commandTimeoutMs: 0,
    });
  });

  test('does not recreate a terminal sandbox during resume', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    });
    const original = await client.create(new Manifest());
    const state = await client.deserializeSessionState(
      await client.serializeSessionState(original.state),
    );
    mocks.createSandbox.mockClear();
    sandboxStatus = 'failed';

    await expect(client.resume(state)).rejects.toThrow(
      'cannot resume sandbox sb_createos_test from status failed',
    );
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  test('destroys a non-preserved sandbox exactly once', async () => {
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    }).create(new Manifest());

    await Promise.all([session.close(), session.close()]);

    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.waitUntilDestroyed).toHaveBeenCalledOnce();
  });

  test('allows explicit deletion after a pause-on-exit close', async () => {
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    }).create(new Manifest());

    await session.close();
    await session.delete();

    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  test('destroys a pause-on-exit sandbox during non-preserving cleanup', async () => {
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    }).create(new Manifest());

    await session.shutdown({ reason: 'cleanup' });
    await session.delete({ reason: 'cleanup' });

    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.waitUntilDestroyed).toHaveBeenCalledOnce();
  });

  test('restarts a reusable preserved paused session handle', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    });
    const session = await client.create(new Manifest());
    await session.delete({
      reason: 'cleanup',
      preserveOwnedSessions: true,
    });

    expect(
      await client.canReusePreservedOwnedSession(session.state, {
        trustedManifest: new Manifest(),
      }),
    ).toBe(true);
    expect(mocks.pause).toHaveBeenCalledOnce();

    await session.start();
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.waitUntilRunning).toHaveBeenCalledOnce();

    await session.close();
    expect(mocks.pause).toHaveBeenCalledTimes(2);
  });

  test('reconnects instead of reusing stale live authority', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
      apiKey: 'old-api-key',
      env: { RUNTIME_SECRET: 'old-secret' },
    });
    const session = await client.create(new Manifest());

    expect(
      await client.canReusePreservedOwnedSession(session.state, {
        clientOptions: {
          apiKey: 'new-api-key',
          env: { RUNTIME_SECRET: 'new-secret' },
        },
        revalidateManifestEntries: true,
        trustedManifest: new Manifest(),
      }),
    ).toBe(false);

    await session.delete({ reason: 'cleanup' });
    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(mocks.destroy).not.toHaveBeenCalled();

    await client.resume(session.state, {
      clientOptions: {
        apiKey: 'new-api-key',
        env: { RUNTIME_SECRET: 'new-secret' },
      },
    });
    expect(mocks.clientOptions).toHaveBeenLastCalledWith({
      apiKey: 'new-api-key',
      baseUrl: undefined,
      fetch: expect.any(Function),
      timeoutMs: undefined,
    });
  });

  test('keeps live credentials private and rejects sandbox identity mutation', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
      apiKey: 'private-api-key',
    });
    const session = await client.create(new Manifest());

    const inspectedValues = Reflect.ownKeys(session.state).map(
      (key) => session.state[key as keyof typeof session.state],
    );
    expect(JSON.stringify(inspectedValues)).not.toContain('private-api-key');
    expect(JSON.stringify({ ...session.state })).not.toContain(
      'private-api-key',
    );

    session.state.sandboxId = 'sb_mutated';
    expect(
      await client.canReusePreservedOwnedSession(session.state, {
        revalidateManifestEntries: true,
        trustedManifest: new Manifest(),
      }),
    ).toBe(false);
    const serialized = await client.serializeSessionState(session.state);
    expect(serialized.sandboxId).toBe('sb_createos_test');

    await session.delete({ reason: 'cleanup' });
    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(mocks.destroy).not.toHaveBeenCalled();

    mocks.getSandbox.mockClear();
    const deserialized = await client.deserializeSessionState(serialized);
    await client.resume(deserialized);
    expect(mocks.getSandbox).toHaveBeenCalledWith('sb_createos_test', {
      timeoutMs: undefined,
    });
  });

  test('rejects live reuse when trusted manifest entries change', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    });
    const session = await client.create(new Manifest());

    expect(
      await client.canReusePreservedOwnedSession(session.state, {
        revalidateManifestEntries: true,
        trustedManifest: new Manifest({
          entries: {
            'changed.txt': { type: 'file', content: 'changed\n' },
          },
        }),
      }),
    ).toBe(false);
  });

  test('starts a sandbox paused outside the local session lifecycle', async () => {
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    }).create(new Manifest());
    sandboxStatus = 'paused';

    await session.start();

    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.waitUntilRunning).toHaveBeenCalledOnce();
  });

  test('retries a preserved-session running wait without replaying resume', async () => {
    const client = new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    });
    const session = await client.create(new Manifest());
    await session.delete({
      reason: 'cleanup',
      preserveOwnedSessions: true,
    });
    mocks.waitUntilRunning.mockRejectedValueOnce(
      new Error('start wait failed'),
    );

    await expect(session.start()).rejects.toThrow('start wait failed');
    await expect(session.start()).resolves.toBeUndefined();

    expect(mocks.resume).toHaveBeenCalledOnce();
  });

  test('pauses after a preserved-session running wait fails', async () => {
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    }).create(new Manifest());
    await session.close();
    mocks.resume.mockImplementationOnce(async () => {
      sandboxStatus = 'resuming';
      return sandbox;
    });
    mocks.waitUntilRunning
      .mockRejectedValueOnce(new Error('start wait failed'))
      .mockImplementationOnce(async () => {
        sandboxStatus = 'running';
        return sandbox;
      });

    await expect(session.start()).rejects.toThrow('start wait failed');
    await expect(session.close()).resolves.toBeUndefined();

    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.pause).toHaveBeenCalledTimes(2);
  });

  test('lets destroy dominate concurrently queued start and pause', async () => {
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    }).create(new Manifest());

    const results = await Promise.allSettled([
      session.start(),
      session.close(),
      session.delete(),
    ]);

    expect(results.map(({ status }) => status)).toEqual([
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  test('lets destroy dominate a concurrently queued pause', async () => {
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    }).create(new Manifest());

    await Promise.all([session.delete(), session.close()]);

    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  test('serializes destroy after a pause already in progress', async () => {
    let finishPause!: () => void;
    const pausePending = new Promise<void>((resolve) => {
      finishPause = resolve;
    });
    mocks.pause.mockImplementation(async () => {
      await pausePending;
      sandboxStatus = 'paused';
      return sandbox;
    });
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    }).create(new Manifest());

    const close = session.close();
    await vi.waitFor(() => expect(mocks.pause).toHaveBeenCalledOnce());
    const deletion = session.delete();
    expect(mocks.destroy).not.toHaveBeenCalled();
    finishPause();
    await Promise.all([close, deletion]);

    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  test('retries rejected pause, destroy, and destroy-wait attempts', async () => {
    const pausedSession = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    }).create(new Manifest());
    mocks.pause.mockRejectedValueOnce(new Error('pause failed'));
    await expect(pausedSession.close()).rejects.toThrow('pause failed');
    await expect(pausedSession.close()).resolves.toBeUndefined();
    expect(mocks.pause).toHaveBeenCalledTimes(2);

    sandboxStatus = 'running';
    const pauseWaitSession = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    }).create(new Manifest());
    const pauseCallsBeforeWaitFailure = mocks.pause.mock.calls.length;
    mocks.waitUntilPaused.mockRejectedValueOnce(new Error('pause wait failed'));
    await expect(pauseWaitSession.close()).rejects.toThrow('pause wait failed');
    await expect(pauseWaitSession.close()).resolves.toBeUndefined();
    expect(mocks.pause).toHaveBeenCalledTimes(pauseCallsBeforeWaitFailure + 1);

    const destroyedSession = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    }).create(new Manifest());
    mocks.destroy.mockRejectedValueOnce(new Error('destroy failed'));
    await expect(destroyedSession.close()).rejects.toThrow('destroy failed');
    await expect(destroyedSession.close()).resolves.toBeUndefined();

    const waitedSession = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
    }).create(new Manifest());
    const destroyCallsBeforeWaitFailure = mocks.destroy.mock.calls.length;
    mocks.waitUntilDestroyed.mockRejectedValueOnce(new Error('wait failed'));
    await expect(waitedSession.close()).rejects.toThrow('wait failed');
    await expect(waitedSession.close()).resolves.toBeUndefined();
    expect(mocks.destroy).toHaveBeenCalledTimes(
      destroyCallsBeforeWaitFailure + 1,
    );
    expect(mocks.waitUntilDestroyed).toHaveBeenCalledTimes(3);
  });

  test('retries destroy when close follows a rejected delete', async () => {
    const session = await new CreateOSSandboxClient({
      rootfs: 'devbox:1',
      shape: 's-1vcpu-1gb',
      pauseOnExit: true,
    }).create(new Manifest());
    mocks.destroy.mockRejectedValueOnce(new Error('destroy failed'));

    await expect(session.delete()).rejects.toThrow('destroy failed');
    await expect(session.close()).resolves.toBeUndefined();

    expect(mocks.destroy).toHaveBeenCalledTimes(2);
    expect(mocks.pause).not.toHaveBeenCalled();
  });
});

function response(stdout = '', stderr = '', exitCode = 0) {
  return {
    result: {
      stdout,
      stderr,
      exit_code: exitCode,
    },
    exec_ms: 1,
  };
}
