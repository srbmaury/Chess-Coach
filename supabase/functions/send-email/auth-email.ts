export type AuthAction =
  | "signup"
  | "recovery"
  | "magiclink"
  | "invite"
  | "reauthentication"
  | "email_change";

export interface AuthEmailHookPayload {
  user: {
    email: string;
    new_email?: string;
    user_metadata?: Record<string, unknown>;
  };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to: string;
    email_action_type: AuthAction;
    site_url: string;
    token_new?: string;
    token_hash_new?: string;
  };
}

export interface AuthEmailMessage {
  to: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  actionUrl: string;
}

interface EmailCopy {
  subject: string;
  heading: string;
  description: string;
  button: string;
  preheader: string;
  footer: string;
}

const ACTIONS = new Set<AuthAction>([
  "signup",
  "recovery",
  "magiclink",
  "invite",
  "reauthentication",
  "email_change",
]);

const COPY: Record<AuthAction, EmailCopy> = {
  signup: {
    subject: "Confirm your Chess ML Coach account",
    heading: "Confirm your email",
    description:
      "Confirm this address to finish creating your account. Your players, analysis, and puzzles will follow you to any device.",
    button: "Confirm email",
    preheader: "One tap to confirm your email and start training.",
    footer: "Didn't create an account? Ignore this email and nothing happens.",
  },
  recovery: {
    subject: "Reset your Chess ML Coach password",
    heading: "Reset your password",
    description:
      "Choose a new password for your Chess ML Coach account. This link works once and expires in about an hour.",
    button: "Choose a new password",
    preheader: "Choose a new password. The link expires in an hour.",
    footer: "Didn't ask for this? Ignore it and your password stays exactly as it is.",
  },
  magiclink: {
    subject: "Your Chess ML Coach sign-in link",
    heading: "Sign in to Chess ML Coach",
    description: "Use the link below to sign in. It works once and expires shortly.",
    button: "Sign in",
    preheader: "One tap to sign in. No password needed.",
    footer: "Didn't request this link? Ignore it.",
  },
  invite: {
    subject: "You're invited to Chess ML Coach",
    heading: "Accept your invitation",
    description: "Use this link to accept your invitation and start training on your own games.",
    button: "Accept invitation",
    preheader: "Your Chess ML Coach invitation is ready.",
    footer: "Wasn't expecting this invitation? You can safely ignore it.",
  },
  reauthentication: {
    subject: "Confirm this Chess ML Coach action",
    heading: "Confirm it's you",
    description: "Use this one-time link to confirm this sensitive account action.",
    button: "Confirm action",
    preheader: "Confirm this sensitive account action.",
    footer: "Didn't request this action? Ignore this email and review your account security.",
  },
  email_change: {
    subject: "Confirm your new email",
    heading: "Confirm your email change",
    description: "Use this link to confirm the requested email address change.",
    button: "Confirm email change",
    preheader: "Confirm the new address for your account.",
    footer: "Didn't change your email? Ignore this and your address stays unchanged.",
  },
};

export class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPayloadError";
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidPayloadError(`Missing ${field}`);
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function actionUrl(
  supabaseUrl: string,
  tokenHash: string,
  action: AuthAction,
  redirectTo: string,
): string {
  let url: URL;
  try {
    url = new URL("/auth/v1/verify", requireString(supabaseUrl, "SUPABASE_URL"));
  } catch {
    throw new InvalidPayloadError("Invalid SUPABASE_URL");
  }
  url.searchParams.set("token", requireString(tokenHash, "token hash"));
  url.searchParams.set("type", action);
  url.searchParams.set("redirect_to", requireString(redirectTo, "redirect target"));
  return url.toString();
}

function renderMessage(
  to: string,
  action: AuthAction,
  tokenHash: string,
  redirectTo: string,
  supabaseUrl: string,
): AuthEmailMessage {
  const copy = COPY[action];
  const link = actionUrl(supabaseUrl, tokenHash, action, redirectTo);
  const safeLink = escapeHtml(link);
  const safe = Object.fromEntries(
    Object.entries(copy).map(([key, value]) => [key, escapeHtml(value)]),
  ) as unknown as EmailCopy;

  return {
    to: requireString(to, "recipient"),
    subject: copy.subject,
    actionUrl: link,
    textContent: `${copy.heading}\n\n${copy.description}\n\n${link}\n\n${copy.footer}\n\nChess ML Coach — train on your own games`,
    htmlContent: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${safe.subject}</title></head>
<body style="margin:0;padding:0;background:#eef0f3"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${safe.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f3;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #dfe2e7">
<tr><td style="padding:32px 32px 0"><span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:20px;font-weight:800;letter-spacing:-.02em;color:#11130f"><span style="color:#5c7a12">&#9822;</span> Chess ML Coach</span></td></tr>
<tr><td style="padding:24px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"><h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#11151c">${safe.heading}</h1><p style="margin:0;font-size:15px;line-height:1.65;color:#4a515e">${safe.description}</p></td></tr>
<tr><td style="padding:28px 32px 0"><a href="${safeLink}" style="display:inline-block;padding:14px 26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:700;color:#11130f;background:#d7ff75;text-decoration:none;border-radius:999px">${safe.button}</a></td></tr>
<tr><td style="padding:24px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"><p style="margin:0 0 6px;font-size:12px;color:#6d7380">Or paste this link into your browser:</p><p style="margin:0;font-size:12px;line-height:1.6;word-break:break-all"><a href="${safeLink}" style="color:#4b6410;text-decoration:none">${safeLink}</a></p></td></tr>
<tr><td style="padding:24px 32px 32px"><div style="border-top:1px solid #eceef1;padding-top:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.6;color:#6d7380">${safe.footer}</div></td></tr>
</table><p style="margin:18px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:11px;color:#8d939e">Chess ML Coach — train on your own games</p>
</td></tr></table></body></html>`,
  };
}

export function buildAuthEmails(
  payload: AuthEmailHookPayload,
  supabaseUrl: string,
): AuthEmailMessage[] {
  if (!payload || typeof payload !== "object" || !payload.user || !payload.email_data) {
    throw new InvalidPayloadError("Invalid hook payload");
  }

  const { user, email_data: email } = payload;
  const action = email.email_action_type;
  if (!ACTIONS.has(action)) {
    throw new InvalidPayloadError("Unsupported email action");
  }

  const redirectTo = requireString(email.redirect_to, "redirect target");
  const currentEmail = requireString(user.email, "user email");

  if (action !== "email_change") {
    return [renderMessage(currentEmail, action, email.token_hash, redirectTo, supabaseUrl)];
  }

  const newEmail = requireString(user.new_email, "new email");
  if (email.token_hash_new) {
    return [
      renderMessage(currentEmail, action, email.token_hash_new, redirectTo, supabaseUrl),
      renderMessage(newEmail, action, email.token_hash, redirectTo, supabaseUrl),
    ];
  }

  return [renderMessage(newEmail, action, email.token_hash, redirectTo, supabaseUrl)];
}
