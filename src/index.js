export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

        // Save subscriber in D1
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