import { UserError } from '@openai/agents-core';
import { randomUUID } from '@openai/agents-core/_shims';
import {
  cloneManifest,
  Manifest,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  normalizeSandboxClientCreateArgs,
  type ExecCommandArgs,
  type ExposedPortEndpoint,
  type SandboxArchiveLimits,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type SandboxClientResumeOptions,
  type SandboxConcurrencyLimits,
  type SandboxPreservedSessionReuseOptions,
  type SandboxSessionLifecycleOptions,
  type SandboxSessionState,
  type WriteStdinArgs,
  type WorkspaceArchiveData,
  type WorkspaceArchiveOptions,
} from '@openai/agents-core/sandbox';
import { stableJsonStringify } from '@openai/agents-core/sandbox/internal';
import {
  appendPtyOutput,
  assertCoreSnapshotUnsupported,
  assertRemoteSandboxSessionStateCanResume,
  assertRemoteSandboxSessionStateUsable,
  assertShellEnvironmentName,
  assertSandboxManifestMetadataSupported,
  closeRemoteSessionOnManifestError,
  createPtyProcessEntry,
  formatPtyExecUpdate,
  isRemoteSandboxSessionStateUnsafe,
  isProviderSandboxNotFoundError,
  materializeEnvironment,
  parseExposedPortEndpoint,
  persistRemoteWorkspaceTar,
  providerErrorMessage,
  rehydrateRemoteSandboxSessionStateValues,
  RemoteSandboxSessionBase,
  serializeRemoteSandboxSessionState,
  shellQuote,
  shellCommandForPty,
  hydrateRemoteWorkspaceTar,
  withProviderError,
  withSandboxSpan,
  writePtyStdin,
  PtyProcessRegistry,
  watchPtyOutput,
  type PtyProcessEntry,
  type RemoteSandboxCommandOptions,
  type RemoteSandboxCommandResult,
} from '../shared';

type CreateOSSandboxStatus =
  | 'creating'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'forking'
  | 'error'
  | 'destroying'
  | 'destroyed'
  | 'failed';

type CreateOSCommandResponse = {
  result: {
    stdout: string;
    stderr: string;
    exit_code: number;
    error?: string;
  };
};

type CreateOSManagedProcess = {
  process_id: string;
  exit_code?: number | null;
};

type CreateOSManagedProcessEvent =
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode?: number | null; signal?: string | null }
  | { type: 'heartbeat' }
  | { type: 'error'; message: string };

