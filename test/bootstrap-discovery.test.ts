import { describe, expect, it } from "vitest";
import { BootstrapDiscovery } from "../src/application/bootstrap-discovery.js";

describe("bootstrap discovery", () => {
  it("captures inbound peers only for an active session and consumes a bound candidate", () => {
    const discovery = new BootstrapDiscovery();
    const session = discovery.start();
    discovery.observeInbound("peer-1", "context-1");
    expect(discovery.list(session.sessionId)).toEqual([{ fromUserId: "peer-1", observedAt: expect.any(String) }]);
    expect(discovery.candidate(session.sessionId, "peer-1")).toMatchObject({ fromUserId: "peer-1", contextToken: "context-1" });
    discovery.complete(session.sessionId, "peer-1");
    expect(() => discovery.list(session.sessionId)).toThrow("BOOTSTRAP_SESSION_NOT_FOUND");
  });

  it("does not expose peers observed before a session starts", () => {
    const discovery = new BootstrapDiscovery();
    discovery.observeInbound("peer-before-session", "context-before-session");
    const session = discovery.start();
    expect(discovery.list(session.sessionId)).toEqual([]);
  });
});
