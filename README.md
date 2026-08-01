# pi-openai-codex-compat

OpenAI Codex compatibility for Pi with native compaction, fast mode, and Codex-optimized capabilities.

This is a Pi package. It registers this slash command:

```txt
/codex-compat
```

## Development

```bash
npm install
npm run check
npm test
```

## Try locally

```bash
pi -e ./extensions/openai-codex-compat/index.ts
```

## Release staging

The GitHub Actions workflow stages npm releases when a `v*` tag is pushed. The tag must match `package.json` version and point at a commit whose subject is `release: v<version>`.