type CreateOSManagedProcesses = {
  create(
    request: {
      cwd?: string;
      env?: Record<string, string>;
      pty: { rows: number; cols: number };
    },
    options?: { timeoutMs?: number },
  ): Promise<CreateOSManagedProcess>;
  connect(
    processId: string,
    options?: { timeoutMs?: number },
  ): AsyncIterable<CreateOSManagedProcessEvent>;
  input(
    processId: string,
    data: string,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
  delete(
    processId: string,
    options?: { timeoutMs?: number; graceMs?: number },
  ): Promise<unknown>;
};

type CreateOSSandboxInstance = {
  id: string;
  status: CreateOSSandboxStatus;
  files: {
    upload(path: string, data: string | Uint8Array): Promise<void>;
    download(path: string): Promise<ArrayBuffer>;
  };
  processes?: CreateOSManagedProcesses;
  runCommand(
    cmd: string,
    args?: string[],
    options?: { timeoutMs?: number },
  ): Promise<CreateOSCommandResponse>;
  previewUrl(port: number): string;
  refresh(options?: { timeoutMs?: number }): Promise<CreateOSSandboxInstance>;
  pause(options?: { timeoutMs?: number }): Promise<CreateOSSandboxInstance>;
  resume(options?: { timeoutMs?: number }): Promise<CreateOSSandboxInstance>;
  destroy(options?: { timeoutMs?: number }): Promise<unknown>;
  waitUntilRunning(options?: {
    timeoutMs?: number;
    request?: { timeoutMs?: number };
  }): Promise<CreateOSSandboxInstance>;
  waitUntilPaused(options?: {
    timeoutMs?: number;
    request?: { timeoutMs?: number };
  }): Promise<CreateOSSandboxInstance>;
  waitUntilDestroyed(options?: {
    timeoutMs?: number;
    request?: { timeoutMs?: number };
  }): Promise<CreateOSSandboxInstance>;
};

type CreateOSSdkClient = {
  createSandbox(
    request: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<CreateOSSandboxInstance>;
  getSandbox(
    sandboxId: string,
    options?: { timeoutMs?: number },
  ): Promise<CreateOSSandboxInstance>;
};

type CreateOSSdkClientClass = new (options?: {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) => CreateOSSdkClient;

type CreateOSLiveAuthority = {
  apiKey?: string;
  baseUrl: string;
  manifestSignature: string;
  preserveOnNextCleanup: boolean;
  sandbox: CreateOSSandboxInstance;
  sandboxId: string;
  sandboxConfigurationSignature: string;
  sourceState: CreateOSSandboxSessionState;
};

const createOSLiveAuthorityTokenKey = Symbol('createOSLiveAuthorityToken');
const createOSLiveAuthorityByState = new WeakMap<
  CreateOSSandboxSessionState,
  CreateOSLiveAuthority
>();
const createOSLiveStateByToken = new WeakMap<
  object,
  CreateOSSandboxSessionState
>();
const CREATEOS_DEFAULT_BASE_URL = 'https://api.sb.createos.sh';

export interface CreateOSSandboxClientOptions extends SandboxClientOptions {
  /** CreateOS compute shape, for example `s-1vcpu-1gb`. */
  shape?: string;
  /** Required when creating a sandbox; may be supplied here or per create call. */
  rootfs?: string;
  name?: string;
  networkIds?: string[];
  diskMib?: number;
  egress?: string[];
  sshPublicKeys?: string[];
  hostId?: string;
  nodeSelector?: Record<string, string>;
  region?: string;
  autoPauseAfterSeconds?: number;
  exposedPorts?: number[];
  pauseOnExit?: boolean;
  env?: Record<string, string>;
  apiKey?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  lifecycleTimeoutMs?: number;
  commandTimeoutMs?: number;
  archiveLimits?: SandboxArchiveLimits | null;
}

export interface CreateOSSandboxSessionState extends SandboxSessionState {
  sandboxId: string;
  shape: string;
  rootfs?: string;
  name?: string;
  networkIds?: string[];
  diskMib?: number;
  egress?: string[];
  sshPublicKeys?: string[];
  hostId?: string;
  nodeSelector?: Record<string, string>;
  region?: string;
  autoPauseAfterSeconds?: number;
  configuredExposedPorts?: number[];
  pauseOnExit: boolean;
  requestTimeoutMs?: number;
  lifecycleTimeoutMs?: number;
  commandTimeoutMs?: number;
  environment: Record<string, string>;
}

export class CreateOSSandboxSession extends RemoteSandboxSessionBase<CreateOSSandboxSessionState> {
  private readonly sandbox: CreateOSSandboxInstance;
  private readonly ptyProcesses = new PtyProcessRegistry();
  private lifecycleTail: Promise<void> = Promise.resolve();
  private ptyAdmissionGeneration = 0;
  private ptyAdmissionOpen = true;
  private destroyRequested = false;
  private destroyCompleted = false;
  private destroyIssued = false;
  private startPromise?: Promise<void>;
  private pausePromise?: Promise<void>;
  private destroyPromise?: Promise<void>;

  constructor(args: {
    state: CreateOSSandboxSessionState;
    sandbox: CreateOSSandboxInstance;
    clientOptions: CreateOSSandboxClientOptions;
    concurrencyLimits?: SandboxConcurrencyLimits;
    archiveLimits?: SandboxArchiveLimits | null;
  }) {
    super({
      state: args.state,
      options: {
        providerName: 'CreateOSSandboxClient',
        providerId: 'createos',
        concurrencyLimits: args.concurrencyLimits,
        archiveLimits: args.archiveLimits,
      },
    });
    this.sandbox = args.sandbox;
    attachLiveAuthority(args.state, args.sandbox, args.clientOptions);
  }

  protected override async resolveRemoteExposedPort(
    requestedPort: number,
  ): Promise<ExposedPortEndpoint> {
    let url: string;
    try {
      url = this.sandbox.previewUrl(requestedPort);
    } catch (error) {
      throw new SandboxProviderError(
        `CreateOSSandboxClient failed to resolve exposed port ${requestedPort}.`,
        {
          provider: 'createos',
          port: requestedPort,
          cause: providerErrorMessage(error),
        },
      );
    }
    return parseExposedPortEndpoint(url, {
      providerName: 'CreateOSSandboxClient',
      source: 'preview URL',
    });
  }

  async prepareWorkspaceRoot(): Promise<void> {
    await this.mkdirRemote(this.state.manifest.root);
  }

  override supportsPty(): boolean {
    return hasManagedProcessPty(this.sandbox.processes);
  }

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    this.assertSessionUsable();
    return await writePtyStdin({
      providerName: 'CreateOSSandboxClient',
      registry: this.ptyProcesses,
      sessionId: args.sessionId,
      chars: args.chars,
      yieldTimeMs: args.yieldTimeMs,
      maxOutputTokens: args.maxOutputTokens,
    });
  }

  protected override async execPtyCommand(
    args: ExecCommandArgs,
  ): Promise<string> {
    this.assertExecRunAs(args.runAs);
    const processes = requireManagedProcessPty(this.sandbox.processes);
    validateEnvironmentNames(this.state.environment);
    const ptyAdmissionGeneration = this.capturePtyAdmissionGeneration();
    await this.beforeExecCommand(args);

    const start = Date.now();
    const { entry, sessionId } = await this.enqueueLifecycle(async () => {
      this.assertPtyAdmissionOpen(ptyAdmissionGeneration);
      const process = await processes.create(
        {
          cwd: this.resolveWorkdir(args.workdir),
          env: this.state.environment,
          pty: { rows: 24, cols: 80 },
        },
        { timeoutMs: this.state.requestTimeoutMs },
      );
      if (!process.process_id) {
        throw new SandboxProviderError(
          'CreateOSSandboxClient managed PTY creation returned no process id.',
          { provider: 'createos', sandboxId: this.state.sandboxId },
        );
      }

      const entry = createPtyProcessEntry({
        tty: true,
        sendInput: async (chars) => {
          await processes.input(process.process_id, chars, {
            timeoutMs: this.state.requestTimeoutMs,
          });
        },
        terminate: async () => {
          await processes.delete(process.process_id, {
            timeoutMs: this.state.requestTimeoutMs,
          });
        },
      });

      try {
        await entry.sendInput?.(`${shellCommandForPty(args)}\n`);
      } catch (error) {
        await entry.terminate?.().catch(() => {});
        throw error;
      }

      const { sessionId, pruned } = this.ptyProcesses.register(entry);
      if (pruned) {
        await pruned.terminate?.().catch(() => {});
      }
      watchCreateOSManagedProcess(processes, process.process_id, entry);
      return { entry, sessionId };
    });

    return await formatPtyExecUpdate({
      registry: this.ptyProcesses,
      sessionId,
      entry,
      startTime: start,
      yieldTimeMs: args.yieldTimeMs,
      maxOutputTokens: args.maxOutputTokens,
    });
  }

  protected override async persistWorkspaceTar(): Promise<Uint8Array> {
    return await persistRemoteWorkspaceTar({
      providerName: 'CreateOSSandboxClient',
      manifest: this.state.manifest,
      io: this.archiveIo(),
      archivePath: this.remoteArchivePath(),
    });
  }

  protected override async hydrateWorkspaceTar(
    data: WorkspaceArchiveData,
    options: WorkspaceArchiveOptions = {},
  ): Promise<void> {
    await hydrateRemoteWorkspaceTar({
      providerName: 'CreateOSSandboxClient',
      manifest: this.state.manifest,
      io: this.archiveIo(),
      data,
      archivePath: this.remoteArchivePath(),
      archiveLimits:
        options.archiveLimits === undefined
          ? this.getArchiveLimits()
          : options.archiveLimits,
    });
  }

  async close(): Promise<void> {
    this.closePtyAdmission();
    if (this.state.pauseOnExit) {
      await this.pauseSandbox();
      return;
    }
    await this.destroySandbox();
  }

  async start(_options?: SandboxSessionLifecycleOptions): Promise<void> {
    if (!this.startPromise) {
      const ptyAdmissionGeneration = this.ptyAdmissionGeneration;
      const attempt = this.enqueueLifecycle(async () => {
        if (this.destroyRequested || this.destroyCompleted) {
          throw new SandboxProviderError(
            `CreateOSSandboxClient cannot start destroyed sandbox ${this.state.sandboxId}.`,
            {
              provider: 'createos',
              sandboxId: this.state.sandboxId,
            },
          );
        }
        await this.sandbox.refresh({
          timeoutMs: this.state.requestTimeoutMs,
        });
        await ensureSandboxRunning(
          this.sandbox,
          this.state.requestTimeoutMs,
          this.state.lifecycleTimeoutMs,
        );
        if (
          !this.destroyRequested &&
          this.ptyAdmissionGeneration === ptyAdmissionGeneration
        ) {
          this.ptyAdmissionOpen = true;
        }
      });
      this.startPromise = attempt;
      void attempt.then(
        () => this.clearStartAttempt(attempt),
        () => this.clearStartAttempt(attempt),
      );
    }
    await this.startPromise;
  }

  async shutdown(_options?: SandboxSessionLifecycleOptions): Promise<void> {
    // The provider retains the sandbox until close/delete chooses pause or destroy.
    this.closePtyAdmission();
    await this.enqueueLifecycle(
      async () => await this.ptyProcesses.terminateAll(),
    );
  }

  async delete(options?: SandboxSessionLifecycleOptions): Promise<void> {
    this.closePtyAdmission();
    const liveAuthority = getLiveAuthority(this.state);
    const preserveForReconnect =
      options?.reason === 'cleanup' &&
      liveAuthority?.preserveOnNextCleanup === true &&
      this.state.pauseOnExit;
    const preserve =
      options?.reason === 'cleanup' &&
      options.preserveOwnedSessions === true &&
      this.state.pauseOnExit;
    if (preserve || preserveForReconnect) {
      await this.pauseSandbox();
      if (preserveForReconnect) {
        liveAuthority.preserveOnNextCleanup = false;
      }
      return;
    }
    await this.destroySandbox();
  }

  protected override async forceTerminateAfterFailedPrivilegedManifestTransition(): Promise<void> {
    this.closePtyAdmission();
    await this.enqueueLifecycle(async () => {
      await this.ptyProcesses.terminateAll();
      await this.sandbox.destroy({ timeoutMs: this.state.requestTimeoutMs });
    });
  }

  protected override afterManifestMutationCommitted(): void {
    const liveAuthority = getLiveAuthority(this.state);
    if (liveAuthority) {
      liveAuthority.manifestSignature = manifestSignature(this.state.manifest);
    }
  }

  protected override async runRemoteCommand(
    command: string,
    options: RemoteSandboxCommandOptions,
  ): Promise<RemoteSandboxCommandResult> {
    const workdir = options.workdir;
    const wrapped = `cd -- ${shellQuote(workdir)} && ${command}`;
    const environment = options.environment ?? this.state.environment;
    validateEnvironmentNames(environment);
    const response = await this.sandbox.runCommand(
      'env',
      [
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        'bash',
        '-lc',
        wrapped,
      ],
      {
        timeoutMs:
          options.timeoutMs ??
          (options.kind === 'exec' ? this.state.commandTimeoutMs : undefined),
      },
    );
    return {
      status: response.result.exit_code,
      stdout: response.result.stdout,
      stderr: [response.result.stderr, response.result.error]
        .filter((value): value is string => Boolean(value))
        .join('\n'),
    };
  }

  protected override async mkdirRemote(path: string): Promise<void> {
    await this.runChecked(`mkdir -p -- ${shellQuote(path)}`, '/');
  }

  protected override async readRemoteText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readRemoteFile(path));
  }

  protected override async readRemoteFile(path: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await this.sandbox.files.download(path));
    } catch (error) {
      if (isProviderSandboxNotFoundError(error)) {
        throw new UserError(`Sandbox path not found: ${path}`);
      }
      throw error;
    }
  }

  protected override async writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const temporaryPath = `${path}.openai-agents-${randomUUID()}.tmp`;
    try {
      await this.sandbox.files.upload(temporaryPath, content);
      await this.runChecked(
        `mv -f -- ${shellQuote(temporaryPath)} ${shellQuote(path)}`,
        '/',
      );
    } catch (error) {
      await this.runRemoteCommand(`rm -f -- ${shellQuote(temporaryPath)}`, {
        kind: 'path',
        workdir: '/',
      }).catch(() => {});
      throw error;
    }
  }

  protected override async deleteRemotePath(path: string): Promise<void> {
    await this.runChecked(`rm -rf -- ${shellQuote(path)}`, '/');
  }

  private async runChecked(command: string, workdir: string): Promise<void> {
    const result = await this.runRemoteCommand(command, {
      kind: 'manifest',
      workdir,
    });
    if (result.status !== 0) {
      throw new SandboxProviderError(
        `CreateOSSandboxClient command failed: ${command}`,
        {
          provider: 'createos',
          sandboxId: this.state.sandboxId,
          status: result.status,
          stderr: result.stderr,
        },
      );
    }
  }

  private async pauseSandbox(): Promise<void> {
    this.closePtyAdmission();
    if (this.destroyRequested) {
      await this.destroySandbox();
      return;
    }
    if (this.destroyCompleted) {
      return;
    }
    if (!this.pausePromise) {
      const attempt = this.enqueueLifecycle(async () => {
        if (this.destroyRequested) {
          return;
        }
        await withSandboxSpan(
          'sandbox.stop',
          { backend_id: 'createos', sandbox_id: this.state.sandboxId },
          async () => {
            await this.ptyProcesses.terminateAll();
            await this.sandbox.refresh({
              timeoutMs: this.state.requestTimeoutMs,
            });
            await ensureSandboxPaused(
              this.sandbox,
              this.state.requestTimeoutMs,
              this.state.lifecycleTimeoutMs,
            );
          },
        );
      });
      this.pausePromise = attempt;
      void attempt.then(
        () => this.clearPauseAttempt(attempt),
        () => this.clearPauseAttempt(attempt),
      );
    }
    await this.pausePromise;
    if (this.destroyRequested) {
      await this.destroySandbox();
    }
  }

  private async destroySandbox(): Promise<void> {
    this.closePtyAdmission();
    this.destroyRequested = true;
    if (this.destroyCompleted) {
      return;
    }
    if (!this.destroyPromise) {
      const attempt = this.enqueueLifecycle(async () => {
        if (this.destroyCompleted) {
          return;
        }
        await withSandboxSpan(
          'sandbox.stop',
          { backend_id: 'createos', sandbox_id: this.state.sandboxId },
          async () => {
            await this.ptyProcesses.terminateAll();
            if (!this.destroyIssued) {
              await this.sandbox.destroy({
                timeoutMs: this.state.requestTimeoutMs,
              });
              this.destroyIssued = true;
            }
            await this.sandbox.waitUntilDestroyed({
              ...lifecycleWaitOptions(this.state),
            });
          },
        );
        this.destroyCompleted = true;
      });
      this.destroyPromise = attempt;
      void attempt.then(
        () => this.clearDestroyAttempt(attempt),
        () => this.clearDestroyAttempt(attempt),
      );
    }
    await this.destroyPromise;
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = queued.then(
      () => {},
      () => {},
    );
    return queued;
  }

  private closePtyAdmission(): void {
    this.ptyAdmissionOpen = false;
    this.ptyAdmissionGeneration += 1;
  }

  private capturePtyAdmissionGeneration(): number {
    this.assertPtyAdmissionOpen();
    return this.ptyAdmissionGeneration;
  }

  private assertPtyAdmissionOpen(expectedGeneration?: number): void {
    if (
      !this.ptyAdmissionOpen ||
      (expectedGeneration !== undefined &&
        this.ptyAdmissionGeneration !== expectedGeneration)
    ) {
      throw new SandboxProviderError(
        'CreateOSSandboxClient cannot start a managed PTY while the session is stopping.',
        { provider: 'createos', sandboxId: this.state.sandboxId },
      );
    }
  }

  private clearPauseAttempt(attempt: Promise<void>): void {
    if (this.pausePromise === attempt) {
      this.pausePromise = undefined;
    }
  }

  private clearStartAttempt(attempt: Promise<void>): void {
    if (this.startPromise === attempt) {
      this.startPromise = undefined;
    }
  }

  private clearDestroyAttempt(attempt: Promise<void>): void {
    if (this.destroyPromise === attempt) {
      this.destroyPromise = undefined;
    }
  }

  private remoteArchivePath(): string {
    const directory = this.state.manifest.root === '/tmp' ? '/var/tmp' : '/tmp';
    return `${directory}/openai-agents-createos-${randomUUID()}.tar`;
  }
}

