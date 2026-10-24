import { z } from "zod";

export const telegramEvents = ["completed", "attention", "approval", "waiting"] as const;
export type TelegramEvent = (typeof telegramEvents)[number];
export const telegramToken = z.string().trim().regex(/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/);
export const telegramChat = z.string().trim().regex(/^[1-9]\d{0,15}$/);
export const telegramSave = z.object({
  revision: z.number().int().nonnegative(),
  token: telegramToken.optional(),
  chatId: telegramChat,
  enabled: z.boolean(),
  includeTitles: z.boolean(),
  events: z.array(z.enum(telegramEvents)).max(4).refine(a => new Set(a).size === a.length),
}).strict();
export type TelegramSave = z.infer<typeof telegramSave>;
export interface TelegramReceipt {
  id: string;
  jobId?: string;
  event: TelegramEvent | "test";
  text: string;
  status: "pending" | "sending" | "sent" | "failed" | "uncertain" | "cancelled";
  createdAt: number;
  updatedAt: number;
  dueAt: number;
  attempts: number;
  messageId?: number;
  issue?: string;
}
export interface TelegramView {
  revision: number;
  configured: boolean;
  enabled: boolean;
  includeTitles: boolean;
  events: TelegramEvent[];
  chatId: string;
  bot?: { id: number; username: string };
  receipts: TelegramReceipt[];
  issue?: string;
}
export interface TelegramCandidate { id: string; name: string }
