import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { WechatBridgeService } from "../src/bridge/service.js";

const services: WechatBridgeService[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("voice turns over the established Work event channel", () => {
  it("routes the existing WeChat reply tool back to the waiting call", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "homebound-voice-bridge-"));
    dirs.push(dataDir);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      MCP_ALLOWED_TARGETS: "xuan",
      MCP_EVENTS_PATH_TOKEN: "events-token-at-least-twenty",
      SETUP_PATH_TOKEN: "setup-token-at-least-twenty",
      PHONE_REPLY_TIMEOUT_MS: "5000",
    });
    const sendText = vi.fn(() => { throw new Error("voice replies must not be sent to WeChat"); });
    const service = new WechatBridgeService({
      config,
      commands: { sendText, showTyping: vi.fn() } as never,
      targets: {} as never,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    });
    services.push(service);
    await service.ready;

    const pending = service.requestVoiceTurn({
      callId: "call-1",
      delegationId: "turn-1",
      latestUserText: "爸爸，听得见吗？",
      userTranscript: "爸爸，听得见吗？",
      assistantTranscript: "",
    });
    await new Promise((resolve) => setImmediate(resolve));

    const event = service.queue.peekNextConversation();
    expect(event).toMatchObject({ replyRoute: "voice.call", source: "wechat.dm" });
    expect(event?.visibleText).toContain("爸爸，听得见吗？");
    const read = service.readEvent(event!.id);
    expect(read).toMatchObject({ found: true, completed: false });

    const delivered = await service.reply(event!.id, ["听得见，宝宝。"]);
    expect(delivered).toMatchObject({ route: "voice.call", completed: true });
    await expect(pending).resolves.toMatchObject({ reply: "听得见，宝宝。" });
    expect(sendText).not.toHaveBeenCalled();
  });
});