function hasManagedProcessPty(
  processes: CreateOSManagedProcesses | undefined,
): processes is CreateOSManagedProcesses {
  return Boolean(
    processes &&
    typeof processes.create === 'function' &&
    typeof processes.connect === 'function' &&
    typeof processes.input === 'function' &&
    typeof processes.delete === 'function',
  );
}

function requireManagedProcessPty(
  processes: CreateOSManagedProcesses | undefined,
): CreateOSManagedProcesses {
  if (!hasManagedProcessPty(processes)) {
    throw new SandboxUnsupportedFeatureError(
      'CreateOSSandboxClient tty=true requires CreateOS SDK managed-process support (version 0.8.2 or newer).',
      { provider: 'createos', feature: 'tty' },
    );
  }
  return processes;
}

function watchCreateOSManagedProcess(
  processes: CreateOSManagedProcesses,
  processId: string,
  entry: PtyProcessEntry,
): void {
  watchPtyOutput(
    entry,
    async () => {
      for await (const event of processes.connect(processId)) {
        if (event.type === 'data') {
          appendPtyOutput(entry, event.data);
        } else if (event.type === 'exit') {
          return event.exitCode ?? (event.signal ? 1 : null);
        } else if (event.type === 'error') {
          throw new SandboxProviderError(
            `CreateOSSandboxClient managed PTY stream failed: ${event.message}`,
            { provider: 'createos', feature: 'tty' },
          );
        }
      }
      return 1;
    },
    (exitCode, error) =>
      typeof exitCode === 'number' && Number.isFinite(exitCode)
        ? exitCode
        : error
          ? 1
          : null,
  );
}

