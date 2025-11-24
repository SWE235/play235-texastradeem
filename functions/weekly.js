
export const onRequestGet = async ({ request, env }) => {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol");
  if (!symbol) {
    return new Response(JSON.stringify({ error: "Missing symbol" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = env.ALPHAVANTAGE_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Missing AlphaVantage key in env" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const avUrl =
      "https://www.alphavantage.co/query?function=TIME_SERIES_WEEKLY_ADJUSTED&symbol=" +
      encodeURIComponent(symbol) +
      "&apikey=" +
      encodeURIComponent(apiKey);

    const upstream = await fetch(avUrl);
    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: "AlphaVantage HTTP " + upstream.status }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
    const data = await upstream.json();
    const series = data["Weekly Adjusted Time Series"];
    if (!series) {
      return new Response(
        JSON.stringify({ error: "No weekly series in response", raw: data }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const entries = Object.entries(series)
      .map(([date, o]) => ({ date, close: parseFloat(o["4. close"]) }))
      .filter((d) => Number.isFinite(d.close))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    if (entries.length < 2) {
      return new Response(
        JSON.stringify({ error: "Not enough weekly points" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    function weekOfYear(dateStr) {
      const d = new Date(dateStr + "T00:00:00Z");
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const diff = (d - yearStart) / 86400000;
      return Math.floor(diff / 7) + 1;
    }

    const changes = [];
    const weeks = [];
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const cur = entries[i];
      const pct = ((cur.close - prev.close) / prev.close) * 100;
      changes.push(parseFloat(pct.toFixed(2)));
      weeks.push(weekOfYear(cur.date));
    }

    if (changes.length > 10) {
      changes.splice(0, changes.length - 10);
      weeks.splice(0, weeks.length - 10);
    }

    return new Response(
      JSON.stringify({ changes, weeks }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Exception: " + (err && err.message) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
