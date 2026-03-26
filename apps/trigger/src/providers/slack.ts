import crypto from "node:crypto";

import type { CursorAgentResponse, CursorWebhookPayload } from "../cursor.js";

export interface SlackCommand {
  command: string | null;
  text: string;
  responseUrl: string | null;
  channelId: string | null;
  userId: string | null;
  userName: string | null;
}

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: Buffer,
): boolean {
  if (!timestamp || !signature) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > 60 * 5) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(baseString).digest("hex")}`;

  return timingSafeCompare(expected, signature);
}

export function parseSlackCommand(rawBody: Buffer): SlackCommand {
  const params = new URLSearchParams(rawBody.toString("utf8"));

  return {
    command: params.get("command"),
    text: params.get("text") ?? "",
    responseUrl: params.get("response_url"),
    channelId: params.get("channel_id"),
    userId: params.get("user_id"),
    userName: params.get("user_name"),
  };
}

export function buildSlackAcceptedMessage(
  agent: CursorAgentResponse,
  repository: string,
  callbacksEnabled: boolean,
): Record<string, string> {
  const lines = [
    `Started a Cursor Cloud Agent for ${repository}.`,
    agent.target.url ? `Agent: ${agent.target.url}` : undefined,
    callbacksEnabled
      ? "I will post another update here when the run finishes."
      : "Set TRIGGER_BASE_URL and CURSOR_WEBHOOK_SECRET to get finish notifications in Slack.",
  ].filter(Boolean);

  return {
    response_type: "ephemeral",
    text: lines.join("\n"),
  };
}

export function buildSlackCompletionMessage(
  payload: CursorWebhookPayload,
): Record<string, string> {
  const lines = [
    `Cursor agent ${payload.status.toLowerCase()}.`,
    payload.target?.prUrl ? `Pull request: ${payload.target.prUrl}` : undefined,
    payload.target?.url ? `Agent: ${payload.target.url}` : undefined,
    payload.summary ? `Summary: ${payload.summary}` : undefined,
  ].filter(Boolean);

  return {
    response_type: "ephemeral",
    text: lines.join("\n"),
  };
}

export async function postSlackResponse(
  responseUrl: string,
  message: Record<string, string>,
): Promise<void> {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(
      `Slack response failed with ${response.status}: ${await response.text()}`,
    );
  }
}

function timingSafeCompare(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}