/**
 * CreateOS-backed sandbox provider for the OpenAI Agents SDK.
 *
 * @see {@link https://docs.createos.sh/Sandbox/Concepts | CreateOS documentation}.
 */
export class CreateOSSandboxClient implements SandboxClient<
  CreateOSSandboxClientOptions,
  CreateOSSandboxSessionState
> {
  readonly backendId = 'createos';
  private readonly options: CreateOSSandboxClientOptions;

  constructor(options: CreateOSSandboxClientOptions = {}) {
    this.options = options;
  }

  async create(
    args?: SandboxClientCreateArgs<CreateOSSandboxClientOptions> | Manifest,
    manifestOptions?: CreateOSSandboxClientOptions,
  ): Promise<CreateOSSandboxSession> {
    const createArgs = normalizeSandboxClientCreateArgs(args, manifestOptions);
    assertCoreSnapshotUnsupported('CreateOSSandboxClient', createArgs.snapshot);
    const resolvedOptions = { ...this.options, ...createArgs.options };
    validateOptions(resolvedOptions);
    if (!resolvedOptions.rootfs || resolvedOptions.rootfs.trim().length === 0) {
      throw new UserError(
        'CreateOSSandboxClient requires a non-empty `rootfs` option to create a sandbox.',
      );
    }
    const manifest = createArgs.manifest;
    assertSandboxManifestMetadataSupported('CreateOSSandboxClient', manifest);

    return await withSandboxSpan(
      'sandbox.start',
      { backend_id: this.backendId },
      async () => {
        const environment = await materializeEnvironment(
          manifest,
          resolvedOptions.env,
        );
        validateEnvironmentNames(environment);
        const client = await createSdkClient(resolvedOptions);
        const sandbox = await withProviderError(
          'CreateOSSandboxClient',
          'createos',
          'create sandbox',
          async () =>
            await client.createSandbox(
              createSandboxRequest(resolvedOptions, environment),
              { timeoutMs: resolvedOptions.requestTimeoutMs },
            ),
        );
        const session = new CreateOSSandboxSession({
          sandbox,
          clientOptions: resolvedOptions,
          concurrencyLimits: createArgs.concurrencyLimits,
          archiveLimits:
            createArgs.archiveLimits === undefined
              ? resolvedOptions.archiveLimits
              : createArgs.archiveLimits,
          state: sessionState(
            manifest,
            sandbox.id,
            resolvedOptions,
            environment,
          ),
        });
        try {
          await session.prepareWorkspaceRoot();
          await session.applyManifest(manifest);
        } catch (error) {
          session.state.pauseOnExit = false;
          await closeRemoteSessionOnManifestError('CreateOS', session, error);
        }
        return session;
      },
    );
  }

  async serializeSessionState(
    state: CreateOSSandboxSessionState,
  ): Promise<Record<string, unknown>> {
    assertRemoteSandboxSessionStateUsable(state);
    const providerState = whitelistSessionState(state);
    const liveAuthority = createOSLiveAuthorityByState.get(state);
    if (liveAuthority) {
      if (liveAuthority.sandbox.id !== liveAuthority.sandboxId) {
        throw new SandboxProviderError(
          'CreateOSSandboxClient live sandbox identity changed before serialization.',
          {
            provider: 'createos',
            sandboxId: liveAuthority.sandboxId,
            actualSandboxId: liveAuthority.sandbox.id,
          },
        );
      }
      providerState.sandboxId = liveAuthority.sandboxId;
    }
    return serializeRemoteSandboxSessionState(providerState, state);
  }

  canPersistOwnedSessionState(state: CreateOSSandboxSessionState): boolean {
    return !isRemoteSandboxSessionStateUnsafe(state) && state.pauseOnExit;
  }

  async canReusePreservedOwnedSession(
    state: CreateOSSandboxSessionState,
    options: SandboxPreservedSessionReuseOptions<CreateOSSandboxClientOptions> = {},
  ): Promise<boolean> {
    if (isRemoteSandboxSessionStateUnsafe(state) || !options.trustedManifest) {
      return false;
    }
    const liveAuthority = getLiveAuthority(state);
    if (!liveAuthority) {
      return false;
    }
    const resolvedOptions = { ...this.options, ...options.clientOptions };
    validateOptions({
      ...resolvedOptions,
      shape: resolvedOptions.shape ?? state.shape,
    });
    const trustedEnvironment = await materializeEnvironment(
      options.trustedManifest,
      resolvedOptions.env,
    );
    validateEnvironmentNames(trustedEnvironment);
    const reusable =
      liveAuthority.sandboxId === state.sandboxId &&
      liveAuthority.sandbox.id === state.sandboxId &&
      liveAuthority.sourceState.sandboxId === state.sandboxId &&
      clientAuthorityMatches(liveAuthority, resolvedOptions) &&
      liveAuthority.sandboxConfigurationSignature ===
        sandboxConfigurationSignatureFromState(state) &&
      liveAuthority.sandboxConfigurationSignature ===
        sandboxConfigurationSignatureFromOptions(state, resolvedOptions) &&
      environmentMatches(state.environment, trustedEnvironment) &&
      (options.revalidateManifestEntries !== true ||
        (liveAuthority.manifestSignature ===
          manifestSignature(state.manifest) &&
          liveAuthority.manifestSignature ===
            manifestSignature(options.trustedManifest)));
    if (!reusable) {
      liveAuthority.preserveOnNextCleanup = true;
    }
    return reusable;
  }

  rebindPreservedOwnedSessionState(
    state: CreateOSSandboxSessionState,
    options: SandboxPreservedSessionReuseOptions<CreateOSSandboxClientOptions> = {},
  ): void {
    const resolvedOptions = { ...this.options, ...options.clientOptions };
    state.pauseOnExit = resolvedOptions.pauseOnExit ?? state.pauseOnExit;
    state.requestTimeoutMs =
      resolvedOptions.requestTimeoutMs ?? state.requestTimeoutMs;
    state.lifecycleTimeoutMs =
      resolvedOptions.lifecycleTimeoutMs ?? state.lifecycleTimeoutMs;
    state.commandTimeoutMs =
      resolvedOptions.commandTimeoutMs ?? state.commandTimeoutMs;
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<CreateOSSandboxSessionState> {
    readStrictOptionalStringRecord(state, 'environment');
    const baseState = await rehydrateRemoteSandboxSessionStateValues(
      state,
      this.options.env,
    );
    const environment = trustedResumedEnvironment(baseState, this.options.env);
    const deserialized = {
      ...baseState,
      environment,
      sandboxId: readRequiredString(state, 'sandboxId'),
      shape: readRequiredString(state, 'shape'),
      rootfs: readStrictOptionalString(state, 'rootfs'),
      name: readStrictOptionalString(state, 'name'),
      networkIds: readStrictOptionalStringArray(state, 'networkIds'),
      diskMib: readStrictOptionalFiniteNumber(state, 'diskMib'),
      egress: readStrictOptionalStringArray(state, 'egress'),
      sshPublicKeys: readStrictOptionalStringArray(state, 'sshPublicKeys'),
      hostId: readStrictOptionalString(state, 'hostId'),
      nodeSelector: readStrictOptionalStringRecord(state, 'nodeSelector'),
      region: readStrictOptionalString(state, 'region'),
      autoPauseAfterSeconds: readStrictOptionalFiniteNumber(
        state,
        'autoPauseAfterSeconds',
      ),
      configuredExposedPorts: readStrictOptionalPorts(
        state,
        'configuredExposedPorts',
      ),
      pauseOnExit: readStrictOptionalBoolean(state, 'pauseOnExit') ?? false,
      requestTimeoutMs: readStrictOptionalFiniteNumber(
        state,
        'requestTimeoutMs',
      ),
      lifecycleTimeoutMs: readStrictOptionalFiniteNumber(
        state,
        'lifecycleTimeoutMs',
      ),
      commandTimeoutMs: readStrictOptionalFiniteNumber(
        state,
        'commandTimeoutMs',
      ),
    };
    validateSessionState(deserialized);
    return deserialized;
  }

  async resume(
    state: CreateOSSandboxSessionState,
    options: SandboxClientResumeOptions<CreateOSSandboxClientOptions> = {},
  ): Promise<CreateOSSandboxSession> {
    assertRemoteSandboxSessionStateCanResume(state);
    const resumeState = snapshotSessionState(state);
    validateDirectSessionState(resumeState);
    const resolvedOptions = {
      ...this.options,
      ...options.clientOptions,
    };
    validateOptions({
      ...resolvedOptions,
      shape: resolvedOptions.shape ?? resumeState.shape,
    });
    const resumedEnvironment = trustedResumedEnvironment(
      resumeState,
      resolvedOptions.env,
    );
    const requestTimeoutMs =
      resolvedOptions.requestTimeoutMs ?? resumeState.requestTimeoutMs;
    const lifecycleTimeoutMs =
      resolvedOptions.lifecycleTimeoutMs ?? resumeState.lifecycleTimeoutMs;
    const commandTimeoutMs =
      resolvedOptions.commandTimeoutMs ?? resumeState.commandTimeoutMs;
    validateOptionalNonNegativeNumber(requestTimeoutMs, 'requestTimeoutMs');
    validateOptionalPositiveNumber(lifecycleTimeoutMs, 'lifecycleTimeoutMs');
    validateOptionalNonNegativeNumber(commandTimeoutMs, 'commandTimeoutMs');
    const client = await createSdkClient({
      ...resolvedOptions,
      requestTimeoutMs,
    });
    const sandbox = await withProviderError(
      'CreateOSSandboxClient',
      'createos',
      'resume sandbox',
      async () => {
        const connected = await client.getSandbox(resumeState.sandboxId, {
          timeoutMs: requestTimeoutMs,
        });
        await ensureSandboxRunning(
          connected,
          requestTimeoutMs,
          lifecycleTimeoutMs,
        );
        return connected;
      },
      { sandboxId: resumeState.sandboxId },
    );
    const resumedState = {
      ...resumeState,
      environment: resumedEnvironment,
      requestTimeoutMs,
      lifecycleTimeoutMs,
      commandTimeoutMs,
    };
    return new CreateOSSandboxSession({
      state: resumedState,
      sandbox,
      clientOptions: resolvedOptions,
      archiveLimits:
        options.archiveLimits === undefined
          ? resolvedOptions.archiveLimits
          : options.archiveLimits,
    });
  }
}

function validateOptions(options: CreateOSSandboxClientOptions): void {
  if (!options.shape || options.shape.trim().length === 0) {
    throw new UserError(
      'CreateOSSandboxClient requires a non-empty `shape` option.',
    );
  }
  validateOptionalPositiveNumber(options.diskMib, 'diskMib');
  validateOptionalPositiveNumber(
    options.autoPauseAfterSeconds,
    'autoPauseAfterSeconds',
  );
  validateOptionalNonNegativeNumber(
    options.requestTimeoutMs,
    'requestTimeoutMs',
  );
  validateOptionalPositiveNumber(
    options.lifecycleTimeoutMs,
    'lifecycleTimeoutMs',
  );
  validateOptionalNonNegativeNumber(
    options.commandTimeoutMs,
    'commandTimeoutMs',
  );
  for (const port of options.exposedPorts ?? []) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new UserError(
        'CreateOSSandboxClient exposedPorts must contain valid TCP ports.',
      );
    }
  }
}

