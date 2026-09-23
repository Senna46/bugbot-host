# Comment on the original PR only when Bugbot fixes exist

Related issue: https://github.com/Senna46/bugbot-host/issues/9

## Goal

Stop posting a notice on the original PR when Cursor Bugbot found nothing.
Leave the hosted PR open, without a comment, when the original was merged
while Bugbot findings or fix commits still exist.

## Behavior

```text
Bugbot success and no extra diff:
  Close the hosted PR. Do not comment on the original.

Same-repo extra commits:
  Retarget, request review, comment once on the original.

Fork extra commits:
  Comment with fetch/merge instructions and close the hosted PR.

Original merged:
  Bugbot not_clean, or the hosted branch has a diff the original does not:
    Leave the hosted PR open. Do not comment. Status kept_open.
  Bugbot success and the hosted branch is behind or equal:
    Close the hosted PR. Do not comment.
  Bugbot pending or missing, and no fix diff yet:
    Do not close. Retry next cycle.

Original closed without merge:
  Close the hosted PR. Do not comment, even if fix commits exist.
```

## Code

- `src/types.ts`: add ShadowStatus `kept_open`
- `src/shadowManager.ts`: drop the no-changes and original-closed comments;
  branch `handleOriginalClosed` on merged vs unmerged
- `src/main.ts`: skip `kept_open` records the same way as `closed`
- README / CLAUDE.md: describe the comment and close rules

## Repository exclusion

`d6e-products/meikei` is never scanned. Existing hosted PRs there are left
as they are. `BUGBOT_HOST_EXCLUDED_REPOS` adds more `owner/repo` names.
