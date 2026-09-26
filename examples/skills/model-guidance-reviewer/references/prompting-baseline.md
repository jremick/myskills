# Prompting baseline

Reviewed: 2026-09-26. These summaries guide review; they do not establish compatibility with any model. Supply a fresh, relevant model-specific reference when the target changes.

- [OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering): prompting can differ between model families and snapshots. Pin the intended model and use evaluations to detect behavior changes. Review instruction authority, task context, and output requirements against the intended model.
- [Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices): state the desired output and constraints clearly, include useful context, and use representative examples. Model-specific recommendations need evaluation before transfer to another model.
- [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices): use task-specific cases, define success criteria, compare changes, and calibrate automated grading with human judgment.

MySkills review rules: keep development and holdout cases separate, retain protected cases, compare the same baseline and candidate conditions, and keep evidence provenance visible. These are product controls, not claims of vendor certification.