function createSandboxRequest(
  options: CreateOSSandboxClientOptions,
  environment: Record<string, string>,
): Record<string, unknown> {
  return omitUndefined({
    shape: options.shape,
    rootfs: options.rootfs,
    name: options.name,
    networks: options.networkIds?.map((id) => ({ id })),
    disk_mib: options.diskMib,
    egress: options.egress,
    envs: environment,
    ssh_pubkeys: options.sshPublicKeys,
    host_id: options.hostId,
    node_selector: options.nodeSelector,
    ingress_enabled: Boolean(options.exposedPorts?.length),
    region: options.region,
    auto_pause_after_seconds: options.autoPauseAfterSeconds,
  });
}

function sessionState(
  manifest: Manifest,
  sandboxId: string,
  options: CreateOSSandboxClientOptions,
  environment: Record<string, string>,
): CreateOSSandboxSessionState {
  return {
    manifest,
    sandboxId,
    shape: options.shape!,
    rootfs: options.rootfs,
    name: options.name,
    networkIds: options.networkIds,
    diskMib: options.diskMib,
    egress: options.egress,
    sshPublicKeys: options.sshPublicKeys,
    hostId: options.hostId,
    nodeSelector: options.nodeSelector,
    region: options.region,
    autoPauseAfterSeconds: options.autoPauseAfterSeconds,
    configuredExposedPorts: options.exposedPorts,
    pauseOnExit: options.pauseOnExit ?? false,
    requestTimeoutMs: options.requestTimeoutMs,
    lifecycleTimeoutMs: options.lifecycleTimeoutMs,
    commandTimeoutMs: options.commandTimeoutMs,
    environment,
  };
}

