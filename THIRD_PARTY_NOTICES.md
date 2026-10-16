# Third-party references

The desktop IPC framing, owner-discovery/follower-start-turn integration approach,
and persistent send-intent design were informed by:

- [progressrdx/codex-auto-resume](https://github.com/progressrdx/codex-auto-resume)
- Inspected revision: `22c773cbc4c4b05cbc0bdd082d10b1c247a6bc9a`
- License: MIT; full notice in `Resources/LICENSE-codex-auto-resume.txt`.

This application has its own native menu bar UI and multi-conversation monitor.
It does not include the reference project's web server, CLI, or tests.

Additional research:

- [OpenAI Codex App Server documentation](https://learn.chatgpt.com/docs/app-server): read-only account quota and conversation discovery.
- [wd-moo/codex-quota-resume](https://github.com/wd-moo/codex-quota-resume): alternate log/UI automation approach; no code included.
- [Justin1491/codex-dashboard](https://github.com/Justin1491/codex-dashboard): CLI latest-session approach; no code included.

The private desktop IPC was also checked against the locally installed ChatGPT.app,
version `26.1013.31256`, build `20586`. This is an unofficial companion application.
