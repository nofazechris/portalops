# Accounts: sign-in, email verification, password reset

PortalOps supports two ways in, and both end in the same kind of account:

- **Email and password.** The address is confirmed with a link we email you. You can add [two-factor sign-in](#two-factor-sign-in).
- **GitHub.** "Continue with GitHub" signs you in with a verified address from your GitHub account.

## Email and password

- Passwords are 12 to 200 characters. The sign-up form shows a strength bar and a checklist, but the **length is the only rule the server enforces**; the rest is advice.
- Passwords are stored as scrypt hashes (64 MiB memory cost). Nobody, including the administrator, can read them.
- After sign-up you are signed in straight away. A banner asks you to confirm your address; the app keeps working while it is unconfirmed.

### Confirming your email

1. Sign-up sends a message with a **Confirm email** button. The link looks like `https://<your-server>/auth#verify=<token>`.
2. The token is in the URL **fragment** (after `#`), so it never reaches a server log or a `Referer` header. The page removes it from the address bar as soon as it loads.
3. The link works **once** and expires after **24 hours**. Asking for another one (the banner's *Resend email*) invalidates the previous link. You can ask once a minute.
4. Existing accounts created before this feature existed were treated as confirmed at upgrade time (once; a restart never confirms anyone).

### Forgot your password

1. On the sign-in form choose **Forgot password?** and enter your address.
2. The page always says "if an account exists, a link is on its way". It answers **identically for unknown addresses**, so it cannot be used to find out who has an account.
3. The link (`/auth#reset=<token>`) works once and expires after **1 hour**. A newer request replaces the older link.
4. Choosing a new password **signs you out everywhere** and counts as confirming your address (you proved you control the inbox). A GitHub-only account can use the same flow to add a password.

## Two-factor sign-in

Add a second step to password sign-in with an authenticator app (Google Authenticator, 1Password, Authy, or any TOTP app).

1. **Settings → Two-factor sign-in → Set up two-factor.** Add the key it shows to your authenticator app (type it in, or open the link on your phone).
2. Enter the 6-digit code the app shows. Two-factor is now on, and you get **ten recovery codes**. Save them now: they are shown only once.
3. From then on, signing in asks for your password and then a code. A code works once; if it is rejected, wait for the next one (they change every 30 seconds).

Lost your phone? Use a recovery code instead of the 6-digit code; each works once. **New recovery codes** (in Settings) replaces the whole set, and **Turn off** needs your password and a current code.
Accounts that sign in with GitHub are not asked for a code by PortalOps: GitHub enforces whatever two-factor you have set there.

## GitHub sign-in

### Turn it on (one time, about 3 minutes)

1. On GitHub open **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Fill in:
   - **Application name:** PortalOps (anything).
   - **Homepage URL:** your server's address, for example `https://portalops.onrender.com`.
   - **Authorization callback URL:** exactly `<your address>/api/v1/auth/github/callback`, for example `https://portalops.onrender.com/api/v1/auth/github/callback`. It must match character for character (no trailing slash).
3. Register the app, then **Generate a new client secret**. GitHub shows it once.
4. Put the two values in your host's environment settings (Render: the service's **Environment** tab): `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. For local development, put them in your git-ignored `.env`, and use a second OAuth App whose callback is `http://localhost:5173/api/v1/auth/github/callback` (set `PORTALOPS_PUBLIC_URL=http://localhost:5173`).
5. Restart the service. "Continue with GitHub" now appears on the sign-in and sign-up forms. Without both values the button is hidden.

The client secret is used only by the server, to exchange the one-time code for a token. It is never sent to the browser, and the worker process does not even receive it.

### What happens when someone clicks it

```
Continue with GitHub ─► /api/v1/auth/github/start      random state saved in a 10-minute cookie
        │
        ▼
   github.com asks "authorize PortalOps?"  (scopes: read:user, user:email)
        │
        ▼
/api/v1/auth/github/callback?code=…&state=…     state must match the cookie, once
        │   server exchanges the code, reads the profile and the email list
        ▼
   signed in ─► /app          (or back to /auth with a clear message if something failed)
```

### How an account is matched (and why)

Only an email address **GitHub itself has verified** is ever used. Then, in order:

| Situation | Result |
|---|---|
| This GitHub account (by its numeric id) signed in before | Signs into that account, even if the email changed |
| An account with that email exists, its address is **verified** | GitHub is linked to it. Its password, if any, keeps working |
| An account with that email exists, but it was **never verified** | The real owner takes it over: the unproven password is discarded, its sessions are revoked, GitHub is linked. This closes the "register someone else's address with my password first" attack |
| That email belongs to an account already linked to a **different** GitHub account | Refused (`github_account_mismatch`): nobody gets merged into someone else's account |
| No such email | A new account is created, already verified, with no password |
| GitHub has no verified email on the account | Refused (`github_no_verified_email`) |

Forged or replayed callbacks are refused (`state_mismatch`): the state value is random per attempt, must match the cookie, and is spent after one use.

## Email delivery

Messages are sent through [Resend](https://resend.com):

| Setting | Meaning |
|---|---|
| `RESEND_API_KEY` | A key with **sending access**. Server environment only |
| `EMAIL_FROM` | The sender, for example `PortalOps <no-reply@yourdomain.com>`. The domain must be verified in Resend |

- **Before you have a domain:** leave `EMAIL_FROM` empty. PortalOps then sends from `onboarding@resend.dev`, which Resend only delivers to **your own Resend account's email address**. That is enough to test the whole flow with your own address.
- **Gmail and other free-mail addresses cannot be used as the sender**: you can't verify a domain you don't own. Buy or use a domain, add it in Resend → Domains, and add the DNS records it shows.
- **No key configured:** nothing is sent. In development the message (with its link) is printed to the server log; in production only a one-line note is logged, never the link.
- A failing email provider never blocks sign-up or reveals whether an address exists. The signed-in *Resend email* button, which is about your own address, does say honestly when it could not send.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Continue with GitHub" is missing | `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` is not set on the server, or the service was not restarted |
| GitHub shows "redirect_uri is not associated with this application" | The OAuth App's callback URL does not exactly equal `<PORTALOPS_PUBLIC_URL>/api/v1/auth/github/callback` |
| Back on the sign-in page with "couldn't be verified" | The 10-minute state cookie expired, was blocked, or the sign-in started on a different address than the callback (for example `localhost` vs `127.0.0.1`). Try again from one address |
| "Your GitHub account has no verified email" | Verify an email in GitHub → Settings → Emails, then retry |
| No verification or reset email arrives | Check spam. If you use the test sender, the recipient must be your own Resend account address. Check the server log for `account email … not sent: Resend 403 …` |
| `email_unavailable` when pressing *Resend email* | The provider refused or timed out (see the log line above); try again in a few minutes |
| The reset link says it expired | Links last 1 hour, work once, and a newer request replaces the older one. Request a new link |
