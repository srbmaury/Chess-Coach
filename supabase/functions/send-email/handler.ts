import { Webhook } from "standardwebhooks";

import {
  InvalidPayloadError,
  buildAuthEmails,
  type AuthEmailHookPayload,
} from "./auth-email.ts";
import {
  BrevoDeliveryError,
  sendBrevoEmail,
  type BrevoConfig,
} from "./brevo.ts";

interface HandlerDependencies {
  getEnv: (name: string) => string | undefined;
  fetchImpl?: typeof fetch;
}

interface HandlerConfig {
  hookSecret: string;
  supabaseUrl: string;
  brevo: BrevoConfig;
}

function json(status: number, body: object): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function loadConfig(getEnv: HandlerDependencies["getEnv"]): HandlerConfig | null {
  const hookSecret = getEnv("SEND_EMAIL_HOOK_SECRET")?.replace(/^v1,/, "");
  const supabaseUrl = getEnv("SUPABASE_URL")?.trim();
  const apiKey = getEnv("BREVO_API_KEY")?.trim();
  const senderEmail = getEnv("BREVO_SENDER_EMAIL")?.trim();
  const senderName = getEnv("BREVO_SENDER_NAME")?.trim();

  if (!hookSecret || !supabaseUrl || !apiKey || !senderEmail || !senderName) {
    return null;
  }

  return {
    hookSecret,
    supabaseUrl,
    brevo: { apiKey, senderEmail, senderName },
  };
}

export function createAuthEmailHandler({
  getEnv,
  fetchImpl = fetch,
}: HandlerDependencies): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const config = loadConfig(getEnv);
    if (!config) {
      return json(500, { error: "Email service is not configured" });
    }

    let rawBody: string;
    try {
      rawBody = await request.text();
    } catch {
      return json(400, { error: "Invalid request body" });
    }

    let payload: AuthEmailHookPayload;
    try {
      payload = new Webhook(config.hookSecret).verify(
        rawBody,
        Object.fromEntries(request.headers),
      ) as AuthEmailHookPayload;
    } catch {
      return json(401, { error: "Invalid webhook signature" });
    }

    let messages;
    try {
      messages = buildAuthEmails(payload, config.supabaseUrl);
    } catch (error) {
      if (error instanceof InvalidPayloadError) {
        return json(400, { error: "Invalid email hook payload" });
      }
      return json(500, { error: "Email rendering failed" });
    }

    try {
      for (const message of messages) {
        await sendBrevoEmail(message, config.brevo, fetchImpl);
      }
    } catch (error) {
      if (error instanceof BrevoDeliveryError) {
        return json(502, { error: "Email provider rejected the message" });
      }
      return json(500, { error: "Email delivery failed" });
    }

    return json(200, {});
  };
}
