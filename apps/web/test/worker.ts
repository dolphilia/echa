export default {
  fetch(): Response {
    return Response.json({ ok: true });
  },
} satisfies ExportedHandler<Env>;
