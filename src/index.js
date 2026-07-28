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

        await env.DB.prepare(
          `INSERT INTO subscribers (name, email)
           VALUES (?, ?)
           ON CONFLICT(email) DO UPDATE SET name = excluded.name`
        )
          .bind(name || null, email)
          .run();

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
