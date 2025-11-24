export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // weekly data endpoint
    if (url.pathname.startsWith("/weekly")) {
      const symbol = url.searchParams.get("symbol");
      if (!symbol) {
        return new Response(JSON.stringify({ error: "Missing symbol" }), { status: 400 });
      }

      const endpoint = `https://www.alphavantage.co/query?function=TIME_SERIES_WEEKLY&symbol=${symbol}&apikey=${env.ALPHAVANTAGE_API_KEY}`;
      const response = await fetch(endpoint);
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // static files served from /public
    return env.ASSETS.fetch(request);
  }
}
