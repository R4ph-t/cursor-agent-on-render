# Render Workflows as an alternative

Render Workflows can complement this deployment, but they are not part of the default path.

## Why Workflows are not the default

- Render Workflows are still in beta.
- Workflows are not yet compatible with `render.yaml` Blueprints.
- The default deployment is easier to explain and easier to deploy from one Blueprint.

## Where Workflows fit

Use a Workflow when you want orchestration around the trigger request instead of a plain HTTP service. Good examples include:

- retrying Cloud Agent launches after transient API failures
- polling for agent completion on a schedule
- fan-out across multiple repositories or prompts
- approval gates before launching a run
- multi-step post-processing after the pull request is created

## Recommended split

If you add Workflows later, keep the public ingress simple:

- `cursor-trigger-api` receives the webhook or slash command
- the trigger service starts a Workflow task
- the Workflow handles retries, polling, and notification fan-out

This keeps provider verification in the HTTP tier while moving slower orchestration steps into Workflow tasks.

## Example workflow responsibilities

- accept a normalized job payload from the trigger API
- launch a Cursor Cloud Agent
- poll `GET /v0/agents/:id` until the run finishes
- notify Slack or Linear with the final pull request URL
- record basic run metadata for auditability

## When to use Workflows

Use the Workflow variant when orchestration is the main goal. Use the default `web + worker` layout when you want a straightforward deployment with fewer moving parts.
