export type BaseInfo = { channel_version: string; bot_agent: string };
export type MessageItem = { type?: number; text_item?: { text?: string } };
export type WeixinMessage = {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
};
export type GetUpdatesResponse = { ret?: number; errcode?: number; errmsg?: string; msgs?: WeixinMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number };
export type QrCodeResponse = { qrcode: string; qrcode_img_content: string };
export type QrStatusResponse = { status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect"; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string; redirect_host?: string };

export const MessageType = { BOT: 2 } as const;
export const MessageItemType = { TEXT: 1 } as const;
export const MessageState = { FINISH: 2 } as const;
