import { randomUUID } from "node:crypto";
import { MessageItemType, MessageState, MessageType, type WeixinMessage } from "./protocol-types.js";

export function buildTextMessage(params: { toUserId: string; text: string; contextToken: string; clientId?: string }): WeixinMessage {
  return {
    from_user_id: "",
    to_user_id: params.toUserId,
    client_id: params.clientId ?? `wechat-personal-gateway-${randomUUID()}`,
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: params.text } }],
    context_token: params.contextToken,
  };
}
