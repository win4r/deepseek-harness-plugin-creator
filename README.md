# DeepSeek Harness Plugin Creator

A reusable Codex skill for designing, implementing, validating, and releasing external plugins and bundle layers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and Cordis.

It supports practical plugin shapes including:

- Bundle patches and host services
- Model-callable tools
- Agent, Session, Goal, and Job integrations
- Cron, heartbeat, durable queues, and restart recovery
- Isolated Workers, subprocesses, and provider adapters
- Web client extensions

The skill deliberately re-discovers and pins the current official Harness/Cordis contract for each project instead of embedding a preview-version API snapshot.

## Install

Clone the repository directly into your Codex skills directory:

```bash
git clone https://github.com/win4r/deepseek-harness-plugin-creator.git \
  ~/.codex/skills/deepseek-harness-plugin-creator
```

## Use

Invoke it explicitly:

```text
$deepseek-harness-plugin-creator Build a durable cron and heartbeat plugin for DeepSeek Harness.
```

Codex may also select it automatically for requests that explicitly concern DeepSeek Harness, `dsh`, or `@deepseek-ai/dsh-*` plugin development. It excludes Codex plugin scaffolding, generic Node packages, installation-only requests, and read-only reviews.

## What the skill enforces

- Current-contract discovery from the official repository or a pinned local checkout
- Minimal plugin-shape selection before adding Workers, storage, UI, or custom loops
- Cordis namespace exports and accurate service injection
- Exact peer/development pairing for shipped Harness/Cordis runtime imports
- Lifecycle ownership for registrations, timers, processes, and durable resources
- Explicit authority boundaries for model tools and external mutations
- Real Loader, package export, patch, fresh-Profile, shutdown, and release gates
- Separate disclosure and opt-in for real-provider tests

Conditional guidance lives under `references/` so only the relevant risk model is loaded for a task.

## Validate a plugin

The bundled validator checks the packaged plugin surface without executing project code:

```bash
node scripts/validate_plugin.mjs /path/to/plugin --built
```

The validator performs descriptor-bound tree inspection using `/usr/bin/python3`, checks package and patch ownership, namespace exports, runtime dependency pairing, release-surface secrets and local paths, symlinks, hardlinks, tree races, and mounted package subpaths. It fails closed when the required POSIX helper is unavailable.

The current release was tested with Node.js 22.20.0 against real Pi Review and Cron plugins, plus positive and adversarial fixtures.

## Repository layout

```text
SKILL.md                     Skill entrypoint and routing
agents/openai.yaml           Codex UI metadata
references/                  Risk-specific implementation and release guidance
scripts/validate_plugin.mjs  Plugin release validator
scripts/enumerate_tree.py    Descriptor-bound filesystem helper
```

DeepSeek Harness is preview software. Revalidate the official contract and dependency versions before every implementation.
