import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";

import {
  CursorClient,
  type CursorWebhookPayload,
  normalizeRepositoryUrl,
} from "./cursor.js";
import {
  extractLinearTaskRequest,
  isFreshLinearWebhook,
  type LinearWebhookPayload,
  postLinearCompletionComment,
  postLinearLaunchComment,
  verifyLinearSignature,
} from "./providers/linear.js";
import {
  buildSlackAcceptedMessage,
  buildSlackCompletionMessage,
  parseSlackCommand,
  postSlackResponse,
  verifySlackSignature,
} from "./providers/slack.js";

type RawBodyRequest = Request & { rawBody?: Buffer };

type NotificationTarget =
  | {
      provider: "slack";
      responseUrl: string;
    }
  | {
      provider: "linear";
      issueId: string;
    };

const taskRequestSchema = z.object({
  prompt: z.string().min(1),
  repository: z.string().optional(),
  ref: z.string().optional(),
  model: z.string().optional(),
  autoCreatePr: z.boolean().optional(),
  openAsCursorGithubApp: z.boolean().optional(),
  skipReviewerRequest: z.boolean().optional(),
  branchName: z.string().optional(),
  notify: z
    .union([
      z.object({
        provider: z.literal("slack"),
        responseUrl: z.string().url(),
      }),
      z.object({
        provider: z.literal("linear"),
        issueId: z.string().min(1),
      }),
    ])
    .optional(),
});

const config = {
  port: Number(process.env.PORT || "3000"),
  cursorApiKey: requiredEnv("CURSOR_API_KEY"),
  cursorApiBaseUrl:
    process.env.CURSOR_API_BASE_URL || "https://api.cursor.com/v0",
  targetRepository: normalizeRepositoryUrl(
    requiredEnv("CURSOR_TARGET_REPOSITORY"),
  ),
  defaultRef: process.env.DEFAULT_SOURCE_REF,
  defaultModel: process.env.DEFAULT_CURSOR_MODEL || "default",
  defaultAutoCreatePr: parseBoolean(process.env.DEFAULT_AUTO_CREATE_PR, true),
  defaultOpenAsCursorGithubApp: parseBoolean(
    process.env.DEFAULT_OPEN_AS_CURSOR_GITHUB_APP,
    false,
  ),
  defaultSkipReviewerRequest: parseBoolean(
    process.env.DEFAULT_SKIP_REVIEWER_REQUEST,
    false,
  ),
  triggerBaseUrl: process.env.TRIGGER_BASE_URL,
  cursorWebhookSecret: process.env.CURSOR_WEBHOOK_SECRET,
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
  linearWebhookSecret: process.env.LINEAR_WEBHOOK_SECRET,
  linearApiKey: process.env.LINEAR_API_KEY,
  linearCommandPrefix: process.env.LINEAR_COMMAND_PREFIX || "@cursor",
};

const webhookConfig =
  config.triggerBaseUrl && config.cursorWebhookSecret
    ? {
        url: new URL(
          "/webhooks/cursor",
          withTrailingSlash(config.triggerBaseUrl),
        ).toString(),
        secret: config.cursorWebhookSecret,
      }
    : undefined;

const cursor = new CursorClient(config.cursorApiKey, config.cursorApiBaseUrl);
const notificationTargets = new Map<string, NotificationTarget>();
const app = express();

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    targetRepository: config.targetRepository,
    cursorWebhookConfigured: Boolean(webhookConfig),
    slackConfigured: Boolean(config.slackSigningSecret),
    linearConfigured: Boolean(config.linearWebhookSecret),
  });
});

