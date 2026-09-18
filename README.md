# pr-shadow

Daemon that mirrors other people's GitHub pull requests as Senna46-authored PRs so [Cursor Bugbot](https://cursor.com/docs/bugbot) can review them. After Bugbot and [Fixooly](https://github.com/Senna46/fixooly) finish with no issues, extra commits are delivered back to the original PR.

Implementation is tracked in pull requests. Do not merge mirror PRs that this daemon creates into a repository default branch.
