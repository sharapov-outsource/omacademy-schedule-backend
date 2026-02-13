# Contributing

Thank you for considering a contribution.

## How to Contribute

1. Fork the repository.
2. Create a feature branch.
3. Make focused, well-scoped changes.
4. Verify your changes locally (build, run, and test API endpoints).
5. Open a Pull Request with a clear description.

## Pull Request Guidelines

- Keep PRs small and reviewable.
- Include context: what changed and why.
- Update documentation if behavior or API changed.
- Preserve backward compatibility where possible.
- Do not commit secrets (`.env`, tokens, credentials).

## Development Notes

- Use `.env.example` as the base for local configuration.
- If your change affects parsing logic, validate against live pages:
  - group list: `cg.htm`
  - group page: `cgXXX.htm`
- For API checks, prefer `groupCode` filter for stable queries.

## Reporting Issues

When opening an issue, include:
- expected behavior
- actual behavior
- reproduction steps
- sample request/response
- logs (if available)
