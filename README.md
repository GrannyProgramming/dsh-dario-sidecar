# dsh-dario-sidecar

Harness-owned lifecycle for [dario](https://github.com/askalf/dario) — a
[DeepSeek Harness](https://github.com/DeepSeek-Harness) (DSH) profile plugin.

## In plain terms

You probably pay for a ChatGPT or Claude subscription. That plan works in the
vendor's own app — but most other tools, including the DeepSeek Harness this
plugin is written for, expect an *API key*. An API key bills you per token,
separately, on top of the subscription you already pay for.

[dario](https://github.com/askalf/dario) closes that gap. It's a small
program that runs on your machine and lets any OpenAI- or Anthropic-compatible
tool use your **subscription** instead of an API bill.

One catch: dario only works while it's running. Normally that means opening a
terminal, starting it yourself, and hoping you remember after every reboot —
and when you forget, your tools fail with confusing errors.

This plugin wires dario into your harness's own startup: **harness starts →
dario starts. Harness stops → dario stops.** Install it once, stop thinking
about it. The rest of this README covers the details.

## What it does

- **Spawns** `dario proxy` through DSH's `subprocess` seam when the plugin
  mounts. Default args `['proxy']` serve every plan dario holds credentials
  for; override `args` for a single-plan posture (see Configuration).
- **Readiness-gates** on `GET /v1/models` answering 2xx before reporting
  ready (default 120 s budget, 500 ms polls), so a slow proxy surfaces as
  "starting", not as a model-route credential error.
- **Adopts** an already-healthy listener instead of spawning a doomed
  duplicate. Adoption is not ownership: teardown kills only what this plugin
  started.
- **Tears down effect-scoped**: SIGTERM → grace (5 s default) → SIGKILL,
  tree-scoped, on unload/HMR — the proxy never outlives the harness.
- **Surfaces mid-life exits** in the harness log with exit code/signal.

## Prerequisites

- A working DSH deployment with a profile (e.g. `web`).
- dario **installed and logged in on the host the harness runs on**:

  ```bash
  npm install -g @askalf/dario
  dario add altman   # attach a ChatGPT Plus/Pro plan (paste the redirect URL back)
  dario login        # and/or a Claude Pro/Max plan
  ```

  This plugin manages the **proxy process only** — OAuth login is a human
  step it deliberately never performs.

## Install

Managed route (wires dependency + bundle entry; the package's own patch
supplies the loader row, so defaults apply):

```bash
dsh plugin --profile web add github:GrannyProgramming/dsh-dario-sidecar
```

Manual route — add the dependency to your profile's `package.json`:

```json
{
  "dependencies": {
    "dsh-dario-sidecar": "github:GrannyProgramming/dsh-dario-sidecar"
  }
}
```

install profile dependencies, then pick **one** of the two ways to mount it:

- **Bundle entry** (defaults, no config): add `"dsh-dario-sidecar"` to
  `dsh.profile.bundles`. The package's own patch inserts the loader row.
- **Manual insert** (you want to override config, e.g. `args`): leave it
  **out** of the bundles list and add the row to the profile's
  `cordis.patch.yml` user patch layer instead:

  ```yaml
  - insert:
      - id: dsh-dario-sidecar
        name: 'dsh-dario-sidecar'
        config:
          args: ['proxy', '--no-claude-auth']   # your override
  ```

⚠️ **These two are mutually exclusive.** A bundle entry *and* a manual insert
for the same id is a `duplicate loader entry id` boot failure — the loader
refuses the whole tree, not just the duplicate row.

## Configuration

Everything lives in the insert row's `config`:

```yaml
- insert:
    - id: dsh-dario-sidecar
      name: 'dsh-dario-sidecar'
      config:
        args: ['proxy', '--no-claude-auth']   # example: ChatGPT-only posture
```

| Field | Default | Meaning |
| --- | --- | --- |
| `command` | `dario` | Executable to spawn (absolute, or resolved on PATH at load). |
| `args` | `['proxy']` | Arguments, no shell. `['proxy','--no-claude-auth']` never loads the Claude OAuth path — useful with a dead/stale Claude credential or a ChatGPT-only deployment. |
| `host` / `port` | `127.0.0.1` / `3456` | Readiness-probe target; passed to the child as `DARIO_HOST` / `DARIO_PORT`. |
| `env` | `{}` | Extra env vars merged onto the scrubbed ambient env (PATH/HOME survive). |
| `readyTimeoutMs` | `120000` | Readiness budget before the spawn is torn down and load fails. |
| `pollIntervalMs` | `500` | Interval between readiness polls. |
| `killGraceMs` | `5000` | SIGTERM → SIGKILL escalation grace. |

## Point a model route at it

With the sidecar up, add dario as an `llm-pi-ai` custom provider in
`$DSH_HOME/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    dario:
      displayName: Dario (subscription)
      api: openai-completions
      baseURL: http://127.0.0.1:3456/v1
      apiKeyEnv: DARIO_API_KEY   # any non-empty value; dario accepts a literal "dario"
      compat:
        supportsDeveloperRole: true
        maxTokensField: max_completion_tokens
      models:
        - id: gpt-5.6-sol
          name: GPT-5.6 Sol
          contextWindow: 272000
          maxTokens: 128000
          input: [ text, image ]
          reasoningEfforts: { off: none, low: low, high: high, max: max }
```

Verify what your account serves before declaring models:
`curl -s localhost:3456/v1/models`. The listing is **static** — a live
`/v1/chat/completions` round-trip is the only real auth proof.

## Troubleshooting

- **Load fails `not ready within …ms; stderr tail: …`** — dario started but
  never served: check `dario status`, purge stale credentials (`dario
  logout`), or raise `readyTimeoutMs`.
- **`resolveExecutable` failure** — dario is not on the *harness process's*
  PATH. Set `command` to the absolute binary path.
- **Port conflict** — set `port` in the insert row *and* the matching
  `baseURL` in your model route.
- **WSL + Windows both have dario** — the two installs shadow each other and
  version-split (`hash -r` to re-resolve). Keep exactly one on the harness
  host, or pin `command` to the right binary.
- **Parallel agents** — subscription tokens flag under concurrency; dario is
  strictly single-flight. Route parallel fan-out to per-token API providers
  instead.

## Origin

Extracted from a working tiered-routing deployment; the design was fixed and
verified in
[council_of_agents #7](https://github.com/GrannyProgramming/council_of_agents/issues/7)
(lifecycle mechanism) and
[#5](https://github.com/GrannyProgramming/council_of_agents/issues/5)
(integration + verification). Shape follows DSH's own
`@deepseek-ai/dsh-lsp-stdio` subprocess-lifecycle pattern.

## License

[MIT](./LICENSE)
