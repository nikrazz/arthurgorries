export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/brevo-webhook") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      return handleBrevoWebhook(request, env);
    }

    if (url.pathname === "/api/subscribe" && request.method === "POST") {
      try {
        const formData = await request.formData();

        const name = String(formData.get("name") || "").trim();
        const email = String(formData.get("email") || "")
          .trim()
          .toLowerCase();

        if (!email || !email.includes("@")) {
          return Response.redirect(
            new URL("/?signup=invalid#newsletter", request.url),
            303
          );
        }

        // New rows default to unsynced; duplicate signups preserve sync status.
        await env.DB.prepare(
          `INSERT INTO subscribers (name, email)
           VALUES (?, ?)
           ON CONFLICT(email) DO UPDATE SET name = excluded.name`
        )
          .bind(name || null, email)
          .run();

        // Sync subscriber to Brevo
        try {
          const brevoResponse = await fetch(
            "https://api.brevo.com/v3/contacts",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "api-key": env.BREVO_API_KEY,
              },
              body: JSON.stringify({
                email,
                attributes: {
                  FIRSTNAME: name,
                },
                listIds: [2],
                updateEnabled: true,
              }),
            }
          );

          if (!brevoResponse.ok) {
            const brevoError = await brevoResponse.text();

            console.error("Brevo sync failed:", {
              status: brevoResponse.status,
              email,
              response: brevoError,
            });
          } else {
            try {
              await env.DB.prepare(
                `UPDATE subscribers
                 SET brevo_synced = 1, brevo_synced_at = CURRENT_TIMESTAMP
                 WHERE email = ?`
              )
                .bind(email)
                .run();
            } catch (error) {
              // Capture already succeeded; tracking failure must not fail signup.
              console.error("Brevo sync status update failed:", {
                email,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          console.error("Brevo sync failed:", {
            email,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // D1 succeeded, so signup is considered successful
        return Response.redirect(
          new URL("/?signup=success#newsletter", request.url),
          303
        );

      } catch (error) {
        console.error("Subscription failed:", error);

        return Response.redirect(
          new URL("/?signup=error#newsletter", request.url),
          303
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleBrevoWebhook(request, env) {
  // Brevo supports auth: { type: "bearer", token: "..." } on webhooks.
  // Authenticate before parsing the body or accessing D1.
  if (!env.BREVO_WEBHOOK_TOKEN) {
    console.error("Brevo webhook unavailable: token is not configured");
    return new Response("Webhook unavailable", { status: 503 });
  }
  if (request.headers.get("Authorization") !== `Bearer ${env.BREVO_WEBHOOK_TOKEN}`) {
    console.warn("Brevo webhook rejected: unauthorized");
    return new Response("Unauthorized", { status: 401 });
  }

  let event;
  try {
    event = await request.json();
  } catch {
    console.warn("Brevo webhook rejected: invalid JSON");
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    console.warn("Brevo webhook rejected: expected a single event object");
    return new Response("Invalid event", { status: 400 });
  }

  // Marketing payload uses "unsubscribe"; webhook setup uses "unsubscribed".
  // https://developers.brevo.com/docs/marketing-webhooks#unsubscribe
  if (event.event !== "unsubscribe") {
    return new Response(null, { status: 204 });
  }
  if (!Array.isArray(event.list_id) || !event.list_id.includes(2)) {
    console.info("Brevo unsubscribe ignored: list 2 is not present");
    return new Response(null, { status: 204 });
  }

  const email = typeof event.email === "string" ? event.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) {
    console.warn("Brevo webhook rejected: invalid unsubscribe email");
    return new Response("Invalid email", { status: 400 });
  }

  // Prefer UTC event seconds; never interpret Brevo's timezone-less date_event.
  const timestamp = [event.ts_event, event.ts].find(
    (value) => Number.isInteger(value) && value >= 0 && value <= 253402300799
  );
  const unsubscribedAt = timestamp === undefined
    ? null
    : new Date(timestamp * 1000).toISOString().slice(0, 19).replace("T", " ");
  if (unsubscribedAt === null) {
    console.warn("Brevo unsubscribe: no valid event timestamp; using receipt time");
  }

  try {
    const result = await env.DB.prepare(
      `UPDATE subscribers
       SET status = 'unsubscribed',
           unsubscribed_at = COALESCE(unsubscribed_at, ?, CURRENT_TIMESTAMP)
       WHERE email = ?
         AND (status <> 'unsubscribed' OR unsubscribed_at IS NULL)`
    )
      .bind(unsubscribedAt, email)
      .run();
    console.info("Brevo unsubscribe processed:", { updated: result.meta.changes });
    return new Response(null, { status: 204 });
  } catch {
    // Do not acknowledge failed writes. Avoid logging payloads or DB error text.
    console.error("Brevo unsubscribe failed: D1 update failed");
    return new Response("Webhook processing failed", { status: 500 });
  }
}
