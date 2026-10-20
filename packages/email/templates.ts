import type { EmailMessage } from "./index.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One plain, mobile-safe layout. No remote images or trackers: the only link is the one the user needs. */
function layout(o: { title: string; intro: string; button: string; link: string; outro: string }): { html: string; text: string } {
  const html = `<!doctype html><html><body style="margin:0;background:#0b0b0b;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#f5f3ee">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0b"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#121212;border:1px solid #242424;border-radius:14px"><tr><td style="padding:28px">
<div style="font-weight:600;font-size:15px;letter-spacing:-0.01em;margin-bottom:18px">PortalOps</div>
<h1 style="font-size:20px;line-height:1.3;margin:0 0 10px;font-weight:600">${esc(o.title)}</h1>
<p style="font-size:14.5px;line-height:1.6;color:#c9c4bb;margin:0 0 22px">${esc(o.intro)}</p>
<a href="${esc(o.link)}" style="display:inline-block;background:#b9a7ff;color:#080808;text-decoration:none;font-weight:600;font-size:14.5px;padding:12px 22px;border-radius:10px">${esc(o.button)}</a>
<p style="font-size:12.5px;line-height:1.6;color:#8d8980;margin:22px 0 0">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all;color:#a8a49c">${esc(o.link)}</span></p>
<p style="font-size:12.5px;line-height:1.6;color:#8d8980;margin:16px 0 0">${esc(o.outro)}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${o.title}\n\n${o.intro}\n\n${o.link}\n\n${o.outro}\n`;
  return { html, text };
}

export function verifyEmailMessage(to: string, link: string, ttlHours: number): EmailMessage {
  const { html, text } = layout({
    title: "Confirm your email address",
    intro: "Welcome to PortalOps. Confirm this address to finish setting up your account.",
    button: "Confirm email",
    link,
    outro: `This link works once and expires in ${ttlHours} hours. If you did not create a PortalOps account, you can ignore this email.`,
  });
  return { to, subject: "Confirm your email for PortalOps", text, html };
}

export function resetPasswordMessage(to: string, link: string, ttlMinutes: number): EmailMessage {
  const { html, text } = layout({
    title: "Reset your password",
    intro: "Someone asked to reset the password for this PortalOps account. If that was you, choose a new password with the button below.",
    button: "Choose a new password",
    link,
    outro: `This link works once and expires in ${ttlMinutes} minutes. If you did not ask for this, ignore this email: your password has not changed.`,
  });
  return { to, subject: "Reset your PortalOps password", text, html };
}