app.post("/v1/tasks", express.json(), async (req, res) => {
  try {
    const body = taskRequestSchema.parse(req.body);
    const repository = resolveRepository(body.repository);

    if (body.notify && !webhookConfig) {
      return res.status(400).json({
        error:
          "Notifications require both TRIGGER_BASE_URL and CURSOR_WEBHOOK_SECRET.",
      });
    }

    const agent = await cursor.createAgent({
      prompt: body.prompt,
      repository,
      ref: body.ref ?? config.defaultRef,
      model: body.model ?? config.defaultModel,
      autoCreatePr: body.autoCreatePr ?? config.defaultAutoCreatePr,
      openAsCursorGithubApp:
        body.openAsCursorGithubApp ?? config.defaultOpenAsCursorGithubApp,
      skipReviewerRequest:
        body.skipReviewerRequest ?? config.defaultSkipReviewerRequest,
      branchName: body.branchName,
      webhook: body.notify ? webhookConfig : undefined,
    });

    if (body.notify) {
      notificationTargets.set(agent.id, body.notify);
    }

    return res.status(202).json({
      id: agent.id,
      status: agent.status,
      repository,
      url: agent.target.url,
      prUrl: agent.target.prUrl ?? null,
    });
  } catch (error) {
    return handleRouteError(res, error);
  }
});

app.post(
  "/providers/slack/commands",
  express.raw({ type: "application/x-www-form-urlencoded" }),
  async (req, res) => {
    try {
      if (!config.slackSigningSecret) {
        return res
          .status(500)
          .json({ error: "SLACK_SIGNING_SECRET is not configured." });
      }

      const rawBody = toRawBody(req.body);
      const valid = verifySlackSignature(
        config.slackSigningSecret,
        req.get("x-slack-request-timestamp") ?? undefined,
        req.get("x-slack-signature") ?? undefined,
        rawBody,
      );

      if (!valid) {
        return res.status(401).json({ error: "Invalid Slack signature." });
      }

      const command = parseSlackCommand(rawBody);
      const parsed = parsePromptWithOptions(command.text);
      if (!parsed.prompt) {
        return res.json({
          response_type: "ephemeral",
          text: "Usage: repo=owner/repo branch=main model=default Fix the flaky auth test",
        });
      }

      const repository = resolveRepository(parsed.options.repo);
      const notifyTarget =
        command.responseUrl && webhookConfig
          ? ({
              provider: "slack",
              responseUrl: command.responseUrl,
            } as const)
          : undefined;

      const agent = await cursor.createAgent({
        prompt: parsed.prompt,
        repository,
        ref: parsed.options.branch ?? config.defaultRef,
        model: parsed.options.model ?? config.defaultModel,
        autoCreatePr: parseBoolean(
          parsed.options.autopr,
          config.defaultAutoCreatePr,
        ),
        openAsCursorGithubApp: config.defaultOpenAsCursorGithubApp,
        skipReviewerRequest: config.defaultSkipReviewerRequest,
        branchName: parsed.options.targetBranch,
        webhook: notifyTarget ? webhookConfig : undefined,
      });

      if (notifyTarget) {
        notificationTargets.set(agent.id, notifyTarget);
      }

      return res.json(
        buildSlackAcceptedMessage(agent, repository, Boolean(notifyTarget)),
      );
    } catch (error) {
      console.error(error);
      return res.json({
        response_type: "ephemeral",
        text: formatError(error),
      });
    }
  },
);

app.post(
  "/providers/linear/webhooks",
  express.json({
    verify: (req, _res, buffer) => {
      (req as RawBodyRequest).rawBody = Buffer.from(buffer);
    },
  }),
  async (req: RawBodyRequest, res) => {
    try {
      if (!config.linearWebhookSecret) {
        return res
          .status(500)
          .json({ error: "LINEAR_WEBHOOK_SECRET is not configured." });
      }

      const rawBody = req.rawBody;
      if (!rawBody) {
        return res.status(400).json({ error: "Missing raw body." });
      }

      const payload = req.body as LinearWebhookPayload;
      if (
        !verifyLinearSignature(
          config.linearWebhookSecret,
          req.get("linear-signature") ?? undefined,
          rawBody,
        ) ||
        !isFreshLinearWebhook(payload.webhookTimestamp)
      ) {
        return res
          .status(401)
          .json({ error: "Invalid Linear webhook signature or timestamp." });
      }

      const task = extractLinearTaskRequest(
        payload,
        config.linearCommandPrefix,
      );
      if (!task) {
        return res.status(202).json({ ok: true, ignored: true });
      }

      const parsed = parsePromptWithOptions(task.prompt);
      if (!parsed.prompt) {
        return res.status(202).json({ ok: true, ignored: true });
      }

      const repository = resolveRepository(parsed.options.repo);
      const notifyTarget =
        webhookConfig && config.linearApiKey
          ? ({
              provider: "linear",
              issueId: task.issueId,
            } as const)
          : undefined;

      const agent = await cursor.createAgent({
        prompt: parsed.prompt,
        repository,
        ref: parsed.options.branch ?? config.defaultRef,
        model: parsed.options.model ?? config.defaultModel,
        autoCreatePr: parseBoolean(
          parsed.options.autopr,
          config.defaultAutoCreatePr,
        ),
        openAsCursorGithubApp: config.defaultOpenAsCursorGithubApp,
        skipReviewerRequest: config.defaultSkipReviewerRequest,
        branchName: parsed.options.targetBranch,
        webhook: notifyTarget ? webhookConfig : undefined,
      });

      if (notifyTarget) {
        notificationTargets.set(agent.id, notifyTarget);
        if (config.linearApiKey) {
          await postLinearLaunchComment(
            config.linearApiKey,
            task.issueId,
            agent,
          );
        }
      }

      return res.status(202).json({
        ok: true,
        id: agent.id,
        url: agent.target.url ?? null,
      });
    } catch (error) {
      return handleRouteError(res, error);
    }
  },
);