async function createSdkClient(
  options: CreateOSSandboxClientOptions,
): Promise<CreateOSSdkClient> {
  const Client = await loadCreateOSSdkClientClass();
  return new Client({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    // Avoid the SDK's shared transport without forwarding credentials on redirects.
    fetch: (input, init) =>
      globalThis.fetch(input, { ...init, redirect: 'manual' }),
    timeoutMs: options.requestTimeoutMs,
  });
}

async function loadCreateOSSdkClientClass(): Promise<CreateOSSdkClientClass> {
  try {
    const { CreateosSandboxClient } = await import('@nodeops-createos/sandbox');
    if (!CreateosSandboxClient) {
      throw new Error('Missing CreateosSandboxClient export.');
    }
    return CreateosSandboxClient as unknown as CreateOSSdkClientClass;
  } catch (error) {
    throw new UserError(
      'CreateOS sandbox support requires the optional `@nodeops-createos/sandbox` package. Install it before using CreateOS-backed sandboxes. ' +
        providerErrorMessage(error),
    );
  }
}

async function ensureSandboxRunning(
  sandbox: CreateOSSandboxInstance,
  requestTimeoutMs?: number,
  lifecycleTimeoutMs?: number,
): Promise<void> {
  const waitOptions = {
    timeoutMs: lifecycleTimeoutMs,
    request: { timeoutMs: requestTimeoutMs },
  };
  if (sandbox.status === 'paused' || sandbox.status === 'pausing') {
    if (sandbox.status === 'pausing') {
      await sandbox.waitUntilPaused(waitOptions);
    }
    await sandbox.resume({ timeoutMs: requestTimeoutMs });
    await sandbox.waitUntilRunning(waitOptions);
    return;
  }
  if (
    sandbox.status === 'creating' ||
    sandbox.status === 'resuming' ||
    sandbox.status === 'forking'
  ) {
    await sandbox.waitUntilRunning(waitOptions);
    return;
  }
  if (sandbox.status !== 'running') {
    throw new SandboxProviderError(
      `CreateOSSandboxClient cannot resume sandbox ${sandbox.id} from status ${sandbox.status}.`,
      {
        provider: 'createos',
        sandboxId: sandbox.id,
        status: sandbox.status,
      },
    );
  }
}

