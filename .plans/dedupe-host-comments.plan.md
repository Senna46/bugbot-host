# Hide internal comment markers and skip duplicate host comments

Related issue: https://github.com/Senna46/bugbot-host/issues/6

## Goal

Original-PR comments from bugbot-host must be readable and not repeated.

GitHub strips HTML comments, so a body that starts with
`<!-- BUGBOT_HOST_COMMENT: delivering -->:7608417f...` shows only
`:7608417f...`. The SHA was also part of the uniqueness key, so each
later original HEAD posted another "Please review #N" comment.

## Behavior

```text
- Markers are a complete HTML comment. SHA is never concatenated after -->.
- delivering / no_changes / fork_fixes: comment once per original PR.
- Retarget and review request still run on later deliveries; skip the comment.
- Old `<!-- BUGBOT_HOST_COMMENT: delivering -->:sha` comments still match
  because detection is a substring search for the HTML marker.
- conflict_failed keeps sha inside the HTML comment so the same HEAD does
  not spam. The visible body may still mention a short SHA for debugging.
```

## Code

- `src/shadowManager.ts`: stop appending `:${headSha}` to delivering /
  no_changes / fork_fixes markers and bodies.
- Keep `commentOnce` as-is (substring match already covers legacy comments).