app.post(
  "/webhooks/cursor",
  express.json({
    verify: (req, _res, buffer) => {
      (req as RawBodyRequest).rawBody = Buffer.from(buffer);
    },
  }),
  async (req: RawBodyRequest, res) => {
    try {
      if (!config.cursorWebhookSecret) {
        return res
          .status(500)
          .json({ error: "CURSOR_WEBHOOK_SECRET is not configured." });
      }

      const signature = req.get("x-webhook-signature") ?? undefined;
      const rawBody = req.rawBody;
      if (!signature || !rawBody) {
        return res
          .status(400)
          .json({ error: "Missing webhook signature or raw body." });
      }

      const computed = createCursorWebhookSignature(
        config.cursorWebhookSecret,
        rawBody,
      );
      if (computed !== signature) {
        return res
          .status(401)
          .json({ error: "Invalid Cursor webhook signature." });
      }

      const payload = req.body as CursorWebhookPayload;
      const target = notificationTargets.get(payload.id);
      if (!target) {
        return res.status(202).json({ ok: true, ignored: true });
      }

      if (target.provider === "slack") {
        await postSlackResponse(
          target.responseUrl,
          buildSlackCompletionMessage(payload),
        );
      } else if (config.linearApiKey) {
        await postLinearCompletionComment(
          config.linearApiKey,
          target.issueId,
          payload,
        );
      }

      if (payload.status === "ERROR" || payload.status === "FINISHED") {
        notificationTargets.delete(payload.id);
      }

      return res.status(202).json({ ok: true });
    } catch (error) {
      return handleRouteError(res, error);
    }
  },
);

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Trigger API listening on port ${config.port}`);
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function resolveRepository(input?: string): string {
  if (!input) {
    return config.targetRepository;
  }

  const requestedRepository = normalizeRepositoryUrl(input);
  if (requestedRepository !== config.targetRepository) {
    throw new Error(
      `This deployment is pinned to ${config.targetRepository}. Requested ${requestedRepository}. Deploy a separate worker for each repository.`,
    );
  }

  return config.targetRepository;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parsePromptWithOptions(text: string): {
  prompt: string;
  options: Record<string, string>;
} {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const options: Record<string, string> = {};
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    const match = token.match(/^([a-zA-Z][\w-]*)=(.+)$/);

    if (!match) {
      break;
    }

    options[match[1]] = match[2];
    index += 1;
  }

  return {
    options,
    prompt: tokens.slice(index).join(" "),
  };
}

function withTrailingSlash(input: string): string {
  return input.endsWith("/") ? input : `${input}/`;
}

function toRawBody(input: unknown): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from("");
}

function createCursorWebhookSignature(secret: string, rawBody: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function handleRouteError(res: Response, error: unknown): Response {
  console.error(error);

  if (error instanceof z.ZodError) {
    return res.status(400).json({
      error: "Invalid request body.",
      details: error.issues,
    });
  }

  return res.status(500).json({
    error: formatError(error),
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