async function ensureSandboxPaused(
  sandbox: CreateOSSandboxInstance,
  requestTimeoutMs?: number,
  lifecycleTimeoutMs?: number,
): Promise<void> {
  const waitOptions = {
    timeoutMs: lifecycleTimeoutMs,
    request: { timeoutMs: requestTimeoutMs },
  };
  if (sandbox.status === 'paused') {
    return;
  }
  if (sandbox.status === 'pausing') {
    await sandbox.waitUntilPaused(waitOptions);
    return;
  }
  if (
    sandbox.status === 'creating' ||
    sandbox.status === 'resuming' ||
    sandbox.status === 'forking'
  ) {
    await sandbox.waitUntilRunning(waitOptions);
  }
  if (sandbox.status === 'running') {
    await sandbox.pause({ timeoutMs: requestTimeoutMs });
    await sandbox.waitUntilPaused(waitOptions);
    return;
  }
  throw new SandboxProviderError(
    `CreateOSSandboxClient cannot pause sandbox ${sandbox.id} from status ${sandbox.status}.`,
    {
      provider: 'createos',
      sandboxId: sandbox.id,
      status: sandbox.status,
    },
  );
}

function whitelistSessionState(
  state: CreateOSSandboxSessionState,
): CreateOSSandboxSessionState {
  return {
    manifest: state.manifest,
    environment: Object.fromEntries(
      Object.keys(state.manifest.environment)
        .filter((key) => typeof state.environment[key] === 'string')
        .map((key) => [key, state.environment[key]]),
    ),
    sandboxId: state.sandboxId,
    shape: state.shape,
    rootfs: state.rootfs,
    name: state.name,
    networkIds: state.networkIds,
    diskMib: state.diskMib,
    egress: state.egress,
    sshPublicKeys: state.sshPublicKeys,
    hostId: state.hostId,
    nodeSelector: state.nodeSelector,
    region: state.region,
    autoPauseAfterSeconds: state.autoPauseAfterSeconds,
    configuredExposedPorts: state.configuredExposedPorts,
    pauseOnExit: state.pauseOnExit,
    requestTimeoutMs: state.requestTimeoutMs,
    lifecycleTimeoutMs: state.lifecycleTimeoutMs,
    commandTimeoutMs: state.commandTimeoutMs,
  };
}

function validateSessionState(state: CreateOSSandboxSessionState): void {
  validateOptions({
    shape: state.shape,
    diskMib: state.diskMib,
    autoPauseAfterSeconds: state.autoPauseAfterSeconds,
    exposedPorts: state.configuredExposedPorts,
    requestTimeoutMs: state.requestTimeoutMs,
    lifecycleTimeoutMs: state.lifecycleTimeoutMs,
    commandTimeoutMs: state.commandTimeoutMs,
  });
}

function validateDirectSessionState(state: CreateOSSandboxSessionState): void {
  const record = state as unknown as Record<string, unknown>;
  readRequiredString(record, 'sandboxId');
  readRequiredString(record, 'shape');
  readStrictOptionalString(record, 'rootfs');
  readStrictOptionalString(record, 'name');
  readStrictOptionalStringArray(record, 'networkIds');
  readStrictOptionalFiniteNumber(record, 'diskMib');
  readStrictOptionalStringArray(record, 'egress');
  readStrictOptionalStringArray(record, 'sshPublicKeys');
  readStrictOptionalString(record, 'hostId');
  readStrictOptionalStringRecord(record, 'nodeSelector');
  readStrictOptionalString(record, 'region');
  readStrictOptionalFiniteNumber(record, 'autoPauseAfterSeconds');
  readStrictOptionalPorts(record, 'configuredExposedPorts');
  if (typeof record.pauseOnExit !== 'boolean') {
    throw invalidSessionField('pauseOnExit', 'a boolean');
  }
  readStrictOptionalFiniteNumber(record, 'requestTimeoutMs');
  readStrictOptionalFiniteNumber(record, 'lifecycleTimeoutMs');
  readStrictOptionalFiniteNumber(record, 'commandTimeoutMs');
  if (readStrictOptionalStringRecord(record, 'environment') === undefined) {
    throw invalidSessionField('environment', 'a record of string values');
  }
  validateSessionState(state);
}

function snapshotSessionState(
  state: CreateOSSandboxSessionState,
): CreateOSSandboxSessionState {
  const record = state as unknown as Record<string, unknown>;
  const snapshot = structuredClone({
    sandboxId: record.sandboxId,
    shape: record.shape,
    rootfs: record.rootfs,
    name: record.name,
    networkIds: record.networkIds,
    diskMib: record.diskMib,
    egress: record.egress,
    sshPublicKeys: record.sshPublicKeys,
    hostId: record.hostId,
    nodeSelector: record.nodeSelector,
    region: record.region,
    autoPauseAfterSeconds: record.autoPauseAfterSeconds,
    configuredExposedPorts: record.configuredExposedPorts,
    pauseOnExit: record.pauseOnExit,
    requestTimeoutMs: record.requestTimeoutMs,
    lifecycleTimeoutMs: record.lifecycleTimeoutMs,
    commandTimeoutMs: record.commandTimeoutMs,
    environment: record.environment,
  });
  return {
    ...snapshot,
    manifest: cloneManifest(state.manifest),
    snapshot:
      state.snapshot === undefined
        ? undefined
        : structuredClone(state.snapshot),
    snapshotFingerprint: state.snapshotFingerprint,
    snapshotFingerprintVersion: state.snapshotFingerprintVersion,
    workspaceReady: state.workspaceReady,
    exposedPorts:
      state.exposedPorts === undefined
        ? undefined
        : structuredClone(state.exposedPorts),
  } as unknown as CreateOSSandboxSessionState;
}

function attachLiveAuthority(
  state: CreateOSSandboxSessionState,
  sandbox: CreateOSSandboxInstance,
  options: CreateOSSandboxClientOptions,
): void {
  const token = Object.freeze({});
  createOSLiveAuthorityByState.set(state, {
    ...resolveClientAuthority(options),
    manifestSignature: manifestSignature(state.manifest),
    preserveOnNextCleanup: false,
    sandbox,
    sandboxId: sandbox.id,
    sandboxConfigurationSignature:
      sandboxConfigurationSignatureFromState(state),
    sourceState: state,
  });
  createOSLiveStateByToken.set(token, state);
  Object.defineProperty(state, createOSLiveAuthorityTokenKey, {
    configurable: false,
    enumerable: true,
    value: token,
    writable: false,
  });
}

