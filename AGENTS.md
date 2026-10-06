# Commit conventions

- For commits made with Codex, keep Aarnavi as the Git author and committer. Add `Co-authored-by: Codex <noreply@openai.com>` as the final commit-message trailer.
- Use brief, technical subjects for small changes, such as `fix: filter unverified roles from digest`. Reserve longer subjects and bodies for substantial workflow changes that need explanation.
- Attribute unattended GitHub Actions and Dependabot commits to the automation that actually made them. Do not add a Codex co-author trailer to those commits.
- Do not rewrite published commit history just to change a title or attribution.
