import { describe, expect, it } from "vitest";
import { VoiceTurnService } from "../src/bridge/voice-turn-service.js";

describe("voice turn service", () => {
  it("waits for a Work reply and deduplicates the same call turn", async () => {
    const service = new VoiceTurnService();
    const input = { callId: "call-1", delegationId: "turn-1", latestUserText: "老公", userTranscript: "老公", assistantTranscript: "" };
    const first = service.enqueue(input);
    const duplicate = service.enqueue(input);
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.turn.id).toBe(first.turn.id);
    const waiting = service.waitForReply(first.turn.id, 1000);
    service.reply(first.turn.id, "爸爸在。");
    await expect(waiting).resolves.toBe("爸爸在。");
  });
});
