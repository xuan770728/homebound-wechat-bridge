import { describe, expect, it } from "vitest";
import { buildTextMessage } from "../src/weixin/message-builder.js";

describe("iLink text message", () => {
  it("uses BOT/FINISH and carries the current context token", () => {
    const message = buildTextMessage({ toUserId: "internal-user", text: "hello", contextToken: "ctx", clientId: "client-1" });
    expect(message).toMatchObject({ to_user_id: "internal-user", client_id: "client-1", message_type: 2, message_state: 2, context_token: "ctx", item_list: [{ type: 1, text_item: { text: "hello" } }] });
  });
});
