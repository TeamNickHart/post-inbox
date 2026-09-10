# HTML-only message

**Expected: a bounce reading** `Message rejected: the message had no
plain-text body — HTML-only mail is not supported, so send the post as plain
text`

## How to send it

This one cannot be a plain-text fixture, because the whole point is that the
message carries *no* text part. Compose it in a client set to HTML only:

- **Apple Mail** — Format → Make Rich Text, then Mail → Settings → Composing
  and set "Message Format: Rich Text". Rich Text alone still usually sends a
  plain-text alternative, so also check Preferences → Composing → uncheck
  "Send plain text alternative" if your version offers it.
- **Gmail on the web** — sends `multipart/alternative` with a text part no
  matter what, so it *cannot* produce this case. Use another client.
- **`swaks`**, if you would rather be certain than fight a mail client:

  ```bash
  swaks --to your-inbound-address --from your-allowlisted-address \
    --header 'Subject: HTML Only Test' \
    --header 'Content-Type: text/html; charset=utf-8' \
    --body '<p>This message has <b>no</b> plain-text part.</p>'
  ```

  Note that mail sent this way will not carry passing DKIM, so it needs the
  subject token — and it exercises the token path at the same time.

## Why this case matters

It is the one rejection a legitimate sender is most likely to hit by accident,
and until recently it bounced with the same bare `Message rejected` as a
security failure — leaving no way to tell "your mail client is misconfigured"
from "you are not allowed to post here".
