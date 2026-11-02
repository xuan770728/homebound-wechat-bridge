import type { AppLogger } from "../observability/logger.js";
import { CredentialStore } from "../persistence/credential-store.js";
import { CursorStore } from "../persistence/cursor-store.js";
import { ContextTokenStore } from "../persistence/context-token-store.js";
import type { Credential, InboundMessageHandler } from "../types.js";
import { ProtocolClient } from "./protocol-client.js";
import { UpdateWorker } from "./update-worker.js";
import { StatusService } from "../application/status-service.js";
import { TargetRegistry } from "../application/target-registry.js";
import type { Config } from "../config.js";

export class AccountRuntime {
  readonly credentials: CredentialStore;
  readonly contexts: ContextTokenStore;
  readonly cursor: CursorStore;
  readonly status: StatusService;
  readonly targets: TargetRegistry;
  readonly client: ProtocolClient;
  private credential?: Credential;
  private worker?: UpdateWorker;

  constructor(private readonly config: Config, private readonly logger: AppLogger, onInbound?: InboundMessageHandler) {
    this.credentials = new CredentialStore(config.dataDir, config.encryptionKey);
    this.contexts = new ContextTokenStore(config.dataDir, config.encryptionKey);
    this.cursor = new CursorStore(config.dataDir, config.encryptionKey);
    this.status = new StatusService(config);
    this.targets = new TargetRegistry(config, this.contexts);
    this.client = new ProtocolClient(config);
    this.onInbound = onInbound;
  }
  private readonly onInbound?: InboundMessageHandler;

  currentCredential(): Credential | undefined { return this.credential; }
  async start(): Promise<void> {
    this.credential = this.credentials.read("default");
    if (!this.credential) { this.status.setAccountStatus("NEED_LOGIN"); return; }
    await this.startWorker(this.credential);
  }
  async applyCredential(credential: Credential): Promise<void> {
    this.credentials.write(credential);
    this.credential = credential;
    await this.startWorker(credential);
  }
  private async startWorker(credential: Credential): Promise<void> {
    await this.stopWorker();
    this.status.setAccountStatus("ONLINE");
    this.worker = new UpdateWorker({ client: this.client, cursorStore: this.cursor, contexts: this.contexts, targets: this.targets, status: this.status, logger: this.logger, baseUrl: credential.baseUrl, token: credential.botToken, accountId: credential.accountId, longPollTimeoutMs: this.config.longPollTimeoutMs, onInbound: this.onInbound });
    await this.client.notifyStart({ baseUrl: credential.baseUrl, token: credential.botToken }).catch((error) => this.logger.warn({ error: String(error) }, "notifyStart failed; continuing poller startup"));
    await this.worker.start();
  }
  async stop(): Promise<void> {
    this.status.setAccountStatus("STOPPING");
    await this.stopPoller();
    await this.notifyStop();
    this.finishStop();
  }
  async stopPoller(): Promise<void> { await this.stopWorker(); }
  async notifyStop(): Promise<void> { if (this.credential) await this.client.notifyStop({ baseUrl: this.credential.baseUrl, token: this.credential.botToken }).catch((error) => this.logger.warn({ error: String(error) }, "notifyStop failed")); }
  finishStop(): void { this.status.setAccountStatus("STOPPED"); }
  private async stopWorker(): Promise<void> { if (this.worker) { await this.worker.stop(); this.worker = undefined; } }
}
