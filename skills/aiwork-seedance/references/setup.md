# AI Work Seedance Skill setup

Run `install.cmd` from a checked-out copy of this skill. The installer copies
the skill to `%USERPROFILE%\.agents\skills\aiwork-seedance` and, when the
directories already exist, mirrors it to `%USERPROFILE%\.codex\skills` and
`%USERPROFILE%\.claude\skills`. It does not require administrator rights.

The installer asks for the AI Work gateway base URL and API key. The key is
stored as a Windows DPAPI user-scoped value under `%APPDATA%\AIWork` and is
never written to the repository or command-line arguments. A CI/non-interactive
install may provide `AIWORK_GATEWAY_BASE_URL` and `AIWORK_API_KEY` environment
variables instead.

The public Starlink Dimension Router base URL is `https://api.gemstory.cn/v1`;
the installer uses it by default. Existing `www.gemstory.cn` settings are
automatically redirected to the official `api.gemstory.cn` host at runtime.

Use `doctor` to verify the gateway, API key, account pool, and video capability
without creating a task. The gateway base URL is normalized to the public `/v1`
API path; if `/admin` or `/admin/v1` is entered, it is corrected automatically.
The health endpoint is derived as `/health`.

For a client that does not discover Agent Skills automatically, add the skill
directory to that client's skill search path or invoke the runner explicitly.
The runner is the shared implementation; client-specific prompts must not
reimplement the upload, idempotency, polling, or download logic.