function getLiveAuthority(
  state: CreateOSSandboxSessionState,
): CreateOSLiveAuthority | undefined {
  const direct = createOSLiveAuthorityByState.get(state);
  if (direct) {
    return direct;
  }
  const token = (
    state as CreateOSSandboxSessionState & {
      [createOSLiveAuthorityTokenKey]?: object;
    }
  )[createOSLiveAuthorityTokenKey];
  const sourceState = token ? createOSLiveStateByToken.get(token) : undefined;
  return sourceState
    ? createOSLiveAuthorityByState.get(sourceState)
    : undefined;
}

function resolveClientAuthority(
  options: CreateOSSandboxClientOptions,
): Pick<CreateOSLiveAuthority, 'apiKey' | 'baseUrl'> {
  const environment = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  return {
    apiKey: options.apiKey ?? environment?.CREATEOS_SANDBOX_API_KEY,
    baseUrl:
      options.baseUrl?.trim() ||
      environment?.CREATEOS_SANDBOX_BASE_URL?.trim() ||
      CREATEOS_DEFAULT_BASE_URL,
  };
}

function clientAuthorityMatches(
  liveAuthority: CreateOSLiveAuthority,
  options: CreateOSSandboxClientOptions,
): boolean {
  const current = resolveClientAuthority(options);
  return (
    liveAuthority.apiKey === current.apiKey &&
    liveAuthority.baseUrl === current.baseUrl
  );
}

function sandboxConfigurationSignatureFromState(
  state: CreateOSSandboxSessionState,
): string {
  return stableJsonStringify({
    shape: state.shape,
    rootfs: state.rootfs,
    name: state.name,
    networkIds: state.networkIds,
    diskMib: state.diskMib,
    egress: state.egress,
    sshPublicKeys: state.sshPublicKeys,
    hostId: state.hostId,
    nodeSelector: state.nodeSelector,
    region: state.region,
    autoPauseAfterSeconds: state.autoPauseAfterSeconds,
    exposedPorts: state.configuredExposedPorts,
  });
}

function sandboxConfigurationSignatureFromOptions(
  state: CreateOSSandboxSessionState,
  options: CreateOSSandboxClientOptions,
): string {
  return stableJsonStringify({
    shape: options.shape ?? state.shape,
    rootfs: options.rootfs ?? state.rootfs,
    name: options.name ?? state.name,
    networkIds: options.networkIds ?? state.networkIds,
    diskMib: options.diskMib ?? state.diskMib,
    egress: options.egress ?? state.egress,
    sshPublicKeys: options.sshPublicKeys ?? state.sshPublicKeys,
    hostId: options.hostId ?? state.hostId,
    nodeSelector: options.nodeSelector ?? state.nodeSelector,
    region: options.region ?? state.region,
    autoPauseAfterSeconds:
      options.autoPauseAfterSeconds ?? state.autoPauseAfterSeconds,
    exposedPorts: options.exposedPorts ?? state.configuredExposedPorts,
  });
}

function environmentMatches(
  current: Record<string, string>,
  trusted: Record<string, string>,
): boolean {
  return stableJsonStringify(current) === stableJsonStringify(trusted);
}

function manifestSignature(manifest: Manifest): string {
  return stableJsonStringify(whitelistManifestForLiveReuse(manifest));
}

function whitelistManifestForLiveReuse(manifest: Manifest): unknown {
  return {
    version: manifest.version,
    root: manifest.root,
    entries: manifest.entries,
    environment: manifest.environment,
    users: manifest.users,
    groups: manifest.groups,
    extraPathGrants: manifest.extraPathGrants,
    remoteMountCommandAllowlist: manifest.remoteMountCommandAllowlist,
  };
}

function trustedResumedEnvironment(
  state: Pick<CreateOSSandboxSessionState, 'manifest' | 'environment'>,
  configuredEnvironment: Record<string, string> = {},
): Record<string, string> {
  const manifestEnvironment = Object.fromEntries(
    Object.keys(state.manifest.environment)
      .filter(
        (key) =>
          !state.manifest.environment[key]?.ephemeral ||
          !(key in configuredEnvironment),
      )
      .filter((key) => typeof state.environment[key] === 'string')
      .map((key) => [key, state.environment[key]]),
  );
  const environment = { ...configuredEnvironment, ...manifestEnvironment };
  validateEnvironmentNames(environment);
  return environment;
}

function validateEnvironmentNames(environment: Record<string, string>): void {
  for (const key of Object.keys(environment)) {
    assertShellEnvironmentName(key);
  }
}

function lifecycleWaitOptions(state: CreateOSSandboxSessionState): {
  timeoutMs?: number;
  request: { timeoutMs?: number };
} {
  return {
    timeoutMs: state.lifecycleTimeoutMs,
    request: { timeoutMs: state.requestTimeoutMs },
  };
}

function validateOptionalPositiveNumber(
  value: number | undefined,
  field: string,
): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new UserError(
      `CreateOSSandboxClient ${field} must be a positive finite number.`,
    );
  }
}

function validateOptionalNonNegativeNumber(
  value: number | undefined,
  field: string,
): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new UserError(
      `CreateOSSandboxClient ${field} must be a non-negative finite number.`,
    );
  }
}

function readRequiredString(
  state: Record<string, unknown>,
  field: string,
): string {
  const value = state[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidSessionField(field, 'a non-empty string');
  }
  return value;
}

function readStrictOptionalString(
  state: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = state[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidSessionField(field, 'a string');
  }
  return value;
}

function readStrictOptionalBoolean(
  state: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = state[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw invalidSessionField(field, 'a boolean');
  }
  return value;
}

function readStrictOptionalFiniteNumber(
  state: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = state[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidSessionField(field, 'a finite number');
  }
  return value;
}

function readStrictOptionalStringArray(
  state: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = state[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalidSessionField(field, 'an array of strings');
  }
  return [...value];
}

function readStrictOptionalStringRecord(
  state: Record<string, unknown>,
  field: string,
): Record<string, string> | undefined {
  const value = state[field];
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== 'string')
  ) {
    throw invalidSessionField(field, 'a string record');
  }
  return { ...(value as Record<string, string>) };
}

function readStrictOptionalPorts(
  state: Record<string, unknown>,
  field: string,
): number[] | undefined {
  const value = state[field];
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (port) =>
        typeof port !== 'number' ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535,
    )
  ) {
    throw invalidSessionField(field, 'an array of valid TCP ports');
  }
  return [...value];
}

function invalidSessionField(field: string, expected: string): TypeError {
  return new TypeError(
    `Invalid CreateOS sandbox session state field \`${field}\`: expected ${expected}.`,
  );
}

function omitUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}
