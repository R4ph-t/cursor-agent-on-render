import crypto from "node:crypto";

import type { CursorAgentResponse, CursorWebhookPayload } from "../cursor.js";

export interface LinearWebhookPayload {
  action: string;
  type: string;
  createdAt: string;
  webhookTimestamp?: number;
  data?: Record<string, unknown>;
  url?: string;
}

export interface LinearTaskRequest {
  issueId: string;
  prompt: string;
}

export function verifyLinearSignature(
  signingSecret: string,
  signature: string | undefined,
  rawBody: Buffer,
): boolean {
  if (!signature) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", signingSecret)
    .update(rawBody)
    .digest();
  const actual = Buffer.from(signature, "hex");

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

export function isFreshLinearWebhook(timestamp: number | undefined): boolean {
  if (!timestamp) {
    return false;
  }

  return Math.abs(Date.now() - timestamp) <= 60 * 1000;
}

export function extractLinearTaskRequest(
  payload: LinearWebhookPayload,
  commandPrefix: string,
): LinearTaskRequest | null {
  if (payload.type === "Comment" && payload.action === "create") {
    const body = asString(payload.data?.body);
    const issueId = asString(payload.data?.issueId);
    const prompt = extractPrefixedPrompt(body, commandPrefix);

    if (issueId && prompt) {
      return {
        issueId,
        prompt,
      };
    }
  }

  if (
    payload.type === "Issue" &&
    (payload.action === "create" || payload.action === "update")
  ) {
    const description = asString(payload.data?.description);
    const issueId = asString(payload.data?.id);
    const title = asString(payload.data?.title);
    const prompt = extractPrefixedPrompt(description, commandPrefix);

    if (issueId && prompt) {
      return {
        issueId,
        prompt: title ? `${prompt}\n\nLinear issue: ${title}` : prompt,
      };
    }
  }

  return null;
}

export async function postLinearLaunchComment(
  apiKey: string,
  issueId: string,
  agent: CursorAgentResponse,
): Promise<void> {
  const lines = [
    "Started a Cursor Cloud Agent from Render.",
    agent.target.url ? `Agent: ${agent.target.url}` : undefined,
    agent.target.prUrl ? `Pull request: ${agent.target.prUrl}` : undefined,
  ].filter(Boolean);

  await postLinearComment(apiKey, issueId, lines.join("\n"));
}

export async function postLinearCompletionComment(
  apiKey: string,
  issueId: string,
  payload: CursorWebhookPayload,
): Promise<void> {
  const lines = [
    `Cursor agent ${payload.status.toLowerCase()}.`,
    payload.target?.prUrl ? `Pull request: ${payload.target.prUrl}` : undefined,
    payload.target?.url ? `Agent: ${payload.target.url}` : undefined,
    payload.summary ? `Summary: ${payload.summary}` : undefined,
  ].filter(Boolean);

  await postLinearComment(apiKey, issueId, lines.join("\n"));
}

async function postLinearComment(
  apiKey: string,
  issueId: string,
  body: string,
): Promise<void> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
          }
        }
      `,
      variables: {
        input: {
          issueId,
          body,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Linear API request failed with ${response.status}: ${await response.text()}`,
    );
  }

  const data = (await response.json()) as {
    data?: {
      commentCreate?: {
        success?: boolean;
      };
    };
    errors?: Array<{ message?: string }>;
  };

  if (!data.data?.commentCreate?.success) {
    const message = data.errors
      ?.map((error) => error.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(
      `Linear commentCreate failed${message ? `: ${message}` : ""}`,
    );
  }
}

function extractPrefixedPrompt(
  input: string | undefined,
  commandPrefix: string,
): string | null {
  if (!input) {
    return null;
  }

  const escapedPrefix = commandPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = input.match(new RegExp(`^\\s*${escapedPrefix}\\s+(.+)$`, "im"));

  return match?.[1]?.trim() || null;
}

function asString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input : undefined;
}
