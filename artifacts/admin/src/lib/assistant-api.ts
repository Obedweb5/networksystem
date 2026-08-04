import { customFetch } from "@workspace/api-client-react";

const jsonPost = <T>(url: string, body?: unknown) =>
  customFetch<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

export interface AssistantChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantToolTrace {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  ok: boolean;
}

export interface AssistantChatResponse {
  reply: string;
  toolTrace: AssistantToolTrace[];
}

export const getAssistantStatus = () => customFetch<{ configured: boolean }>("/api/assistant/status");

export const sendAssistantChat = (messages: AssistantChatMessage[]) =>
  jsonPost<AssistantChatResponse>("/api/assistant/chat", { messages });
