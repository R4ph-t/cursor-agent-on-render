export interface LaunchAgentInput {
  prompt: string;
  repository: string;
  ref?: string;
  model?: string;
  autoCreatePr?: boolean;
  openAsCursorGithubApp?: boolean;
  skipReviewerRequest?: boolean;
  branchName?: string;
  webhook?: {
    url: string;
    secret?: string;
  };
}

export interface CursorAgentResponse {
  id: string;
  name: string;
  status: string;
  source: {
    repository: string;
    ref?: string;
  };
  target: {
    branchName?: string;
    url?: string;
    prUrl?: string;
    autoCreatePr?: boolean;
    openAsCursorGithubApp?: boolean;
    skipReviewerRequest?: boolean;
  };
  createdAt: string;
  summary?: string;
}

export interface CursorWebhookPayload {
  event: "statusChange";
  timestamp: string;
  id: string;
  status: string;
  source?: {
    repository?: string;
    ref?: string;
  };
  target?: {
    url?: string;
    branchName?: string;
    prUrl?: string;
  };
  summary?: string;
}

export class CursorClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.cursor.com/v0",
  ) {}

  async createAgent(input: LaunchAgentInput): Promise<CursorAgentResponse> {
    const response = await fetch(`${this.baseUrl}/agents`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: {
          text: input.prompt,
        },
        model: input.model,
        source: {
          repository: input.repository,
          ref: input.ref,
        },
        target: {
          autoCreatePr: input.autoCreatePr,
          openAsCursorGithubApp: input.openAsCursorGithubApp,
          skipReviewerRequest: input.skipReviewerRequest,
          branchName: input.branchName,
        },
        webhook: input.webhook,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Cursor API request failed with ${response.status}: ${await response.text()}`,
      );
    }

    return (await response.json()) as CursorAgentResponse;
  }
}

export function normalizeRepositoryUrl(input: string): string {
  if (/^https?:\/\//i.test(input)) {
    return input;
  }

  if (/^[^/\s]+\/[^/\s]+$/.test(input)) {
    return `https://github.com/${input}`;
  }

  throw new Error(
    `Repository must be a full URL or owner/repo slug. Received: ${input}`,
  );
}
